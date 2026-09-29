import crypto from 'node:crypto';

import { getMessageTreeDb } from './message-tree-db.js';

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
