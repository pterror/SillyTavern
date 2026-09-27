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
 * @property {TokenizerOutcome} [outcome] Records what encodeWithTokenizer()/countWithTokenizer()
 * fell back to, for one request's warnings and basis.
 */

/** A remote tokenizer answered with an HTTP error, a network error or a reply without token ids. */
export class TokenizerFailure extends Error {}

/**
 * Token ids from one `tokenizers` type, with no fallback: a remote failure throws a
 * TokenizerFailure and a local tokenizer's own error propagates. encodeWithTokenizer() decides
 * what a failure becomes.
 *
 * OPENAI and GPT2 both encode with tiktoken's gpt2 here; an OPENAI resolution with a model is
 * encoded with that model's tiktoken by encodeWithTokenizer() before reaching this.
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
        // encodeViaTextgenAPI() shapes a reply with no token list as `ids: []` with no count.
        if (result && !('error' in result) && Array.isArray(result.ids) && typeof result.count === 'number') {
            return result.ids;
        }
        throw new TokenizerFailure(`The ${textgenApiType ?? 'text completion'} backend's tokenizer failed`);
    }

    if (tokenizerType === tokenizers.API_KOBOLD) {
        let url = String(koboldBaseUrl ?? '').replace(/\/$/, '');
        url += '/extra/tokencount';
        let result;
        try {
            result = await fetchImpl(url, {
                method: 'POST',
                body: JSON.stringify({ prompt: text }),
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (error) {
            throw new TokenizerFailure(`The KoboldAI backend's tokenizer failed: ${error.message}`);
        }
        if (!result.ok) {
            throw new TokenizerFailure(`The KoboldAI backend's tokenizer failed: ${result.status} ${result.statusText}`);
        }
        const data = await result.json().catch(() => null);
        if (!Array.isArray(data?.ids)) {
            throw new TokenizerFailure('The KoboldAI backend\'s tokenizer gave no token ids');
        }
        return data.ids;
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
 * @property {'remote'|'local'|'unknown'|'none'|'fallback'|'failed'} basis resolveTokenizer() gives
 * the first four; `fallback` (the local copy answered after a failure) and `failed` (no tokenizer
 * answered, so the estimate and no ids) describe one request's outcome, from tokenizerOutcomeBasis().
 * @property {LocalTokenizer|null} localCopy The map's exact local tokenizer for the model, or null.
 * The only fallback when the tokenizer fails.
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
 * What one request's counts and encodes fell back to. Nothing outlives the request: the next one
 * tries the tokenizer again.
 * @typedef {object} TokenizerOutcome
 * @property {LocalTokenizer|null} usedCopy The local copy that answered for a failed remote tokenizer.
 * @property {boolean} failed Some count or encode had no tokenizer: the estimate, or no ids.
 * @property {boolean} countEstimated Some count fell to the estimate.
 */

/** @returns {TokenizerOutcome} */
export function createTokenizerOutcome() {
    return { usedCopy: null, failed: false, countEstimated: false };
}

/**
 * The basis one request's counts and ids actually had.
 * @param {ResolvedTokenizer} resolved
 * @param {TokenizerOutcome} outcome
 * @returns {ResolvedTokenizer['basis']}
 */
export function tokenizerOutcomeBasis(resolved, outcome) {
    if (outcome.failed) return 'failed';
    if (outcome.usedCopy) return 'fallback';
    return resolved.basis;
}

/**
 * Counts `text` with a resolveTokenizer() answer; an estimate resolution gives the estimate, as
 * does a tokenizer that fails with no local copy to answer for it.
 * @param {ResolvedTokenizer} resolved
 * @param {string} text
 * @param {EncodeWithTokenizerTypeOptions} [options] What a remote tokenizer needs (backend URL,
 * model, type, request), the request's `outcome`, and test stubs.
 * @returns {Promise<number>}
 */
export async function countWithTokenizer(resolved, text, options = {}) {
    if (resolved.kind === 'estimate') {
        return estimateTokenCount(text);
    }
    const ids = await encodeWithTokenizer(resolved, text, options);
    if (ids === null) {
        if (options.outcome) options.outcome.countEstimated = true;
        return estimateTokenCount(text);
    }
    return ids.length;
}

/**
 * Token ids for `text` with a resolveTokenizer() answer, or null when there are none: an estimate
 * resolution, or a tokenizer that failed (a remote failure, or a local tokenizer that throws) with
 * no local copy to answer for it. Every call tries the tokenizer again.
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
    const { outcome } = options;
    try {
        return await encodeWithLocalOrType(resolved, str, options);
    } catch (error) {
        console.warn(`Tokenizer ${resolved.name} failed:`, error.message);
    }
    if (resolved.kind === 'remote' && resolved.localCopy) {
        try {
            const ids = await encodeWithLocalOrType(resolved.localCopy, str, options);
            if (outcome) outcome.usedCopy = resolved.localCopy;
            return ids;
        } catch (error) {
            console.warn(`Tokenizer ${resolved.localCopy.name} failed:`, error.message);
        }
    }
    if (outcome) outcome.failed = true;
    return null;
}

/**
 * @param {{id: number, model?: string}} tokenizer A resolution or a LocalTokenizer.
 * @param {string} text
 * @param {EncodeWithTokenizerTypeOptions} options
 * @returns {Promise<number[]>}
 */
