import { TEXTGEN_TYPES } from './constants.js';
import { mergeObjectWithYaml, trimV1 } from './util.js';
import { readUserSettings } from './settings-reads.js';
import { readSecret, SECRET_KEYS } from './endpoints/secrets.js';
import { fetchTextgenStatus, knownModelName } from './backend-status.js';
import { logBackendFailure } from './backend-unreachable.js';

export const MAX_REMEMBERED_LLAMACPP_URLS = 100;

/** @type {Map<string, boolean>} */
const detected = new Map();

/**
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
 * @returns {boolean|undefined}
 */
export function recallLlamaCppDetection(url) {
    return detected.get(trimV1(url));
}

export function clearLlamaCppDetectionMemory() {
    detected.clear();
}

/**
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
 * @param {import('./users.js').UserDirectoryList|undefined} directories
 * @param {string} includeHeaders
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
 * @property {string} url
 * @property {Record<string, string>} headers
 */

/**
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
            ? readUserSettings(directories, ['oai_settings.custom_include_headers'])['oai_settings.custom_include_headers']
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
 * @param {CustomLlamaCppEndpoint} endpoint
 * @returns {Promise<string|null>}
 */
export async function lookupCustomLlamaCppModel(endpoint) {
    try {
        const status = await fetchTextgenStatus(trimV1(endpoint.url), TEXTGEN_TYPES.LLAMACPP, { headers: { 'Content-Type': 'application/json', ...endpoint.headers } });
        return status.ok ? knownModelName(status.result) : null;
    } catch (error) {
        logBackendFailure(endpoint.url, error, () => console.warn(`Model lookup failed for the custom llama.cpp URL: ${error}`));
        return null;
    }
}
