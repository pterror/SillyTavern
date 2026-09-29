import crypto from 'node:crypto';

import { TEXTGEN_TYPES } from './constants.js';
import { tokenizers, TOKENIZER_TYPE_KEYS } from './tokenizer-ids.js';
import { encodeTextByLocalTokenizerType, encodeViaTextgenAPI, getBytePieceChunks, getLocalTokenizerFileIdentity, getTiktokenIdentity, getTiktokenTokenizer, guesstimate } from './endpoints/tokenizers.js';
import { lookupModelTokenizer, mapResultKey } from './tokenizer-model-map.js';
import { hasRemoteTokenizer, lookupBackendModel } from './backend-status.js';
import { llamaCppPropsModelName, textgenLlamaCppBackend } from './llamacpp-props.js';
import { TOKENIZER_NAMES, describeMapEntry, describeTokenizerId, localResolution, estimateResolution, resolveChatCompletionTokenizer, selectBackendResult, selectModelResult } from './tokenizer-map-resolution.js';
import { findTokenizerSource } from './tokenizer-sources.js';
import { loadRegistryTokenizer } from './tokenizer-loader.js';

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
 * fell back to and which tokenizer files they downloaded, for one request's warnings and basis.
 * @property {import('./users.js').UserDirectoryList} [directories] The requesting user's directories,
 * for their saved Hugging Face token when a registry entry's file is downloaded. Defaults to
 * `request.user.directories`.
 * @property {import('./tokenizer-loader.js').RegistryTokenizerOptions['registry']} [registry]
 * Replaces the tokenizer registry, for tests.
 * @property {import('./tokenizer-loader.js').RegistryTokenizerOptions['loadPinned']} [loadPinned]
 * Replaces the registry file loader, for tests.
 * @property {boolean} [promptStart] The text begins the prompt a generation sends. llama.cpp's
 * `/tokenize` then puts BOS in as the generation does (`add_special`); whether that backend adds BOS
 * depends on the loaded gguf, so when it fails no local copy answers for it.
 * @property {{ pieces?: Array<string|number[]> }} [piecesOut] Asks llama.cpp's `/tokenize` for each
 * token's piece, and receives them when it answers.
 * @property {{ tokenizer?: ResolvedTokenizer|LocalTokenizer|null }} [answeredOut] Receives the tokenizer
 * that gave this call's ids or count: the resolution, its local copy when that answered for a failed
 * remote one, or null for the estimate. Per call, because a request's outcome only says a copy answered
 * some call.
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
        const llamaCpp = textgenApiType === TEXTGEN_TYPES.LLAMACPP ? llamaCppTokenizeOptions(options) : undefined;
        return remoteIds(await encodeTextgenRemote(request, text, textgenBaseUrl, textgenModel, textgenApiType, llamaCpp), textgenApiType, options);
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
    if (key && findTokenizerSource(key, options.registry)) {
        return encodeWithRegistryEntry(key, text, options);
    }
    if (key) {
        return encodeLocal(key, text);
    }

    throw new Error(`Unsupported tokenizer type for encoding: ${tokenizerType}`);
}

/**
 * The `/tokenize` fields llama.cpp gets for these options, or undefined for upstream's request.
 * @param {EncodeWithTokenizerTypeOptions} options
 * @returns {{ addSpecial?: boolean, withPieces?: boolean }|undefined}
 */
