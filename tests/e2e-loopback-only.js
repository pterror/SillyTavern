import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

/**
 * The e2e harness reaches loopback only: no test may reach a real service. Loaded into each e2e server (`--import`,
 * `e2e-st-server.js`), it refuses the server's outgoing requests to anything else and writes each one to the file
 * `ST_E2E_REFUSED_LOG` names, which fails the test that made it (`frontend/fixtures.js`). The page's own requests are
 * kept in there too. The default API, AI Horde, which every new account and every page's status check asks, is
 * answered as it is when it can't be reached, and isn't counted: a test that wants replies connects a local mock.
 */

/**
 * @param {string} host a host name or address, IPv6 ones bracketed or not
 * @returns {boolean} whether it is this machine's loopback
 */
export function isLoopbackHost(host) {
    const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
    return bare === 'localhost' || bare === '::1' || /^127(\.\d{1,3}){3}$/.test(bare) || bare === '::ffff:127.0.0.1';
}

/**
 * @param {URL} url
 * @returns {boolean} whether a request to it leaves the machine: a network URL whose host isn't loopback
 */
export function leavesMachine(url) {
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && !isLoopbackHost(url.hostname);
}

const REFUSED_CODE = 'E2E_NOT_LOOPBACK';

const log = process.env.ST_E2E_REFUSED_LOG;

/** @param {URL} url */
const isUnreachableHorde = url => url.hostname === 'aihorde.net' || url.href === 'https://raw.githubusercontent.com/db0/AI-Horde-text-model-reference/main/db.json';

/** @param {string} target */
function refused(target) {
    if (log) fs.appendFileSync(log, `${target}\n`);
    return Object.assign(new Error(`The e2e harness reaches loopback only, so ${target} was refused`), { code: REFUSED_CODE });
}

if (log) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async function loopbackFetch(input, init) {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (isUnreachableHorde(url)) throw new TypeError('fetch failed', { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${url.hostname}`), { code: 'ENOTFOUND' }) });
        if (leavesMachine(url)) throw new TypeError('fetch failed', { cause: refused(url.origin) });
        return realFetch(input, init);
    };

    /**
     * @param {unknown[]} args net.connect's or tls.connect's
     * @returns {string | null} the host it connects to; null for a local socket path
     */
    const hostOf = args => {
        const [first, second] = args;
        if (first && typeof first === 'object') {
            const options = /** @type {{ host?: string, path?: string }} */ (first);
            return options.path ? null : options.host ?? 'localhost';
        }
        if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
            return typeof second === 'string' ? second : 'localhost';
        }
        return null;
    };

    for (const module of [net, tls]) {
        const connect = module.connect;
        const guarded = /** @type {typeof net.connect} */ (/** @type {unknown} */ (function (/** @type {any[]} */ ...args) {
            const host = hostOf(args);
            if (host === null || isLoopbackHost(host)) return connect.apply(module, /** @type {any} */ (args));
            const socket = new net.Socket();
            const error = refused(host);
            process.nextTick(() => socket.destroy(error));
            return socket;
        }));
        module.connect = guarded;
        if (module === net) net.createConnection = guarded;
    }
}
