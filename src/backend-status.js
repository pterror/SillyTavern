import fetch from 'node-fetch';

import { TEXTGEN_TYPES } from './constants.js';
import { setAdditionalHeadersByType } from './additional-headers.js';
import { trimV1 } from './util.js';

/**
 * Whether a backend's own tokenizer can be used, per `(api, type, url)`. One entry per backend
 * URL a user has pointed at, never per card.
 * @type {Map<string, boolean>}
 */
const remoteTokenization = new Map();

/** Model names the status lookups answer with when they don't know the model. */
const UNKNOWN_MODEL_NAMES = new Set(['Valid', 'None', 'no_connection', 'ReadOnly']);

const MIN_TOKENIZATION_KCPPVERSION = '1.41';

/**
 * Cleans a backend URL the way that API's `/status` route does before calling it.
 * @param {string} api
 * @param {string} url
 * @returns {string}
 */
export function cleanStatusUrl(api, url) {
    let cleaned = String(url ?? '');
    if (cleaned.indexOf('localhost') !== -1) {
        cleaned = cleaned.replace('localhost', '127.0.0.1');
    }
    return api === 'kobold' ? cleaned : trimV1(cleaned);
}

/**
 * @param {string} api
 * @param {string|undefined} type
 * @param {string} url
 */
function capabilityKey(api, type, url) {
    return JSON.stringify([api, type ?? '', cleanStatusUrl(api, url)]);
}

/**
 * @param {string} api
 * @param {string|undefined} type
 * @param {string} url
 * @param {boolean} supported
 */
export function rememberRemoteTokenization(api, type, url, supported) {
    remoteTokenization.set(capabilityKey(api, type, url), supported);
}

/**
 * @param {string} api
 * @param {string|undefined} type
 * @param {string} url
 * @returns {boolean|undefined} undefined when nothing is remembered yet
 */
export function recallRemoteTokenization(api, type, url) {
    return remoteTokenization.get(capabilityKey(api, type, url));
}

export function clearRemoteTokenizationMemory() {
    remoteTokenization.clear();
}

/**
 * The client's `versionCompare(koboldCppVersion, '1.41')` (public/scripts/utils.js,
 * kai-settings.js). `/status` fills koboldCppVersion from the `result` field of `/extra/version`,
 * which KoboldCpp sets to 'KoboldCpp'; that sorts after any digit, so it passes.
 * @param {string|undefined} koboldCppVersion
 * @returns {boolean}
 */
export function koboldCanUseTokenization(koboldCppVersion) {
    return (koboldCppVersion || '0.0.0').localeCompare(MIN_TOKENIZATION_KCPPVERSION, undefined, { numeric: true, sensitivity: 'base' }) > -1;
}

/**
 * The textgen `/status` lookup: the backend's model list, and for OOBA and Tabby the loaded model.
 * Throws on network errors.
 * @param {string} baseUrl Already cleaned (see cleanStatusUrl).
 * @param {string} apiType One of TEXTGEN_TYPES.
 * @param {{ headers: object }} args Fetch options with the backend's headers.
 * @returns {Promise<{ ok: false } | { ok: true, result: string, data: any[], supportsTokenization: boolean }>}
 */
