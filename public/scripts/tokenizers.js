import { localforage } from '../lib.js';
import { nai_settings } from '../script.js';
import { main_api } from './generation-params.js';
import { event_types, eventSource } from './events.js';
import { power_user } from './power-user.js';
import { chat_completion_sources, getChatCompletionModel, oai_settings } from './chat-completion-settings.js';
import { debounce, getStringHash } from './utils.js';
import { kai_settings } from './kai-settings.js';
import { SERVER_INPUTS, textgen_types, textgenerationwebui_settings as textgen_settings, getTextGenServer, getTextGenModel } from './textgen-settings.js';
import { horde_settings } from './horde.js';
import { showTokenizerWarnings } from './tokenizer-notices.js';
export { BYTES_PER_TOKEN as CHARACTERS_PER_TOKEN_RATIO };

export const BYTES_PER_TOKEN = 3.35;
export const TOKENIZER_WARNING_KEY = 'tokenizationWarningShown';
export const TOKENIZER_SUPPORTED_KEY = 'tokenizationSupported';

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
    // Official tokenizer files the server downloads on demand, from 1000 up, above upstream's range.
    // A value is fixed forever once shipped: never renumbered, reused or removed.
    QWEN3: 1000,
    LLAMA3_1: 1001,
    NEMO_TEKKEN: 1002,
    KIMI: 1003,
    QWEN2_VL: 1004,
    QWEN2_5: 1005,
    QWEN3_5: 1006,
    QWEN3_5_BASE: 1007,
    QWEN3_8: 1008,
    CODEQWEN1_5: 1009,
    DEEPSEEK_V2: 1010,
    DEEPSEEK_V2_5: 1011,
    DEEPSEEK_R1: 1012,
    DEEPSEEK_V3_1: 1013,
    DEEPSEEK_V3_2: 1014,
    DEEPSEEK_V4: 1015,
    DEEPSEEK_V4_1: 1016,
    DEEPSEEK_R1_DISTILL_QWEN: 1017,
    DEEPSEEK_R1_DISTILL_LLAMA: 1018,
    DEEPSEEK_R1_0528_QWEN3: 1019,
    GEMMA_4: 1020,
    GEMMA_4_ASSISTANT: 1021,
    GEMMA_3_IT: 1022,
    GEMMA_3_PT: 1023,
    GEMMA_3N: 1024,
    CODEGEMMA: 1025,
    GEMMA_2_JPN: 1026,
    LLAMA3_1_BASE: 1027,
    LLAMA3_3: 1028,
    LLAMA4: 1029,
    LLAMA_GUARD_3_8B: 1030,
    LLAMA_GUARD_3_11B_VISION: 1031,
    LLAMA_GUARD_2: 1032,
    LLAMA_GUARD_4: 1033,
    MISTRAL_7B_V0_3: 1034,
    MATHSTRAL: 1035,
    MISTRAL_LARGE_2411: 1036,
    MISTRAL_7B_V0_3_HF: 1037,
    CODESTRAL_22B_HF: 1038,
    CODESTRAL_MAMBA_HF: 1039,
    MATHSTRAL_HF: 1040,
    MISTRAL_LARGE_2411_HF: 1041,
    MINISTRAL_8B_2410_HF: 1042,
    MINISTRAL_3_INSTRUCT_HF: 1043,
    MINISTRAL_3_BASE_HF: 1044,
    MISTRAL_SMALL_4_HF: 1045,
    SHIELDSTRAL_HF: 1046,
    MISTRAL_SMALL_3_HF: 1047,
    COMMAND_A_VISION: 1048,
    COMMAND_A_PLUS: 1049,
    AYA_VISION_32B: 1050,
    TINY_AYA: 1051,
    TINY_AYA_BASE: 1052,
    COMMAND_R_08_2024_HF: 1053,
    AYA_VISION_32B_HF: 1054,
    GLM_4_0414: 1055,
    GLM_4_5: 1056,
    GLM_5: 1057,
    GLM_EDGE: 1058,
    AUTOGLM_PHONE: 1059,
    KIMI_K2_BASE: 1060,
    KIMI_K2_THINKING: 1061,
    KIMI_K2_5: 1062,
    KIMI_K3: 1063,
    KIMI_VL: 1064,
    MOONLIGHT: 1065,
    MINIMAX_TEXT_01: 1066,
    MINIMAX_M1: 1067,
    MINIMAX_M2: 1068,
    MINIMAX_M3: 1069,
    GPT_OSS: 1070,
    PHI_1: 1071,
    PHI_3_HF: 1072,
    PHI_3_SMALL: 1073,
    PHI_3_VISION: 1074,
    PHI_4: 1075,
    PHI_4_MINI: 1076,
    PHI_4_MULTIMODAL: 1077,
    PHI_4_REASONING: 1078,
    PHI_4_REASONING_VISION: 1079,
    NEMOTRON_4: 1080,
    LLAMA_3_1_NEMOTRON_51B: 1081,
    NEMOTRON_H: 1082,
    LLAMA_3_1_NEMOTRON_NANO_VL: 1083,
    ACEREASON_NEMOTRON_1_1: 1084,
    NEMOTRON_NANO_12B_V2_VL: 1085,
    NEMOTRON_3: 1086,
};

