import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { getConfigValue, setConfigFilePath } from '../util.js';

/**
 * Moves one user's derived entries to their current form (engine/src/store/convert_derived.rs). A one-off: run once with the server stopped, then deleted with its test, the
 * engine's `convert_derived` module and its binding methods, and the server's refusal to open a store it hasn't run
 * on (src/user-stores.js).
 *
 * - Value heads: each entity field's value moves to its one head (VALUE and JSON_HEAD entries into `HEAD`).
 * - Free entry keys: each book's free intervals move from being keyed by their start to their end.
 *
 *   node src/migrations/convert-derived.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *   node src/migrations/convert-derived.js --apply [the same]
 *
 * Both refuse while the configured port can't be bound, and without a store. Entities and books move `STEP` at a
 * time in the commit queue, only what is still in an old form, so a re-run moves nothing. Each moved entity's values
 * (each book's free keys) are read the old way before its step and the new way after, and must be equal; then
 * nothing may be left in an old form, and the store is closed (flushed), reopened and checked again. Any mismatch
 * stops it, non-zero. The dry run writes nothing.
 */

const LOG_PREFIX = '[convert-derived]';
/** Entities or books per step. */
const STEP = 500;

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
    // Their imports read config when they load: after the config path is set.
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

    const started = Date.now();
    /** @type {any} */
    let lib = await LibraryEngine.open(await options.engine(), storeDir);
    try {
        await lib.store.ready();

        // ---- derived entries ----
        let entities = 0;
        let books = 0;
        let entries = 0;
        /** @type {string[]} */
        const conflicts = [];
        /** @type {string[]} */
        const mismatches = [];
        if (options.apply) {
            /** @type {number[] | null} */
            let from = [0, 0];
            while (from) {
                const st = await lib.store.convertDerivedStep(from, STEP);
                const now = await lib.store.convertDerivedDigest(st.moved, st.books);
                st.moved.forEach((/** @type {number} */ e, /** @type {number} */ i) => {
                    if (now.entities[i] !== st.before[i]) mismatches.push(`entity ${e}: values read ${now.entities[i]} after, ${st.before[i]} before`);
                });
                st.books.forEach((/** @type {number} */ b, /** @type {number} */ i) => {
                    if (now.books[i] !== st.booksBefore[i]) mismatches.push(`book ${b}: free keys read ${now.books[i]} after, ${st.booksBefore[i]} before`);
                });
                entities += st.moved.length;
                books += st.books.length;
                entries += st.entries;
                conflicts.push(...st.conflicts);
                if (mismatches.length) break;
                from = st.next;
            }
            log(`${LOG_PREFIX} moved: ${entities} entities' value heads and ${books} books' free keys, ${entries} entries`);
        } else {
            log(`${LOG_PREFIX} derived entries in an old form: ${(await lib.store.convertDerivedPending()) ? 'some' : 'none'}`);
        }
        for (const c of conflicts) warnLine(`${LOG_PREFIX} CONFLICT: ${c}`);
        for (const m of mismatches) warnLine(`${LOG_PREFIX} MISMATCH: ${m}`);
        if (mismatches.length || conflicts.length) {
            warnLine(`${LOG_PREFIX} FAILED: ${mismatches.length} entities or books don't read as before, ${conflicts.length} entries left in conflict`);
            return 1;
        }

        if (!options.apply) {
            log(`${LOG_PREFIX} dry run done; nothing was written`);
            return 0;
        }

        // ---- nothing is left in an old form, also once flushed and reopened ----
        const check = async (/** @type {string} */ when) => {
            if (await lib.store.convertDerivedPending()) {
                warnLine(`${LOG_PREFIX} FAILED: ${when}, derived entries are still in an old form`);
                return false;
            }
            return true;
        };
        if (!await check('after the moves')) return 1;
        const closing = lib;
        lib = null;
        await closing.close();
        lib = await LibraryEngine.open(await options.engine(), storeDir);
        await lib.store.ready();
        if (!await check('after the flush and reopen')) return 1;
        log(`${LOG_PREFIX} flushed and reopened: every derived entry is in its current form`);
    } finally {
        if (lib) await lib.close();
    }
    log(`${LOG_PREFIX} done in ${((Date.now() - started) / 1000).toFixed(0)} s`);
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