export async function fetchTextgenStatus(baseUrl, apiType, args) {
    let url = baseUrl;
    let result = '';
    let supportsTokenization = false;

    switch (apiType) {
        case TEXTGEN_TYPES.GENERIC:
        case TEXTGEN_TYPES.OOBA:
        case TEXTGEN_TYPES.VLLM:
        case TEXTGEN_TYPES.APHRODITE:
        case TEXTGEN_TYPES.KOBOLDCPP:
        case TEXTGEN_TYPES.LLAMACPP:
        case TEXTGEN_TYPES.INFERMATICAI:
        case TEXTGEN_TYPES.OPENROUTER:
        case TEXTGEN_TYPES.FEATHERLESS:
            url += '/v1/models';
            break;
        case TEXTGEN_TYPES.DREAMGEN:
            url += '/api/openai/v1/models';
            break;
        case TEXTGEN_TYPES.MANCER:
            url += '/oai/v1/models';
            break;
        case TEXTGEN_TYPES.TABBY:
            url += '/v1/model/list';
            break;
        case TEXTGEN_TYPES.TOGETHERAI:
            url += '/api/models?&info';
            break;
        case TEXTGEN_TYPES.OLLAMA:
            url += '/api/tags';
            break;
        case TEXTGEN_TYPES.HUGGINGFACE:
            url += '/info';
            break;
    }

    const modelsReply = await fetch(url, args);
    const isPossiblyLmStudio = modelsReply.headers.get('x-powered-by') === 'Express';

    if (!modelsReply.ok) {
        console.error('Models endpoint is offline.');
        return { ok: false };
    }

    /** @type {any} */
    let data = await modelsReply.json();

    // Rewrap to OAI-like response
    if (apiType === TEXTGEN_TYPES.TOGETHERAI && Array.isArray(data)) {
        data = { data: data.map(x => ({ id: x.name, ...x })) };
    }

    if (apiType === TEXTGEN_TYPES.OLLAMA && Array.isArray(data.models)) {
        data = { data: data.models.map(x => ({ id: x.name, ...x })) };
    }

    if (apiType === TEXTGEN_TYPES.HUGGINGFACE) {
        data = { data: [] };
    }

    if (!Array.isArray(data.data)) {
        console.error('Models response is not an array.');
        return { ok: false };
    }

    const modelIds = data.data.map(x => x.id);

    // Set result to the first model ID
    result = modelIds[0] || 'Valid';

    if (apiType === TEXTGEN_TYPES.OOBA && !isPossiblyLmStudio) {
        try {
            const modelInfoUrl = baseUrl + '/v1/internal/model/info';
            const modelInfoReply = await fetch(modelInfoUrl, args);

            if (modelInfoReply.ok) {
                /** @type {any} */
                const modelInfo = await modelInfoReply.json();
                const modelName = modelInfo?.model_name;
                console.debug('Ooba model info:', { model_name: modelName });
                result = modelName || result;
                supportsTokenization = true;
            }
        } catch (error) {
            console.error(`Failed to get Ooba model info: ${error}`);
        }
    } else if (apiType === TEXTGEN_TYPES.TABBY) {
        try {
            const modelInfoUrl = baseUrl + '/v1/model';
            const modelInfoReply = await fetch(modelInfoUrl, args);

            if (modelInfoReply.ok) {
                /** @type {any} */
                const modelInfo = await modelInfoReply.json();
                const modelName = modelInfo?.id;
                console.debug('Tabby model info:', { id: modelName });
                result = modelName || result;
            } else {
                // TabbyAPI returns an error 400 if a model isn't loaded

                result = 'None';
            }
        } catch (error) {
            console.error(`Failed to get TabbyAPI model info: ${error}`);
        }
    }

    return { ok: true, result, data: data.data, supportsTokenization };
}

/**
 * @param {string} url
 * @param {any} fallback Answer when the call fails or doesn't give JSON.
 */
function fetchKoboldJson(url, fallback) {
    // We catch errors both from the response not having a successful HTTP status and from JSON parsing failing
    return fetch(url).then(response => {
        if (!response.ok) throw new Error(`Kobold API error: ${response.status, response.statusText}`);
        return response.json();
    }).catch(() => fallback);
}

/**
 * KoboldCpp's version field, as `/status` reports it: the `result` of `/extra/version`.
 * @param {string} apiServer Already cleaned (see cleanStatusUrl).
 * @returns {Promise<string|undefined>}
 */
export async function fetchKoboldCppVersion(apiServer) {
    /** @type {any} */
    const reply = await fetchKoboldJson(`${apiServer}/extra/version`, { version: '0.0' });
    return reply.result;
}

/**
 * @param {string} apiServer Already cleaned (see cleanStatusUrl).
 * @returns {Promise<string>} 'no_connection' when unknown
 */
