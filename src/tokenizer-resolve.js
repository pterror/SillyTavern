import { TEXTGEN_TYPES } from './constants.js';
import { encodeTextByLocalTokenizerType, encodeViaTextgenAPI } from './endpoints/tokenizers.js';

/**
 * Server-side port of the tokenizer TYPE resolution logic in public/scripts/tokenizers.js
 * (the `tokenizers` enum, `getTokenizerBestMatch()`), public/scripts/textgen-models.js
 * (`getCurrentOpenRouterModelTokenizer()`/`getCurrentDreamGenModelTokenizer()`), and
 * public/scripts/textgen-settings.js (`getTokenizerForTokenIds()`).
 *
 * This module is deliberately separate from src/token-bans-and-bias.js and
 * src/textgen-generation-data.js, which both take an already-resolved `encode` function as a
 * plain injected parameter and explicitly leave "which tokenizer" out of scope. This module is
 * that missing piece - it decides WHICH tokenizer to use, then (via encodeWithTokenizerType)
 * turns that decision into working token ids, trying a remote/API tokenizer first where
 * applicable and falling back to a local one on failure.
 *
 * Porting decision (documented once, applies throughout): the client gates remote-tokenizer
 * attempts on two sessionStorage flags (TOKENIZER_WARNING_KEY / TOKENIZER_SUPPORTED_KEY) that
 * exist purely to avoid retrying a remote endpoint that already failed once in this browser
 * session - a client-side performance optimization, not a behavioral requirement. The server has
 * no equivalent concept of "this session already saw a failure", and doesn't need one: it can
 * just always attempt the remote call and fall back on error, the same way
 * encodeViaTextgenAPI/encodeTextByLocalTokenizerType already do internally. So neither
 * resolveTokenizerType() nor encodeWithTokenizerType() implement any sessionStorage-equivalent
 * gating - that's an intentional omission, not a gap.
 */

/** Mirrors public/scripts/tokenizers.js's `tokenizers` enum exactly. */
export const tokenizers = {
    NONE: 0,
    GPT2: 1,
    OPENAI: 2,
    LLAMA: 3,
    NERD: 4,
    NERD2: 5,
    API_CURRENT: 6,
    MISTRAL: 7,
    YI: 8,
    API_TEXTGENERATIONWEBUI: 9,
    API_KOBOLD: 10,
    CLAUDE: 11,
    LLAMA3: 12,
    GEMMA: 13,
    JAMBA: 14,
    QWEN2: 15,
    COMMAND_R: 16,
    NEMO: 17,
    DEEPSEEK: 18,
    COMMAND_A: 19,
    BEST_MATCH: 99,
};

/**
 * Mirrors public/scripts/tokenizers.js's ENCODE_TOKENIZERS: local tokenizers that support
 * encoding/decoding token ids. NERD/NERD2 are deliberately excluded, per the client's own
 * comment, because no weights have been released for them yet.
 */
export const ENCODE_TOKENIZERS = [
    tokenizers.LLAMA,
    tokenizers.MISTRAL,
    tokenizers.YI,
    tokenizers.LLAMA3,
    tokenizers.GEMMA,
    tokenizers.JAMBA,
    tokenizers.QWEN2,
    tokenizers.COMMAND_R,
    tokenizers.COMMAND_A,
    tokenizers.NEMO,
    tokenizers.DEEPSEEK,
];

/**
 * Mirrors public/scripts/tokenizers.js's TEXTGEN_TOKENIZERS (populated at runtime there via
 * initTokenizers() due to circular imports; here it's just a static list since there's no such
 * circularity server-side).
 */
export const TEXTGEN_TOKENIZERS = [
    TEXTGEN_TYPES.OOBA,
    TEXTGEN_TYPES.TABBY,
    TEXTGEN_TYPES.KOBOLDCPP,
    TEXTGEN_TYPES.LLAMACPP,
    TEXTGEN_TYPES.VLLM,
    TEXTGEN_TYPES.APHRODITE,
];

