import crypto from 'node:crypto';

import { userStore } from './user-stores.js';
import { countWithTokenizer, encodeWithTokenizer, encodeWithTokenizerAndChunks, isLlamaCppTokenizer, tokenizerIdentity } from './tokenizer-resolve.js';
import { countChatCompletionMessages } from './endpoints/tokenizers.js';
export { LAST_USED_GRANULARITY_MS, PRUNE_BATCH_ROWS, PRUNE_PAUSE_MS, TOKEN_COUNT_ROW_CAP } from './token-cache-engine.js';

/**
 * What a stored result is of. The same text counts differently with and without BOS, or as a
 * chat-completion message, so the kind is part of the key.
 */
export const TOKEN_KEY_KINDS = Object.freeze({
    /** A plain count, no BOS. */
    TEXT: 'text',
    /** A `promptStart` count, with BOS. */
    PROMPT: 'prompt',
    /** A chat-completion messages count, per-message overhead included; its text is {@link chatMessageKeyText}. */
    CC_MESSAGE: 'cc-message',
    /** Token ids as `encodeWithTokenizer` returns them, no BOS; stored in `token_ids`. */
    IDS: 'ids',
});

const KINDS = new Set(Object.values(TOKEN_KEY_KINDS));


/**
 * The `text_hash` of a stored count or ids: sha256 of the kind and the exact text. Everything the result depends on
 * besides the tokenizer has to be in `text`.
 * @param {string} kind One of {@link TOKEN_KEY_KINDS}.
 * @param {string} text
 * @returns {string} sha256, hex.
 */
export function tokenKeyHash(kind, text) {
    if (!KINDS.has(kind)) throw new Error(`Unknown token key kind: ${kind}`);
    // No kind holds a newline, so the kind ends at the first one.
    return crypto.createHash('sha256').update(`${kind}\n${text}`).digest('hex');
}

/**
 * The key text of a {@link TOKEN_KEY_KINDS.CC_MESSAGE} count: the exact JSON of the messages
 * `countChatCompletionMessages` receives, and the model of the tokenizer that counts them, because the tiktoken
 * per-message overhead depends on the model and not only on the encoding (gpt-3.5-turbo-0301 vs gpt-4).
 * @param {string | null | undefined} model
 * @param {object[]} messages
 * @returns {string}
 */
export function chatMessageKeyText(model, messages) {
    return JSON.stringify([model ?? null, messages]);
}

/**
 * The user's token cache (`TokenCache`).
 * @param {import('./users.js').UserDirectoryList} directories
 */
async function cacheOf(directories) {
    return (await userStore(directories)).tokens;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} identity
 * @param {string} hash
 * @returns {Promise<number | null>} null when nothing is stored under the key.
 */
export async function readCount(directories, identity, hash) {
    return (await cacheOf(directories)).readCount(identity, hash);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} identity
 * @param {string} hash
 * @returns {Promise<number[] | null>} null when nothing is stored under the key.
 */
export async function readIds(directories, identity, hash) {
    return (await readIdsRow(directories, identity, hash))?.ids ?? null;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} identity
 * @param {string} hash
 * @returns {Promise<{ ids: number[], chunks: string[] | null } | null>} null when nothing is stored under the key;
 * `chunks` null when it was stored without them.
 */
export async function readIdsRow(directories, identity, hash) {
    return (await cacheOf(directories)).readIdsRow(identity, hash);
}

/**
 * @typedef {object} PendingTokenRows
 * @property {{ identity: string, hash: string, count: number, replace?: boolean }[]} [counts] `replace`: a count
 * taken again on purpose (a recount), written over the stored one.
 * @property {{ identity: string, hash: string, ids: ArrayLike<number>, chunks?: string[] | null }[]} [ids] `chunks`:
 * llama.cpp's pieces for the ids, when the encode asked for them.
 */

/**
 * Stores keys new to the cache and marks reused ones used (`TokenCache.writeBack()`).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {PendingTokenRows} pending
 * @param {number} [now] The `last_used` to write.
 * @returns {Promise<{ prunesScheduled: ('token_counts' | 'token_ids')[] }>} The tables this write pushed past the
 * cap and started an eviction for.
 */
export async function writeBack(directories, pending, now = Date.now()) {
    if (!pending.counts?.length && !pending.ids?.length) return { prunesScheduled: [] };
    return (await cacheOf(directories)).writeBack(pending, now);
}


