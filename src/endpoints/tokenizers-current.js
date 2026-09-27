import express from 'express';

import { countChatCompletionMessages, decodeWithLocalTokenizer, getLocalEncodeChunks } from './tokenizers.js';
import {
    resolveTokenizer, createTokenizerOutcome, countWithTokenizer, encodeWithTokenizer, estimateTokenCount,
    tokenizerAnswer, tokenizerResponseWarnings, readTokenizerState,
} from '../tokenizer-resolve.js';
import { localResolution } from '../tokenizer-map-resolution.js';

// The `/api/tokenizers/current/*` routes. They live apart from ./tokenizers.js because the
// resolver imports that module.

export const router = express.Router();

/**
 * The local tokenizer that turns ids back into text for a resolution: the local one, or a remote
 * one's exact local copy. null when there is none.
 * @param {import('../tokenizer-resolve.js').ResolvedTokenizer} resolved
 * @returns {import('../tokenizer-resolve.js').ResolvedTokenizer|null}
 */
function getDecodingResolution(resolved) {
    if (resolved.kind === 'local') {
        return resolved;
    }
    if (resolved.kind === 'remote' && resolved.localCopy) {
        return localResolution(resolved.localCopy, null);
    }
    return null;
}

/**
 * Trims `text` to `limit` tokens the way upstream's `/trimtokens` does: `start` keeps the first
 * tokens and `end` the last. With no tokenizer that can turn the sliced ids back into text, it trims
 * by upstream's character-proportion fallback, whose `start`/`end` keep the opposite ends.
 * @param {import('../tokenizer-resolve.js').ResolvedTokenizer} resolved
 * @param {string} text
 * @param {number} limit
 * @param {'start'|'end'} direction
 * @param {import('../tokenizer-resolve.js').EncodeWithTokenizerTypeOptions} options
 * @returns {Promise<string>}
 */
async function trimToTokenLimit(resolved, text, limit, direction, options) {
    const decoding = getDecodingResolution(resolved);
    const ids = await encodeWithTokenizer(decoding ?? resolved, text, options);
    const count = ids?.length ?? estimateTokenCount(text);
    if (count <= limit) {
        return text;
    }

    if (decoding && ids !== null) {
        const slice = direction === 'start' ? ids.slice(0, limit) : ids.slice(-limit);
        try {
            return (await decodeWithLocalTokenizer(decoding, slice, options)).text;
        } catch (error) {
            console.warn('Decoding failed while trimming to a token limit, returning the text unchanged', error);
            options.outcome.failed = true;
            return text;
        }
    }

    console.warn('No token ids to slice while trimming to a token limit, falling back to estimation');
    const trimIndex = Math.floor(text.length * (limit / count));
    return direction === 'start' ? text.substring(trimIndex) : text.substring(0, text.length - trimIndex);
}

/**
 * A `/current/*` route: resolves the tokenizer for the request's `state` and answers with what
 * `handle` gives, the tokenizer that answered, and any warnings about it.
 * @template T
 * @param {(body: any, state: import('../tokenizer-resolve.js').TokenizerState) => T|null} parse The
 * route's input; null answers 400.
 * @param {(input: T, resolved: import('../tokenizer-resolve.js').ResolvedTokenizer, options: import('../tokenizer-resolve.js').EncodeWithTokenizerTypeOptions) => Promise<object>} handle
 * @returns {(request: import('express').Request, response: import('express').Response) => Promise<any>}
 */
function currentTokenizerRoute(parse, handle) {
    return async function (request, response) {
        const state = readTokenizerState(request.body?.state);
        const input = state && parse(request.body, state);
        if (!input) {
            return response.sendStatus(400);
        }
        try {
            const resolved = await resolveTokenizer(state, { directories: request.user?.directories });
            const outcome = createTokenizerOutcome();
            const options = {
                // setAdditionalHeaders() picks the backend's API key by the body's api_type.
                request: /** @type {any} */ ({ body: { api_type: state.type }, user: request.user }),
                textgenBaseUrl: state.url,
                textgenModel: state.model,
                textgenApiType: state.type,
                koboldBaseUrl: state.url,
                directories: request.user?.directories,
                outcome,
            };
            const result = await handle(input, resolved, options);
            const warnings = tokenizerResponseWarnings(state, resolved, outcome);
            return response.send({
                ...result,
                tokenizer: tokenizerAnswer(state, resolved, outcome),
                ...(warnings.length > 0 ? { warnings } : {}),
            });
        } catch (error) {
            console.error(error);
            return response.sendStatus(500);
        }
    };
}

/**
 * @param {any} body
 * @returns {string[]|null}
 */
function readTexts(body) {
    return Array.isArray(body.texts) ? body.texts.map(text => String(text ?? '')) : null;
}

router.post('/current/count', currentTokenizerRoute(
    (body, state) => {
        if (Array.isArray(body.messages)) {
            return state.api === 'openai' ? { messages: body.messages } : null;
        }
        const texts = readTexts(body);
        const padding = Number(body.padding ?? 0);
        return texts && { texts, padding: Number.isFinite(padding) ? padding : 0 };
    },
    async (input, resolved, options) => {
        if ('messages' in input) {
            return { count: await countChatCompletionMessages(resolved, input.messages, options.outcome, options.directories) };
        }
        const counts = await Promise.all(input.texts.map(async text => text.length > 0
            ? await countWithTokenizer(resolved, text, options) + input.padding
            : 0));
        return { counts };
    },
));

router.post('/current/encode', currentTokenizerRoute(
    (body) => {
        const texts = readTexts(body);
        return texts && { texts };
    },
    async ({ texts }, resolved, options) => {
        const ids = await Promise.all(texts.map(text => encodeWithTokenizer(resolved, text, options)));
        if (resolved.kind !== 'local') {
            return { ids };
        }
        const chunks = await Promise.all(ids.map((tokenIds, i) => tokenIds === null
            ? null
            : getLocalEncodeChunks(resolved, texts[i], tokenIds, options).catch(() => null)));
        return { ids, chunks };
    },
));

router.post('/current/decode', currentTokenizerRoute(
    (body) => Array.isArray(body.ids) && body.ids.every(id => Number.isInteger(id)) ? { ids: body.ids } : null,
    async ({ ids }, resolved, options) => {
        const decoding = getDecodingResolution(resolved);
        if (!decoding) {
            return { text: '', chunks: [] };
        }
        try {
            return await decodeWithLocalTokenizer(decoding, ids, options);
        } catch (error) {
            console.warn(`Tokenizer ${decoding.name} failed to decode:`, error.message);
            options.outcome.failed = true;
            return { text: '', chunks: [] };
        }
    },
));

router.post('/current/trim', currentTokenizerRoute(
    (body) => ({
        text: String(body.text ?? ''),
        limit: Number(body.limit),
        direction: /** @type {'start'|'end'} */ (body.direction === 'start' ? 'start' : 'end'),
    }),
    async ({ text, limit, direction }, resolved, options) => {
        if (!text) {
            return { text: '' };
        }
        if (isNaN(limit)) {
            return { text };
        }
        if (limit <= 0) {
            return { text: '' };
        }
        return { text: await trimToTokenLimit(resolved, text, limit, direction, options) };
    },
));

router.post('/current/tokenizer', currentTokenizerRoute(() => ({}), async () => ({})));
