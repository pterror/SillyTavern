import express from 'express';

import { decodeWithLocalTokenizer, getLocalEncodeChunks } from './tokenizers.js';
import {
    resolveTokenizer, createTokenizerOutcome, encodeWithTokenizer,
    estimateTokenCount, tokenizerAnswer, tokenizerResponseWarnings, isExplicitTokenizer, tokenizerIdentity,
} from '../tokenizer-resolve.js';
import { localResolution } from '../tokenizer-map-resolution.js';
import { readTokenizerState } from '../connection-state-header.js';
import { createLlamaCppPropsCheck } from '../llamacpp-props.js';
import { createStoredCounter, writeBack } from '../token-count-store.js';
import { countWithConnection } from '../connection-counts.js';

export const router = express.Router();

/**
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
 * @param {import('../tokenizer-resolve.js').TokenizerState & { explicitTokenizer?: any }} state
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{ recount?: boolean }} [options]
 */
export async function openTokenizer(state, directories, { recount = false } = {}) {
    const llamaCppProps = createLlamaCppPropsCheck({ reuse: true });
    const resolved = await resolveTokenizer(state, { directories, llamaCppProps });
    const outcome = createTokenizerOutcome();
    /** @type {import('../tokenizer-resolve.js').EncodeWithTokenizerTypeOptions} */
    const options = {
        request: /** @type {any} */ ({ body: { api_type: state.type }, user: { directories } }),
        textgenBaseUrl: state.url,
        textgenModel: state.model,
        textgenApiType: state.type,
        koboldBaseUrl: state.url,
        directories,
        outcome,
    };
    const identityFacts = { textgenApiType: state.type, llamaCppProps: llamaCppProps.props };
    /** @type {Promise<string|null> | null} */
    let identity = null;
    /** @type {import('../token-count-store.js').StoredCounter | null} */
    let counter = null;
    return {
        resolved,
        options,
        outcome,
        identity: () => (identity ??= tokenizerIdentity(resolved, identityFacts)),
        storedCounter: async () => {
            if (!counter) {
                identity ??= tokenizerIdentity(resolved, identityFacts);
                counter = createStoredCounter({ resolved, identity: await identity, directories, encodeOptions: options, identityFacts, recount });
            }
            return counter;
        },
        writeCounted: async () => {
            if (counter) await writeBack(directories, counter.pending);
        },
    };
}

/**
 * @template T
 * @param {(body: any, state: import('../tokenizer-resolve.js').TokenizerState) => T|null} parse
 * @param {(input: T, resolved: import('../tokenizer-resolve.js').ResolvedTokenizer, options: import('../tokenizer-resolve.js').EncodeWithTokenizerTypeOptions, storedCounter: () => Promise<import('../token-count-store.js').StoredCounter>) => Promise<object>} handle
 * @returns {(request: import('express').Request, response: import('express').Response) => Promise<any>}
 */
function currentTokenizerRoute(parse, handle) {
    return async function (request, response) {
        const state = readTokenizerState(request.body?.state);
        const input = state && parse(request.body, state);
        const explicitTokenizer = request.body?.explicitTokenizer;
        if (!input || (explicitTokenizer !== undefined && !isExplicitTokenizer(explicitTokenizer))) {
            return response.sendStatus(400);
        }
        try {
            const { resolved, options, outcome, storedCounter, writeCounted } = await openTokenizer(
                { ...state, explicitTokenizer }, request.user?.directories, { recount: request.body?.recount === true });
            const result = await handle(input, resolved, options, storedCounter);
            const warnings = tokenizerResponseWarnings(state, resolved, outcome);
            response.send({
                ...result,
                tokenizer: tokenizerAnswer(state, resolved, outcome),
                ...(warnings.length > 0 ? { warnings } : {}),
            });
            writeCounted().catch(error => console.error('Failed to store token counts:', error));
            return;
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
        if (Array.isArray(body.messages_each)) {
            return state.api === 'openai' ? { messagesEach: body.messages_each } : null;
        }
        const texts = readTexts(body);
        const padding = Number(body.padding ?? 0);
        return texts && { texts, padding: Number.isFinite(padding) ? padding : 0, promptStart: body.promptStart === true };
    },
    async (input, _resolved, _options, storedCounter) => {
        const counter = await storedCounter();
        if ('messages' in input) {
            return { count: await counter.countChatMessage(input.messages) };
        }
        if ('messagesEach' in input) {
            return { counts: await Promise.all(input.messagesEach.map(message => counter.countChatMessage([message]))) };
        }
        const count = input.promptStart ? counter.countPromptText : counter.countText;
        const counts = await Promise.all(input.texts.map(async text => text.length > 0
            ? await count(text) + input.padding
            : 0));
        return { counts };
    },
));

router.post('/count', async function (request, response) {
    const texts = readTexts(request.body ?? {});
    if (!texts) return response.sendStatus(400);
    try {
        const counted = await countWithConnection(request.user.directories, {}, texts, { recount: request.body?.recount === true });
        return counted ? response.send(counted) : response.status(400).send({ error: 'No connection is chosen to count with.' });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/current/encode', currentTokenizerRoute(
    (body) => {
        const texts = readTexts(body);
        return texts && { texts };
    },
    async ({ texts }, resolved, options, storedCounter) => {
        const counter = await storedCounter();
        if (resolved.kind === 'remote') {
            const encoded = await Promise.all(texts.map(text => counter.encodeTextWithChunks(text)));
            const ids = encoded.map(result => result.ids);
            return encoded.some(result => result.chunks !== undefined) ? { ids, chunks: encoded.map(result => result.chunks ?? null) } : { ids };
        }
        const ids = await Promise.all(texts.map(text => counter.encodeText(text)));
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
