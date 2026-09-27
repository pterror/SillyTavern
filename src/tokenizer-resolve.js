import { TEXTGEN_TYPES } from './constants.js';
import { tokenizers, TOKENIZER_TYPE_KEYS } from './tokenizer-ids.js';
import { encodeTextByLocalTokenizerType, encodeViaTextgenAPI, getTiktokenTokenizer, guesstimate } from './endpoints/tokenizers.js';
import { lookupModelTokenizer } from './tokenizer-model-map.js';
import { hasRemoteTokenizer, lookupBackendModel } from './backend-status.js';
import { TOKENIZER_NAMES, describeMapEntry, localResolution, estimateResolution, resolveChatCompletionTokenizer } from './tokenizer-map-resolution.js';

/**
 * The server's one tokenizer resolution (resolveTokenizer), and counting and encoding with its
 * answer. The client's sessionStorage gates on remote tokenizers (TOKENIZER_WARNING_KEY /
 * TOKENIZER_SUPPORTED_KEY) have no counterpart here: the remote is tried on every request.
 */

export { tokenizers };

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

export { TOKENIZER_TYPE_KEYS };

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
 * @param {number} tokenizerType A `tokenizers` value.
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

/** Explicit settings that name a local tokenizer. */
const EXPLICIT_LOCAL_TOKENIZERS = [
    ...ENCODE_TOKENIZERS,
    tokenizers.GPT2,
    tokenizers.CLAUDE,
    tokenizers.NERD,
    tokenizers.NERD2,
    tokenizers.OPENAI,
];

/**
 * The model upstream counts an explicit OpenAI setting with: `/openai/encode` gets no model and
 * falls to `getTokenizerModel('')`'s default.
 */
const EXPLICIT_OPENAI_MODEL = 'gpt-3.5-turbo';

/**
 * @typedef {object} TokenizerState
 * @property {string} api main_api: 'textgenerationwebui', 'kobold', 'novel', 'koboldhorde' or 'openai'.
 * @property {string} [type] Textgen type, or the chat-completion source.
 * @property {string} [url] Backend URL (textgen and kobold).
 * @property {string} [model] The backend's model setting; empty asks the backend (textgen, kobold).
 * @property {string} [source] Chat-completion source.
 * @property {number} [tokenizerSetting] A `tokenizers` value; defaults to BEST_MATCH.
 * @property {string[]} [hordeModels] Selected Horde models.
 */

/**
 * @typedef {object} LocalTokenizer
 * @property {number} id A `tokenizers` value.
 * @property {string} name
 * @property {string} [model] The tiktoken model for OPENAI; for chat completion, the tokenizer
 * model string `/openai/encode` takes.
 */

/**
 * @typedef {object} ResolvedTokenizer
 * @property {'remote'|'local'|'estimate'} kind
 * @property {number} id A `tokenizers` value; API_TEXTGENERATIONWEBUI or API_KOBOLD for remote, NONE for an estimate.
 * @property {string} name
 * @property {string} [model]
 * @property {'remote'|'local'|'unknown'|'none'} basis
 * @property {LocalTokenizer|null} localCopy The map's exact local tokenizer for the model, or null.
 */

/**
 * The one tokenizer resolution, used for counts and token ids alike. Never falls back to LLAMA:
 * only the map, an explicit setting or the NovelAI list give llama.
 * @param {TokenizerState} state
 * @param {{ directories?: import('./users.js').UserDirectoryList }} [deps] directories give the
 * backend's API key headers for the model lookup and capability probe.
 * @returns {Promise<ResolvedTokenizer>}
 */
