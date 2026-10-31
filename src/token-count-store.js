import crypto from 'node:crypto';

import { userStore } from './user-stores.js';
import { countWithTokenizer, encodeWithTokenizer, encodeWithTokenizerAndChunks, isLlamaCppTokenizer, tokenizerIdentity } from './tokenizer-resolve.js';
import { countChatCompletionMessages } from './endpoints/tokenizers.js';
export { LAST_USED_GRANULARITY_MS, PRUNE_BATCH_ROWS, PRUNE_PAUSE_MS, TOKEN_COUNT_ROW_CAP } from './token-cache-engine.js';

export const TOKEN_KEY_KINDS = Object.freeze({
    TEXT: 'text',
    PROMPT: 'prompt',
    CC_MESSAGE: 'cc-message',
    IDS: 'ids',
});

const KINDS = new Set(Object.values(TOKEN_KEY_KINDS));


/**
 * @param {string} kind
 * @param {string} text
 * @returns {string}
 */
export function tokenKeyHash(kind, text) {
    if (!KINDS.has(kind)) throw new Error(`Unknown token key kind: ${kind}`);
    return crypto.createHash('sha256').update(`${kind}\n${text}`).digest('hex');
}

/**
 * @param {string | null | undefined} model
 * @param {object[]} messages
 * @returns {string}
 */