/**
 * Numeric tokenizer enum -> string key used by encodeTextByLocalTokenizerType() and the
 * '/api/tokenizers/<key>/encode' routes. Derived from the string segment of each entry's `encode`
 * URL in public/scripts/tokenizers.js's TOKENIZER_URLS. Only covers tokenizer types that have a
 * local encoder (i.e. every ENCODE_TOKENIZERS entry, plus CLAUDE and GPT2, both of which also have
 * real local encoders even though they're not in ENCODE_TOKENIZERS - that list is about the UI's
 * encode/decode playground, not about what's locally encodable).
 */
export const TOKENIZER_TYPE_KEYS = {
    [tokenizers.GPT2]: 'gpt2',
    [tokenizers.LLAMA]: 'llama',
    [tokenizers.MISTRAL]: 'mistral',
    [tokenizers.YI]: 'yi',
    [tokenizers.CLAUDE]: 'claude',
    [tokenizers.LLAMA3]: 'llama3',
    [tokenizers.GEMMA]: 'gemma',
    [tokenizers.JAMBA]: 'jamba',
    [tokenizers.QWEN2]: 'qwen2',
    [tokenizers.COMMAND_R]: 'command-r',
    [tokenizers.COMMAND_A]: 'command-a',
    [tokenizers.NEMO]: 'nemo',
    [tokenizers.DEEPSEEK]: 'deepseek',
};

/**
 * Mirrors public/scripts/textgen-models.js's getCurrentOpenRouterModelTokenizer(), but as a pure
 * function of the current OpenRouter model id and the OpenRouter models list, instead of reading
 * textgen_settings.openrouter_model / the module-level openRouterModels array directly.
 * @param {string} [modelId] textgen_settings.openrouter_model equivalent.
 * @param {Array<{id: string, architecture?: {tokenizer?: string}}>} [models] openRouterModels equivalent.
 * @returns {number} A `tokenizers` value.
 */
export function getCurrentOpenRouterModelTokenizer(modelId, models = []) {
    const model = models.find(x => x.id === modelId);
    if (modelId?.includes('jamba')) {
        return tokenizers.JAMBA;
    }
    switch (model?.architecture?.tokenizer) {
        case 'Llama2':
            return tokenizers.LLAMA;
        case 'Llama3':
            return tokenizers.LLAMA3;
        case 'Yi':
            return tokenizers.YI;
        case 'Mistral':
            return tokenizers.MISTRAL;
        case 'Gemini':
            return tokenizers.GEMMA;
        case 'Claude':
            return tokenizers.CLAUDE;
        case 'Cohere':
            return tokenizers.COMMAND_R;
        case 'Qwen':
            return tokenizers.QWEN2;
        default:
            return tokenizers.OPENAI;
    }
}

/**
 * Mirrors public/scripts/textgen-models.js's getCurrentDreamGenModelTokenizer(), as a pure
 * function of the current DreamGen model id and the DreamGen models list.
 *
 * Deviation: the client version does `model.id.startsWith(...)` unconditionally, which throws if
 * `model` isn't found in the list. Here that's guarded with optional chaining (falling through to
 * the MISTRAL default) instead of throwing, since a resolver function throwing on a stale/unknown
 * model id is worse than just returning its already-existing default.
 * @param {string} [modelId] textgen_settings.dreamgen_model equivalent.
 * @param {Array<{id: string}>} [models] dreamGenModels equivalent.
 * @returns {number} A `tokenizers` value.
 */
export function getCurrentDreamGenModelTokenizer(modelId, models = []) {
    const model = models.find(x => x.id === modelId);
    if (model?.id?.startsWith('lucid-v1-medium') || model?.id?.startsWith('lucid-v1-base')) {
        return tokenizers.MISTRAL;
    } else if (model?.id?.startsWith('lucid-v1-extra-large') || model?.id?.startsWith('lucid-v1-max')) {
        return tokenizers.LLAMA3;
    } else {
        return tokenizers.MISTRAL;
    }
}

