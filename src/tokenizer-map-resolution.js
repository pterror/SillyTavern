import { CHAT_COMPLETION_SOURCES, TEXTGEN_TYPES } from './constants.js';
import { tokenizers, TOKENIZER_TYPE_KEYS } from './tokenizer-ids.js';
import { lookupModelTokenizer } from './tokenizer-model-map.js';
import { findTokenizerSource, getTokenizerDisplayName } from './tokenizer-sources.js';

// The parts of resolveTokenizer() (src/tokenizer-resolve.js) that need only the model map, kept
// apart so src/endpoints/tokenizers.js can resolve chat-completion models without importing the
// resolver, which imports it.

/** The `#tokenizer` option labels, plus the client's names for the two API tokenizers. */
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
 * @property {typeof lookupModelTokenizer} [lookupModel] Replaces the model map, for tests
 * @property {readonly import('./tokenizer-sources.js').TokenizerSourceEntry[]} [registry] Replaces TOKENIZER_SOURCES, for tests
 */

/**
 * A registry entry as a local tokenizer: its `tokenizers` value, its id as `source`, and its name.
 * @param {string} source A registry entry id
 * @param {MapDeps['registry']} [registry]
 * @returns {import('./tokenizer-resolve.js').LocalTokenizer|null} null when there is no such entry
 */
function describeRegistryEntry(source, registry) {
    const entry = findTokenizerSource(source, registry);
    const id = Object.keys(TOKENIZER_TYPE_KEYS).find(key => TOKENIZER_TYPE_KEYS[key] === source);
    if (!entry || id === undefined) {
        return null;
    }
    return { id: Number(id), source, name: getTokenizerDisplayName(entry) };
}

/**
 * Textgen types where the model name is the weights the user loaded. `generic` and `huggingface`
 * are not among them: whether one is self-hosted is unknowable from the type.
 */
const SELF_HOSTED_TEXTGEN_TYPES = [
    TEXTGEN_TYPES.OOBA,
    TEXTGEN_TYPES.VLLM,
    TEXTGEN_TYPES.APHRODITE,
    TEXTGEN_TYPES.TABBY,
    TEXTGEN_TYPES.KOBOLDCPP,
    TEXTGEN_TYPES.LLAMACPP,
    TEXTGEN_TYPES.OLLAMA,
];

/** Ollama's cloud models (`deepseek-v4-pro:cloud`, `deepseek-v4-pro:0813-cloud`) run on Ollama's hosted service. */
const OLLAMA_CLOUD_TAG = /:(?:[^:]*-)?cloud$/i;

/**
 * Every chat-completion source, Horde, NovelAI and the hosted textgen types are hosted APIs.
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
 * The map's result for this backend.
 *
 * DeepSeek's own API gets the estimate for every id: its `/models` `name` is a display name that
 * DeepSeek's own pages contradict, so which model an id serves can't be looked up.
 *
 * A model whose vendor's own files disagree gets its file only on the vendor's own API. Every other
 * backend gets none, so its remote tokenizer or the estimate, and no local copy, because the file it
 * uses is unknowable: a server can use either file, and a gguf's vocab is converted from either. The
 * `hf` file would be for a backend whose own docs say it tokenizes with the repo's `tokenizer.json`;
 * no backend here is documented as one.
 *
 * The `other` result applies only on a self-hosted backend, where the name is the weights the user
 * loaded. Every hosted API gets the estimate for it, unless there is a `rest` result, which applies on
 * every backend the other keys give none for.
 * @param {import('./tokenizer-model-map.js').MapResult|null} result
 * @param {{ api: string, type?: string, source?: string, model?: string }} state `model` is the name the result is for
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
 * @param {import('./tokenizer-model-map.js').MapResult|null} entry A lookupModelTokenizer() answer,
 * after selectBackendResult().
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
        // A registry entry has no `model`: `/openai/*` take no name for it, and the chat-completion
        // model name, which the browser sends instead, maps to the same entry.
        return 'source' in entry ? describeRegistryEntry(entry.source, registry) : null;
    }
    const described = { id: entry, name: TOKENIZER_NAMES[entry] };
    return api === 'openai' ? { ...described, model: TOKENIZER_TYPE_KEYS[entry] } : described;
}

/**
 * A `tokenizers` value as the local tokenizer an explicit pick of it names.
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
 * Chat completion's resolution (resolveTokenizer() rule 5): the map on the model, for every
 * source; the tokenizer setting never applies. Unmapped gives the estimate.
 * @param {string|null|undefined} model
 * @param {string} [source] The chat-completion source
 * @param {MapDeps} [deps]
 * @returns {import('./tokenizer-resolve.js').ResolvedTokenizer}
 */
export function resolveChatCompletionTokenizer(model, source = undefined, deps = {}) {
    const { lookupModel = lookupModelTokenizer, registry } = deps;
    const result = selectBackendResult(lookupModel('openai', String(model ?? '')), { api: 'openai', source });
    const local = describeMapEntry(result, 'openai', registry);
    return local ? localResolution(local, local) : estimateResolution('unknown');
}