function llamaCppTokenizeOptions(options) {
    const fields = {
        ...(options.promptStart ? { addSpecial: true } : {}),
        ...(options.piecesOut ? { withPieces: true } : {}),
    };
    return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * @param {any} result An encodeViaTextgenAPI() answer
 * @param {string|undefined} apiType
 * @param {EncodeWithTokenizerTypeOptions} options
 * @returns {number[]}
 */
function remoteIds(result, apiType, options) {
    // encodeViaTextgenAPI() shapes a reply with no token list as `ids: []` with no count.
    if (result && !('error' in result) && Array.isArray(result.ids) && typeof result.count === 'number') {
        if (options.piecesOut && Array.isArray(result.pieces)) {
            options.piecesOut.pieces = result.pieces;
        }
        return result.ids;
    }
    throw new TokenizerFailure(`The ${apiType ?? 'text completion'} backend's tokenizer failed`);
}

/**
 * Whether the resolution's tokenizer is llama.cpp's `/tokenize`.
 * @param {ResolvedTokenizer} resolved
 * @param {EncodeWithTokenizerTypeOptions} options
 * @returns {boolean}
 */
function isLlamaCppTokenizer(resolved, options) {
    return resolved.kind === 'remote'
        && (!!resolved.llamaCpp || (resolved.id === tokenizers.API_TEXTGENERATIONWEBUI && options.textgenApiType === TEXTGEN_TYPES.LLAMACPP));
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
 * Token ids from a registry entry's tokenizer, recording a download of its file in the request's outcome.
 * @param {string} source A registry entry id
 * @param {string} text
 * @param {EncodeWithTokenizerTypeOptions} options
 * @returns {Promise<number[]>}
 */
async function encodeWithRegistryEntry(source, text, options) {
    const tokenizer = await loadRegistryTokenizer(source, {
        directories: options.directories ?? options.request?.user?.directories,
        outcome: options.outcome,
        registry: options.registry,
        loadPinned: options.loadPinned,
    });
    return Array.from(await tokenizer.encode(text));
}

/**
 * The model upstream counts an explicit OpenAI setting with: `/openai/encode` gets no model and
 * falls to `getTokenizerModel('')`'s default.
 */
const EXPLICIT_OPENAI_MODEL = 'gpt-3.5-turbo';

/** @typedef {import('./connection-state-header.js').TokenizerState} TokenizerState */

/**
 * @typedef {object} LocalTokenizer
 * @property {number} id A `tokenizers` value.
 * @property {string} [source] A registry entry id (src/tokenizer-sources.js), for a registry entry.
 * @property {string} name
 * @property {string} [model] The tiktoken model for OPENAI; for chat completion, the tokenizer
 * model string `/openai/encode` takes.
 */

/**
 * @typedef {object} ResolvedTokenizer
 * @property {'remote'|'local'|'estimate'} kind
 * @property {number} id A `tokenizers` value; API_TEXTGENERATIONWEBUI or API_KOBOLD for remote, NONE for an estimate.
 * @property {string} [source] A registry entry id, for a local registry entry.
 * @property {string} name
 * @property {string} [model]
 * @property {'remote'|'local'|'unknown'|'none'|'fallback'|'failed'} basis resolveTokenizer() gives
 * the first four; `fallback` (the local copy answered after a failure) and `failed` (no tokenizer
 * answered, so the estimate and no ids) describe one request's outcome, from tokenizerOutcomeBasis().
 * @property {LocalTokenizer|null} localCopy The map's exact local tokenizer for the model, or null.
 * The only fallback when the tokenizer fails.
 * @property {import('./custom-llamacpp.js').CustomLlamaCppEndpoint & { model: string }} [llamaCpp] A
 * chat-completion custom URL that is llama.cpp: where its `/tokenize` is and the model setting it gets.
 */

/**
 * Whether `value` is an explicit pick (rule 1): a local tokenizer or NONE.
 * @param {unknown} value
 * @returns {value is number}
 */
export function isExplicitTokenizer(value) {
    return EXPLICIT_LOCAL_TOKENIZERS.includes(/** @type {number} */ (value)) || value === tokenizers.NONE;
}

/**
 * Rule 1: an explicit pick resolves to that local tokenizer, or to the estimate for NONE.
 * @param {number} id An id isExplicitTokenizer() accepts.
 * @param {import('./tokenizer-map-resolution.js').MapDeps['registry']} registry
 * @returns {ResolvedTokenizer}
 */
function resolveExplicitSetting(id, registry) {
    if (id === tokenizers.NONE) {
        return estimateResolution('none');
    }
    const local = id === tokenizers.OPENAI
        ? { id: tokenizers.OPENAI, name: EXPLICIT_OPENAI_MODEL, model: EXPLICIT_OPENAI_MODEL }
        : describeTokenizerId(id, registry);
    return localResolution(local, null);
}

/**
 * The one tokenizer resolution, used for counts and token ids alike. Never falls back to LLAMA:
 * only the map, an explicit setting or the NovelAI list give llama.
 * @param {TokenizerState} state
 * @param {{ directories?: import('./users.js').UserDirectoryList, customIncludeHeaders?: string, llamaCppProps?: import('./llamacpp-props.js').LlamaCppPropsCheck } & import('./tokenizer-map-resolution.js').MapDeps} [deps]
 * directories give the backend's API key headers for the model lookup and capability probe;
 * customIncludeHeaders are a server-built chat-completion send's custom headers, its macros substituted.
 * llamaCppProps asks a llama.cpp backend's `/props`, for its identity (tokenizerIdentity()) and, when
 * the model setting is empty and the reply has `model_alias`, its model name in place of `/v1/models`.
 * Without it, the name comes from `/v1/models` and nothing asks `/props`.
 * @returns {Promise<ResolvedTokenizer>}
 */
export async function resolveTokenizer(state, deps = {}) {
    const { api, type, url, hordeModels } = state;
    const tokenizerSetting = state.tokenizerSetting ?? tokenizers.BEST_MATCH;
    const { lookupModel = lookupModelTokenizer, registry } = deps;

    // A tokenizer the caller named outright, like a named route: before every other rule, on every api.
    if (isExplicitTokenizer(state.explicitTokenizer)) {
        return resolveExplicitSetting(state.explicitTokenizer, registry);
    }

    // Upstream never applies the tokenizer setting to chat completion.
    if (api === 'openai') {
        return resolveChatCompletionTokenizer(state.model, state.source, { ...deps, url: state.url });
    }

    if (isExplicitTokenizer(tokenizerSetting)) {
        return resolveExplicitSetting(tokenizerSetting, registry);
    }

    // Every other setting (API_CURRENT, BEST_MATCH) resolves alike: the remote tokenizer when
    // the backend has one, else the map.

    if (api === 'koboldhorde') {
        const results = (hordeModels ?? []).map(model => selectBackendResult(lookupModel(api, model), state));
        const keys = new Set(results.map(result => result === null ? null : mapResultKey(result)));
        const local = keys.size === 1 ? describeMapEntry(results[0], api, registry) : null;
        return local ? localResolution(local, local) : estimateResolution('unknown');
    }

    const backend = { api, type, url, directories: deps.directories };
    const props = api === 'textgenerationwebui' && type === TEXTGEN_TYPES.LLAMACPP && deps.llamaCppProps
        ? await deps.llamaCppProps.ask(textgenLlamaCppBackend(url, state.model ?? '', deps.directories))
        : undefined;
    const propsName = state.model ? undefined : llamaCppPropsModelName(props);
    const model = state.model || (propsName !== undefined ? propsName : await lookupBackendModel(backend));
    const local = describeMapEntry(await selectModelResult(api, model, state, deps), api, registry);

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
 * @property {Array<{ family: string, license: string }>} downloads The registry files this request downloaded.
 */

/** @returns {TokenizerOutcome} */
export function createTokenizerOutcome() {
    return { usedCopy: null, failed: false, countEstimated: false, downloads: [] };
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
 * What tokenizerIdentity() knows besides the tokenizer.
 * @typedef {object} TokenizerIdentityFacts
 * @property {string} [textgenApiType] One of TEXTGEN_TYPES, for a text-completion remote tokenizer.
 * @property {any} [llamaCppProps] The llama.cpp backend's parsed `GET /props` reply, asked for the
 * counts this identity is for.
 * @property {import('./tokenizer-map-resolution.js').MapDeps['registry']} [registry] Replaces the
 * tokenizer registry, for tests.
 */

/**
 * The name of the tokenizer a count or ids came from, for storing them: two tokenizers with the same
 * identity give the same ids for every text. null when there's none to trust, so nothing is stored:
 * - a registry entry: `file:<format>:<pinned sha256>`, and for the `tiktoken` format the sha256 of its
 *   config too, because entries that share a file read it differently;
 * - a bundled or downloaded file: getLocalTokenizerFileIdentity();
 * - tiktoken: getTiktokenIdentity();
 * - llama.cpp's `/tokenize`: `llamacpp:` and the JSON of `/props`' `[model_path, build_info]`, null
 *   when the reply is missing either, because llama.cpp says nothing else about the file it loaded
 *   and a new build can tokenize differently;
 * - every other remote tokenizer: null, because none reports anything tied to the file it loaded;
 * - the estimate, or no tokenizer: null.
 * For the tokenizer that answered a call, pass encodeWithTokenizer()'s `answeredOut.tokenizer`.
 * @param {ResolvedTokenizer|LocalTokenizer|null|undefined} tokenizer
 * @param {TokenizerIdentityFacts} [facts]
 * @returns {Promise<string|null>}
 */
export async function tokenizerIdentity(tokenizer, facts = {}) {
    if (!tokenizer || ('kind' in tokenizer && tokenizer.kind === 'estimate')) {
        return null;
    }
    const { id } = tokenizer;
    const isTextgenRemote = id === tokenizers.API_TEXTGENERATIONWEBUI || id === tokenizers.API_CURRENT;
    if (('llamaCpp' in tokenizer && tokenizer.llamaCpp) || (isTextgenRemote && facts.textgenApiType === TEXTGEN_TYPES.LLAMACPP)) {
        return llamaCppIdentity(facts.llamaCppProps);
    }
    if (isTextgenRemote || id === tokenizers.API_KOBOLD || id === tokenizers.NONE || ('kind' in tokenizer && tokenizer.kind === 'remote')) {
        return null;
    }
    try {
        if (tokenizer.source) {
            return registryIdentity(tokenizer.source, facts.registry);
        }
        if (id === tokenizers.OPENAI) {
            return getTiktokenIdentity(String(tokenizer.model));
        }
        if (id === tokenizers.GPT2) {
            return getTiktokenIdentity('gpt2');
        }
        const key = TOKENIZER_TYPE_KEYS[id];
        if (key && findTokenizerSource(key, facts.registry)) {
            return registryIdentity(key, facts.registry);
        }
        return key ? await getLocalTokenizerFileIdentity(key) : null;
    } catch (error) {
        console.warn(`No identity for the ${tokenizer.name} tokenizer:`, error.message);
        return null;
    }
}

/**
 * @param {any} props
 * @returns {string|null}
 */
function llamaCppIdentity(props) {
    const modelPath = props?.model_path;
    const buildInfo = props?.build_info;
    if (typeof modelPath !== 'string' || !modelPath || typeof buildInfo !== 'string' || !buildInfo) {
        return null;
    }
    return `llamacpp:${JSON.stringify([modelPath, buildInfo])}`;
}

/**
 * @param {string} source A registry entry id
 * @param {TokenizerIdentityFacts['registry']} registry
 * @returns {string|null}
 */
function registryIdentity(source, registry) {
    const entry = findTokenizerSource(source, registry);
    if (!entry) {
        return null;
    }
    const identity = `file:${entry.format}:${entry.sha256.toLowerCase()}`;
    if (!entry.tiktoken) {
        return identity;
    }
    return `${identity}:${crypto.createHash('sha256').update(JSON.stringify(entry.tiktoken)).digest('hex')}`;
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
        if (options.answeredOut) options.answeredOut.tokenizer = null;
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
    const { outcome, answeredOut } = options;
    if (answeredOut) answeredOut.tokenizer = null;
    if (resolved.kind === 'estimate') {
        return null;
    }
    try {
        const ids = await encodeWithLocalOrType(resolved, str, options);
        if (answeredOut) answeredOut.tokenizer = resolved;
        return ids;
    } catch (error) {
        console.warn(`Tokenizer ${resolved.name} failed:`, error.message);
    }
    const copyCanAnswer = !(options.promptStart && isLlamaCppTokenizer(resolved, options));
    if (resolved.kind === 'remote' && resolved.localCopy && copyCanAnswer) {
        try {
            const ids = await encodeWithLocalOrType(resolved.localCopy, str, options);
            if (outcome) outcome.usedCopy = resolved.localCopy;
            if (answeredOut) answeredOut.tokenizer = resolved.localCopy;
            return ids;
        } catch (error) {
            console.warn(`Tokenizer ${resolved.localCopy.name} failed:`, error.message);
        }
    }
    if (outcome) outcome.failed = true;
    return null;
}

/**
 * Token ids as encodeWithTokenizer() gives them, and the chunks llama.cpp's `/tokenize` names for them
 * when it is the tokenizer and answered: `chunks` is undefined for any other tokenizer, and null when
 * llama.cpp didn't answer.
 * @param {ResolvedTokenizer} resolved
 * @param {string} text
 * @param {EncodeWithTokenizerTypeOptions} [options]
 * @returns {Promise<{ ids: number[]|null, chunks?: string[]|null }>}
 */
export async function encodeWithTokenizerAndChunks(resolved, text, options = {}) {
    if (!isLlamaCppTokenizer(resolved, options)) {
        return { ids: await encodeWithTokenizer(resolved, text, options) };
    }
    /** @type {{ pieces?: Array<string|number[]> }} */
    const piecesOut = {};
    const ids = await encodeWithTokenizer(resolved, text, { ...options, piecesOut });
    return { ids, chunks: piecesOut.pieces ? getBytePieceChunks(piecesOut.pieces) : null };
}

/**
 * @param {{id: number, source?: string, model?: string, llamaCpp?: ResolvedTokenizer['llamaCpp']}} tokenizer A resolution or a LocalTokenizer.
 * @param {string} text
 * @param {EncodeWithTokenizerTypeOptions} options
 * @returns {Promise<number[]>}
 */
async function encodeWithLocalOrType(tokenizer, text, options) {
    if (tokenizer.llamaCpp) {
        const { url, model, headers } = tokenizer.llamaCpp;
        const { encodeTextgenRemote = encodeViaTextgenAPI } = options;
        const result = await encodeTextgenRemote(null, text, url, model, TEXTGEN_TYPES.LLAMACPP, { ...llamaCppTokenizeOptions(options), headers });
        return remoteIds(result, TEXTGEN_TYPES.LLAMACPP, options);
    }
    if (tokenizer.source) {
        return encodeWithRegistryEntry(tokenizer.source, text, options);
    }
    if (tokenizer.id === tokenizers.OPENAI) {
        return Array.from(getTiktokenTokenizer(tokenizer.model).encode(text));
    }
    return encodeWithTokenizerType(tokenizer.id, text, options);
}

/**
 * The `key` of every warning about this resolution: `api|type-or-source|url|model|tokenizer`. The
 * tokenizer part is the registry entry id when the resolution or its local copy is a registry entry,
 * because the model setting can be empty (llama.cpp), and then only the entry tells two models apart.
 * @param {TokenizerState} state
 * @param {ResolvedTokenizer} resolved
 * @returns {string}
 */
function tokenizerWarningKey(state, resolved) {
    const tokenizerKey = resolved.source
        ?? resolved.localCopy?.source
        ?? Object.keys(tokenizers).find(key => tokenizers[key] === resolved.id)?.toLowerCase()
        ?? '';
    return [state.api, state.type ?? state.source ?? '', state.url ?? '', state.model ?? '', tokenizerKey].join('|');
}

/**
 * A `license` warning for each registry file the request downloaded.
 * @param {string} key
 * @param {TokenizerOutcome} outcome
 * @returns {Array<{kind: 'license', key: string, message: string}>}
 */
function licenseWarnings(key, outcome) {
    return (outcome.downloads ?? []).map(({ family, license }) => ({
        kind: 'license',
        key,
        message: `Downloaded the ${family} tokenizer. License: ${license}`,
    }));
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
    const messages = droppedMessages(resolved);
    const template = entries.length === 1 ? messages.one : messages.many;
    const values = { count: String(entries.length), entries: entries.join(', ') };
    return {
        kind: 'dropped',
        key: tokenizerWarningKey(state, resolved),
        message: template.replace(/\{(count|entries)\}/g, (_, name) => values[name]),
        entries,
    };
}

/**
 * The `dropped` warning's wording for one entry and for several, with `{count}` and `{entries}`
 * left for the browser to fill in on the sends it builds.
 * @param {ResolvedTokenizer} resolved
 * @returns {{ one: string, many: string }}
 */
function droppedMessages(resolved) {
    const reason = droppedReason(resolved);
    return {
        one: `Left out {count} entry that need token ids, because ${reason}: {entries}`,
        many: `Left out {count} entries that need token ids, because ${reason}: {entries}`,
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
 * estimate, `dropped` for the entries it had no ids for, and `license` for each registry file it
 * downloaded.
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
            message: trimEstimateMessage(resolved),
        });
    }
    const dropped = droppedEntriesWarning(state, resolved, droppedEntries);
    if (dropped) {
        warnings.push(dropped);
    }
    warnings.push(...licenseWarnings(key, outcome));
    return warnings;
}

/**
 * @param {ResolvedTokenizer} resolved
 * @returns {string}
 */
function trimEstimateMessage(resolved) {
    return `${failedTokenizerName(resolved)} failed, so the prompt was fitted to the context by an estimated token count.`;
}

const UNKNOWN_MODEL_MESSAGE = 'No tokenizer is known for this model, so token counts are estimates. A tokenizer can be picked in Advanced Formatting → Tokenizer.';

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
 * warnings carry, and the wording the browser shows for it: a `dropped` or `trim-estimate` warning
 * for a send it builds, and the on-screen marker's title for an unknown model.
 * @param {TokenizerState} state
 * @param {ResolvedTokenizer} resolved
 * @param {TokenizerOutcome} outcome
 * @returns {{ id: number, name: string, model?: string, basis: ResolvedTokenizer['basis'], key: string, messages: { dropped: { one: string, many: string }, trimEstimate: string, unknownModel: string } }}
 */
export function tokenizerAnswer(state, resolved, outcome) {
    const used = outcome.usedCopy ?? resolved;
    const answer = {
        id: used.id,
        name: used.name,
        basis: tokenizerOutcomeBasis(resolved, outcome),
        key: tokenizerWarningKey(state, resolved),
        messages: {
            dropped: droppedMessages(resolved),
            trimEstimate: trimEstimateMessage(resolved),
            unknownModel: UNKNOWN_MODEL_MESSAGE,
        },
    };
    if (used.model) {
        answer.model = used.model;
    }
    return answer;
}

/**
 * The warnings a `/api/tokenizers/current/*` response carries: `fallback-copy` when a local copy
 * answered for a failed remote tokenizer, `estimate` when a tokenizer failed with none to answer,
 * and `license` for each registry file the request downloaded.
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
    warnings.push(...licenseWarnings(key, outcome));
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