/**
 * @typedef {object} TokenizerResolveDeps
 * @property {string} [naiModel] nai_settings.model_novel equivalent (only used when forApi === 'novel').
 * @property {string} [textgenType] textgenerationwebui_settings.type equivalent (one of TEXTGEN_TYPES).
 * @property {boolean} [isConnected] online_status !== 'no_connection' equivalent. Defaults to true -
 * server-side callers building a request generally already know they have a live backend to call.
 * @property {boolean} [canUseTokenization] kai_flags.can_use_tokenization equivalent (kobold only).
 * @property {string} [textgenModel] getTextGenModel() equivalent - the current textgen model name,
 * used for substring matching when no remote/API tokenizer is available.
 * @property {string} [openRouterModel] textgen_settings.openrouter_model equivalent.
 * @property {Array<{id: string, architecture?: {tokenizer?: string}}>} [openRouterModels]
 * @property {string} [dreamGenModel] textgen_settings.dreamgen_model equivalent.
 * @property {Array<{id: string}>} [dreamGenModels]
 */

/**
 * Mirrors public/scripts/tokenizers.js's getTokenizerBestMatch(forApi), minus the
 * sessionStorage-based remote-tokenizer gating (see module doc comment for why that's omitted).
 * @param {string} forApi API to get the tokenizer for ('novel', 'kobold', 'textgenerationwebui',
 * 'koboldhorde', or anything else - which resolves to tokenizers.NONE, same as the client).
 * @param {TokenizerResolveDeps} [deps]
 * @returns {number} A `tokenizers` value.
 */
export function getTokenizerBestMatch(forApi, deps = {}) {
    const {
        naiModel,
        textgenType,
        isConnected = true,
        canUseTokenization = false,
        textgenModel,
        openRouterModel,
        openRouterModels,
        dreamGenModel,
        dreamGenModels,
    } = deps;

    if (forApi === 'novel') {
        if (naiModel?.includes('clio')) {
            return tokenizers.NERD;
        }
        if (naiModel?.includes('kayra')) {
            return tokenizers.NERD2;
        }
        if (naiModel?.includes('erato')) {
            return tokenizers.LLAMA3;
        }
    }

    if (forApi === 'kobold' || forApi === 'textgenerationwebui' || forApi === 'koboldhorde') {
        const isTokenizerSupported = TEXTGEN_TOKENIZERS.includes(textgenType);

        if (isConnected) {
            if (forApi === 'kobold' && canUseTokenization) {
                return tokenizers.API_KOBOLD;
            }

            if (forApi === 'textgenerationwebui' && isTokenizerSupported) {
                return tokenizers.API_TEXTGENERATIONWEBUI;
            }
            if (forApi === 'textgenerationwebui' && textgenType === TEXTGEN_TYPES.OPENROUTER) {
                return getCurrentOpenRouterModelTokenizer(openRouterModel, openRouterModels);
            }
            if (forApi === 'textgenerationwebui' && textgenType === TEXTGEN_TYPES.DREAMGEN) {
                return getCurrentDreamGenModelTokenizer(dreamGenModel, dreamGenModels);
            }
        }

        if (forApi === 'textgenerationwebui') {
            const model = String(textgenModel ?? '').toLowerCase();
            if (model.includes('llama3') || model.includes('llama-3')) {
                return tokenizers.LLAMA3;
            }
            if (model.includes('mistral') || model.includes('mixtral')) {
                return tokenizers.MISTRAL;
            }
            if (model.includes('gemma')) {
                return tokenizers.GEMMA;
            }
            if (model.includes('nemo') || model.includes('pixtral')) {
                return tokenizers.NEMO;
            }
            if (model.includes('deepseek')) {
                return tokenizers.DEEPSEEK;
            }
            if (model.includes('yi')) {
                return tokenizers.YI;
            }
            if (model.includes('jamba')) {
                return tokenizers.JAMBA;
            }
            if (model.includes('command-r')) {
                return tokenizers.COMMAND_R;
            }
            if (model.includes('command-a')) {
                return tokenizers.COMMAND_A;
            }
            if (model.includes('qwen2')) {
                return tokenizers.QWEN2;
            }
        }

        return tokenizers.LLAMA;
    }

    return tokenizers.NONE;
}

/**
 * @typedef {TokenizerResolveDeps & {
 *   forApi?: string,
 *   userTokenizerSetting?: number,
 * }} ResolveTokenizerTypeParams
 */

