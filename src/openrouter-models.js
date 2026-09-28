import fetch from 'node-fetch';

import { clearDownloadFailure, isDownloadBackedOff, recordDownloadFailure } from './tokenizer-sources.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** How long a fetched model list answers before the next lookup fetches it again. */
export const OPENROUTER_MODELS_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * OpenRouter's public model list, without a key.
 * @returns {Promise<any[]|null>} null when OpenRouter answers with an error or an unexpected shape
 */
export async function fetchOpenRouterModels() {
    const response = await fetch(OPENROUTER_MODELS_URL, {
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

/**
 * OpenRouter model id -> its `hugging_face_id`, for the models that name one. One entry per model in
 * OpenRouter's catalog at most (177 of its 458 models named one on 2026-09-28), whatever the user's data.
 * @type {Map<string, string>|null} null until a list has been fetched
 */
let huggingFaceIds = null;

/** `performance.now()` when `huggingFaceIds` was filled. */
let fetchedAt = 0;

/** @type {Promise<boolean>|null} */
let inFlight = null;

/**
 * Keeps the `hugging_face_id` of every model in a fetched list, replacing what was kept before.
 * @param {unknown} models The `data` array of OpenRouter's `/models` reply
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

/** Forgets the kept list, for tests. */
export function forgetOpenRouterModels() {
    huggingFaceIds = null;
    fetchedAt = 0;
    inFlight = null;
    clearDownloadFailure(OPENROUTER_MODELS_URL);
}

/**
 * @param {() => Promise<any[]|null>} fetchModels
 * @returns {Promise<boolean>} whether the list was fetched
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
 * The `hugging_face_id` OpenRouter lists for a model. A list older than an hour is fetched again; a
 * failed fetch is not retried for a minute, and answers `{ ok: false }` meanwhile. An id with a variant
 * suffix that isn't listed itself (`:nitro`) is looked up without it.
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
