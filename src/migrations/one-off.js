import net from 'node:net';
import process from 'node:process';

import { getConfigValue } from '../util.js';

/**
 * What every one-off (src/migrations) shares: its arguments, the check that the server is stopped, and the engine.
 */

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
 * @param {string[]} argv
 * @returns {{ dryRun?: true, apply?: true, dataRoot: string, handle: string, config: string, unknown: string[] }}
 */
export function parseOneOffArgs(argv) {
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

/**
 * The engine binding, built for this checkout if need be (the server builds it when it starts; the server is
 * stopped while a one-off runs).
 * @returns {Promise<any>}
 */
export async function loadOneOffEngine() {
    if (!process.env.ST_ENGINE_PATH) {
        const { ensureEngine } = await import('../../engine/fetch.js');
        await ensureEngine();
    }
    const { loadEngine } = await import('../../engine/load.js');
    return loadEngine().binding;
}