/**
 * Mirrors public/scripts/textgen-settings.js's getTokenizerForTokenIds() - the actual entry point
 * used by getCustomTokenBans()/calculateLogitBias() (ported in src/token-bans-and-bias.js) to pick
 * a tokenizer. That client function always calls getTokenizerBestMatch('textgenerationwebui'), so
 * `forApi` here defaults to 'textgenerationwebui' to match; passing a different `forApi` just
 * delegates straight to getTokenizerBestMatch() (useful for API-general resolution, e.g. the
 * 'novel' NAI-model branch, which getTokenizerForTokenIds() itself never reaches).
 * @param {ResolveTokenizerTypeParams} [params]
 * @returns {number} A `tokenizers` value.
 */
export function resolveTokenizerType(params = {}) {
    const { forApi = 'textgenerationwebui', userTokenizerSetting, ...deps } = params;

    if (forApi !== 'textgenerationwebui') {
        return getTokenizerBestMatch(forApi, deps);
    }

    const bestMatchTokenizer = getTokenizerBestMatch('textgenerationwebui', deps);
    if (bestMatchTokenizer === tokenizers.API_TEXTGENERATIONWEBUI) {
        return tokenizers.API_CURRENT;
    }

    if (userTokenizerSetting === tokenizers.API_CURRENT && TEXTGEN_TOKENIZERS.includes(deps.textgenType)) {
        return tokenizers.API_CURRENT;
    }

    if (ENCODE_TOKENIZERS.includes(userTokenizerSetting)) {
        return userTokenizerSetting;
    }

    if (deps.textgenType === TEXTGEN_TYPES.OPENROUTER) {
        return getCurrentOpenRouterModelTokenizer(deps.openRouterModel, deps.openRouterModels);
    }

    if (deps.textgenType === TEXTGEN_TYPES.DREAMGEN) {
        return getCurrentDreamGenModelTokenizer(deps.dreamGenModel, deps.dreamGenModels);
    }

    return tokenizers.LLAMA;
}

/**
 * @typedef {object} EncodeWithTokenizerTypeOptions
 * @property {import('express').Request} [request] Original request, forwarded to
 * encodeViaTextgenAPI() for header forwarding (only needed for API_TEXTGENERATIONWEBUI/API_CURRENT).
 * @property {string} [textgenBaseUrl] Textgen backend base URL (API_TEXTGENERATIONWEBUI/API_CURRENT).
 * @property {string} [textgenModel] Textgen backend model name (API_TEXTGENERATIONWEBUI/API_CURRENT).
 * @property {string} [textgenApiType] One of TEXTGEN_TYPES (API_TEXTGENERATIONWEBUI/API_CURRENT).
 * @property {string} [koboldBaseUrl] KoboldAI Classic backend base URL (API_KOBOLD).
 * @property {(tokenizerType: string, text: string) => Promise<number[]>} [encodeLocal] Injected
 * replacement for encodeTextByLocalTokenizerType, for testing without real tokenizer model files.
 * @property {(request: any, text: string, baseUrl: string, model: string, apiType: string) => Promise<{count: number, ids: number[]}|{error: true}>} [encodeTextgenRemote]
 * Injected replacement for encodeViaTextgenAPI, for testing without real network calls.
 * @property {typeof fetch} [fetchImpl] Injected replacement for the global fetch, used for the
 * API_KOBOLD remote-count call.
 */

