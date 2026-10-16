import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { getConfigValue, setConfigFilePath } from '../util.js';

/**
 * Recomputes one user's search block maxima with the engine's reference lengths (d8b53563f changed them; the maxima
 * in a store built before still hold scores computed with the old ones, some below what a document scores now, so a
 * search could skip it). Every map is computed from the store's postings and lengths and written only where it
 * differs. A one-off: run once with the server stopped, then deleted with the engine's
 * `oneOffRecomputeSearchMaxima` and its test.
 *
 *   node src/migrations/recompute-search-maxima.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *   node src/migrations/recompute-search-maxima.js --apply [the same]
 *
 * Both open the store, so both refuse while the configured port can't be bound. The dry run writes nothing and
 * reports how many maps the apply would write.
 */

const LOG_PREFIX = '[recompute-search-maxima]';

/**
 * @param {string} host
 * @param {number} port
 * @returns {Promise<string>} 'free', 'in-use', 'unavailable' (no such address here), or the error.
 */
export function probeBind(host, port) {
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
 * @returns {Promise<number>} The exit code: 0 done, 1 refused or failed.
 */
export async function runRecompute(options) {
    const log = options.log ?? console.log;
    const warnLine = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    // Its imports read config when they load: after the config path is set.
    const { STORE_DIR } = await import('../user-stores.js');
    const storeDir = path.join(options.dataRoot, options.handle, STORE_DIR);
    log(`${LOG_PREFIX} ${options.apply ? 'apply' : 'dry run'} for ${storeDir}`);
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
    const engine = await options.engine();
    const started = Date.now();
    const store = await engine.Store.open(storeDir);
    let counts;
    try {
        await store.ready();
        counts = await store.oneOffRecomputeSearchMaxima(!options.apply);
    } finally {
        await store.close();
    }
    const n = (/** @type {number} */ x) => x.toLocaleString('en-US');
    log(`${LOG_PREFIX} posting blocks read: ${n(counts.postingBlocks)}`);
    log(`${LOG_PREFIX} maxima maps ${options.apply ? 'written or deleted' : 'the apply would write or delete'}: ${n(counts.entries)} (slots raised ${n(counts.raised)}, lowered or gone ${n(counts.lowered)}, added ${n(counts.added)})`);
    log(`${LOG_PREFIX} ${options.apply ? 'done' : 'dry run done; nothing was written'} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
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
        process.exitCode = await runRecompute({
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
