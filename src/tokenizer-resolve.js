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

export { tokenizers };

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
 * @property {import('express').Request} [request]
 * @property {string} [textgenBaseUrl]
 * @property {string} [textgenModel]
 * @property {string} [textgenApiType]
 * @property {string} [koboldBaseUrl]
 * @property {(tokenizerType: string, text: string) => Promise<number[]>} [encodeLocal]
 * @property {(request: any, text: string, baseUrl: string, model: string, apiType: string) => Promise<{count: number, ids: number[]}|{error: true}>} [encodeTextgenRemote]
 * @property {typeof fetch} [fetchImpl]
 * @property {TokenizerOutcome} [outcome]
 * @property {import('./users.js').UserDirectoryList} [directories]
 * @property {import('./tokenizer-loader.js').RegistryTokenizerOptions['registry']} [registry]
 * @property {import('./tokenizer-loader.js').RegistryTokenizerOptions['loadPinned']} [loadPinned]
 * @property {boolean} [promptStart]
 * @property {{ pieces?: Array<string|number[]> }} [piecesOut]
 * @property {{ tokenizer?: ResolvedTokenizer|LocalTokenizer|null }} [answeredOut]
 */

export class TokenizerFailure extends Error {
    /**
     * @param {string} message
     * @param {boolean} [unreachable]
     */
    constructor(message, unreachable = false) {
        super(message);
        this.unreachable = unreachable;
    }
}

/**
 * @param {number} tokenizerType
 * @param {string} text
 * @param {EncodeWithTokenizerTypeOptions} [options]
 * @returns {Promise<number[]>}
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
 * @param {any} result
 * @param {string|undefined} apiType
 * @param {EncodeWithTokenizerTypeOptions} options
 * @returns {number[]}
 */
function remoteIds(result, apiType, options) {
    if (result && !('error' in result) && Array.isArray(result.ids) && typeof result.count === 'number') {
        if (options.piecesOut && Array.isArray(result.pieces)) {
            options.piecesOut.pieces = result.pieces;
        }
        return result.ids;
    }
    throw new TokenizerFailure(`The ${apiType ?? 'text completion'} backend's tokenizer failed`, result?.unreachable === true);
}

/**
 * @param {ResolvedTokenizer} resolved
 * @param {EncodeWithTokenizerTypeOptions} options
 * @returns {boolean}
 */
export function isLlamaCppTokenizer(resolved, options) {
    return resolved.kind === 'remote'
        && (!!resolved.llamaCpp || (resolved.id === tokenizers.API_TEXTGENERATIONWEBUI && options.textgenApiType === TEXTGEN_TYPES.LLAMACPP));
}

const EXPLICIT_LOCAL_TOKENIZERS = [
    ...ENCODE_TOKENIZERS,
    tokenizers.GPT2,
    tokenizers.CLAUDE,
    tokenizers.NERD,
    tokenizers.NERD2,
    tokenizers.OPENAI,
];

/**
 * @param {string} source
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

const EXPLICIT_OPENAI_MODEL = 'gpt-3.5-turbo';

/** @typedef {import('./connection-state-header.js').TokenizerState} TokenizerState */

/**
 * @typedef {object} LocalTokenizer
 * @property {number} id
 * @property {string} [source]
 * @property {string} name
 * @property {string} [model]
 */

/**
 * @typedef {object} ResolvedTokenizer
 * @property {'remote'|'local'|'estimate'} kind
 * @property {number} id
 * @property {string} [source]
 * @property {string} name
 * @property {string} [model]
 * @property {'remote'|'local'|'unknown'|'none'|'fallback'|'failed'} basis
 * @property {LocalTokenizer|null} localCopy
 * @property {import('./custom-llamacpp.js').CustomLlamaCppEndpoint & { model: string }} [llamaCpp]
 */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isExplicitTokenizer(value) {
    return EXPLICIT_LOCAL_TOKENIZERS.includes(/** @type {number} */ (value)) || value === tokenizers.NONE;
}

/**
 * @param {number} id
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
 * @param {TokenizerState} state
 * @param {{ directories?: import('./users.js').UserDirectoryList, customIncludeHeaders?: string, llamaCppProps?: import('./llamacpp-props.js').LlamaCppPropsCheck } & import('./tokenizer-map-resolution.js').MapDeps} [deps]
 * @returns {Promise<ResolvedTokenizer>}
 */
