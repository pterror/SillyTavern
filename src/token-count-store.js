import crypto from 'node:crypto';

import { getMessageTreeDb } from './message-tree-db.js';
import { countWithTokenizer, encodeWithTokenizer, tokenizerIdentity } from './tokenizer-resolve.js';
import { countChatCompletionMessages } from './endpoints/tokenizers.js';

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

/** meta keys holding each table's row count. */
const ROW_COUNT_KEYS = Object.freeze({ token_counts: 'token_counts_rows', token_ids: 'token_ids_rows' });

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
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {string} identity
 * @param {string} hash
 * @returns {Promise<number | null>} null when nothing is stored under the key.
 */
export async function readCount(directories, identity, hash) {
    const db = await getMessageTreeDb(directories);
    if (!db) return null;
    const row = /** @type {{ count: number } | undefined} */ (db.get(
        'SELECT count FROM token_counts WHERE identity = @identity AND text_hash = @hash', { identity, hash }));
    return row === undefined ? null : Number(row.count);
}

/**
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {string} identity
 * @param {string} hash
 * @returns {Promise<number[] | null>} null when nothing is stored under the key.
 */
export async function readIds(directories, identity, hash) {
    const db = await getMessageTreeDb(directories);
    if (!db) return null;
    const row = /** @type {{ ids: string } | undefined} */ (db.get(
        'SELECT ids FROM token_ids WHERE identity = @identity AND text_hash = @hash', { identity, hash }));
    return row === undefined ? null : JSON.parse(row.ids);
}

/**
 * @typedef {object} PendingTokenRows
 * @property {{ identity: string, hash: string, count: number }[]} [counts]
 * @property {{ identity: string, hash: string, ids: ArrayLike<number> }[]} [ids]
 */

/**
 * Stores keys new to the tables and marks reused ones used, in one transaction, keeping each table's row count in
 * meta. A key already stored keeps its value; only its `last_used` is written.
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {PendingTokenRows} pending
 * @param {number} [now] The `last_used` to write.
 */
export async function writeBack(directories, { counts = [], ids = [] }, now = Date.now()) {
    if (counts.length === 0 && ids.length === 0) return;
    const db = await getMessageTreeDb(directories);
    if (!db) return;
    db.transaction(() => {
        let insertedCounts = 0;
        for (const { identity, hash, count } of counts) {
            if (db.run(
                'INSERT INTO token_counts (identity, text_hash, count, last_used) VALUES (@identity, @hash, @count, @now) ON CONFLICT DO NOTHING',
                { identity, hash, count, now }).changes > 0) {
                insertedCounts++;
            } else {
                db.run('UPDATE token_counts SET last_used = @now WHERE identity = @identity AND text_hash = @hash', { identity, hash, now });
            }
        }
        let insertedIds = 0;
        for (const { identity, hash, ids: tokenIds } of ids) {
            if (db.run(
                'INSERT INTO token_ids (identity, text_hash, ids, last_used) VALUES (@identity, @hash, @ids, @now) ON CONFLICT DO NOTHING',
                { identity, hash, ids: JSON.stringify(Array.from(tokenIds)), now }).changes > 0) {
                insertedIds++;
            } else {
                db.run('UPDATE token_ids SET last_used = @now WHERE identity = @identity AND text_hash = @hash', { identity, hash, now });
            }
        }
        addToRowCount(db, ROW_COUNT_KEYS.token_counts, insertedCounts);
        addToRowCount(db, ROW_COUNT_KEYS.token_ids, insertedIds);
    });
}

/**
 * A table with no row count in meta has had no row written since it was created, so it starts from 0.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} key
 * @param {number} delta
 */
function addToRowCount(db, key, delta) {
    if (delta === 0) return;
    db.run(
        `INSERT INTO meta (key, value) VALUES (@key, @delta)
         ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + @delta`,
        { key, delta });
}

/**
 * @typedef {object} StoredCounter
 * @property {(text: string) => Promise<number>} countText A plain count, no BOS.
 * @property {(text: string) => Promise<number>} countPromptText A `promptStart` count, with BOS.
 * @property {(messages: object[]) => Promise<number>} countChatMessage A chat-completion messages count.
 * @property {(text: string) => Promise<ArrayLike<number> | null>} encodeText Token ids, no BOS; null when
 * no tokenizer answered.
 * @property {PendingTokenRows} pending The rows read or counted, for {@link writeBack}.
 */

/**
 * @typedef {{ tokenizer?: import('./tokenizer-resolve.js').ResolvedTokenizer | import('./tokenizer-resolve.js').LocalTokenizer | null }} AnsweredOut
 */

/**
 * Counts and encodes through the `token_counts` and `token_ids` tables, for one request. With a null
 * identity everything is counted or encoded as it is without the tables, and nothing is read or pending.
 * Otherwise a text already stored under `identity` is read, not counted, and its row is pending so write-back
 * marks it used; a text not stored is counted, and its row is pending under the identity of the tokenizer
 * that answered, so a local copy's answer is stored under the copy's identity and an estimate or null ids
 * aren't stored. Each key is read or counted once per counter.
 * @param {object} args
 * @param {import('./tokenizer-resolve.js').ResolvedTokenizer} args.resolved A resolveTokenizer() answer.
 * @param {string | null} args.identity `tokenizerIdentity(resolved, facts)`, as the caller computed it.
 * @param {import('./users.js').UserDirectoryList} args.directories The user's directories: the message tree db,
 * and the Hugging Face token for a messages count.
 * @param {import('./tokenizer-resolve.js').EncodeWithTokenizerTypeOptions} [args.encodeOptions] For
 * countWithTokenizer() and encodeWithTokenizer(); its `outcome` goes to countChatCompletionMessages().
 * @param {import('./tokenizer-resolve.js').TokenizerIdentityFacts} [args.identityFacts] For the identity of a
 * tokenizer that answered and isn't `resolved`.
 * @param {PendingTokenRows} [args.pending] Where rows are pushed; one object may be shared by several counters.
 * @param {(text: string, answeredOut: AnsweredOut) => Promise<ArrayLike<number> | null>} [args.encode]
 * Replaces encodeWithTokenizer() for `encodeText`, setting `answeredOut.tokenizer` as it does.
 * @param {(messages: object[], answeredOut: AnsweredOut) => Promise<number>} [args.countMessages] Replaces
 * countChatCompletionMessages() for `countChatMessage`, setting `answeredOut.tokenizer` as it does.
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
            pending,
        };
    }

    pending.counts ??= [];
    pending.ids ??= [];
    /** @type {Map<string, number | number[] | ArrayLike<number>>} Values read or pending in this counter, by identity and hash. */
    const seen = new Map();

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
            pending.counts.push({ identity: rowIdentity, hash, count: value });
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
        const read = kind === TOKEN_KEY_KINDS.IDS
            ? await readIds(directories, identity, readHash)
            : await readCount(directories, identity, readHash);
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

    return {
        countText: text => stored(TOKEN_KEY_KINDS.TEXT, text),
        countPromptText: text => stored(TOKEN_KEY_KINDS.PROMPT, text),
        encodeText: text => stored(TOKEN_KEY_KINDS.IDS, text),
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