export async function fetchKoboldModel(apiServer) {
    /** @type {any} */
    const reply = await fetchKoboldJson(`${apiServer}/v1/model`, null);
    return !reply || reply.result === 'ReadOnly' ? 'no_connection' : reply.result;
}

/**
 * The kobold `/status` lookup. Never throws: each failed call gives that call's default.
 * @param {string} apiServer Already cleaned (see cleanStatusUrl).
 * @returns {Promise<{ koboldUnitedVersion: string, koboldCppVersion: string, model: string }>}
 */
export async function fetchKoboldStatus(apiServer) {
    const [koboldUnitedResponse, koboldCppVersion, model] = await Promise.all([
        fetchKoboldJson(`${apiServer}/v1/info/version`, { result: '0.0.0' }),
        fetchKoboldCppVersion(apiServer),
        fetchKoboldModel(apiServer),
    ]);
    return { koboldUnitedVersion: koboldUnitedResponse.result, koboldCppVersion, model };
}

/**
 * @typedef {object} BackendRef
 * @property {string} api
 * @property {string} [type] Textgen type.
 * @property {string} url
 * @property {import('./users.js').UserDirectoryList} [directories] For the backend's API key headers.
 */

/**
 * @param {BackendRef} backend
 */
async function fetchTextgenStatusFor({ type, url, directories }) {
    const baseUrl = cleanStatusUrl('textgenerationwebui', url);
    const args = { headers: { 'Content-Type': 'application/json' } };
    if (directories) {
        setAdditionalHeadersByType(args.headers, type, baseUrl, directories);
    }
    return fetchTextgenStatus(baseUrl, type, args);
}

/**
 * @param {string|undefined} name
 * @returns {string|null}
 */
export function knownModelName(name) {
    return typeof name === 'string' && name !== '' && !UNKNOWN_MODEL_NAMES.has(name) ? name : null;
}

/**
 * The backend's current model, asked with the `/status` lookup. Only textgen and kobold have one.
 * @param {BackendRef} backend
 * @returns {Promise<string|null>} null when unknown, including a failed lookup
 */
export async function lookupBackendModel(backend) {
    try {
        if (backend.api === 'textgenerationwebui') {
            const status = await fetchTextgenStatusFor(backend);
            if (status.ok && backend.type === TEXTGEN_TYPES.OOBA) {
                rememberRemoteTokenization(backend.api, backend.type, backend.url, status.supportsTokenization);
            }
            return status.ok ? knownModelName(status.result) : null;
        }
        if (backend.api === 'kobold') {
            return knownModelName(await fetchKoboldModel(cleanStatusUrl('kobold', backend.url)));
        }
    } catch (error) {
        console.warn(`Model lookup failed for ${backend.api} ${backend.type ?? ''}: ${error}`);
    }
    return null;
}

/**
 * Whether the backend's own tokenizer can be used: remembered from `/status`, or probed with the
 * same lookup on first need. Only OOBA (encode endpoint) and kobold (version gate) depend on the
 * backend; the other textgen tokenizer types always have one.
 * @param {BackendRef} backend
 * @param {readonly string[]} textgenTokenizerTypes
 * @returns {Promise<boolean>}
 */
export async function hasRemoteTokenizer(backend, textgenTokenizerTypes) {
    if (backend.api === 'textgenerationwebui') {
        if (!textgenTokenizerTypes.includes(backend.type)) {
            return false;
        }
        if (backend.type !== TEXTGEN_TYPES.OOBA) {
            return true;
        }
    } else if (backend.api !== 'kobold') {
        return false;
    }

    const type = backend.api === 'kobold' ? undefined : backend.type;
    const remembered = recallRemoteTokenization(backend.api, type, backend.url);
    if (remembered !== undefined) {
        return remembered;
    }
    if (backend.api === 'kobold') {
        const version = await fetchKoboldCppVersion(cleanStatusUrl('kobold', backend.url));
        rememberRemoteTokenization(backend.api, type, backend.url, koboldCanUseTokenization(version));
    } else {
        await lookupBackendModel(backend);
    }
    return recallRemoteTokenization(backend.api, type, backend.url) ?? false;
}
