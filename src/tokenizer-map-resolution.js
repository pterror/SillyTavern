import { tokenizers, TOKENIZER_TYPE_KEYS } from './tokenizer-ids.js';
import { lookupModelTokenizer } from './tokenizer-model-map.js';

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
 * @param {number|string|null} entry A lookupModelTokenizer() answer.
 * @param {string} api
 * @returns {import('./tokenizer-resolve.js').LocalTokenizer|null}
 */
export function describeMapEntry(entry, api) {
    if (entry === null || entry === undefined) {
        return null;
    }
    if (typeof entry === 'string') {
        return { id: tokenizers.OPENAI, name: entry, model: entry };
    }
    const described = { id: entry, name: TOKENIZER_NAMES[entry] };
    return api === 'openai' ? { ...described, model: TOKENIZER_TYPE_KEYS[entry] } : described;
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
 * @returns {import('./tokenizer-resolve.js').ResolvedTokenizer}
 */
export function resolveChatCompletionTokenizer(model) {
    const local = describeMapEntry(lookupModelTokenizer('openai', String(model ?? '')), 'openai');
    return local ? localResolution(local, local) : estimateResolution('unknown');
}