// A list of local tokenizers that support encoding and decoding token ids.
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
    tokenizers.QWEN3,
    tokenizers.LLAMA3_1,
    tokenizers.NEMO_TEKKEN,
    tokenizers.KIMI,
    tokenizers.QWEN2_VL,
    tokenizers.QWEN2_5,
    tokenizers.QWEN3_5,
    tokenizers.QWEN3_5_BASE,
    tokenizers.QWEN3_8,
    tokenizers.CODEQWEN1_5,
    tokenizers.DEEPSEEK_V2,
    tokenizers.DEEPSEEK_V2_5,
    tokenizers.DEEPSEEK_R1,
    tokenizers.DEEPSEEK_V3_1,
    tokenizers.DEEPSEEK_V3_2,
    tokenizers.DEEPSEEK_V4,
    tokenizers.DEEPSEEK_V4_1,
    tokenizers.DEEPSEEK_R1_DISTILL_QWEN,
    tokenizers.DEEPSEEK_R1_DISTILL_LLAMA,
    tokenizers.DEEPSEEK_R1_0528_QWEN3,
    tokenizers.GEMMA_4,
    tokenizers.GEMMA_4_ASSISTANT,
    tokenizers.GEMMA_3_IT,
    tokenizers.GEMMA_3_PT,
    tokenizers.GEMMA_3N,
    tokenizers.CODEGEMMA,
    tokenizers.GEMMA_2_JPN,
    tokenizers.LLAMA3_1_BASE,
    tokenizers.LLAMA3_3,
    tokenizers.LLAMA4,
    tokenizers.LLAMA_GUARD_3_8B,
    tokenizers.LLAMA_GUARD_3_11B_VISION,
    tokenizers.LLAMA_GUARD_2,
    tokenizers.LLAMA_GUARD_4,
    tokenizers.MISTRAL_7B_V0_3,
    tokenizers.MATHSTRAL,
    tokenizers.MISTRAL_LARGE_2411,
    tokenizers.MISTRAL_7B_V0_3_HF,
    tokenizers.CODESTRAL_22B_HF,
    tokenizers.CODESTRAL_MAMBA_HF,
    tokenizers.MATHSTRAL_HF,
    tokenizers.MISTRAL_LARGE_2411_HF,
    tokenizers.MINISTRAL_8B_2410_HF,
    tokenizers.MINISTRAL_3_INSTRUCT_HF,
    tokenizers.MINISTRAL_3_BASE_HF,
    tokenizers.MISTRAL_SMALL_4_HF,
    tokenizers.SHIELDSTRAL_HF,
    tokenizers.MISTRAL_SMALL_3_HF,
    tokenizers.COMMAND_A_VISION,
    tokenizers.COMMAND_A_PLUS,
    tokenizers.AYA_VISION_32B,
    tokenizers.TINY_AYA,
    tokenizers.TINY_AYA_BASE,
    tokenizers.COMMAND_R_08_2024_HF,
    tokenizers.AYA_VISION_32B_HF,
    tokenizers.GLM_4_0414,
    tokenizers.GLM_4_5,
    tokenizers.GLM_5,
    tokenizers.GLM_EDGE,
    tokenizers.AUTOGLM_PHONE,
    tokenizers.KIMI_K2_BASE,
    tokenizers.KIMI_K2_THINKING,
    tokenizers.KIMI_K2_5,
    tokenizers.KIMI_K3,
    tokenizers.KIMI_VL,
    tokenizers.MOONLIGHT,
    tokenizers.MINIMAX_TEXT_01,
    tokenizers.MINIMAX_M1,
    tokenizers.MINIMAX_M2,
    tokenizers.MINIMAX_M3,
    tokenizers.GPT_OSS,
    tokenizers.PHI_1,
    tokenizers.PHI_3_HF,
    tokenizers.PHI_3_SMALL,
    tokenizers.PHI_3_VISION,
    tokenizers.PHI_4,
    tokenizers.PHI_4_MINI,
    tokenizers.PHI_4_MULTIMODAL,
    tokenizers.PHI_4_REASONING,
    tokenizers.PHI_4_REASONING_VISION,
    tokenizers.NEMOTRON_4,
    tokenizers.LLAMA_3_1_NEMOTRON_51B,
    tokenizers.NEMOTRON_H,
    tokenizers.LLAMA_3_1_NEMOTRON_NANO_VL,
    tokenizers.ACEREASON_NEMOTRON_1_1,
    tokenizers.NEMOTRON_NANO_12B_V2_VL,
    tokenizers.NEMOTRON_3,
    // uncomment when NovelAI releases Kayra and Clio weights, lol
    //tokenizers.NERD,
    //tokenizers.NERD2,
];

/**
 * Whether the given (or currently active) main API is Chat Completion (OpenAI-compatible).
 * @param {string} [api] API to check. Defaults to the currently active main API.
 * @returns {boolean}
 */
function isOpenAiApi(api = main_api) {
    return api === 'openai';
}

/**
 * A list of Text Completion sources that support remote tokenization.
 * Populated in initTokenziers due to circular dependencies.
 * @type {string[]}
 */
export const TEXTGEN_TOKENIZERS = [];

const TOKENIZER_URLS = {
    [tokenizers.GPT2]: {
        encode: '/api/tokenizers/gpt2/encode',
        decode: '/api/tokenizers/gpt2/decode',
        count: '/api/tokenizers/gpt2/encode',
    },
    [tokenizers.OPENAI]: {
        encode: '/api/tokenizers/openai/encode',
        decode: '/api/tokenizers/openai/decode',
        count: '/api/tokenizers/openai/encode',
    },
    [tokenizers.LLAMA]: {
        encode: '/api/tokenizers/llama/encode',
        decode: '/api/tokenizers/llama/decode',
        count: '/api/tokenizers/llama/encode',
    },
    [tokenizers.NERD]: {
        encode: '/api/tokenizers/nerdstash/encode',
        decode: '/api/tokenizers/nerdstash/decode',
        count: '/api/tokenizers/nerdstash/encode',
    },
    [tokenizers.NERD2]: {
        encode: '/api/tokenizers/nerdstash_v2/encode',
        decode: '/api/tokenizers/nerdstash_v2/decode',
        count: '/api/tokenizers/nerdstash_v2/encode',
    },
    [tokenizers.MISTRAL]: {
        encode: '/api/tokenizers/mistral/encode',
        decode: '/api/tokenizers/mistral/decode',
        count: '/api/tokenizers/mistral/encode',
    },
    [tokenizers.YI]: {
        encode: '/api/tokenizers/yi/encode',
        decode: '/api/tokenizers/yi/decode',
        count: '/api/tokenizers/yi/encode',
    },
    [tokenizers.CLAUDE]: {
        encode: '/api/tokenizers/claude/encode',
        decode: '/api/tokenizers/claude/decode',
        count: '/api/tokenizers/claude/encode',
    },
    [tokenizers.LLAMA3]: {
        encode: '/api/tokenizers/llama3/encode',
        decode: '/api/tokenizers/llama3/decode',
        count: '/api/tokenizers/llama3/encode',
    },
    [tokenizers.GEMMA]: {
        encode: '/api/tokenizers/gemma/encode',
        decode: '/api/tokenizers/gemma/decode',
        count: '/api/tokenizers/gemma/encode',
    },
    [tokenizers.JAMBA]: {
        encode: '/api/tokenizers/jamba/encode',
        decode: '/api/tokenizers/jamba/decode',
        count: '/api/tokenizers/jamba/encode',
    },
    [tokenizers.QWEN2]: {
        encode: '/api/tokenizers/qwen2/encode',
        decode: '/api/tokenizers/qwen2/decode',
        count: '/api/tokenizers/qwen2/encode',
    },
    [tokenizers.COMMAND_R]: {
        encode: '/api/tokenizers/command-r/encode',
        decode: '/api/tokenizers/command-r/decode',
        count: '/api/tokenizers/command-r/encode',
    },
    [tokenizers.COMMAND_A]: {
        encode: '/api/tokenizers/command-a/encode',
        decode: '/api/tokenizers/command-a/decode',
        count: '/api/tokenizers/command-a/encode',
    },
    [tokenizers.NEMO]: {
        encode: '/api/tokenizers/nemo/encode',
        decode: '/api/tokenizers/nemo/decode',
        count: '/api/tokenizers/nemo/encode',
    },
    [tokenizers.DEEPSEEK]: {
        encode: '/api/tokenizers/deepseek/encode',
        decode: '/api/tokenizers/deepseek/decode',
        count: '/api/tokenizers/deepseek/encode',
    },
};

