import { TEXTGEN_TYPES } from './constants.js';
import { setAdditionalHeadersByType } from './additional-headers.js';
import { trimV1 } from './util.js';
import { logBackendFailure } from './backend-unreachable.js';

export const PROPS_REUSE_MS = 5000;

/**
 * @typedef {object} LlamaCppPropsBackend
 * @property {string} api
 * @property {string} type
 * @property {string} url
 * @property {string} model
 * @property {Record<string, string>} headers
 */

/** @type {Map<string, { props: object, at: number }>} */
const recent = new Map();

/**
 * @param {LlamaCppPropsBackend} backend
 * @returns {string}
 */
function backendKey({ api, type, url, model }) {
    return JSON.stringify([api, type, url, model]);
}

/**
 * @param {number} now
 */
function forgetStaleAnswers(now) {
    for (const [key, entry] of recent) {
        if (now - entry.at >= PROPS_REUSE_MS) {
            recent.delete(key);
        }
    }
}

export function clearLlamaCppPropsMemory() {
    recent.clear();
}

/**
 * @param {LlamaCppPropsBackend} backend
 * @returns {Promise<object|null>}
 */
export async function fetchLlamaCppProps(backend) {
    if (!backend.url) return null;
    let url = `${trimV1(backend.url)}/props`;
    if (backend.model) {
        url += `?model=${encodeURIComponent(backend.model)}`;
    }
    try {
        const reply = await fetch(url, { method: 'GET', headers: backend.headers });
        if (!reply.ok) {
            console.warn(`llama.cpp /props at ${backend.url} answered ${reply.status}`);
            return null;
        }
        const props = await reply.json();
        return props && typeof props === 'object' && !Array.isArray(props) ? props : null;
    } catch (error) {
        logBackendFailure(backend.url, error, () => console.warn(`llama.cpp /props at ${backend.url} failed: ${error}`));
        return null;
    }
}

/**
 * @typedef {object} LlamaCppPropsCheck
 * @property {(backend: LlamaCppPropsBackend) => Promise<object|null>} ask
 * @property {object|null|undefined} props
 */

/**
 * @param {{ reuse: boolean }} options
 * @returns {LlamaCppPropsCheck}
 */
export function createLlamaCppPropsCheck({ reuse }) {
    /** @type {Map<string, Promise<object|null>>} */
    const asked = new Map();
    /** @type {LlamaCppPropsCheck} */
    const check = {
        props: undefined,
        ask(backend) {
            const key = backendKey(backend);
            if (!asked.has(key)) {
                asked.set(key, askProps(backend, key, reuse));
            }
            return asked.get(key).then(props => {
                check.props = props;
                return props;
            });
        },
    };
    return check;
}

/**
 * @param {LlamaCppPropsBackend} backend
 * @param {string} key
 * @param {boolean} reuse
 * @returns {Promise<object|null>}
 */
async function askProps(backend, key, reuse) {
    forgetStaleAnswers(Date.now());
    const held = recent.get(key);
    if (reuse && held) {
        return held.props;
    }
    const props = await fetchLlamaCppProps(backend);
    if (props) {
        recent.delete(key);
        recent.set(key, { props, at: Date.now() });
    }
    return props;
}

/**
 * @param {string} url
 * @param {string} model
 * @param {import('./users.js').UserDirectoryList|undefined} directories
 * @returns {LlamaCppPropsBackend}
 */
export function textgenLlamaCppBackend(url, model, directories) {
    const headers = {};
    if (directories) {
        setAdditionalHeadersByType(headers, TEXTGEN_TYPES.LLAMACPP, trimV1(url), directories);
    }
    return { api: 'textgenerationwebui', type: TEXTGEN_TYPES.LLAMACPP, url, model, headers };
}

/**
 * @param {any} props
 * @returns {string|null|undefined}
 */
export function llamaCppPropsModelName(props) {
    if (!props || typeof props !== 'object' || !('model_alias' in props)) {
        return undefined;
    }
    const alias = props.model_alias;
    const modelPath = typeof props.model_path === 'string' ? props.model_path : '';
    if (typeof alias === 'string' && alias !== '' && alias !== modelPath) {
        return alias;
    }
    const fileName = modelPath.slice(modelPath.lastIndexOf('/') + 1);
    return fileName || null;
}
