import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue, setConfigFilePath } from '../util.js';

/**
 * Moves one user's lorebook links onto the characters, as one list each (list 4): each character's `bookLink` (its
 * one link from before) becomes its first link, and upstream's `world_info.charLore` from the user's settings file
 * (`settings/world_info_settings.json`, else the root `settings.json`) its links after it, then the `charLore` key
 * is removed from that file (the only file edit). A one-off: run once with the server stopped, then deleted with its
 * test, together with the `bookLink` deriver and record kind (engine/src/store/books.rs, engine/src/log/format.rs).
 *
 *   node src/migrations/convert-character-links.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *   node src/migrations/convert-character-links.js --apply [the same]
 *
 * Both refuse while the configured port can't be bound, and without a store. Each `charLore` entry that isn't
 * `{ name: string, extraBooks: string[] }`, or names no character (`<name>.png`), is listed and dropped; each extra
 * book name no book has is listed and linked as an unresolved name. Repeats are dropped, the first kept (a book the
 * `bookLink` names included). A character with no `bookLink` gets its first extra book as its first link (its card's
 * `world`), its empty stored `world` text dropped and its identity hash following. Characters are written 100 per
 * commit, only what differs from what they hold (a re-run writes nothing). After writing, every character is read
 * back and compared; then the store is closed (flushed, so the runs cover the whole log), reopened, and checked to
 * have no derived entry pointing at a `bookLink` record. Only then is `charLore` removed from the settings file.
 * The dry run writes nothing.
 */

const LOG_PREFIX = '[convert-character-links]';
/** Characters per commit, and links per read. */
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
 * Where the user's `charLore` is: the sharded settings file, else the root settings.json; its parsed content.
 * @param {string} root
 * @returns {{ file: string, sharded: boolean, content: any } | null}
 */
function settingsSource(root) {
    const sharded = path.join(root, 'settings', 'world_info_settings.json');
    if (fs.existsSync(sharded)) return { file: sharded, sharded: true, content: JSON.parse(fs.readFileSync(sharded, 'utf8')) };
    const legacy = path.join(root, 'settings.json');
    if (fs.existsSync(legacy)) return { file: legacy, sharded: false, content: JSON.parse(fs.readFileSync(legacy, 'utf8')) };
    return null;
}

/**
 * The `world_info` object holding `charLore` in a settings source's content, or null.
 * @param {{ sharded: boolean, content: any }} source
 */
