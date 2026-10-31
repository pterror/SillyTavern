import { CHAT_COMPLETION_SOURCES, TEXTGEN_TYPES } from './constants.js';
import { tokenizers, TOKENIZER_TYPE_KEYS } from './tokenizer-ids.js';
import { lookupModelTokenizer } from './tokenizer-model-map.js';
import { findEntriesByRepo, findTokenizerSource, getTokenizerDisplayName } from './tokenizer-sources.js';
import { lookupOpenRouterHuggingFaceId } from './openrouter-models.js';
import { lookupCustomLlamaCppModel, resolveCustomLlamaCppEndpoint } from './custom-llamacpp.js';
import { llamaCppPropsModelName } from './llamacpp-props.js';

export const TOKENIZER_NAMES = {
    [tokenizers.NONE]: 'None / Estimated',
    [tokenizers.GPT2]: 'GPT-2',
    [tokenizers.LLAMA]: 'Llama 1/2',
    [tokenizers.LLAMA3]: 'Llama 3',
    [tokenizers.GEMMA]: 'Gemma / Gemini',
    [tokenizers.JAMBA]: 'Jamba',
    [tokenizers.QWEN2]: 'Qwen2',
    [tokenizers.COMMAND_R]: 'Command-R',
    [tokenizers.COMMAND_A]: 'Command-A',
    [tokenizers.NERD]: 'NerdStash (NovelAI Clio)',
    [tokenizers.NERD2]: 'NerdStash v2 (NovelAI Kayra)',
    [tokenizers.MISTRAL]: 'Mistral V1',
    [tokenizers.NEMO]: 'Mistral Nemo',
    [tokenizers.YI]: 'Yi',
    [tokenizers.CLAUDE]: 'Claude 1/2',
    [tokenizers.DEEPSEEK]: 'DeepSeek V3',
    [tokenizers.API_TEXTGENERATIONWEBUI]: 'API (Text Completion)',
    [tokenizers.API_KOBOLD]: 'API (KoboldAI Classic)',
};

/**
 * @typedef {object} MapDeps
 * @property {typeof lookupModelTokenizer} [lookupModel]
 * @property {readonly import('./tokenizer-sources.js').TokenizerSourceEntry[]} [registry]
 * @property {() => Promise<any[]|null>} [fetchOpenRouterModels]
 */

/**
 * @param {string} source
 * @param {MapDeps['registry']} [registry]
 * @returns {import('./tokenizer-resolve.js').LocalTokenizer|null}
 */
function describeRegistryEntry(source, registry) {
    const entry = findTokenizerSource(source, registry);
    const id = Object.keys(TOKENIZER_TYPE_KEYS).find(key => TOKENIZER_TYPE_KEYS[key] === source);
    if (!entry || id === undefined) {
        return null;
    }
    return { id: Number(id), source, name: getTokenizerDisplayName(entry) };
}

const SELF_HOSTED_TEXTGEN_TYPES = [
    TEXTGEN_TYPES.OOBA,
    TEXTGEN_TYPES.VLLM,
    TEXTGEN_TYPES.APHRODITE,
    TEXTGEN_TYPES.TABBY,
    TEXTGEN_TYPES.KOBOLDCPP,
    TEXTGEN_TYPES.LLAMACPP,
    TEXTGEN_TYPES.OLLAMA,
];

const OLLAMA_CLOUD_TAG = /:(?:[^:]*-)?cloud$/i;

/**
 * @param {{ api: string, type?: string, model?: string }} state
 * @returns {boolean}
 */
function isSelfHostedBackend(state) {
    if (state.api === 'kobold') {
        return true;
    }
    if (state.api !== 'textgenerationwebui' || !SELF_HOSTED_TEXTGEN_TYPES.includes(state.type)) {
        return false;
    }
    return !(state.type === TEXTGEN_TYPES.OLLAMA && OLLAMA_CLOUD_TAG.test(String(state.model ?? '')));
}

/**
 * @param {import('./tokenizer-model-map.js').MapResult|null} result
 * @param {{ api: string, type?: string, source?: string, model?: string }} state
 * @returns {import('./tokenizer-model-map.js').MapResult|null}
 */
export function selectBackendResult(result, state) {
    if (state.api === 'openai' && state.source === CHAT_COMPLETION_SOURCES.DEEPSEEK) {
        return null;
    }
    if (result === null || typeof result !== 'object' || !('byBackend' in result)) {
        return result;
    }
    const vendorApis = result.byBackend.vendorApis ?? {};
    if (state.api === 'openai' && state.source && Object.hasOwn(vendorApis, state.source)) {
        return vendorApis[state.source];
    }
    if (result.byBackend.other !== undefined && isSelfHostedBackend(state)) {
        return result.byBackend.other;
    }
    return result.byBackend.rest ?? null;
}

/**
 * @param {{ api: string, type?: string, source?: string }} state
 * @returns {boolean}
 */
function isOpenRouter(state) {
    return (state.api === 'openai' && state.source === CHAT_COMPLETION_SOURCES.OPENROUTER)
        || (state.api === 'textgenerationwebui' && state.type === TEXTGEN_TYPES.OPENROUTER);
}

/**
 * @param {string} api
 * @param {string} model
 * @param {{ api: string, type?: string, source?: string, model?: string }} state
 * @param {MapDeps} [deps]
 * @returns {Promise<import('./tokenizer-model-map.js').MapResult|null>}
 */