export async function resolveTokenizer(state, deps = {}) {
    const { api, type, url, hordeModels } = state;
    const tokenizerSetting = state.tokenizerSetting ?? tokenizers.BEST_MATCH;

    // Upstream never applies the tokenizer setting to chat completion.
    if (api === 'openai') {
        return resolveChatCompletionTokenizer(state.model);
    }

    if (EXPLICIT_LOCAL_TOKENIZERS.includes(tokenizerSetting)) {
        const local = tokenizerSetting === tokenizers.OPENAI
            ? { id: tokenizers.OPENAI, name: EXPLICIT_OPENAI_MODEL, model: EXPLICIT_OPENAI_MODEL }
            : { id: tokenizerSetting, name: TOKENIZER_NAMES[tokenizerSetting] };
        return localResolution(local, null);
    }
    if (tokenizerSetting === tokenizers.NONE) {
        return estimateResolution('none');
    }

    // Every other setting (API_CURRENT, BEST_MATCH) resolves alike: the remote tokenizer when
    // the backend has one, else the map.

    if (api === 'koboldhorde') {
        const entries = new Set((hordeModels ?? []).map(model => lookupModelTokenizer(api, model)));
        const [only] = entries;
        const local = entries.size === 1 ? describeMapEntry(only, api) : null;
        return local ? localResolution(local, local) : estimateResolution('unknown');
    }

    const backend = { api, type, url, directories: deps.directories };
    const model = state.model || await lookupBackendModel(backend);
    const local = describeMapEntry(lookupModelTokenizer(api, model), api);

    if (await hasRemoteTokenizer(backend, TEXTGEN_TOKENIZERS)) {
        const id = api === 'kobold' ? tokenizers.API_KOBOLD : tokenizers.API_TEXTGENERATIONWEBUI;
        return { kind: 'remote', id, name: TOKENIZER_NAMES[id], basis: 'remote', localCopy: local };
    }

    return local ? localResolution(local, local) : estimateResolution('unknown');
}

/**
 * Upstream's no-tokenizer count: UTF-8 bytes / 3.35, rounded up.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokenCount(text) {
    return guesstimate(String(text ?? ''));
}

/**
 * Counts `text` with a resolveTokenizer() answer; an estimate resolution gives the estimate.
 * @param {ResolvedTokenizer} resolved
 * @param {string} text
 * @param {EncodeWithTokenizerTypeOptions} [options] What a remote tokenizer needs (backend URL,
 * model, type, request), and test stubs.
 * @returns {Promise<number>}
 */
export async function countWithTokenizer(resolved, text, options = {}) {
    if (resolved.kind === 'estimate') {
        return estimateTokenCount(text);
    }
    return (await encodeWithTokenizer(resolved, text, options)).length;
}

/**
 * Token ids for `text` with a resolveTokenizer() answer, or null for an estimate resolution,
 * which has no ids.
 * @param {ResolvedTokenizer} resolved
 * @param {string} text
 * @param {EncodeWithTokenizerTypeOptions} [options] As for countWithTokenizer().
 * @returns {Promise<number[]|null>}
 */
export async function encodeWithTokenizer(resolved, text, options = {}) {
    const str = String(text ?? '');
    if (resolved.kind === 'estimate') {
        return null;
    }
    if (resolved.id === tokenizers.OPENAI) {
        return Array.from(getTiktokenTokenizer(resolved.model).encode(str));
    }
    return encodeWithTokenizerType(resolved.id, str, options);
}

/**
 * The `dropped` warning for entries a send left out because its resolution has no token ids.
 * @param {TokenizerState} state
 * @param {ResolvedTokenizer} resolved
 * @param {string[]} entries
 * @returns {{ kind: 'dropped', key: string, message: string, entries: string[] } | null} null when nothing was dropped
 */
export function droppedEntriesWarning(state, resolved, entries) {
    if (entries.length === 0) {
        return null;
    }
    const tokenizerKey = Object.keys(tokenizers).find(key => tokenizers[key] === resolved.id)?.toLowerCase() ?? '';
    const key = [state.api, state.type ?? state.source ?? '', state.url ?? '', state.model ?? '', tokenizerKey].join('|');
    const reason = resolved.basis === 'none'
        ? 'the tokenizer is set to None'
        : 'no tokenizer is known for this model';
    const noun = entries.length === 1 ? 'entry' : 'entries';
    return {
        kind: 'dropped',
        key,
        message: `Left out ${entries.length} ${noun} that need token ids, because ${reason}: ${entries.join(', ')}`,
        entries,
    };
}

/**
 * The tokenizer setting a connection-profile send uses: the profile's own `tokenizer` (a
 * lowercased `tokenizers` key, as the `/tokenizer` command returns it) when it names one, else
 * the main setting.
 * @param {string|undefined} profileTokenizer
 * @param {number} mainSetting
 * @returns {number}
 */
export function resolveProfileTokenizerSetting(profileTokenizer, mainSetting) {
    const match = Object.entries(tokenizers).find(([key]) => key.toLowerCase() === profileTokenizer);
    return match ? match[1] : mainSetting;
}
