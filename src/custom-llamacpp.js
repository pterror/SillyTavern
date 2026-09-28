import fetch from 'node-fetch';

import { TEXTGEN_TYPES } from './constants.js';
import { mergeObjectWithYaml, trimV1 } from './util.js';
import { readSettingsAtPaths } from './settings-store.js';
import { readSecret, SECRET_KEYS } from './endpoints/secrets.js';
import { fetchTextgenStatus, knownModelName } from './backend-status.js';

/**
 * Whether a chat-completion custom URL is llama.cpp, so its counts go through llama.cpp's own
 * `/tokenize`. Detected with `GET <url minus a trailing /v1>/props`, built as the `/props` route
 * builds it (trimV1), and remembered per URL.
 */

/** At most this many URLs are remembered; the oldest is forgotten first. */
export const MAX_REMEMBERED_LLAMACPP_URLS = 100;

/** @type {Map<string, boolean>} Keyed by the URL with a trailing `/` and `/v1` removed. */
const detected = new Map();

/**
 * llama.cpp's own `GET /props` reply shape (llama.cpp server README, "GET `/props`: Get server global
 * properties"): a `default_generation_settings` object, a numeric `total_slots` and a string `build_info`.
 * @param {unknown} data
 * @returns {boolean}
 */
export function isLlamaCppProps(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return false;
    }
    const props = /** @type {Record<string, unknown>} */ (data);
    const settings = props.default_generation_settings;
    return !!settings && typeof settings === 'object' && !Array.isArray(settings)
        && typeof props.total_slots === 'number'
        && typeof props.build_info === 'string';
}

/**
 * Asks `url` for its `/props`. Any failure (HTTP or network error, a reply that isn't JSON or has
 * another shape) means it is not llama.cpp. Never throws.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<boolean>}
 */
export async function probeLlamaCpp(url, headers) {
    try {
        const reply = await fetch(`${trimV1(url)}/props`, { method: 'GET', headers });
        if (!reply.ok) {
            return false;
        }
        return isLlamaCppProps(await reply.json());
    } catch (error) {
        console.debug(`llama.cpp detection at ${url} failed: ${error}`);
        return false;
    }
}

/**
 * @param {string} url
 * @param {boolean} isLlamaCpp
 */
export function rememberLlamaCppDetection(url, isLlamaCpp) {
    const key = trimV1(url);
    detected.delete(key);
    detected.set(key, isLlamaCpp);
    while (detected.size > MAX_REMEMBERED_LLAMACPP_URLS) {
        detected.delete(detected.keys().next().value);
    }
}

/**
 * @param {string} url
 * @returns {boolean|undefined} undefined when nothing is remembered for it
 */
export function recallLlamaCppDetection(url) {
    return detected.get(trimV1(url));
}

export function clearLlamaCppDetectionMemory() {
    detected.clear();
}

/**
 * Probes `url` and remembers the answer, replacing what was remembered.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<boolean>}
 */
export async function refreshLlamaCppDetection(url, headers) {
    const isLlamaCpp = await probeLlamaCpp(url, headers);
    rememberLlamaCppDetection(url, isLlamaCpp);
    return isLlamaCpp;
}

/**
 * The headers a chat-completion custom send gives its URL: `Authorization: Bearer <the active custom
 * key>`, then the custom headers over it. Must stay what the send gives, because the textgen llama.cpp
 * key must never reach a custom URL.
 * @param {import('./users.js').UserDirectoryList|undefined} directories
 * @param {string} includeHeaders The custom headers as YAML, macros already substituted.
 * @returns {Record<string, string>}
 */
export function customEndpointHeaders(directories, includeHeaders) {
    const apiKey = directories ? readSecret(directories, SECRET_KEYS.CUSTOM) : '';
    const headers = {};
    mergeObjectWithYaml(headers, includeHeaders);
    return { 'Authorization': 'Bearer ' + apiKey, ...headers };
}

/**
 * @typedef {object} CustomLlamaCppEndpoint
 * @property {string} url The custom URL
 * @property {Record<string, string>} headers What the send gives that URL
 */

/**
 * The chat-completion custom URL as a llama.cpp backend, or null when it isn't one. The custom
 * headers are `includeHeaders` when the caller has them with its own macros substituted (a
 * server-built send); otherwise they are the saved ones, and when those hold a macro (`{{`) what the
 * send gives the URL can't be known here, so nothing is asked and the URL is not treated as llama.cpp.
 * @param {string|undefined} url
 * @param {import('./users.js').UserDirectoryList|undefined} directories
 * @param {string} [includeHeaders]
 * @returns {Promise<CustomLlamaCppEndpoint|null>}
 */
export async function resolveCustomLlamaCppEndpoint(url, directories, includeHeaders = undefined) {
    if (typeof url !== 'string' || !url) {
        return null;
    }
    let headerText = includeHeaders;
    if (headerText === undefined) {
        const saved = directories
            ? readSettingsAtPaths(directories, ['oai_settings.custom_include_headers'])['oai_settings.custom_include_headers']
            : undefined;
        headerText = typeof saved === 'string' ? saved : '';
        if (headerText.includes('{{')) {
            return null;
        }
    }
    const headers = customEndpointHeaders(directories, headerText);
    const remembered = recallLlamaCppDetection(url);
    const isLlamaCpp = remembered ?? await refreshLlamaCppDetection(url, headers);
    return isLlamaCpp ? { url, headers } : null;
}

/**
 * The model a llama.cpp custom URL lists first in `/v1/models`, as textgen llama.cpp's `/status` lookup
 * reads it; null when unknown or the lookup fails.
 * @param {CustomLlamaCppEndpoint} endpoint
 * @returns {Promise<string|null>}
 */
export async function lookupCustomLlamaCppModel(endpoint) {
    try {
        const status = await fetchTextgenStatus(trimV1(endpoint.url), TEXTGEN_TYPES.LLAMACPP, { headers: { 'Content-Type': 'application/json', ...endpoint.headers } });
        return status.ok ? knownModelName(status.result) : null;
    } catch (error) {
        console.warn(`Model lookup failed for the custom llama.cpp URL: ${error}`);
        return null;
    }
}