export async function selectModelResult(api, model, state, deps = {}) {
    const { lookupModel = lookupModelTokenizer, registry, fetchOpenRouterModels } = deps;
    const backendState = { ...state, model };
    if (isOpenRouter(state) && model) {
        const listed = await lookupOpenRouterHuggingFaceId(model, fetchOpenRouterModels ? { fetchModels: fetchOpenRouterModels } : {});
        if (!listed.ok) {
            return null;
        }
        const entries = listed.huggingFaceId ? findEntriesByRepo(listed.huggingFaceId, registry) : [];
        if (entries.length === 1 && !entries[0].severalOfficialFiles) {
            return { source: entries[0].id };
        }
        if (entries.length > 0) {
            const repoResult = lookupModel(api, /** @type {string} */ (listed.huggingFaceId));
            const isPerBackend = repoResult !== null && typeof repoResult === 'object' && 'byBackend' in repoResult;
            return isPerBackend ? selectBackendResult(repoResult, backendState) : null;
        }
    }
    return selectBackendResult(lookupModel(api, model), backendState);
}

/**
 * @param {import('./tokenizer-model-map.js').MapResult|null} entry
 * @param {string} api
 * @param {MapDeps['registry']} [registry]
 * @returns {import('./tokenizer-resolve.js').LocalTokenizer|null}
 */
export function describeMapEntry(entry, api, registry = undefined) {
    if (entry === null || entry === undefined) {
        return null;
    }
    if (typeof entry === 'string') {
        return { id: tokenizers.OPENAI, name: entry, model: entry };
    }
    if (typeof entry === 'object') {
        return 'source' in entry ? describeRegistryEntry(entry.source, registry) : null;
    }
    const described = { id: entry, name: TOKENIZER_NAMES[entry] };
    return api === 'openai' ? { ...described, model: TOKENIZER_TYPE_KEYS[entry] } : described;
}

/**
 * @param {number} id
 * @param {MapDeps['registry']} [registry]
 * @returns {import('./tokenizer-resolve.js').LocalTokenizer}
 */
export function describeTokenizerId(id, registry = undefined) {
    return describeRegistryEntry(TOKENIZER_TYPE_KEYS[id], registry) ?? { id, name: TOKENIZER_NAMES[id] };
}

/**
 * @param {import('./tokenizer-resolve.js').LocalTokenizer} local
 * @param {import('./tokenizer-resolve.js').LocalTokenizer|null} localCopy
 * @returns {import('./tokenizer-resolve.js').ResolvedTokenizer}
 */
export function localResolution(local, localCopy) {
    return { kind: 'local', ...local, basis: 'local', localCopy };
}

/**
 * @param {'unknown'|'none'} basis
 * @returns {import('./tokenizer-resolve.js').ResolvedTokenizer}
 */
export function estimateResolution(basis) {
    return { kind: 'estimate', id: tokenizers.NONE, name: TOKENIZER_NAMES[tokenizers.NONE], basis, localCopy: null };
}

/**
 * @typedef {object} ChatCompletionConnection
 * @property {string} [url]
 * @property {import('./users.js').UserDirectoryList} [directories]
 * @property {string} [customIncludeHeaders]
 * @property {import('./llamacpp-props.js').LlamaCppPropsCheck} [llamaCppProps]
 * @property {import('./token-count-store.js').StoredEncoder} [storedEncoder]
 */

/**
 * @param {string|null|undefined} model
 * @param {string} [source]
 * @param {MapDeps & ChatCompletionConnection} [deps]
 * @returns {Promise<import('./tokenizer-resolve.js').ResolvedTokenizer>}
 */
export async function resolveChatCompletionTokenizer(model, source = undefined, deps = {}) {
    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        const endpoint = await resolveCustomLlamaCppEndpoint(deps.url, deps.directories, deps.customIncludeHeaders);
        if (endpoint) {
            return customLlamaCppResolution(endpoint, String(model ?? ''), deps);
        }
    }
    const result = await selectModelResult('openai', String(model ?? ''), { api: 'openai', source }, deps);
    const local = describeMapEntry(result, 'openai', deps.registry);
    return local ? localResolution(local, local) : estimateResolution('unknown');
}

/**
 * @param {import('./custom-llamacpp.js').CustomLlamaCppEndpoint} endpoint
 * @param {string} model
 * @param {MapDeps & ChatCompletionConnection} deps
 * @returns {Promise<import('./tokenizer-resolve.js').ResolvedTokenizer>}
 */
async function customLlamaCppResolution(endpoint, model, deps) {
    const state = { api: 'textgenerationwebui', type: TEXTGEN_TYPES.LLAMACPP };
    const props = deps.llamaCppProps
        ? await deps.llamaCppProps.ask({ api: 'openai', type: CHAT_COMPLETION_SOURCES.CUSTOM, url: endpoint.url, model, headers: endpoint.headers })
        : undefined;
    const propsName = model ? undefined : llamaCppPropsModelName(props);
    const name = model || (propsName !== undefined ? propsName : await lookupCustomLlamaCppModel(endpoint));
    const local = describeMapEntry(await selectModelResult(state.api, name, state, deps), state.api, deps.registry);
    const resolved = {
        kind: /** @type {const} */ ('remote'),
        id: tokenizers.API_TEXTGENERATIONWEBUI,
        name: TOKENIZER_NAMES[tokenizers.API_TEXTGENERATIONWEBUI],
        basis: /** @type {const} */ ('remote'),
        localCopy: local,
    };
    Object.defineProperty(resolved, 'llamaCpp', { value: { ...endpoint, model }, enumerable: false });
    return resolved;
}
