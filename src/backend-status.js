import { TEXTGEN_TYPES } from './constants.js';
import { setAdditionalHeadersByType } from './additional-headers.js';
import { trimV1 } from './util.js';
import { logBackendFailure } from './backend-unreachable.js';
import { fetchOutgoing } from './outgoing-fetch.js';

/** @type {Map<string, boolean>} */
const remoteTokenization = new Map();

const UNKNOWN_MODEL_NAMES = new Set(['Valid', 'None', 'no_connection', 'ReadOnly']);

const MIN_TOKENIZATION_KCPPVERSION = '1.41';

/**
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
 * @returns {boolean|undefined}
 */
export function recallRemoteTokenization(api, type, url) {
    return remoteTokenization.get(capabilityKey(api, type, url));
}

export function clearRemoteTokenizationMemory() {
    remoteTokenization.clear();
}

/**
 * @param {string|undefined} version
 * @param {string} minimum
 */
function atLeast(version, minimum) {
    return (version || '0.0.0').localeCompare(minimum, undefined, { numeric: true, sensitivity: 'base' }) > -1;
}

/**
 * What a KoboldAI server's versions say it takes.
 * @param {{ koboldUnitedVersion?: string, koboldCppVersion?: string }} versions
 * @returns {import('./kobold-generation-data.js').KoboldGenerationFlags}
 */
export function koboldFlagsOf({ koboldUnitedVersion, koboldCppVersion }) {
    return {
        can_use_stop_sequence: atLeast(koboldUnitedVersion, '1.2.2'),
        can_use_default_badwordsids: atLeast(koboldUnitedVersion, '1.2.4'),
        can_use_streaming: atLeast(koboldCppVersion, '1.30'),
        can_use_mirostat: atLeast(koboldCppVersion, '1.35'),
        can_use_grammar: atLeast(koboldCppVersion, '1.44'),
        can_use_min_p: atLeast(koboldCppVersion, '1.48'),
    };
}

/** @type {Map<string, import('./kobold-generation-data.js').KoboldGenerationFlags>} */
const koboldFlags = new Map();

/**
 * @param {string} apiServer
 * @param {import('./kobold-generation-data.js').KoboldGenerationFlags} flags
 */
export function rememberKoboldFlags(apiServer, flags) {
    koboldFlags.set(cleanStatusUrl('kobold', apiServer), flags);
}

/**
 * What the KoboldAI server at this address takes: from its last status check, or asked now.
 * @param {string} apiServer
 * @returns {Promise<import('./kobold-generation-data.js').KoboldGenerationFlags>}
 */
export async function koboldFlagsFor(apiServer) {
    const url = cleanStatusUrl('kobold', apiServer);
    const known = koboldFlags.get(url);
    if (known) return known;
    const status = await fetchKoboldStatus(url);
    const flags = koboldFlagsOf(status);
    if (status.model !== 'no_connection') koboldFlags.set(url, flags);
    return flags;
}

/**
 * @param {string|undefined} koboldCppVersion
 * @returns {boolean}
 */
export function koboldCanUseTokenization(koboldCppVersion) {
    return atLeast(koboldCppVersion, MIN_TOKENIZATION_KCPPVERSION);
}

/**
 * @param {string} baseUrl
 * @param {string} apiType
 * @param {{ headers: object }} args
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

    const modelsReply = await fetchOutgoing(url, args);
    const isPossiblyLmStudio = modelsReply.headers.get('x-powered-by') === 'Express';

    if (!modelsReply.ok) {
        console.error('Models endpoint is offline.');
        return { ok: false };
    }

    /** @type {any} */
    let data = await modelsReply.json();

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

    result = modelIds[0] || 'Valid';

    if (apiType === TEXTGEN_TYPES.OOBA && !isPossiblyLmStudio) {
        try {
            const modelInfoUrl = baseUrl + '/v1/internal/model/info';
            const modelInfoReply = await fetchOutgoing(modelInfoUrl, args);

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
            const modelInfoReply = await fetchOutgoing(modelInfoUrl, args);

            if (modelInfoReply.ok) {
                /** @type {any} */
                const modelInfo = await modelInfoReply.json();
                const modelName = modelInfo?.id;
                console.debug('Tabby model info:', { id: modelName });
                result = modelName || result;
            } else {
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
 * @param {any} fallback
 */
function fetchKoboldJson(url, fallback) {
    return fetchOutgoing(url).then(response => {
        if (!response.ok) throw new Error(`Kobold API error: ${response.status, response.statusText}`);
        return response.json();
    }).catch(() => fallback);
}

/**
 * @param {string} apiServer
 * @returns {Promise<string|undefined>}
 */
export async function fetchKoboldCppVersion(apiServer) {
    /** @type {any} */
    const reply = await fetchKoboldJson(`${apiServer}/extra/version`, { version: '0.0' });
    return reply.result;
}

/**
 * @param {string} apiServer
 * @returns {Promise<string>}
 */
export async function fetchKoboldModel(apiServer) {
    /** @type {any} */
    const reply = await fetchKoboldJson(`${apiServer}/v1/model`, null);
    return !reply || reply.result === 'ReadOnly' ? 'no_connection' : reply.result;
}

/**
 * @param {string} apiServer
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
 * @property {string} [type]
 * @property {string} url
 * @property {import('./users.js').UserDirectoryList} [directories]
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
 * @param {BackendRef} backend
 * @returns {Promise<string|null>}
 */
export async function lookupBackendModel(backend) {
    if (!backend.url) return null;
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
        logBackendFailure(backend.url, error, () => console.warn(`Model lookup failed for ${backend.api} ${backend.type ?? ''}: ${error}`));
    }
    return null;
}

/**
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