export async function resolveTokenizer(state, deps = {}) {
    const { api, type, url, hordeModels } = state;
    const tokenizerSetting = state.tokenizerSetting ?? tokenizers.BEST_MATCH;
    const { lookupModel = lookupModelTokenizer, registry } = deps;

    if (isExplicitTokenizer(state.explicitTokenizer)) {
        return resolveExplicitSetting(state.explicitTokenizer, registry);
    }

    if (api === 'openai') {
        return resolveChatCompletionTokenizer(state.model, state.source, { ...deps, url: state.url });
    }

    if (isExplicitTokenizer(tokenizerSetting)) {
        return resolveExplicitSetting(tokenizerSetting, registry);
    }

    if (api === 'koboldhorde') {
        const results = (hordeModels ?? []).map(model => selectBackendResult(lookupModel(api, model), state));
        const keys = new Set(results.map(result => result === null ? null : mapResultKey(result)));
        const local = keys.size === 1 ? describeMapEntry(results[0], api, registry) : null;
        return local ? localResolution(local, local) : estimateResolution('unknown');
    }

    const backend = { api, type, url, directories: deps.directories };
    const reachable = Boolean(url);
    const props = reachable && api === 'textgenerationwebui' && type === TEXTGEN_TYPES.LLAMACPP && deps.llamaCppProps
        ? await deps.llamaCppProps.ask(textgenLlamaCppBackend(url, state.model ?? '', deps.directories))
        : undefined;
    const propsName = state.model ? undefined : llamaCppPropsModelName(props);
    const model = state.model || (propsName !== undefined ? propsName : reachable ? await lookupBackendModel(backend) : null);
    const local = describeMapEntry(await selectModelResult(api, model, state, deps), api, registry);

    if (reachable && await hasRemoteTokenizer(backend, TEXTGEN_TOKENIZERS)) {
        const id = api === 'kobold' ? tokenizers.API_KOBOLD : tokenizers.API_TEXTGENERATIONWEBUI;
        return { kind: 'remote', id, name: TOKENIZER_NAMES[id], basis: 'remote', localCopy: local };
    }

    return local ? localResolution(local, local) : estimateResolution('unknown');
}

/**
 * @param {string} text
 * @returns {number}
 */
export function estimateTokenCount(text) {
    return guesstimate(String(text ?? ''));
}

/**
 * @typedef {object} TokenizerOutcome
 * @property {LocalTokenizer|null} usedCopy
 * @property {boolean} failed
 * @property {boolean} countEstimated
 * @property {Array<{ family: string, license: string }>} downloads
 */

/** @returns {TokenizerOutcome} */
export function createTokenizerOutcome() {
    return { usedCopy: null, failed: false, countEstimated: false, downloads: [] };
}

/**
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
 * @typedef {object} TokenizerIdentityFacts
 * @property {string} [textgenApiType]
 * @property {any} [llamaCppProps]
 * @property {import('./tokenizer-map-resolution.js').MapDeps['registry']} [registry]
 */

/**
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
 * @param {string} source
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
 * @param {ResolvedTokenizer} resolved
 * @param {string} text
 * @param {EncodeWithTokenizerTypeOptions} [options]
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
 * @param {ResolvedTokenizer} resolved
 * @param {string} text
 * @param {EncodeWithTokenizerTypeOptions} [options]
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
        if (!error?.unreachable) console.warn(`Tokenizer ${resolved.name} failed:`, error.message);
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
 * @param {{id: number, source?: string, model?: string, llamaCpp?: ResolvedTokenizer['llamaCpp']}} tokenizer
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
 * @param {TokenizerState} state
 * @param {ResolvedTokenizer} resolved
 * @param {string[]} entries
 * @returns {{ kind: 'dropped', key: string, message: string, entries: string[] } | null}
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
 * @param {string|undefined} profileTokenizer
 * @param {number} mainSetting
 * @returns {number}
 */
export function resolveProfileTokenizerSetting(profileTokenizer, mainSetting) {
    const match = Object.entries(tokenizers).find(([key]) => key.toLowerCase() === profileTokenizer);
    return match ? match[1] : mainSetting;
}
