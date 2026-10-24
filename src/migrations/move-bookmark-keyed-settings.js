import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue, setConfigFilePath } from '../util.js';

/**
 * Moves extension settings stored under a bookmark's old chat id (`b<id>`) to the chat id extensions see now (the
 * bookmark's label, `ChatEngine.bookmarkChatIds()`), so what an extension kept per chat goes on matching that chat.
 * A one-off: run once with the server stopped, then deleted with its test.
 *
 * Only `settings/extension_settings.json` is read: there extensions keep their own data, and a key there that is a
 * `b<id>` of an existing bookmark is that chat's. A key is moved only when its bookmark exists and its chat id now
 * differs; a key whose new name is already taken in the same object is left, and listed. The dry run lists every
 * move and writes nothing; --apply writes the file once (atomically), after copying it beside itself.
 *
 *   node src/migrations/move-bookmark-keyed-settings.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *   node src/migrations/move-bookmark-keyed-settings.js --apply [the same]
 */

const LOG_PREFIX = '[move-bookmark-keyed-settings]';
const BOOKMARK_KEY = /^b(0|[1-9][0-9]*)$/;

/**
 * Every object key in `value` that reads as a bookmark's old chat id, with where it is.
 * @param {unknown} value
 * @param {string[]} [at]
 * @returns {{ path: string[], key: string }[]}
 */
export function bookmarkKeysIn(value, at = []) {
    if (value === null || typeof value !== 'object') return [];
    const out = [];
    for (const [key, inner] of Object.entries(value)) {
        if (!Array.isArray(value) && BOOKMARK_KEY.test(key)) out.push({ path: at, key });
        out.push(...bookmarkKeysIn(inner, [...at, key]));
    }
    return out;
}

/**
 * Renames, in place, each key the map names to its new name, keeping the keys' order; a key whose new name the same
 * object already has is left.
 * @param {unknown} value
 * @param {Map<string, string>} rename Old key to new.
 * @param {string[]} [at]
 * @returns {{ moved: { path: string[], from: string, to: string }[], taken: { path: string[], from: string, to: string }[] }}
 */
export function renameKeys(value, rename, at = []) {
    /** @type {{ path: string[], from: string, to: string }[]} */
    const moved = [];
    /** @type {{ path: string[], from: string, to: string }[]} */
    const taken = [];
    if (value === null || typeof value !== 'object') return { moved, taken };
    if (!Array.isArray(value)) {
        const obj = /** @type {Record<string, unknown>} */ (value);
        const entries = Object.entries(obj);
        const names = new Set(entries.map(([k]) => k));
        const next = entries.map(([key, inner]) => {
            const to = rename.get(key);
            if (to === undefined || to === key) return [key, inner];
            if (names.has(to)) {
                taken.push({ path: at, from: key, to });
                return [key, inner];
            }
            moved.push({ path: at, from: key, to });
            return [to, inner];
        });
        for (const key of Object.keys(obj)) delete obj[key];
        for (const [key, inner] of next) obj[/** @type {string} */ (key)] = inner;
    }
    for (const [key, inner] of Object.entries(value)) {
        const deeper = renameKeys(inner, rename, [...at, key]);
        moved.push(...deeper.moved);
        taken.push(...deeper.taken);
    }
    return { moved, taken };
}

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

/** @returns {Promise<{ running: boolean, lines: string[] }>} `running` unless each address is free or not on this machine. */
async function probeConfiguredServer() {
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
 * @returns {Promise<number>} The exit code: 0 done (or nothing to do), 1 refused or failed.
 */
export async function runMove(options) {
    const log = options.log ?? console.log;
    const warnLine = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    // Their imports read config when they load: after the config path is set.
    const { setStoreEngine, userStore, closeUserStores, STORE_DIR } = await import('../user-stores.js');

    const root = path.join(options.dataRoot, options.handle);
    const file = path.join(root, 'settings', 'extension_settings.json');
    log(`${LOG_PREFIX} ${options.apply ? 'apply' : 'dry run'} for ${root}`);
    if (!fs.existsSync(path.join(root, STORE_DIR))) {
        warnLine(`${LOG_PREFIX} REFUSED: ${path.join(root, STORE_DIR)} doesn't exist`);
        return 1;
    }
    if (!fs.existsSync(file)) {
        log(`${LOG_PREFIX} no ${file}: nothing to move`);
        return 0;
    }
    const probe = await probeServer();
    probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
    if (probe.running) {
        warnLine(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
        return 1;
    }

    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const found = bookmarkKeysIn(settings);
    if (found.length === 0) {
        log(`${LOG_PREFIX} no key there is a bookmark's old chat id: nothing to move`);
        return 0;
    }

    const binding = await options.engine();
    setStoreEngine(() => binding);
    const store = await userStore({ root });
    /** @type {Map<string, string>} */
    const rename = new Map();
    try {
        for (const key of new Set(found.map(f => f.key))) {
            const tree = await store.chats.treeOfChatId(key);
            if (tree === null) continue;
            const id = await store.chats.bookmarkChatId(tree, key.slice(1));
            if (id !== key) rename.set(key, id);
        }
    } finally {
        await closeUserStores();
    }

    const { moved, taken } = renameKeys(settings, rename);
    for (const m of moved) log(`${LOG_PREFIX} ${[...m.path, m.from].join(' > ')} -> ${m.to}`);
    for (const t of taken) warnLine(`${LOG_PREFIX} left: ${[...t.path, t.from].join(' > ')} (${t.to} is there already)`);
    log(`${LOG_PREFIX} ${moved.length} key(s) ${options.apply ? 'moved' : 'to move'}, ${taken.length} left`);
    if (!options.apply || moved.length === 0) return 0;

    const copy = `${file}.before-bookmark-keys-${Date.now()}`;
    fs.copyFileSync(file, copy);
    writeFileAtomicSync(file, JSON.stringify(settings, null, 4), 'utf8');
    log(`${LOG_PREFIX} written; the file as it was is at ${copy}`);
    return 0;
}

/**
 * @param {string[]} argv
 * @returns {{ dryRun?: true, apply?: true, dataRoot: string, handle: string, config: string, unknown: string[] }}
 */
function parseArgs(argv) {
    /** @type {{ dryRun?: true, apply?: true, dataRoot: string, handle: string, config: string, unknown: string[] }} */
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', unknown: [] };
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
    if (args.unknown.length > 0 || Boolean(args.dryRun) === Boolean(args.apply)) {
        console.warn(`${LOG_PREFIX} usage: --dry-run | --apply  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        process.exitCode = 2;
    } else {
        setConfigFilePath(args.config);
        process.exitCode = await runMove({
            dataRoot: args.dataRoot,
            handle: args.handle,
            apply: Boolean(args.apply),
            engine: async () => {
                // The server builds the engine for this checkout when it starts; the server is stopped here.
                if (!process.env.ST_ENGINE_PATH) {
                    const { ensureEngine } = await import('../../engine/fetch.js');
                    await ensureEngine();
                }
                const { loadEngine } = await import('../../engine/load.js');
                return loadEngine().binding;
            },
        });
    }
}