/**
 * Turns a resolved `tokenizers` type into actual token ids, trying a remote/API tokenizer first
 * where applicable and falling back to a local one on failure - the direct
 * try-then-fallback replacement for the client's sessionStorage-gated remote-tokenizer logic (see
 * module doc comment).
 *
 * Judgment calls (flagged per the task):
 * - OPENAI vs GPT2: the client's TOKENIZER_URLS[tokenizers.OPENAI].encode points at
 *   '/api/tokenizers/openai/encode', which (see router.post('/openai/encode', ...) in
 *   src/endpoints/tokenizers.js) is model-name-aware - it picks among llama/llama3/mistral/yi/
 *   claude/gemma/jamba/qwen2/command-r/command-a/nemo/deepseek/tiktoken(model) encoders based on
 *   the *actual model name string*, not a fixed tokenizer. encodeTextByLocalTokenizerType() has no
 *   equivalent "pick by model name" entry point - it only exposes fixed-key encoding (a flat
 *   'gpt2' tiktoken call being the closest fixed key). Fully porting the real /openai/encode
 *   behavior would mean either exporting a second, model-name-aware helper from
 *   src/endpoints/tokenizers.js (out of scope - the task only asked to export
 *   encodeViaTextgenAPI), or duplicating that route's if/else chain here. Given the task's
 *   explicit instruction to use encodeTextByLocalTokenizerType('gpt2', text) for both OPENAI and
 *   GPT2, that's what's implemented below - it is an approximation for OPENAI, not a byte-for-byte
 *   port, and undercounts/mismatches tokens for non-OpenAI model names. Flagging this rather than
 *   silently guessing.
 * - Kobold remote-count helper placement: implemented inline here with `fetchImpl` (defaulting to
 *   the global fetch) rather than factoring a shared helper out of the
 *   '/remote/kobold/count' route in src/endpoints/tokenizers.js. The route's own handler is a thin
 *   ~15-line wrapper with Express-specific bits (request/response, sendStatus(400)) around one
 *   fetch call; duplicating just the fetch call here is small enough that adding a second exported
 *   function to tokenizers.js for it seemed like more indirection than value. If a second caller
 *   shows up, extracting a shared `postKoboldTokenCount(baseUrl, text, fetchImpl)` helper there
 *   (mirroring how encodeViaTextgenAPI was exported) would be the natural follow-up.
 *
 * @param {number} tokenizerType A `tokenizers` value (typically from resolveTokenizerType()).
 * @param {string} text Text to encode.
 * @param {EncodeWithTokenizerTypeOptions} [options]
 * @returns {Promise<number[]>} Array of token ids. Empty array for tokenizers.NONE (matches the
 * client, which effectively doesn't tokenize when no API is selected).
 */
export async function encodeWithTokenizerType(tokenizerType, text, options = {}) {
    const {
        request,
        textgenBaseUrl,
        textgenModel,
        textgenApiType,
        koboldBaseUrl,
        encodeLocal = encodeTextByLocalTokenizerType,
        encodeTextgenRemote = encodeViaTextgenAPI,
        fetchImpl = fetch,
    } = options;

    if (tokenizerType === tokenizers.NONE) {
        return [];
    }

    if (tokenizerType === tokenizers.API_TEXTGENERATIONWEBUI || tokenizerType === tokenizers.API_CURRENT) {
        const result = await encodeTextgenRemote(request, text, textgenBaseUrl, textgenModel, textgenApiType);
        if (result && !result.error && Array.isArray(result.ids)) {
            return result.ids;
        }
        return encodeLocal(TOKENIZER_TYPE_KEYS[tokenizers.LLAMA], text);
    }

    if (tokenizerType === tokenizers.API_KOBOLD) {
        try {
            let url = String(koboldBaseUrl ?? '').replace(/\/$/, '');
            url += '/extra/tokencount';
            const result = await fetchImpl(url, {
                method: 'POST',
                body: JSON.stringify({ prompt: text }),
                headers: { 'Content-Type': 'application/json' },
            });
            if (result.ok) {
                const data = await result.json();
                if (Array.isArray(data?.ids)) {
                    return data.ids;
                }
            } else {
                console.warn(`API returned error: ${result.status} ${result.statusText}`);
            }
        } catch (error) {
            console.error(error);
        }
        return encodeLocal(TOKENIZER_TYPE_KEYS[tokenizers.LLAMA], text);
    }

    if (tokenizerType === tokenizers.OPENAI || tokenizerType === tokenizers.GPT2) {
        return encodeLocal('gpt2', text);
    }

    const key = TOKENIZER_TYPE_KEYS[tokenizerType];
    if (key) {
        return encodeLocal(key, text);
    }

    throw new Error(`Unsupported tokenizer type for encoding: ${tokenizerType}`);
}
