import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { getConfigValue, setConfigFilePath } from '../util.js';

/**
 * Gives one user's world-info entries their history (engine/src/store/history.rs): each value and list place an
 * entry holds as written before history (a `textValue`/`textEdit` head, a `jsonValue`, an `itemPlace`) is written
 * again as its first change, a `histSet` or `histPlace` holding the same, with no user or session (who wrote it
 * isn't known) and the time of this run; the old records die. Entries of world books, of their `originalData` and of
 * characters' own books alike. A one-off: run once with the server stopped, then deleted with its test and the
 * engine's `legacyEntries` read (engine/src/store/history.rs, engine/src/store_binding.rs).
 *
 *   node src/migrations/convert-entries-to-history.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *   node src/migrations/convert-entries-to-history.js --apply [the same]
 *
 * Both refuse while the configured port can't be bound, and without a store. Entries are read and written 100 at a
 * time, only what isn't history yet, so a re-run writes nothing. Each batch is read back after its commit and
 * compared with what it held; then nothing written before history may be left, and the store is closed (flushed,
 * so the runs cover the whole log), reopened, and checked again. Any mismatch stops it, non-zero. The dry run writes
 * nothing.
 */

const LOG_PREFIX = '[convert-entries-to-history]';
/** Entries per read and per commit. */
const BATCH = 100;

/**
 * @param {string} host
 * @param {number} port
 * @returns {Promise<string>} 'free', 'in-use', 'unavailable' (no such address here), or the error.
 */
function probeBind(host, port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', err => {
            const code = /** @type {any} */ (err).code;
            if (code === 'EADDRINUSE') resolve('in-use');
            else if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') resolve('unavailable');
            else resolve(`error ${code ?? err.message}`);
        });
        server.listen({ host, port, exclusive: true }, () => server.close(() => resolve('free')));
    });
}

/**
 * Binds the configured port on the addresses the server listens on.
 * @returns {Promise<{ running: boolean, lines: string[] }>} `running` unless each address is free or not on this machine.
 */
export async function probeConfiguredServer() {
    const port = getConfigValue('port', 8000, 'number');
    const listen = getConfigValue('listen', false, 'boolean');
    const v4 = String(getConfigValue('listenAddress.ipv4', '0.0.0.0'));
    const v6 = String(getConfigValue('listenAddress.ipv6', '[::]')).replace(/^\[|\]$/g, '');
    const hosts = [
        listen ? (net.isIPv4(v4) ? v4 : '0.0.0.0') : '127.0.0.1',
        listen ? (net.isIPv6(v6) ? v6 : '::') : '::1',
    ];
    const lines = [];
    let running = false;
    for (const host of hosts) {
        const result = await probeBind(host, port);
        lines.push(`port probe ${host.includes(':') ? `[${host}]` : host}:${port}: ${result}`);
        if (result !== 'free' && result !== 'unavailable') running = true;
    }
    return { running, lines };
}

/**
 * An entity's values and items, comparable: what a read back must equal.
 * @param {import('../entity-values.js').StoredEntity | null} e
 */