const textEncoder = new TextEncoder();

/**
 * Token counts for the current chat only, keyed `${tokenizer.key}-${hash}+${padding}` (text) or
 * `${tokenizer.key}-${hash}` (a chat-completion message). Emptied on CHAT_CHANGED and whenever the
 * server names a different tokenizer.
 * @type {Map<string, number>}
 */
const countCache = new Map();

/**
 * Token ids for the current settings' entries (bias, banned tokens, NovelAI bad words and stop
 * strings), keyed `${tokenizer.key}|${tokenizer.id}|${text}`; null where the tokenizer has none.
 * Emptied whenever the server names a different tokenizer.
 * @type {Map<string, number[]|null>}
 */
const idCache = new Map();

/**
 * Per API, the texts its current entries encode, for the background prefetch.
 * @type {Map<string, () => string[]>}
 */
const entryTextSources = new Map();

/**
 * Called whenever the server names a different tokenizer for the current state.
 * @type {Set<() => void>}
 */
const tokenizerChangeListeners = new Set();

/**
 * Guesstimates the token count for a string.
 * @param {string} str String to tokenize.
 * @returns {number} Token count.
 */
export function guesstimate(str) {
    const byteLength = textEncoder.encode(str).length;
    return Math.ceil(byteLength / BYTES_PER_TOKEN);
}

/**
 * A no-op: counts are kept in memory for the current chat only. Exported because upstream exports it.
 */
export async function saveTokenCache() {}

/**
 * Deletes the `tokenCache` blob older clients stored: an entry for every chat ever opened, keyed by
 * tokenizers the client picked.
 */
async function removeStoredTokenCache() {
    try {
        await localforage.createInstance({ name: 'SillyTavern_ChatCompletions' }).removeItem('tokenCache');
    } catch (e) {
        console.log('Chat Completions: unable to remove the stored token cache', e);
    }
}

/**
 * @typedef {object} Tokenizer
 * @property {number} tokenizerId - The id of the tokenizer option
 * @property {string} tokenizerKey - Internal name/key of the tokenizer
 * @property {string} tokenizerName - Human-readable detailed name of the tokenizer (as displayed in the UI)
 */

/**
 * The tokenizer a `/api/tokenizers/current/*` response names.
 * @typedef {object} CurrentTokenizer
 * @property {number} id A `tokenizers` value: API id for a remote tokenizer, NONE for an estimate.
 * @property {string} name
 * @property {string} [model]
 * @property {'remote'|'local'|'unknown'|'none'|'fallback'|'failed'} basis
 * @property {string} key
 * @property {{ dropped?: { one: string, many: string }, trimEstimate?: string, unknownModel?: string }} [messages]
 * Server-built wording; `dropped` has `{count}` and `{entries}` for the browser to fill in.
 */

/**
 * Gets all tokenizers available to the user.
 * @returns {Tokenizer[]} Tokenizer info.
 */
export function getAvailableTokenizers() {
    const tokenizerOptions = $('#tokenizer').find('option').toArray();
    return tokenizerOptions.map(tokenizerOption => ({
        tokenizerId: Number(tokenizerOption.value),
        tokenizerKey: Object.entries(tokenizers).find(([_, value]) => value === Number(tokenizerOption.value))[0].toLocaleLowerCase(),
        tokenizerName: tokenizerOption.text,
    }));
}

/**
 * Selects tokenizer if not already selected.
 * @param {number} tokenizerId Tokenizer ID.
 */
export function selectTokenizer(tokenizerId) {
    if (tokenizerId !== power_user.tokenizer) {
        const tokenizer = getAvailableTokenizers().find(tokenizer => tokenizer.tokenizerId === tokenizerId);
        if (!tokenizer) {
            console.warn('Failed to find tokenizer with id', tokenizerId);
            return;
        }
        $('#tokenizer').val(tokenizer.tokenizerId).trigger('change');
        toastr.info(`Tokenizer: "${tokenizer.tokenizerName}" selected`);
    }
}

/**
 * A text completion type's model setting, as the server reads it for its sends. Never throws.
 * @param {string} type Text completion type.
 * @returns {string}
 */
function getTextgenModelSetting(type) {
    if (type === textgen_types.OLLAMA) {
        return textgen_settings.ollama_model ?? '';
    }
    return getTextGenModel({ ...textgen_settings, type }) ?? '';
}

/**
 * The on-screen state of a text completion type, for `/api/tokenizers/current/*`.
 * @param {string} type Text completion type.
 */
function getTextgenTokenizerState(type) {
    return {
        api: 'textgenerationwebui',
        type,
        url: getTextGenServer(type),
        model: getTextgenModelSetting(type),
        tokenizerSetting: power_user.tokenizer,
    };
}

/**
 * The on-screen connection state the server resolves the tokenizer from. Names no tokenizer.
 * @param {string} [api] Main API. Defaults to the current one.
 * @returns {object|null} null for an API with no tokenizer state.
 */
function getTokenizerState(api = main_api) {
    switch (api) {
        case 'textgenerationwebui':
            return getTextgenTokenizerState(textgen_settings.type);
        case 'kobold':
            return { api, url: kai_settings.api_server ?? '', tokenizerSetting: power_user.tokenizer };
        case 'novel':
            return { api, model: nai_settings.model_novel ?? '', tokenizerSetting: power_user.tokenizer };
        case 'koboldhorde':
            return { api, hordeModels: Array.isArray(horde_settings.models) ? horde_settings.models : [], tokenizerSetting: power_user.tokenizer };
        case 'openai': {
            const source = oai_settings.chat_completion_source;
            // The server counts with a custom URL's own `/tokenize` when the URL is llama.cpp.
            const url = source === chat_completion_sources.CUSTOM ? { url: oai_settings.custom_url ?? '' } : {};
            return { api, source, ...url, model: getChatCompletionModel() ?? '', tokenizerSetting: power_user.tokenizer };
        }
        default:
            return null;
    }
}

/**
 * The server's last answer for the on-screen state, with the state it answered.
 * @type {{ stateKey: string, tokenizer: CurrentTokenizer } | null}
 */
let rememberedTokenizer = null;

/**
 * Remembers a response's tokenizer if it answered the current on-screen state, emptying the count
 * cache when it names a different tokenizer.
 * @param {string} stateKey The request's state, serialized.
 * @param {CurrentTokenizer} tokenizer
 * @returns {boolean} Whether it answered the current state.
 */
function rememberTokenizer(stateKey, tokenizer) {
    if (!tokenizer || typeof tokenizer !== 'object' || stateKey !== JSON.stringify(getTokenizerState())) {
        return false;
    }
    const previous = rememberedTokenizer?.tokenizer;
    const changed = !previous || previous.key !== tokenizer.key || previous.id !== tokenizer.id;
    if (changed) {
        countCache.clear();
        idCache.clear();
        tokenizerChangeListeners.forEach(listener => listener());
    }
    rememberedTokenizer = { stateKey, tokenizer };
    if (changed) {
        // After the caller has stored what this response answered.
        queueMicrotask(prefetchEntryTokenIdsDebounced);
    }
    return true;
}

