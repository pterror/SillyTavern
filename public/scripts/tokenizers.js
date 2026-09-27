import { localforage } from '../lib.js';
import { nai_settings } from '../script.js';
import { main_api } from './generation-params.js';
import { event_types, eventSource } from './events.js';
import { power_user } from './power-user.js';
import { getChatCompletionModel, oai_settings } from './chat-completion-settings.js';
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
 * @property {{ dropped?: { one: string, many: string } }} [messages] Server-built wording, with
 * `{count}` and `{entries}` for the browser to fill in.
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
        case 'openai':
            return { api, source: oai_settings.chat_completion_source, model: getChatCompletionModel() ?? '', tokenizerSetting: power_user.tokenizer };
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
    if (async) {
        return Promise.resolve(jQuery.ajax(request)).catch((error) => {
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
 * Gets the friendly name of the current tokenizer.
 * @param {string} forApi API to get the tokenizer for. Defaults to the main API.
 * @returns {Tokenizer} Tokenizer info
 */
export function getFriendlyTokenizerName(forApi) {
    if (!forApi) {
        forApi = main_api;
    }

    if (forApi === 'openai') {
        return { tokenizerName: getTokenizerModel(), tokenizerKey: getTokenizerKey(tokenizers.OPENAI), tokenizerId: tokenizers.OPENAI };
    }

    const tokenizer = forApi === main_api ? getCurrentTokenizerSync() : askTokenizerSync(getTokenizerState(forApi));
    const tokenizerId = tokenizer?.id ?? tokenizers.NONE;
    const tokenizerName = tokenizer?.name ?? $(`#tokenizer option[value="${tokenizers.NONE}"]`).text();
    return { tokenizerName, tokenizerKey: getTokenizerKey(tokenizerId), tokenizerId };
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
 * @returns {number[]|Promise<number[]>}
 */
function countTexts(strings, padding, async) {
    const results = new Array(strings.length).fill(0);
    const tokenizer = getRememberedTokenizer();
    /** @type {number[]} */
    const pending = [];

    for (let i = 0; i < strings.length; i++) {
        const str = strings[i];
        if (typeof str !== 'string' || !str.length) {
            continue;
        }
        const cached = tokenizer ? countCache.get(`${tokenizer.key}-${getStringHash(str)}+${padding}`) : undefined;
        if (typeof cached === 'number') {
            results[i] = cached;
        } else {
            pending.push(i);
        }
    }

    if (pending.length === 0) {
        return async ? Promise.resolve(results) : results;
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
                countCache.set(`${answered.key}-${getStringHash(strings[i])}+${padding}`, count);
            }
        });
        return results;
    };
    const body = { state, texts: pending.map(i => strings[i]), padding };
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
    return countTexts(strings, padding, true);
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

    const [count] = await countTexts([str], padding ?? 0, true);
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

    const [count] = /** @type {number[]} */ (countTexts([str], padding ?? 0, false));
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
 * @returns {number[]} Array of token ids.
 */
function getTextTokensFromServer(endpoint, str) {
    let ids = [];
    jQuery.ajax({
        async: false,
        type: 'POST',
        url: endpoint,
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
 * Encodes a string with the current state's tokenizer through `/current/encode`.
 * @param {string} str String to tokenize.
 * @returns {number[]} Array of token ids; empty when the tokenizer has none for it.
 */
function getTextTokensFromCurrent(str) {
    const state = getTokenizerState();
    if (!state) {
        return [];
    }
    const data = postCurrent('encode', { state, texts: [str] }, false);
    rememberTokenizer(JSON.stringify(state), data?.tokenizer);
    return Array.isArray(data?.ids?.[0]) ? data.ids[0] : [];
}

/**
 * Calls the underlying tokenizer model to decode token ids to text.
 * @param {string} endpoint API endpoint.
 * @param {number[]} ids Array of token ids
 * @returns {({ text: string, chunks?: string[] })} Decoded token text as a single string and individual chunks (if available).
 */
function decodeTextTokensFromServer(endpoint, ids) {
    let text = '';
    let chunks = [];
    jQuery.ajax({
        async: false,
        type: 'POST',
        url: endpoint,
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
    }
    return decodeTextTokensFromServer(endpointUrl, ids);
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
    $(document).on('input', Object.values(SERVER_INPUTS).join(', '), refreshCurrentTokenizerDebounced);
    $(document).on('input change', '#banned_tokens_textgenerationwebui, #global_banned_tokens_textgenerationwebui, #send_banned_tokens_textgenerationwebui, #nai_banned_tokens', prefetchEntryTokenIdsDebounced);

    void removeStoredTokenCache();
    void refreshCurrentTokenizer();
}