function held(e) {
    if (!e) return 'none';
    const values = e.values.map(v => [String(v.field), v.text !== undefined ? `t${v.text}` : `j${v.json}`]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const items = e.items.map(i => [i.list, i.item, i.position]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return JSON.stringify({ key: e.key, values, items });
}

/**
 * Each page of entries that hold anything written before history, in key order.
 * @param {any} store
 * @param {(entries: { id: bigint, fields: (number | string)[], items: [number, number][] }[]) => Promise<void>} each
 */
async function legacyPages(store, each) {
    let after;
    for (;;) {
        const page = await store.worldRead('legacyEntries', { ...(after === undefined ? {} : { after }), limit: BATCH });
        if (page.entries.length) await each(page.entries);
        if (!page.more) return;
        after = page.last;
    }
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.apply
 * @param {() => Promise<any>} options.engine Loads the engine binding.
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @returns {Promise<number>} The exit code: 0 done (or nothing to do), 1 refused, stopped or failed.
 */
export async function runConvert(options) {
    const log = options.log ?? console.log;
    const warnLine = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    // Its imports read config when they load: after the config path is set.
    const { STORE_DIR } = await import('../user-stores.js');
    const { LibraryEngine } = await import('../library-engine.js');

    const root = path.join(options.dataRoot, options.handle);
    const storeDir = path.join(root, STORE_DIR);
    log(`${LOG_PREFIX} ${options.apply ? 'apply' : 'dry run'} for ${root}`);
    if (!fs.existsSync(storeDir)) {
        warnLine(`${LOG_PREFIX} REFUSED: ${storeDir} doesn't exist`);
        return 1;
    }
    const probe = await probeServer();
    probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
    if (probe.running) {
        warnLine(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
        return 1;
    }
    log(`${LOG_PREFIX} (a server started with a --port override isn't seen by the probe: make sure none runs)`);

    /** @type {any} */
    let lib = await LibraryEngine.open(await options.engine(), storeDir);
    try {
        await lib.store.ready();
        const next = await lib.nextIds();
        const time = Date.now();
        let entries = 0;
        let values = 0;
        let places = 0;
        /** @type {string[]} */
        const mismatches = [];
        await legacyPages(lib.store, async page => {
            const ids = page.map(x => x.id);
            const before = await lib.entities(ids);
            const records = [];
            page.forEach((x, n) => {
                const e = before[n];
                if (!e) {
                    mismatches.push(`entry ${x.id}: listed, but reads as none`);
                    return;
                }
                entries++;
                for (const field of x.fields) {
                    const v = e.values.find((/** @type {any} */ s) => s.field === field);
                    if (!v) {
                        mismatches.push(`entry ${x.id}: field ${field} listed, but holds no value`);
                        continue;
                    }
                    const json = v.text === undefined;
                    records.push({ kind: 'histSet', entity: x.id, field, value: json ? v.json : v.text, json, id: next.change++, time });
                    values++;
                }
                for (const [list, item] of x.items) {
                    const at = e.items.find((/** @type {any} */ i) => i.list === list && i.item === item);
                    if (!at) {
                        mismatches.push(`entry ${x.id}: item ${list}:${item} listed, but has no place`);
                        continue;
                    }
                    records.push({ kind: 'histPlace', entity: x.id, list, item, position: at.position, id: next.change++, time });
                    places++;
                }
            });
            if (!options.apply || records.length === 0 || mismatches.length) return;
            await lib.store.commit(records);
            const after = await lib.entities(ids);
            after.forEach((/** @type {any} */ e, /** @type {number} */ n) => {
                if (held(e) !== held(before[n])) mismatches.push(`entry ${ids[n]}: reads back as ${held(e)}, held ${held(before[n])}`);
            });
        });
        log(`${LOG_PREFIX} entries with values from before history: ${entries}; ${options.apply ? 'written' : 'the apply would write'}: ${values} values and ${places} places`);
        if (mismatches.length) {
            for (const m of mismatches) warnLine(`${LOG_PREFIX} MISMATCH: ${m}`);
            warnLine(`${LOG_PREFIX} FAILED: ${mismatches.length} entries don't read as planned`);
            return 1;
        }
        if (!options.apply) {
            log(`${LOG_PREFIX} dry run done; nothing was written`);
            return 0;
        }

        // ---- nothing from before history is left, also once flushed and reopened ----
        const left = async () => {
            let n = 0;
            await legacyPages(lib.store, async page => {
                n += page.length;
            });
            return n;
        };
        let n = await left();
        if (n > 0) {
            warnLine(`${LOG_PREFIX} FAILED: ${n} entries still hold values from before history`);
            return 1;
        }
        const closing = lib;
        lib = null;
        await closing.close();
        lib = await LibraryEngine.open(await options.engine(), storeDir);
        await lib.store.ready();
        n = await left();
        if (n > 0) {
            warnLine(`${LOG_PREFIX} FAILED: after the flush, ${n} entries still hold values from before history`);
            return 1;
        }
        log(`${LOG_PREFIX} flushed and reopened: every entry's values are history`);
    } finally {
        if (lib) await lib.close();
    }
    log(`${LOG_PREFIX} done`);
    return 0;
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', dryRun: false, apply: false, unknown: /** @type {string[]} */ ([]) };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--apply') out.apply = true;
        else if ((arg === '--data-root' || arg === '--handle' || arg === '--config') && argv[i + 1] !== undefined) {
            out[/** @type {'dataRoot' | 'handle' | 'config'} */ ({ '--data-root': 'dataRoot', '--handle': 'handle', '--config': 'config' }[arg])] = argv[++i];
        } else out.unknown.push(arg);
    }
    return out;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    if (args.unknown.length > 0 || args.dryRun === args.apply) {
        console.warn(`${LOG_PREFIX} usage: --dry-run | --apply  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        process.exitCode = 2;
    } else {
        setConfigFilePath(args.config);
        process.exitCode = await runConvert({
            ...args,
            engine: async () => {
                // The server builds the engine for this checkout when it starts; the server is stopped here.
                const { ensureEngine } = await import('../../engine/fetch.js');
                await ensureEngine();
                const { loadEngine } = await import('../../engine/load.js');
                return loadEngine().binding;
            },
        });
    }
}