/**
 * @returns {CurrentTokenizer|null} The remembered answer, if it is for the current state.
 */
function getRememberedTokenizer() {
    if (rememberedTokenizer && rememberedTokenizer.stateKey === JSON.stringify(getTokenizerState())) {
        return rememberedTokenizer.tokenizer;
    }
    return null;
}

/**
 * The server's answer for the current on-screen state, as the last response left it. Never asks the
 * server.
 * @returns {CurrentTokenizer|null} null when no response has answered the current state.
 */
export function getRememberedTokenizerAnswer() {
    return getRememberedTokenizer();
}

/** The routes whose response `warnings` are shown. */
const ROUTES_WITH_NOTICES = new Set(['count', 'encode', 'trim']);

/**
 * Shows the `fallback-copy` / `estimate` warnings a count, encode or trim response carries. Never
 * throws, so the functions that count add no throws.
 * @param {any} data The response.
 */
function showResponseWarnings(data) {
    if (!Array.isArray(data?.warnings) || data.warnings.length === 0) {
        return;
    }
    try {
        showTokenizerWarnings(data?.warnings);
    } catch (error) {
        console.error('Could not show the tokenizer warnings', error);
    }
}

/**
 * Posts to a `/api/tokenizers/current/*` route.
 * @param {string} route
 * @param {object} body
 * @param {boolean} async
 * @returns {any} The response data (a promise when `async`); null (or a promise of null) on failure.
 */
function postCurrent(route, body, async) {
    const request = {
        async,
        type: 'POST',
        url: `/api/tokenizers/current/${route}`,
        data: JSON.stringify(body),
        dataType: 'json',
        contentType: 'application/json',
    };
    const notify = ROUTES_WITH_NOTICES.has(route);
    if (async) {
        return Promise.resolve(jQuery.ajax(request)).then((data) => {
            if (notify) showResponseWarnings(data);
            return data;
        }, (error) => {
            console.error(`Tokenizer request /current/${route} failed`, error);
            return null;
        });
    }
    let data = null;
    jQuery.ajax({
        ...request,
        success: (response) => { data = response; },
        error: (_xhr, _status, error) => console.error(`Tokenizer request /current/${route} failed`, error),
    });
    if (notify) showResponseWarnings(data);
    return data;
}

/**
 * Asks the server which tokenizer answers `state`, synchronously, and remembers the answer.
 * @param {object|null} state
 * @returns {CurrentTokenizer|null}
 */
function askTokenizerSync(state) {
    if (!state) {
        return null;
    }
    const stateKey = JSON.stringify(state);
    const data = postCurrent('tokenizer', { state }, false);
    rememberTokenizer(stateKey, data?.tokenizer);
    return data?.tokenizer ?? null;
}

/**
 * The current state's tokenizer: the remembered answer, or one synchronous ask for it.
 * @returns {CurrentTokenizer|null}
 */
function getCurrentTokenizerSync() {
    return getRememberedTokenizer() ?? askTokenizerSync(getTokenizerState());
}

/**
 * Asks the server for the current state's tokenizer in the background and remembers the answer.
 * @returns {Promise<void>}
 */
async function refreshCurrentTokenizer() {
    const state = getTokenizerState();
    if (!state) {
        return;
    }
    const stateKey = JSON.stringify(state);
    const data = await postCurrent('tokenizer', { state }, true);
    rememberTokenizer(stateKey, data?.tokenizer);
}

const refreshCurrentTokenizerDebounced = debounce(refreshCurrentTokenizer);

/**
 * @param {CurrentTokenizer} tokenizer
 * @param {string} text
 * @returns {string}
 */
function idCacheKey(tokenizer, text) {
    return `${tokenizer.key}|${tokenizer.id}|${text}`;
}

/**
 * Stores an encode response's ids if it answered the current state and its tokenizer didn't fail.
 * @param {string} stateKey
 * @param {string[]} texts
 * @param {any} data
 * @returns {(number[]|null)[]|null} The response's ids, null for a failed request.
 */
function applyEncodeResponse(stateKey, texts, data) {
    const ids = Array.isArray(data?.ids) ? data.ids : null;
    const tokenizer = ids && data.tokenizer ? data.tokenizer : null;
    if (tokenizer && rememberTokenizer(stateKey, tokenizer) && tokenizer.basis !== 'failed') {
        texts.forEach((text, i) => idCache.set(idCacheKey(tokenizer, text), Array.isArray(ids[i]) ? ids[i] : null));
    }
    return ids;
}

/**
 * Registers the texts an API's current entries encode, so they are fetched in the background.
 * @param {string} api Main API the entries are sent to.
 * @param {() => string[]} getTexts
 */
export function registerEntryTextSource(api, getTexts) {
    entryTextSources.set(api, getTexts);
}

/**
 * Encodes the current API's entries that aren't in the id cache, in the background.
 * @returns {Promise<void>}
 */
async function prefetchEntryTokenIds() {
    const getTexts = entryTextSources.get(main_api);
    const state = getTokenizerState();
    if (!getTexts || !state) {
        return;
    }
    const tokenizer = getRememberedTokenizer();
    const texts = [...new Set(getTexts())].filter(text => !tokenizer || !idCache.has(idCacheKey(tokenizer, text)));
    if (texts.length === 0) {
        return;
    }
    const stateKey = JSON.stringify(state);
    applyEncodeResponse(stateKey, texts, await postCurrent('encode', { state, texts }, true));
}

export const prefetchEntryTokenIdsDebounced = debounce(prefetchEntryTokenIds);

/**
 * Token ids for entry texts, sent to `api`: the id cache's, and one synchronous `/current/encode`
 * for the rest.
 * @param {string[]} texts
 * @param {string} [api] Main API the entries are sent to. Defaults to the current one.
 * @returns {{ ids: Map<string, number[]|null>, tokenizer: CurrentTokenizer|null }} null ids where
 * there are none.
 */
export function getEntryTokenIds(texts, api = main_api) {
    const ids = new Map();
    const tokenizer = api === main_api ? getRememberedTokenizer() : null;
    const missing = [];
    for (const text of new Set(texts)) {
        const key = tokenizer ? idCacheKey(tokenizer, text) : null;
        if (key && idCache.has(key)) {
            ids.set(text, idCache.get(key));
        } else {
            missing.push(text);
        }
    }

    const state = getTokenizerState(api);
    if (missing.length === 0 || !state) {
        missing.forEach(text => ids.set(text, null));
        return { ids, tokenizer };
    }

    const data = postCurrent('encode', { state, texts: missing }, false);
    const answered = applyEncodeResponse(JSON.stringify(state), missing, data);
    missing.forEach((text, i) => ids.set(text, Array.isArray(answered?.[i]) ? answered[i] : null));
    return { ids, tokenizer: answered ? data.tokenizer : tokenizer };
}

