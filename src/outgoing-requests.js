import dns from 'node:dns';
import net from 'node:net';

import ipMatch from 'ip-matching';
import { Agent, EnvHttpProxyAgent, buildConnector, setGlobalDispatcher } from 'undici';

import { color, isValidUrl } from './util.js';
import { filterValidIpPatterns } from './express-common.js';

const FILTER_LOG_HEADER = '[Private Request Filter]';
const PROXY_LOG_HEADER = '[Request Proxy]';

export const PROXY_PROTOCOLS = Object.freeze(['http:', 'https:', 'socks:', 'socks5:']);

/** @type {import('ip-matching').IPMatch[]} */
const privateIpRanges = [
    '127.0.0.0/8',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
    '::1/128',
    'fc00::/7',
    'fe80::/10',
].map(range => ipMatch.getMatch(range));

/**
 * @typedef {object} PrivateRequestFilterSettings
 * @property {boolean} listen Whether the server listens beyond localhost (only used to warn when the filter is off).
 * @property {boolean} enabled
 * @property {string[]} privateAddressWhitelist Private IP addresses or CIDR ranges requests may still reach.
 * @property {boolean} logBlocked
 * @property {boolean} logAllowed
 * @property {boolean} allowUnresolvedHosts
 */

/**
 * @typedef {object} RequestProxySettings
 * @property {boolean} enabled
 * @property {string} url
 * @property {string[]} bypass Hosts reached directly, not through the proxy.
 */

/**
 * Builds the connector that refuses connections to private addresses outside the whitelist. The address checked is
 * the one connected to, so a hostname can't resolve to a public address for the check and a private one after.
 * @param {PrivateRequestFilterSettings} settings
 * @returns {{ connect: import('undici').buildConnector.connector, allowed: Readonly<import('ip-matching').IPMatch[]> }}
 */
export function privateAddressConnector({ privateAddressWhitelist, logBlocked, logAllowed, allowUnresolvedHosts }) {
    const logEntryWarning = (entry, message) => `${color.red('Warning')}: Ignoring invalid private whitelist entry ${color.yellow(entry)} - ${message}`;
    const whitelist = Array.isArray(privateAddressWhitelist) ? privateAddressWhitelist : [];
    const allowed = Object.freeze(filterValidIpPatterns(whitelist, logEntryWarning).map(pattern => ipMatch.getMatch(pattern)));

    /**
     * @param {string} address
     * @returns {Error|null} Why a connection to `address` is refused, or null when it isn't.
     */
    const refusal = (address) => {
        if (!privateIpRanges.some(range => range.matches(address))) return null;
        if (allowed.some(match => match.matches(address))) {
            if (logAllowed) console.info(color.green(FILTER_LOG_HEADER), 'Allowed request to private IP address:', color.blue(address));
            return null;
        }
        const message = `Blocked request to private IP address: ${address}`;
        if (logBlocked) console.error(color.red(FILTER_LOG_HEADER), message);
        return new Error(message);
    };

    /** @type {typeof dns.lookup} */
    const lookup = /** @type {any} */ ((hostname, options, callback) => {
        dns.lookup(hostname, options, (error, address, family) => {
            if (error) {
                if (allowUnresolvedHosts) return callback(error, address, family);
                const message = `Unable to resolve host: ${hostname}. Set privateAddressWhitelist.allowUnresolvedHosts to true to bypass this check.`;
                console.error(color.red(FILTER_LOG_HEADER), message);
                return callback(new Error(message), address, family);
            }
            const addresses = Array.isArray(address) ? address.map(entry => entry.address) : [address];
            for (const resolved of addresses) {
                const refused = refusal(resolved);
                if (refused) return callback(refused, address, family);
            }
            callback(null, address, family);
        });
    });

    const direct = buildConnector({ lookup });
    /** @type {import('undici').buildConnector.connector} */
    const connect = (options, callback) => {
        const refused = net.isIP(options.hostname) ? refusal(options.hostname) : null;
        if (refused) return callback(refused, null);
        return direct(options, callback);
    };
    return { connect, allowed };
}

/**
 * Sets the dispatcher every outgoing request made with fetch() goes through: no time limit on a reply (a long
 * generation sends nothing until it's done), keep-alive as configured, the private request filter on direct
 * connections and the request proxy for everything it doesn't bypass.
 * @param {object} settings
 * @param {boolean} settings.enableKeepAlive
 * @param {PrivateRequestFilterSettings} settings.privateRequestFilter
 * @param {RequestProxySettings} settings.requestProxy
 * @returns {import('undici').Dispatcher} The dispatcher set.
 */
export function initOutgoingRequests({ enableKeepAlive, privateRequestFilter, requestProxy }) {
    /** @type {import('undici').Agent.Options} */
    const options = { headersTimeout: 0, bodyTimeout: 0 };
    if (!enableKeepAlive) options.pipelining = 0;

    if (privateRequestFilter.enabled) {
        const { connect, allowed } = privateAddressConnector(privateRequestFilter);
        options.connect = connect;
        console.info();
        console.info(color.green(FILTER_LOG_HEADER), 'Enabled');
        if (allowed.length > 0) {
            console.info(color.green(FILTER_LOG_HEADER), 'Allowed private addresses:', color.blue(allowed.join(', ')));
        }
        console.info();
    } else if (privateRequestFilter.listen) {
        console.warn();
        console.warn(color.yellow('Warning: listen is enabled but private request filter is disabled. This may expose your server to SSRF attacks.'));
        console.warn(color.blue('To enable, provide trusted addresses in privateAddressWhitelist.allowedRanges and set privateAddressWhitelist.enabled to true in config.yaml and restart the server.'));
    }

    const proxyUrl = requestProxy.enabled ? usableProxyUrl(requestProxy.url) : null;
    if (proxyUrl && privateRequestFilter.enabled) {
        console.warn(color.yellow(PROXY_LOG_HEADER), 'Warning: Request proxy is enabled while private request filter is also enabled. Only URLs that BYPASS the request proxy will be checked.');
        console.warn(color.yellow(PROXY_LOG_HEADER), 'To ensure all requests are properly filtered, disable the request proxy.');
    }

    const dispatcher = proxyUrl
        ? new EnvHttpProxyAgent({ ...options, httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy: Array.isArray(requestProxy.bypass) ? requestProxy.bypass.join(',') : '' })
        : new Agent(options);
    setGlobalDispatcher(dispatcher);

    if (proxyUrl) {
        console.info();
        console.info(color.green(PROXY_LOG_HEADER), 'Proxy URL is used:', color.blue(proxyUrl));
        console.info();
    }
    return dispatcher;
}

/**
 * @param {string} url
 * @returns {string|null}
 */
function usableProxyUrl(url) {
    if (!url) {
        console.error(color.red(PROXY_LOG_HEADER), 'No proxy URL provided');
        return null;
    }
    if (!isValidUrl(url)) {
        console.error(color.red(PROXY_LOG_HEADER), 'Invalid proxy URL provided');
        return null;
    }
    const { protocol } = new URL(url);
    if (!PROXY_PROTOCOLS.includes(protocol)) {
        console.error(color.red(PROXY_LOG_HEADER), `Unsupported proxy protocol ${protocol} - use one of ${PROXY_PROTOCOLS.join(', ')}`);
        return null;
    }
    return url;
}