export function chatMessageKeyText(model, messages) {
    return JSON.stringify([model ?? null, messages]);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
async function cacheOf(directories) {
    return (await userStore(directories)).tokens;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} identity
 * @param {string} hash
 * @returns {Promise<number | null>}
 */
export async function readCount(directories, identity, hash) {
    return (await cacheOf(directories)).readCount(identity, hash);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} identity
 * @param {string} hash
 * @returns {Promise<number[] | null>}
 */
export async function readIds(directories, identity, hash) {
    return (await readIdsRow(directories, identity, hash))?.ids ?? null;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} identity
 * @param {string} hash
 * @returns {Promise<{ ids: number[], chunks: string[] | null } | null>}
 */
export async function readIdsRow(directories, identity, hash) {
    return (await cacheOf(directories)).readIdsRow(identity, hash);
}

/**
 * @typedef {object} PendingTokenRows
 * @property {{ identity: string, hash: string, count: number, replace?: boolean }[]} [counts]
 * @property {{ identity: string, hash: string, ids: ArrayLike<number>, chunks?: string[] | null }[]} [ids]
 */

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {PendingTokenRows} pending
 * @param {number} [now]
 * @returns {Promise<{ prunesScheduled: ('token_counts' | 'token_ids')[] }>}
 */
export async function writeBack(directories, pending, now = Date.now()) {
    if (!pending.counts?.length && !pending.ids?.length) return { prunesScheduled: [] };
    return (await cacheOf(directories)).writeBack(pending, now);
}


/**
 * @template T
 * @param {() => Promise<T | null>} read
 * @returns {Promise<T | null>}
 */
async function readOrMiss(read) {
    try {
        return await read();
    } catch (error) {
        console.error('Failed to read stored token counts:', error);
        return null;
    }
}

/**
 * @typedef {object} StoredCounter
 * @property {(text: string) => Promise<number>} countText
 * @property {(text: string) => Promise<number>} countPromptText
 * @property {(messages: object[]) => Promise<number>} countChatMessage
 * @property {(text: string) => Promise<ArrayLike<number> | null>} encodeText
 * @property {(text: string) => Promise<{ ids: ArrayLike<number> | null, chunks?: string[] | null }>} encodeTextWithChunks
 * @property {PendingTokenRows} pending
 */

/** @typedef {{ tokenizer?: import('./tokenizer-resolve.js').ResolvedTokenizer | import('./tokenizer-resolve.js').LocalTokenizer | null }} AnsweredOut */

/**
 * @param {object} args
 * @param {import('./tokenizer-resolve.js').ResolvedTokenizer} args.resolved
 * @param {string | null} args.identity
 * @param {import('./users.js').UserDirectoryList} args.directories
 * @param {import('./tokenizer-resolve.js').EncodeWithTokenizerTypeOptions} [args.encodeOptions]
 * @param {import('./tokenizer-resolve.js').TokenizerIdentityFacts} [args.identityFacts]
 * @param {PendingTokenRows} [args.pending]
 * @param {(text: string, answeredOut: AnsweredOut) => Promise<ArrayLike<number> | null>} [args.encode]
 * @param {(messages: object[], answeredOut: AnsweredOut) => Promise<number>} [args.countMessages]
 * @param {boolean} [args.recount]
 * @returns {StoredCounter}
 */
export function createStoredCounter({
    resolved,
    identity,
    directories,
    encodeOptions = {},
    identityFacts = {},
    pending = { counts: [], ids: [] },
    encode = undefined,
    countMessages = undefined,
    recount = false,
}) {
    const compute = {
        [TOKEN_KEY_KINDS.TEXT]: (text, answeredOut) => countWithTokenizer(resolved, text, { ...encodeOptions, answeredOut }),
        [TOKEN_KEY_KINDS.PROMPT]: (text, answeredOut) => countWithTokenizer(resolved, text, { ...encodeOptions, promptStart: true, answeredOut }),
        [TOKEN_KEY_KINDS.IDS]: encode ?? ((text, answeredOut) => encodeWithTokenizer(resolved, text, { ...encodeOptions, answeredOut })),
        [TOKEN_KEY_KINDS.CC_MESSAGE]: countMessages
            ?? ((messages, answeredOut) => countChatCompletionMessages(resolved, messages, encodeOptions.outcome, directories, answeredOut)),
    };

    if (identity === null || identity === undefined) {
        return {
            countText: text => countWithTokenizer(resolved, text, encodeOptions),
            countPromptText: text => countWithTokenizer(resolved, text, { ...encodeOptions, promptStart: true }),
            encodeText: text => (encode ? encode(text, {}) : encodeWithTokenizer(resolved, text, encodeOptions)),
            countChatMessage: messages => (countMessages
                ? countMessages(messages, {})
                : countChatCompletionMessages(resolved, messages, encodeOptions.outcome, directories)),
            encodeTextWithChunks: text => encodeWithTokenizerAndChunks(resolved, text, encodeOptions),
            pending,
        };
    }

    pending.counts ??= [];
    pending.ids ??= [];
    /** @type {Map<string, number | number[] | ArrayLike<number>>} */
    const seen = new Map();
    /** @type {Map<string, { ids: ArrayLike<number>, chunks: string[] | null }>} */
    const seenWithChunks = new Map();

    /**
     * @param {string} kind
     * @param {{ model?: string } | null | undefined} tokenizer
     * @param {any} input
     * @returns {string}
     */
    const keyText = (kind, tokenizer, input) => (kind === TOKEN_KEY_KINDS.CC_MESSAGE
        ? chatMessageKeyText(tokenizer?.model, input)
        : String(input ?? ''));

    /**
     * @param {string} kind
     * @param {string} rowIdentity
     * @param {string} hash
     * @param {any} value
     */
    const push = (kind, rowIdentity, hash, value) => {
        if (kind === TOKEN_KEY_KINDS.IDS) {
            pending.ids.push({ identity: rowIdentity, hash, ids: value });
        } else {
            pending.counts.push({ identity: rowIdentity, hash, count: value, ...(recount ? { replace: true } : {}) });
        }
        seen.set(`${rowIdentity}\n${hash}`, value);
    };

    /**
     * @param {string} kind
     * @param {any} input
     */
    const stored = async (kind, input) => {
        const readHash = tokenKeyHash(kind, keyText(kind, resolved, input));
        const readKey = `${identity}\n${readHash}`;
        if (seen.has(readKey)) {
            return seen.get(readKey);
        }
        const read = recount && kind !== TOKEN_KEY_KINDS.IDS ? null : await readOrMiss(() => (kind === TOKEN_KEY_KINDS.IDS
            ? readIds(directories, identity, readHash)
            : readCount(directories, identity, readHash)));
        if (read !== null) {
            push(kind, identity, readHash, read);
            return read;
        }

        /** @type {AnsweredOut} */
        const answeredOut = { tokenizer: null };
        const result = await compute[kind](input, answeredOut);
        const answered = answeredOut.tokenizer;
        if (answered === null || answered === undefined || (kind === TOKEN_KEY_KINDS.IDS && result === null)) {
            return result;
        }
        const answeredIdentity = answered === resolved ? identity : await tokenizerIdentity(answered, identityFacts);
        if (answeredIdentity === null) {
            return result;
        }
        const writeHash = tokenKeyHash(kind, keyText(kind, answered, input));
        if (!seen.has(`${answeredIdentity}\n${writeHash}`)) {
            push(kind, answeredIdentity, writeHash, kind === TOKEN_KEY_KINDS.IDS ? Array.from(result) : result);
        }
        return result;
    };

    /**
     * @param {string} text
     */
    const storedWithChunks = async (text) => {
        if (!isLlamaCppTokenizer(resolved, encodeOptions)) {
            return { ids: await stored(TOKEN_KEY_KINDS.IDS, text) };
        }
        const hash = tokenKeyHash(TOKEN_KEY_KINDS.IDS, String(text ?? ''));
        const readKey = `${identity}\n${hash}`;
        if (seenWithChunks.has(readKey)) {
            return seenWithChunks.get(readKey);
        }
        const read = await readOrMiss(() => readIdsRow(directories, identity, hash));
        if (read !== null && read.chunks !== null) {
            push(TOKEN_KEY_KINDS.IDS, identity, hash, read.ids);
            seenWithChunks.set(readKey, read);
            return read;
        }

        /** @type {AnsweredOut} */
        const answeredOut = { tokenizer: null };
        const result = await encodeWithTokenizerAndChunks(resolved, text, { ...encodeOptions, answeredOut });
        const answered = answeredOut.tokenizer;
        if (answered === null || answered === undefined || result.ids === null) {
            return result;
        }
        const answeredIdentity = answered === resolved ? identity : await tokenizerIdentity(answered, identityFacts);
        if (answeredIdentity === null) {
            return result;
        }
        const writeKey = `${answeredIdentity}\n${hash}`;
        if (!seenWithChunks.has(writeKey)) {
            const value = { ids: Array.from(result.ids), chunks: result.chunks ?? null };
            pending.ids.push({ identity: answeredIdentity, hash, ...value });
            seen.set(writeKey, value.ids);
            seenWithChunks.set(writeKey, value);
        }
        return result;
    };

    return {
        countText: text => stored(TOKEN_KEY_KINDS.TEXT, text),
        countPromptText: text => stored(TOKEN_KEY_KINDS.PROMPT, text),
        encodeText: text => stored(TOKEN_KEY_KINDS.IDS, text),
        encodeTextWithChunks: storedWithChunks,
        countChatMessage: messages => stored(TOKEN_KEY_KINDS.CC_MESSAGE, messages),
        pending,
    };
}

/** @typedef {(resolved: import('./tokenizer-resolve.js').ResolvedTokenizer, encode: (text: string, answeredOut: AnsweredOut) => Promise<ArrayLike<number> | null>) => Promise<(text: string) => Promise<ArrayLike<number> | null>>} StoredEncoder */

/**
 * @param {object} args
 * @param {import('./users.js').UserDirectoryList} args.directories
 * @param {PendingTokenRows} args.pending
 * @param {import('./llamacpp-props.js').LlamaCppPropsCheck} [args.llamaCppProps]
 * @returns {StoredEncoder}
 */
export function createStoredEncoder({ directories, pending, llamaCppProps = undefined }) {
    return async (resolved, encode) => {
        const identityFacts = { llamaCppProps: llamaCppProps?.props };
        const identity = await tokenizerIdentity(resolved, identityFacts);
        return createStoredCounter({ resolved, identity, directories, identityFacts, pending, encode }).encodeText;
    };
}
