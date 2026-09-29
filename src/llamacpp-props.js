import fetch from 'node-fetch';

import { TEXTGEN_TYPES } from './constants.js';
import { setAdditionalHeadersByType } from './additional-headers.js';
import { trimV1 } from './util.js';

/**
 * llama.cpp's `GET /props` (llama.cpp server README, "GET `/props`: Get server global properties"),
 * asked for what stored llama.cpp counts are trusted against (`model_path` and `build_info`, see
 * tokenizerIdentity() in tokenizer-resolve.js) and for the model name the map reads when the model
 * setting is empty. llama.cpp says nothing when its model changes, so a generation asks afresh; a
 * `/api/tokenizers/current/*` request reuses a recent answer for the same backend.
 */

/** How long a `/current/*` request reuses a `/props` answer for the same backend. */
export const PROPS_REUSE_MS = 5000;

/**
 * @typedef {object} LlamaCppPropsBackend
 * @property {string} api `textgenerationwebui`, or `openai` for a chat-completion custom URL.
 * @property {string} type The textgen type, or the chat-completion source.
 * @property {string} url The backend URL.
 * @property {string} model The model setting; non-empty asks with `?model=` (router mode).
 * @property {Record<string, string>} headers The backend's headers.
 */

/** @type {Map<string, { props: object, at: number }>} Recent answers, one per backend. */
const recent = new Map();

/**
 * @param {LlamaCppPropsBackend} backend
 * @returns {string}
 */
function backendKey({ api, type, url, model }) {
    return JSON.stringify([api, type, url, model]);
}

/**
 * Removes the answers too old to reuse, so what is held is bounded by the backends asked within
 * PROPS_REUSE_MS.
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
 * Asks the backend for its `/props`, built as the `/props` route builds it: the URL less a trailing
 * `/v1`, and `?model=` when there is a model setting. Never throws.
 * @param {LlamaCppPropsBackend} backend
 * @returns {Promise<object|null>} The parsed reply; null for a failed request or a reply that isn't a JSON object.
 */
export async function fetchLlamaCppProps(backend) {
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
        console.warn(`llama.cpp /props at ${backend.url} failed: ${error}`);
        return null;
    }
}

/**
 * The `/props` answers one request uses: each backend is asked at most once per check. A
 * generation's check (`reuse: false`) always asks afresh; a `/current/*` request's (`reuse: true`)
 * takes an answer for the same backend given less than PROPS_REUSE_MS ago. Every answer a check gets
 * becomes the one reused.
 * @typedef {object} LlamaCppPropsCheck
 * @property {(backend: LlamaCppPropsBackend) => Promise<object|null>} ask
 * @property {object|null|undefined} props The last answer asked for: undefined before any, null
 * when the request failed.
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
 * A textgen llama.cpp backend, with the headers its other requests get.
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
 * The model name the map reads, from a `/props` reply: a non-empty `model_alias` that differs from
 * `model_path` is a set alias and is the name; otherwise the file name after the last `/` of
 * `model_path`. undefined when the reply carries no `model_alias` field (or there is no reply), so
 * the alias can't be known from it; null when there is no name.
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