/**
 * A read of the token cache, where a failure is logged and answers null, a miss: upstream never reads this
 * cache, so a request mustn't fail because it can't be read.
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
 * @property {(text: string) => Promise<number>} countText A plain count, no BOS.
 * @property {(text: string) => Promise<number>} countPromptText A `promptStart` count, with BOS.
 * @property {(messages: object[]) => Promise<number>} countChatMessage A chat-completion messages count.
 * @property {(text: string) => Promise<ArrayLike<number> | null>} encodeText Token ids, no BOS; null when
 * no tokenizer answered.
 * @property {(text: string) => Promise<{ ids: ArrayLike<number> | null, chunks?: string[] | null }>} encodeTextWithChunks
 * What encodeWithTokenizerAndChunks() gives: for llama.cpp, the ids and its pieces as chunks (null when it gave none),
 * where a stored row without chunks is a miss; otherwise the ids alone.
 * @property {PendingTokenRows} pending The rows read or counted, for {@link writeBack}.
 */

/**
 * @typedef {{ tokenizer?: import('./tokenizer-resolve.js').ResolvedTokenizer | import('./tokenizer-resolve.js').LocalTokenizer | null }} AnsweredOut
 */

/**
 * Counts and encodes through the user's token cache, for one request. With a null
 * identity everything is counted or encoded as it is without the cache, and nothing is read or pending.
 * Otherwise a text already stored under `identity` is read, not counted, and its row is pending so write-back
 * marks it used; a text not stored is counted, and its row is pending under the identity of the tokenizer
 * that answered, so a local copy's answer is stored under the copy's identity and an estimate or null ids
 * aren't stored. A read that fails is logged and counts as not stored. Each key is read or counted once per counter.
 * @param {object} args
 * @param {import('./tokenizer-resolve.js').ResolvedTokenizer} args.resolved A resolveTokenizer() answer.
 * @param {string | null} args.identity `tokenizerIdentity(resolved, facts)`, as the caller computed it.
 * @param {import('./users.js').UserDirectoryList} args.directories The user's directories: the token cache, and
 * the Hugging Face token for a messages count.
 * @param {import('./tokenizer-resolve.js').EncodeWithTokenizerTypeOptions} [args.encodeOptions] For
 * countWithTokenizer() and encodeWithTokenizer(); its `outcome` goes to countChatCompletionMessages().
 * @param {import('./tokenizer-resolve.js').TokenizerIdentityFacts} [args.identityFacts] For the identity of a
 * tokenizer that answered and isn't `resolved`.
 * @param {PendingTokenRows} [args.pending] Where rows are pushed; one object may be shared by several counters.
 * @param {(text: string, answeredOut: AnsweredOut) => Promise<ArrayLike<number> | null>} [args.encode]
 * Replaces encodeWithTokenizer() for `encodeText`, setting `answeredOut.tokenizer` as it does.
 * @param {(messages: object[], answeredOut: AnsweredOut) => Promise<number>} [args.countMessages] Replaces
 * countChatCompletionMessages() for `countChatMessage`, setting `answeredOut.tokenizer` as it does.
 * @param {boolean} [args.recount] Counts are taken again, not read, and written over the stored ones (ids are read as
 * usual).
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
    /** @type {Map<string, number | number[] | ArrayLike<number>>} Values read or pending in this counter, by identity and hash. */
    const seen = new Map();
    /** @type {Map<string, { ids: ArrayLike<number>, chunks: string[] | null }>} The ids of `seen` that have their chunks. */
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
     * Like `stored(TOKEN_KEY_KINDS.IDS, text)`, for llama.cpp with its pieces: ids stored or seen without chunks
     * are a miss, and the row pushed for them carries the chunks, so write-back adds them to it.
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

/**
 * @typedef {(resolved: import('./tokenizer-resolve.js').ResolvedTokenizer, encode: (text: string, answeredOut: AnsweredOut) => Promise<ArrayLike<number> | null>) => Promise<(text: string) => Promise<ArrayLike<number> | null>>} StoredEncoder
 */

/**
 * Wraps an encoder with a request's stored ids, for a caller that resolves its tokenizer itself
 * (computeLogitBias(), given it as `ChatCompletionConnection.storedEncoder`). The identity is computed
 * when the result is called, from `llamaCppProps.props` as it is then, because the caller's resolution
 * is what asks `/props`.
 * @param {object} args
 * @param {import('./users.js').UserDirectoryList} args.directories
 * @param {PendingTokenRows} args.pending The request's rows, which encodes add to.
 * @param {import('./llamacpp-props.js').LlamaCppPropsCheck} [args.llamaCppProps] The request's `/props` check.
 * @returns {StoredEncoder} Given the resolution and an encoder that sets `answeredOut.tokenizer` to the
 * tokenizer that answered (`resolved`, its local copy, or null), the stored counter's `encodeText`.
 */
export function createStoredEncoder({ directories, pending, llamaCppProps = undefined }) {
    return async (resolved, encode) => {
        const identityFacts = { llamaCppProps: llamaCppProps?.props };
        const identity = await tokenizerIdentity(resolved, identityFacts);
        return createStoredCounter({ resolved, identity, directories, identityFacts, pending, encode }).encodeText;
    };
}