/**
 * Calls `listener` whenever the server names a different tokenizer for the current state.
 * @param {() => void} listener
 */
export function onTokenizerChange(listener) {
    tokenizerChangeListeners.add(listener);
}

/**
 * The on-screen connection state of `api`, as JSON with non-ASCII characters escaped so it can be a
 * header value.
 * @param {string} [api] Main API. Defaults to the current one.
 * @returns {string}
 */
export function getTokenizerStateHeader(api = main_api) {
    return JSON.stringify(getTokenizerState(api)).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The server's tokenizer answer for `api`'s on-screen state: the remembered one, or one synchronous
 * ask for it.
 * @param {string} [api] Main API. Defaults to the current one.
 * @returns {CurrentTokenizer|null}
 */
export function getTokenizerAnswer(api = main_api) {
    return api === main_api ? getCurrentTokenizerSync() : askTokenizerSync(getTokenizerState(api));
}

/**
 * Shows the `trim-estimate` warning, in the server's words, when the current state's remembered
 * answer after a browser-built send's counts has basis `failed`: the send was fitted to the context
 * by the estimate because the tokenizer failed. Asks the server nothing.
 */
export function showTrimEstimateWarning() {
    const tokenizer = getRememberedTokenizer();
    if (tokenizer?.basis !== 'failed') {
        return;
    }
    const message = tokenizer.messages?.trimEstimate;
    if (typeof message !== 'string') {
        console.warn('The prompt was fitted to the context by an estimated token count');
        return;
    }
    showTokenizerWarnings([{ kind: 'trim-estimate', key: tokenizer.key, message }]);
}

/**
 * Shows the `dropped` warning for the entries one send left out, in the server's words.
 * @param {CurrentTokenizer|null} tokenizer The answer the entries' ids came from.
 * @param {string[]} entries
 */
export function showDroppedEntries(tokenizer, entries) {
    if (entries.length === 0) {
        return;
    }
    const templates = tokenizer?.messages?.dropped;
    const template = entries.length === 1 ? templates?.one : templates?.many;
    if (typeof template !== 'string') {
        console.warn('Left out entries that need token ids:', entries);
        return;
    }
    const values = { count: String(entries.length), entries: entries.join(', ') };
    const message = template.replace(/\{(count|entries)\}/g, (_, name) => values[name]);
    showTokenizerWarnings([{ kind: 'dropped', key: tokenizer.key, message, entries }]);
}

/**
 * @param {number} tokenizerId
 * @returns {string} The lowercased `tokenizers` key.
 */
function getTokenizerKey(tokenizerId) {
    return Object.entries(tokenizers).find(([_, value]) => value === tokenizerId)?.[0].toLocaleLowerCase() ?? '';
}

/**
 * The friendly name of a server-resolved tokenizer.
 * @param {string} api
 * @param {CurrentTokenizer|null} tokenizer
 * @returns {Tokenizer} Tokenizer info
 */
function toFriendlyTokenizer(api, tokenizer) {
    if (api === 'openai') {
        return { tokenizerName: tokenizer?.model ?? getChatCompletionModel() ?? '', tokenizerKey: getTokenizerKey(tokenizers.OPENAI), tokenizerId: tokenizers.OPENAI };
    }

    const tokenizerId = tokenizer?.id ?? tokenizers.NONE;
    const tokenizerName = tokenizer?.name ?? $(`#tokenizer option[value="${tokenizers.NONE}"]`).text();
    return { tokenizerName, tokenizerKey: getTokenizerKey(tokenizerId), tokenizerId };
}

/**
 * Gets the friendly name of the current tokenizer.
 * @param {string} forApi API to get the tokenizer for. Defaults to the main API.
 * @returns {Tokenizer} Tokenizer info
 */
export function getFriendlyTokenizerName(forApi) {
    if (!forApi) {
        forApi = main_api;
    }

    if (forApi === 'openai') {
        return toFriendlyTokenizer('openai', isOpenAiApi() ? getCurrentTokenizerSync() : askTokenizerSync(getTokenizerState('openai')));
    }

    return toFriendlyTokenizer(forApi, forApi === main_api ? getCurrentTokenizerSync() : askTokenizerSync(getTokenizerState(forApi)));
}

/**
 * Gets the tokenizer the server resolves for an API.
 * @param {string} forApi API to get the tokenizer for. Defaults to the main API.
 * @returns {number} Tokenizer type.
 */
export function getTokenizerBestMatch(forApi) {
    if (!forApi) {
        forApi = main_api;
    }

    if (forApi === 'openai') {
        return tokenizers.NONE;
    }

    const tokenizer = forApi === main_api ? getCurrentTokenizerSync() : askTokenizerSync(getTokenizerState(forApi));
    return tokenizer?.id ?? tokenizers.NONE;
}

/**
 * The tokenizer the server resolves for a text completion type's own model.
 * @param {string} type Text completion type.
 * @returns {number} Tokenizer type.
 */
export function getTextgenTypeTokenizer(type) {
    const tokenizer = main_api === 'textgenerationwebui' && textgen_settings.type === type
        ? getCurrentTokenizerSync()
        : askTokenizerSync(getTextgenTokenizerState(type));
    return tokenizer?.id ?? tokenizers.NONE;
}

/**
 * Counts texts with the current state's tokenizer: cached counts, and one `/current/count` request
 * for the rest. A failed request gives the estimate, uncached.
 * @param {string[]} strings
 * @param {number} padding Added to each non-empty count.
 * @param {boolean} async
 * @param {boolean} [promptStart] Every text begins the prompt a generation sends, and is counted as that prompt is.
 * @returns {{ counts: number[], tokenizer: CurrentTokenizer|null }|Promise<{ counts: number[], tokenizer: CurrentTokenizer|null }>}
 */
function countTexts(strings, padding, async, promptStart = false) {
    const cacheSuffix = promptStart ? '^' : '';
    const results = new Array(strings.length).fill(0);
    const tokenizer = getRememberedTokenizer();
    /** @type {number[]} */
    const pending = [];

    for (let i = 0; i < strings.length; i++) {
        const str = strings[i];
        if (typeof str !== 'string' || !str.length) {
            continue;
        }
        const cached = tokenizer ? countCache.get(`${tokenizer.key}-${getStringHash(str)}+${padding}${cacheSuffix}`) : undefined;
        if (typeof cached === 'number') {
            results[i] = cached;
        } else {
            pending.push(i);
        }
    }

    if (pending.length === 0) {
        const done = { counts: results, tokenizer };
        return async ? Promise.resolve(done) : done;
    }

    const state = getTokenizerState();
    const stateKey = JSON.stringify(state);
    const apply = (data) => {
        const counts = Array.isArray(data?.counts) ? data.counts : null;
        const answered = counts && data.tokenizer ? data.tokenizer : null;
        const store = !!answered && rememberTokenizer(stateKey, answered) && answered.basis !== 'failed';
        pending.forEach((i, j) => {
            const count = counts ? Number(counts[j]) : NaN;
            if (isNaN(count)) {
                results[i] = guesstimate(strings[i]) + padding;
                return;
            }
            results[i] = count;
            if (store) {
                countCache.set(`${answered.key}-${getStringHash(strings[i])}+${padding}${cacheSuffix}`, count);
            }
        });
        return { counts: results, tokenizer: answered };
    };
    const body = { state, texts: pending.map(i => strings[i]), padding, ...(promptStart ? { promptStart } : {}) };
    return async ? postCurrent('count', body, true).then(apply) : apply(postCurrent('count', body, false));
}

/**
 * Same resolution as getTokenCountAsync(), but for many strings in one call: every string that
 * isn't already cached goes to the server in a single request.
 * @param {string[]} strings Strings to tokenize, in order
 * @param {number} [padding=0] Padding tokens added to each non-empty result
 * @returns {Promise<number[]>} Token counts, same order/length as `strings`
 */
export async function getTokenCountsAsyncBatch(strings, padding = 0) {
    if (isOpenAiApi()) {
        return Promise.all(strings.map(str => getTokenCountAsync(str, padding)));
    }
    const { counts } = await countTexts(strings, padding, true);
    return counts;
}

/**
 * Same as getTokenCountsAsyncBatch(), and also names the tokenizer these counts came from.
 * @param {string[]} strings Strings to tokenize, in order
 * @param {number} [padding=0] Padding tokens added to each non-empty result
 * @returns {Promise<{ counts: number[], tokenizer: Tokenizer, answer: CurrentTokenizer|null }>} Token counts, same
 * order/length as `strings`, their tokenizer, and the server's answer they came from: the response's own, the
 * remembered one when every count was cached, or null when the request failed.
 */
export async function getTokenCountsWithTokenizer(strings, padding = 0) {
    if (isOpenAiApi()) {
        const counts = await Promise.all(strings.map(str => getTokenCountAsync(str, padding)));
        const answer = getRememberedTokenizer();
        return { counts, tokenizer: toFriendlyTokenizer('openai', answer), answer };
    }
    const { counts, tokenizer } = await countTexts(strings, padding, true);
    return { counts, tokenizer: toFriendlyTokenizer(main_api, tokenizer), answer: tokenizer };
}

/**
 * Same count as getTokenCountAsync(str, padding), with the server's answer it came from: the
 * response's own, the remembered one when no request was made, or null when the request failed.
 * @param {string} str String to tokenize
 * @param {number | undefined} padding Optional padding tokens. Defaults to 0.
 * @returns {Promise<{ count: number, answer: CurrentTokenizer|null }>}
 */
export async function getTokenCountWithAnswer(str, padding = undefined) {
    if (typeof str !== 'string' || !str?.length) {
        return { count: 0, answer: getRememberedTokenizer() };
    }

    if (isOpenAiApi()) {
        if (padding === power_user.token_padding) {
            return { count: guesstimate(str) + padding, answer: getRememberedTokenizer() };
        }
        const count = await counterWrapperOpenAIAsync(str);
        return { count, answer: getRememberedTokenizer() };
    }

    const { counts: [count], tokenizer } = await countTexts([str], padding ?? 0, true);
    return { count, answer: tokenizer };
}

/**
 * Gets the token count for a string using the current model tokenizer.
 * @param {string} str String to tokenize
 * @param {number | undefined} padding Optional padding tokens. Defaults to 0.
 * @returns {Promise<number>} Token count.
 */
export async function getTokenCountAsync(str, padding = undefined) {
    if (typeof str !== 'string' || !str?.length) {
        return 0;
    }

    if (isOpenAiApi()) {
        if (padding === power_user.token_padding) {
            // For main "shadow" prompt building
            return guesstimate(str) + padding;
        }
        // For extensions and WI
        return counterWrapperOpenAIAsync(str);
    }

    const { counts: [count] } = await countTexts([str], padding ?? 0, true);
    return count;
}

/**
 * getTokenCountAsync() for a text that begins the prompt a generation sends: counted as the backend
 * counts that prompt, so with BOS where the backend adds one.
 * @param {string} str String to tokenize
 * @param {number | undefined} padding Optional padding tokens. Defaults to 0.
 * @returns {Promise<number>} Token count.
 */
export async function getPromptTokenCountAsync(str, padding = undefined) {
    if (typeof str !== 'string' || !str?.length || isOpenAiApi()) {
        return getTokenCountAsync(str, padding);
    }
    const { counts: [count] } = await countTexts([str], padding ?? 0, true, true);
    return count;
}

/**
 * Gets the token count for a string using the current model tokenizer.
 * @param {string} str String to tokenize
 * @param {number | undefined} padding Optional padding tokens. Defaults to 0.
 * @returns {number} Token count.
 * @deprecated Use getTokenCountAsync instead.
 */
export function getTokenCount(str, padding = undefined) {
    if (typeof str !== 'string' || !str?.length) {
        return 0;
    }

    if (isOpenAiApi()) {
        if (padding === power_user.token_padding) {
            // For main "shadow" prompt building
            return guesstimate(str) + padding;
        }
        // For extensions and WI
        return counterWrapperOpenAI(str);
    }

    const { counts: [count] } = /** @type {{ counts: number[] }} */ (countTexts([str], padding ?? 0, false));
    return count;
}

/**
 * Gets the token count for a string using the OpenAI tokenizer.
 * @param {string} text Text to tokenize.
 * @returns {number} Token count.
 * @deprecated Use counterWrapperOpenAIAsync instead.
 */
function counterWrapperOpenAI(text) {
    const message = { content: text };
    return countTokensOpenAI(message, true);
}

/**
 * Gets the token count for a string using the OpenAI tokenizer.
 * @param {string} text Text to tokenize.
 * @returns {Promise<number>} Token count.
 */
function counterWrapperOpenAIAsync(text) {
    const message = { content: text };
    return countTokensOpenAIAsync(message, true);
}

/**
 * The chat-completion tokenizer model string the server resolves: the answer's model, or the
 * chat-completion model name when the answer has none (an estimate).
 * @returns {string}
 */
export function getTokenizerModel() {
    const tokenizer = isOpenAiApi() ? getCurrentTokenizerSync() : askTokenizerSync(getTokenizerState('openai'));
    return tokenizer?.model ?? getChatCompletionModel() ?? '';
}

/**
 * A chat-completion message count from a `/current/count` response; the estimate when it has none.
 * @param {string} stateKey
 * @param {object} message
 * @param {any} data
 * @returns {number}
 */
function applyMessageCount(stateKey, message, data) {
    const count = Number(data?.count);
    if (isNaN(count)) {
        return guesstimate(JSON.stringify(message));
    }
    const tokenizer = data.tokenizer;
    if (rememberTokenizer(stateKey, tokenizer) && tokenizer.basis !== 'failed') {
        countCache.set(`${tokenizer.key}-${getStringHash(JSON.stringify(message))}`, count);
    }
    return count;
}

/**
 * @returns {{ state: object, stateKey: string, tokenizer: CurrentTokenizer|null }}
 */
function getMessageCountContext() {
    const state = getTokenizerState('openai');
    return { state, stateKey: JSON.stringify(state), tokenizer: isOpenAiApi() ? getRememberedTokenizer() : null };
}

/**
 * @param {any[] | Object} messages
 * @deprecated Use countTokensOpenAIAsync instead.
 */
export function countTokensOpenAI(messages, full = false) {
    const { state, stateKey, tokenizer } = getMessageCountContext();

    if (!Array.isArray(messages)) {
        messages = [messages];
    }

    let token_count = 0;

    for (const message of messages) {
        const cacheKey = tokenizer ? `${tokenizer.key}-${getStringHash(JSON.stringify(message))}` : '';
        const cachedCount = (cacheKey ? countCache.get(cacheKey) : undefined);

        if (typeof cachedCount === 'number') {
            token_count += cachedCount;
        } else {
            token_count += applyMessageCount(stateKey, message, postCurrent('count', { state, messages: [message] }, false));
        }
    }

    if (!full) token_count -= 2;

    return token_count;
}

/**
 * Returns the token count for a message using the chat-completion tokenizer the server resolves.
 * Rejects when the count request fails, as upstream does.
 * @param {object[]|object} messages
 * @param {boolean} full
 * @returns {Promise<number>} Token count.
 */
export async function countTokensOpenAIAsync(messages, full = false) {
    const { state, stateKey, tokenizer } = getMessageCountContext();

    if (!Array.isArray(messages)) {
        messages = [messages];
    }

    let token_count = 0;

    for (const message of messages) {
        const cacheKey = tokenizer ? `${tokenizer.key}-${getStringHash(JSON.stringify(message))}` : '';
        const cachedCount = (cacheKey ? countCache.get(cacheKey) : undefined);

        if (typeof cachedCount === 'number') {
            token_count += cachedCount;
        } else {
            const data = await jQuery.ajax({
                async: true,
                type: 'POST',
                url: '/api/tokenizers/current/count',
                data: JSON.stringify({ state, messages: [message] }),
                dataType: 'json',
                contentType: 'application/json',
            });
            showResponseWarnings(data);
            token_count += applyMessageCount(stateKey, message, data);
        }
    }

    if (!full) token_count -= 2;

    return token_count;
}

/**
 * Calls the underlying tokenizer model to encode a string to tokens.
 * @param {string} endpoint API endpoint.
 * @param {string} str String to tokenize.
 * @param {Record<string, string>} [headers] Extra request headers.
 * @returns {number[]} Array of token ids.
 */
function getTextTokensFromServer(endpoint, str, headers = undefined) {
    let ids = [];
    jQuery.ajax({
        async: false,
        type: 'POST',
        url: endpoint,
        headers,
        data: JSON.stringify({ text: str }),
        dataType: 'json',
        contentType: 'application/json',
        success: function (data) {
            ids = data.ids;

            // Don't want to break reverse compatibility, so sprinkle in some of the JS magic
            if (Array.isArray(data.chunks)) {
                Object.defineProperty(ids, 'chunks', { value: data.chunks });
            }
        },
    });
    return ids;
}

/**
 * Encodes a string with the current state's tokenizer through `/current/encode`, and remembers the tokenizer that answered.
 * @param {string} str String to tokenize.
 * @returns {{ ids: number[], chunks: string[]|null, tokenizer: CurrentTokenizer|null }} Token ids (empty when the tokenizer has none for it), their chunks when given, and the tokenizer named in the response.
 */
export function encodeCurrentTokens(str) {
    const state = getTokenizerState();
    if (!state) {
        return { ids: [], chunks: null, tokenizer: null };
    }
    const data = postCurrent('encode', { state, texts: [str] }, false);
    rememberTokenizer(JSON.stringify(state), data?.tokenizer);
    return {
        ids: Array.isArray(data?.ids?.[0]) ? data.ids[0] : [],
        chunks: Array.isArray(data?.chunks?.[0]) ? data.chunks[0] : null,
        tokenizer: data?.tokenizer ?? null,
    };
}

/**
 * Encodes a string with the current state's tokenizer through `/current/encode`.
 * @param {string} str String to tokenize.
 * @returns {number[]} Array of token ids; empty when the tokenizer has none for it.
 */
function getTextTokensFromCurrent(str) {
    return encodeCurrentTokens(str).ids;
}

/**
 * The official tokenizer files' values (1000 and up). They have no named route: `getTextTokens` and
 * `decodeTextTokens` send them to `/current/*` as `explicitTokenizer`, which the server honours on
 * every API.
 */
const REGISTRY_TOKENIZERS = Object.values(tokenizers).filter(value => value >= 1000);

/**
 * Encodes a string with the tokenizer the caller named, through `/current/encode` as `explicitTokenizer`.
 * The response isn't the on-screen state's tokenizer, so it isn't remembered.
 * @param {number} tokenizerType A REGISTRY_TOKENIZERS value.
 * @param {string} str String to tokenize.
 * @returns {number[]} Array of token ids, with their `chunks` when given, like a named route's.
 */
function getTextTokensFromExplicit(tokenizerType, str) {
    const state = getTokenizerState();
    if (!state) {
        return [];
    }
    const data = postCurrent('encode', { state, texts: [str], explicitTokenizer: tokenizerType }, false);
    const ids = Array.isArray(data?.ids?.[0]) ? data.ids[0] : [];
    if (Array.isArray(data?.chunks?.[0])) {
        Object.defineProperty(ids, 'chunks', { value: data.chunks[0] });
    }
    return ids;
}

/**
 * Decodes token ids with the tokenizer the caller named, through `/current/decode` as `explicitTokenizer`.
 * The response isn't the on-screen state's tokenizer, so it isn't remembered.
 * @param {number} tokenizerType A REGISTRY_TOKENIZERS value.
 * @param {number[]} ids Array of token ids
 * @returns {({ text: string, chunks: string[] })} Decoded token text and chunks. Empty on failure.
 */
function decodeTextTokensFromExplicit(tokenizerType, ids) {
    const state = getTokenizerState();
    if (!state) {
        return { text: '', chunks: [] };
    }
    const data = postCurrent('decode', { state, ids, explicitTokenizer: tokenizerType }, false);
    return { text: typeof data?.text === 'string' ? data.text : '', chunks: Array.isArray(data?.chunks) ? data.chunks : [] };
}

/**
 * Calls the underlying tokenizer model to decode token ids to text.
 * @param {string} endpoint API endpoint.
 * @param {number[]} ids Array of token ids
 * @param {Record<string, string>} [headers] Extra request headers.
 * @returns {({ text: string, chunks?: string[] })} Decoded token text as a single string and individual chunks (if available).
 */
function decodeTextTokensFromServer(endpoint, ids, headers = undefined) {
    let text = '';
    let chunks = [];
    jQuery.ajax({
        async: false,
        type: 'POST',
        url: endpoint,
        headers,
        data: JSON.stringify({ ids: ids }),
        dataType: 'json',
        contentType: 'application/json',
        success: function (data) {
            text = data.text;
            chunks = data.chunks;
        },
    });
    return { text, chunks };
}

/**
 * Headers for an `/openai/*` request: the chat-completion state, which the server resolves from
 * instead of `?model=`. The query stays for callers that send no state.
 * @returns {Record<string, string>}
 */
function getOpenAIRouteHeaders() {
    return { 'X-ST-Connection-State': getTokenizerStateHeader('openai') };
}

/**
 * Encodes a string to tokens using the server API.
 * @param {number} tokenizerType Tokenizer type.
 * @param {string} str String to tokenize.
 * @returns {number[]} Array of token ids.
 */
export function getTextTokens(tokenizerType, str) {
    switch (tokenizerType) {
        case tokenizers.API_CURRENT:
        case tokenizers.API_TEXTGENERATIONWEBUI:
        case tokenizers.API_KOBOLD:
            return getTextTokensFromCurrent(str);
        default: {
            if (REGISTRY_TOKENIZERS.includes(tokenizerType)) {
                return getTextTokensFromExplicit(tokenizerType, str);
            }
            const tokenizerEndpoints = TOKENIZER_URLS[tokenizerType];
            if (!tokenizerEndpoints) {
                console.warn('Unknown tokenizer type', tokenizerType);
                return [];
            }
            let endpointUrl = tokenizerEndpoints.encode;
            if (!endpointUrl) {
                console.warn('This tokenizer type does not support encoding', tokenizerType);
                return [];
            }
            if (tokenizerType === tokenizers.OPENAI) {
                endpointUrl += `?model=${getTokenizerModel()}`;
                return getTextTokensFromServer(endpointUrl, str, getOpenAIRouteHeaders());
            }
            return getTextTokensFromServer(endpointUrl, str);
        }
    }
}

/**
 * Decodes token ids to text using the server API.
 * @param {number} tokenizerType Tokenizer type.
 * @param {number[]} ids Array of token ids
 * @returns {({ text: string, chunks?: string[] })} Decoded token text as a single string and individual chunks (if available).
 */
export function decodeTextTokens(tokenizerType, ids) {
    // Currently, neither remote API can decode, but this may change in the future. Put this guard here to be safe
    if (tokenizerType === tokenizers.API_CURRENT) {
        return decodeTextTokens(tokenizers.NONE, ids);
    }
    if (REGISTRY_TOKENIZERS.includes(tokenizerType)) {
        return decodeTextTokensFromExplicit(tokenizerType, ids);
    }
    const tokenizerEndpoints = TOKENIZER_URLS[tokenizerType];
    if (!tokenizerEndpoints) {
        console.warn('Unknown tokenizer type', tokenizerType);
        return { text: '', chunks: [] };
    }
    let endpointUrl = tokenizerEndpoints.decode;
    if (!endpointUrl) {
        console.warn('This tokenizer type does not support decoding', tokenizerType);
        return { text: '', chunks: [] };
    }
    if (tokenizerType === tokenizers.OPENAI) {
        endpointUrl += `?model=${getTokenizerModel()}`;
        return decodeTextTokensFromServer(endpointUrl, ids, getOpenAIRouteHeaders());
    }
    return decodeTextTokensFromServer(endpointUrl, ids);
}

/**
 * Decodes token ids to text with the tokenizer the server resolves for the API's on-screen state.
 * @param {number[]} ids Array of token ids
 * @param {string} [api] Main API. Defaults to the current one.
 * @returns {({ text: string, chunks: string[] })} Decoded token text as a single string and individual chunks. Empty on failure.
 */
export function decodeCurrentTokens(ids, api = main_api) {
    const state = getTokenizerState(api);
    if (!state) {
        return { text: '', chunks: [] };
    }
    const data = postCurrent('decode', { state, ids }, false);
    rememberTokenizer(JSON.stringify(state), data?.tokenizer);
    return { text: typeof data?.text === 'string' ? data.text : '', chunks: Array.isArray(data?.chunks) ? data.chunks : [] };
}

/**
 * Trims text to a token limit with the tokenizer the server resolves for the on-screen state.
 * @param {string} text Text to trim.
 * @param {number} limit Maximum number of tokens to keep.
 * @param {string} direction `start` keeps the first tokens, anything else the last.
 * @returns {Promise<{ text: string, tokenizer: CurrentTokenizer|null }|null>} The trimmed text and the tokenizer that trimmed it; null on failure.
 */
export async function trimCurrentTokens(text, limit, direction) {
    const state = getTokenizerState();
    if (!state) {
        return null;
    }
    const data = await postCurrent('trim', { state, text, limit, direction }, true);
    rememberTokenizer(JSON.stringify(state), data?.tokenizer);
    if (typeof data?.text !== 'string') {
        return null;
    }
    return { text: data.text, tokenizer: data.tokenizer ?? null };
}

export async function initTokenizers() {
    TEXTGEN_TOKENIZERS.push(
        textgen_types.OOBA,
        textgen_types.TABBY,
        textgen_types.KOBOLDCPP,
        textgen_types.LLAMACPP,
        textgen_types.VLLM,
        textgen_types.APHRODITE,
    );

    eventSource.on(event_types.CHAT_CHANGED, () => countCache.clear());

    // The inputs the server's answer depends on. Delegated, so each runs after the control's own
    // handler has updated its setting.
    for (const event of [
        event_types.ONLINE_STATUS_CHANGED,
        event_types.CHATCOMPLETION_SOURCE_CHANGED,
        event_types.CHATCOMPLETION_MODEL_CHANGED,
        event_types.CONNECTION_PROFILE_LOADED,
    ]) {
        eventSource.on(event, refreshCurrentTokenizer);
    }
    $(document).on('change', '#main_api, #textgen_type, #model_novel_select, #horde_model, #tokenizer', refreshCurrentTokenizer);
    $(document).on('input', [...Object.values(SERVER_INPUTS), '#custom_api_url_text'].join(', '), refreshCurrentTokenizerDebounced);
    $(document).on('input change', '#banned_tokens_textgenerationwebui, #global_banned_tokens_textgenerationwebui, #send_banned_tokens_textgenerationwebui, #nai_banned_tokens', prefetchEntryTokenIdsDebounced);

    void removeStoredTokenCache();
    void refreshCurrentTokenizer();
}
