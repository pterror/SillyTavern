import { clearDownloadFailure, isDownloadBackedOff, recordDownloadFailure } from './tokenizer-sources.js';
import { fetchOutgoing } from './outgoing-fetch.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export const OPENROUTER_MODELS_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * @returns {Promise<any[]|null>}
 */
export async function fetchOpenRouterModels() {
    const response = await fetchOutgoing(OPENROUTER_MODELS_URL, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
        console.warn(`OpenRouter models API returned ${response.status}: ${response.statusText}`);
        return null;
    }

    /** @type {any} */
    const data = await response.json();

    if (!Array.isArray(data?.data)) {
        console.warn('OpenRouter API response format unexpected');
        return null;
    }

    return data.data;
}

/** @type {Map<string, string>|null} */
let huggingFaceIds = null;

let fetchedAt = 0;

/** @type {Promise<boolean>|null} */
let inFlight = null;

/**
 * @param {unknown} models
 */
export function rememberOpenRouterModels(models) {
    if (!Array.isArray(models)) {
        return;
    }
    const ids = new Map();
    for (const model of models) {
        if (typeof model?.id === 'string' && typeof model.hugging_face_id === 'string' && model.hugging_face_id !== '') {
            ids.set(model.id, model.hugging_face_id);
        }
    }
    huggingFaceIds = ids;
    fetchedAt = performance.now();
    clearDownloadFailure(OPENROUTER_MODELS_URL);
}

export function forgetOpenRouterModels() {
    huggingFaceIds = null;
    fetchedAt = 0;
    inFlight = null;
    clearDownloadFailure(OPENROUTER_MODELS_URL);
}

/**
 * @param {() => Promise<any[]|null>} fetchModels
 * @returns {Promise<boolean>}
 */
async function refresh(fetchModels) {
    try {
        const models = await fetchModels();
        if (models) {
            rememberOpenRouterModels(models);
            return true;
        }
    } catch (error) {
        console.warn('OpenRouter model list fetch failed:', error.message);
    }
    recordDownloadFailure(OPENROUTER_MODELS_URL);
    return false;
}

/**
 * @param {string} modelId
 * @param {{ fetchModels?: () => Promise<any[]|null> }} [options]
 * @returns {Promise<{ ok: false } | { ok: true, huggingFaceId: string|null }>}
 */
export async function lookupOpenRouterHuggingFaceId(modelId, { fetchModels = fetchOpenRouterModels } = {}) {
    const isFresh = huggingFaceIds !== null && performance.now() - fetchedAt < OPENROUTER_MODELS_MAX_AGE_MS;
    if (!isFresh) {
        if (isDownloadBackedOff(OPENROUTER_MODELS_URL)) {
            return { ok: false };
        }
        inFlight ??= refresh(fetchModels).finally(() => { inFlight = null; });
        if (!await inFlight) {
            return { ok: false };
        }
    }
    const ids = /** @type {Map<string, string>} */ (huggingFaceIds);
    const id = String(modelId ?? '');
    const base = id.includes(':') ? id.slice(0, id.lastIndexOf(':')) : id;
    return { ok: true, huggingFaceId: ids.get(id) ?? ids.get(base) ?? null };
}