async function encodeWithLocalOrType(tokenizer, text, options) {
    if (tokenizer.id === tokenizers.OPENAI) {
        return Array.from(getTiktokenTokenizer(tokenizer.model).encode(text));
    }
    return encodeWithTokenizerType(tokenizer.id, text, options);
}

/**
 * The `key` of every warning about this resolution: `api|type-or-source|url|model|tokenizer`.
 * @param {TokenizerState} state
 * @param {ResolvedTokenizer} resolved
 * @returns {string}
 */
function tokenizerWarningKey(state, resolved) {
    const tokenizerKey = Object.keys(tokenizers).find(key => tokenizers[key] === resolved.id)?.toLowerCase() ?? '';
    return [state.api, state.type ?? state.source ?? '', state.url ?? '', state.model ?? '', tokenizerKey].join('|');
}

/**
 * The `dropped` warning for entries a send left out because it had no token ids for them.
 * @param {TokenizerState} state
 * @param {ResolvedTokenizer} resolved
 * @param {string[]} entries
 * @returns {{ kind: 'dropped', key: string, message: string, entries: string[] } | null} null when nothing was dropped
 */
export function droppedEntriesWarning(state, resolved, entries) {
    if (entries.length === 0) {
        return null;
    }
    const noun = entries.length === 1 ? 'entry' : 'entries';
    return {
        kind: 'dropped',
        key: tokenizerWarningKey(state, resolved),
        message: `Left out ${entries.length} ${noun} that need token ids, because ${droppedReason(resolved)}: ${entries.join(', ')}`,
        entries,
    };
}

/**
 * @param {ResolvedTokenizer} resolved
 * @returns {string}
 */
function droppedReason(resolved) {
    if (resolved.basis === 'none') return 'the tokenizer is set to None';
    if (resolved.kind === 'estimate') return 'no tokenizer is known for this model';
    if (resolved.kind === 'remote') return 'the backend\'s tokenizer failed and no local copy is known for this model';
    return `the ${resolved.name} tokenizer failed`;
}

/**
 * Every warning one server-built send carries about its tokenizer: `fallback-copy` when a local
 * copy answered for a failed remote tokenizer, `trim-estimate` when a failure left a count to the
 * estimate, and `dropped` for the entries it had no ids for.
 * @param {TokenizerState} state
 * @param {ResolvedTokenizer} resolved
 * @param {TokenizerOutcome} outcome
 * @param {string[]} droppedEntries
 * @returns {Array<{kind: string, key: string, message: string, entries?: string[]}>}
 */
export function sendTokenizerWarnings(state, resolved, outcome, droppedEntries) {
    const key = tokenizerWarningKey(state, resolved);
    const warnings = [];
    if (outcome.usedCopy) {
        warnings.push({
            kind: 'fallback-copy',
            key,
            message: `The backend's tokenizer failed, so its local copy, ${outcome.usedCopy.name}, was used.`,
        });
    }
    if (outcome.countEstimated) {
        warnings.push({
            kind: 'trim-estimate',
            key,
            message: `${failedTokenizerName(resolved)} failed, so the prompt was fitted to the context by an estimated token count.`,
        });
    }
    const dropped = droppedEntriesWarning(state, resolved, droppedEntries);
    if (dropped) {
        warnings.push(dropped);
    }
    return warnings;
}

/**
 * @param {ResolvedTokenizer} resolved
 * @returns {string}
 */
function failedTokenizerName(resolved) {
    return resolved.kind === 'remote' ? 'The backend\'s tokenizer' : `The ${resolved.name} tokenizer`;
}

/**
 * The `tokenizer` a `/api/tokenizers/current/*` response names: the tokenizer that answered (the
 * local copy when it answered for a failed remote one), the request's basis, and the `key` its
 * warnings carry.
 * @param {TokenizerState} state
 * @param {ResolvedTokenizer} resolved
 * @param {TokenizerOutcome} outcome
 * @returns {{ id: number, name: string, model?: string, basis: ResolvedTokenizer['basis'], key: string }}
 */
export function tokenizerAnswer(state, resolved, outcome) {
    const used = outcome.usedCopy ?? resolved;
    const answer = { id: used.id, name: used.name, basis: tokenizerOutcomeBasis(resolved, outcome), key: tokenizerWarningKey(state, resolved) };
    if (used.model) {
        answer.model = used.model;
    }
    return answer;
}

/**
 * The warnings a `/api/tokenizers/current/*` response carries: `fallback-copy` when a local copy
 * answered for a failed remote tokenizer, `estimate` when a tokenizer failed with none to answer.
 * @param {TokenizerState} state
 * @param {ResolvedTokenizer} resolved
 * @param {TokenizerOutcome} outcome
 * @returns {Array<{kind: string, key: string, message: string}>}
 */
export function tokenizerResponseWarnings(state, resolved, outcome) {
    const key = tokenizerWarningKey(state, resolved);
    const warnings = [];
    if (outcome.usedCopy) {
        warnings.push({
            kind: 'fallback-copy',
            key,
            message: `The backend's tokenizer failed, so its local copy, ${outcome.usedCopy.name}, was used.`,
        });
    }
    if (outcome.failed) {
        warnings.push({
            kind: 'estimate',
            key,
            message: `${failedTokenizerName(resolved)} failed, so token counts are estimates.`,
        });
    }
    return warnings;
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