function worldInfoOf(source) {
    const wis = source.sharded ? source.content : source.content?.world_info_settings;
    const wi = wis?.world_info;
    return wi && typeof wi === 'object' && !Array.isArray(wi) ? wi : null;
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
    const { FIELD, TYPE } = await import('../library-codes.js');
    const { LINKS, linkListRecords, storedLinks } = await import('../character-links.js');
    const { bookKey } = await import('../world-info-keys.js');

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

    const source = settingsSource(root);
    const worldInfo = source ? worldInfoOf(source) : null;
    const charLore = worldInfo && Object.hasOwn(worldInfo, 'charLore') ? worldInfo.charLore : undefined;
    log(`${LOG_PREFIX} settings: ${source ? source.file : 'none'}; charLore: ${charLore === undefined ? 'none' : Array.isArray(charLore) ? `${charLore.length} entries` : 'not a list'}`);

    /** @type {any} */
    let lib = await LibraryEngine.open(await options.engine(), storeDir);
    try {
        await lib.store.ready();

        // ---- charLore, by character: its extra book keys in order, repeats dropped ----
        /** @type {Map<bigint, string[]>} */
        const extras = new Map();
        /** @type {Map<bigint, string>} */
        const avatarOf = new Map();
        let dropped = 0;
        const entries = charLore === undefined ? [] : Array.isArray(charLore) ? charLore : null;
        if (entries === null) {
            warnLine(`${LOG_PREFIX} dropped: charLore isn't a list: ${JSON.stringify(charLore)}`);
            dropped++;
        }
        for (let i = 0; i < (entries ?? []).length; i += BATCH) {
            const batch = /** @type {any[]} */ (entries).slice(i, i + BATCH);
            const shaped = batch.map(x => x && typeof x === 'object' && typeof x.name === 'string' && Array.isArray(x.extraBooks) && x.extraBooks.every((/** @type {unknown} */ b) => typeof b === 'string'));
            const ids = await lib.ids(TYPE.character, batch.map((x, n) => (shaped[n] ? `${x.name}.png` : '')));
            batch.forEach((x, n) => {
                if (!shaped[n]) {
                    warnLine(`${LOG_PREFIX} dropped: charLore[${i + n}] isn't { name: string, extraBooks: string[] }: ${JSON.stringify(x)}`);
                    dropped++;
                    return;
                }
                const id = ids[n];
                if (id === null) {
                    warnLine(`${LOG_PREFIX} dropped: charLore[${i + n}] names no character (${x.name}.png): ${JSON.stringify(x)}`);
                    dropped++;
                    return;
                }
                const keys = extras.get(id) ?? [];
                for (const name of x.extraBooks) {
                    const key = bookKey(name);
                    if (key && !keys.includes(key)) keys.push(key);
                }
                extras.set(id, keys);
                avatarOf.set(id, `${x.name}.png`);
            });
        }

        // ---- the books those keys name; a key no book has becomes an unresolved name ----
        const allKeys = [...new Set([...extras.values()].flat())];
        /** @type {Map<string, bigint | null>} */
        const bookOf = new Map();
        for (let i = 0; i < allKeys.length; i += BATCH) {
            const keys = allKeys.slice(i, i + BATCH);
            (await lib.ids(TYPE.book, keys)).forEach((id, n) => bookOf.set(keys[n], id));
        }
        for (const [key, id] of bookOf) if (id === null) log(`${LOG_PREFIX} no book has the name "${key}": it is linked as an unresolved name`);

        /**
         * The characters to write, 100 at a time: those with a `bookLink` (from the engine, in id order), then those
         * only charLore names.
         * @param {(ids: bigint[], legacy: Map<bigint, bigint | null>) => Promise<void>} each
         */
        const characters = async each => {
            const left = new Set(extras.keys());
            let after;
            for (;;) {
                const page = await lib.store.worldRead('legacyLinks', { after, limit: BATCH });
                const legacy = new Map(page.links.map((/** @type {any} */ l) => [l.entity, l.book]));
                for (const id of legacy.keys()) left.delete(id);
                if (legacy.size) await each([...legacy.keys()], legacy);
                if (!page.more || page.links.length === 0) break;
                after = page.links[page.links.length - 1].entity;
            }
            const rest = [...left];
            for (let i = 0; i < rest.length; i += BATCH) await each(rest.slice(i, i + BATCH), new Map());
        };

        /**
         * Each character's links as they should be: its `bookLink`'s book (else its first link now), then its
         * charLore books, repeats dropped.
         * @param {any} stored
         * @param {Map<bigint, bigint | null>} legacy
         * @param {Map<string, bigint>} made Unresolved names made so far (key -> id).
         */
        const wanted = (stored, legacy, made) => {
            const first = legacy.has(stored.id) ? legacy.get(stored.id) : (storedLinks(stored)[0]?.book ?? null);
            const books = first === null || first === undefined ? [] : [first];
            for (const key of extras.get(stored.id) ?? []) {
                const b = bookOf.get(key) ?? made.get(key);
                if (b !== undefined && b !== null && !books.includes(b)) books.push(b);
            }
            return books;
        };

        // ---- plan (dry run) or write ----
        let legacyCount = 0;
        let changed = 0;
        let records = 0;
        /** @type {Map<string, bigint>} */
        const made = new Map();
        await characters(async (ids, legacy) => {
            legacyCount += legacy.size;
            const entities = await lib.entities(ids);
            const batch = [];
            for (const e of entities) {
                if (!e) continue;
                for (const key of extras.get(e.id) ?? []) {
                    if (bookOf.get(key) === null && !made.has(key)) {
                        const id = lib.nextId++;
                        made.set(key, id);
                        batch.push({ kind: 'entityCreate', entity: id, type: TYPE.book, key, added: Date.now() });
                    }
                }
                const before = storedLinks(e);
                const after = wanted(e, legacy, made);
                const own = linkListRecords(e.id, before, after);
                // A first link made here (no `bookLink`, no link before) is what the card reads as `world`.
                if (!legacy.has(e.id) && before.length === 0 && after.length > 0) {
                    if (e.values.some(v => v.field === FIELD.world)) own.unshift({ kind: 'valueDelete', entity: e.id, field: FIELD.world });
                    const name = (await lib.bookNames([after[0]])).get(after[0]) ?? [...made].find(([, id]) => id === after[0])?.[0];
                    const r = await lib.identityRecord(e, /** @type {string} */ (name));
                    if (r) own.push(r);
                }
                if (own.length) changed++;
                for (const r of own) batch.push(r);
            }
            records += batch.length;
            if (options.apply && batch.length) await lib.store.commit(batch);
        });
        log(`${LOG_PREFIX} characters with a bookLink: ${legacyCount}; charLore entries dropped: ${dropped}; characters ${options.apply ? 'written' : 'the apply would write'}: ${changed} (${records} records)`);
        if (!options.apply) {
            log(`${LOG_PREFIX} dry run done; nothing was written`);
            return 0;
        }

        // ---- read back: every character's links as wanted, and no bookLink left ----
        /** @type {string[]} */
        const mismatches = [];
        await characters(async (ids, legacy) => {
            for (const id of legacy.keys()) mismatches.push(`character ${id}: still has its bookLink`);
        });
        const all = [...new Set([...extras.keys()])];
        for (let i = 0; i < all.length; i += BATCH) {
            const entities = await lib.entities(all.slice(i, i + BATCH), { fields: [], lists: [LINKS] });
            for (const e of entities) {
                if (!e) continue;
                const got = storedLinks(e).map(l => l.book);
                const want = wanted(e, new Map(), made);
                if (JSON.stringify(got.map(String)) !== JSON.stringify(want.map(String))) mismatches.push(`${avatarOf.get(e.id)}: links ${got.join(',')}, wanted ${want.join(',')}`);
            }
        }
        if (mismatches.length) {
            for (const m of mismatches) warnLine(`${LOG_PREFIX} MISMATCH: ${m}`);
            warnLine(`${LOG_PREFIX} FAILED: ${mismatches.length} characters don't read back as planned; charLore is kept`);
            return 1;
        }
        log(`${LOG_PREFIX} read back: every character's links as planned`);

        // ---- flushed: the runs cover the whole log; nothing derived points at a bookLink record ----
        const closing = lib;
        lib = null;
        await closing.close();
        lib = await LibraryEngine.open(await options.engine(), storeDir);
        await lib.store.ready();
        const left = await lib.store.worldRead('legacyLinks', { limit: 1 });
        if (left.links.length > 0) {
            warnLine(`${LOG_PREFIX} FAILED: after the flush, character ${left.links[0].entity} still has a bookLink; charLore is kept`);
            return 1;
        }
        log(`${LOG_PREFIX} flushed and reopened: no bookLink is pointed at`);
    } finally {
        if (lib) await lib.close();
    }

    if (source && charLore !== undefined) {
        delete worldInfoOf(source)?.charLore;
        writeFileAtomicSync(source.file, JSON.stringify(source.content, null, 4), 'utf8');
        log(`${LOG_PREFIX} removed charLore from ${source.file}`);
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
