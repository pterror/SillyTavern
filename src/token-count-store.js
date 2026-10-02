import crypto from 'node:crypto';

import { getMessageTreeDb } from './message-tree-db.js';
import { addTreeMetaSync, setTreeMetaSync } from './message-tree-meta.js';
import { writeRowIfChanged } from './row-values.js';
import { countWithTokenizer, encodeWithTokenizer, encodeWithTokenizerAndChunks, isLlamaCppTokenizer, tokenizerIdentity } from './tokenizer-resolve.js';
import { countChatCompletionMessages } from './endpoints/tokenizers.js';
import { delay } from './util.js';

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
    return (await readIdsRow(directories, identity, hash))?.ids ?? null;
}

/**
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {string} identity
 * @param {string} hash
 * @returns {Promise<{ ids: number[], chunks: string[] | null } | null>} null when nothing is stored under the key;
 * `chunks` null when the row was stored without them.
 */
export async function readIdsRow(directories, identity, hash) {
    const db = await getMessageTreeDb(directories);
    if (!db) return null;
    const row = /** @type {{ ids: string, chunks: string | null } | undefined} */ (db.get(
        'SELECT ids, chunks FROM token_ids WHERE identity = @identity AND text_hash = @hash', { identity, hash }));
    return row === undefined ? null : { ids: JSON.parse(row.ids), chunks: row.chunks === null ? null : JSON.parse(row.chunks) };
}

/**
 * @typedef {object} PendingTokenRows
 * @property {{ identity: string, hash: string, count: number }[]} [counts]
 * @property {{ identity: string, hash: string, ids: ArrayLike<number>, chunks?: string[] | null }[]} [ids] `chunks`:
 * llama.cpp's pieces for the ids, when the encode asked for them.
 */

/**
 * Stores keys new to the tables and marks reused ones used, in one transaction, keeping each table's row count in
 * meta. A key already stored keeps its value; only its `last_used` is written, and its `chunks` when it was stored
 * without them.
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {PendingTokenRows} pending
 * @param {number} [now] The `last_used` to write.
 * @param {TokenTableLimits} [limits]
 * @returns {Promise<{ prunesScheduled: TokenTable[] }>} The tables this write pushed past the cap and scheduled a
 *   prune for; a table with one already pending or its row count being set isn't scheduled again.
 */
export async function writeBack(directories, { counts = [], ids = [] }, now = Date.now(), limits = DEFAULT_TOKEN_TABLE_LIMITS) {
    /** @type {TokenTable[]} */
    const prunesScheduled = [];
    if (counts.length === 0 && ids.length === 0) return { prunesScheduled };
    const db = await getMessageTreeDb(directories);
    if (!db) return { prunesScheduled };
    const countsFill = rowCountFills.get(jobKey(directories, 'token_counts'));
    const idsFill = rowCountFills.get(jobKey(directories, 'token_ids'));
    const inserted = { token_counts: 0, token_ids: 0, countsBehindFill: 0, idsBehindFill: 0 };
    db.transaction(() => {
        // Reset here: a transaction that hits busy is rolled back and rerun.
        inserted.token_counts = inserted.token_ids = inserted.countsBehindFill = inserted.idsBehindFill = 0;
        for (const { identity, hash, count } of counts) {
            if (db.run(
                'INSERT INTO token_counts (identity, text_hash, count, last_used) VALUES (@identity, @hash, @count, @now) ON CONFLICT DO NOTHING',
                { identity, hash, count, now }).changes > 0) {
                inserted.token_counts++;
                if (countsFill && isBehindFill(countsFill, identity, hash)) inserted.countsBehindFill++;
            } else {
                writeRowIfChanged(db, 'token_counts', { identity, text_hash: hash }, { last_used: now });
            }
        }
        for (const { identity, hash, ids: tokenIds, chunks = null } of ids) {
            const storedChunks = chunks === null ? null : JSON.stringify(chunks);
            if (db.run(
                'INSERT INTO token_ids (identity, text_hash, ids, chunks, last_used) VALUES (@identity, @hash, @ids, @chunks, @now) ON CONFLICT DO NOTHING',
                { identity, hash, ids: JSON.stringify(Array.from(tokenIds)), chunks: storedChunks, now }).changes > 0) {
                inserted.token_ids++;
                if (idsFill && isBehindFill(idsFill, identity, hash)) inserted.idsBehindFill++;
            } else {
                const stored = /** @type {{ chunks: string | null } | undefined} */ (db.get(
                    'SELECT chunks FROM token_ids WHERE identity = @identity AND text_hash = @hash', { identity, hash }));
                writeRowIfChanged(db, 'token_ids', { identity, text_hash: hash }, { last_used: now, chunks: stored?.chunks ?? storedChunks });
            }
        }
        addToRowCount(db, ROW_COUNT_KEYS.token_counts, inserted.token_counts);
        addToRowCount(db, ROW_COUNT_KEYS.token_ids, inserted.token_ids);
    });
    if (countsFill) countsFill.behind += inserted.countsBehindFill;
    if (idsFill) idsFill.behind += inserted.idsBehindFill;
    for (const table of TOKEN_TABLES) {
        if (inserted[table] > 0 && readRowCount(db, table) > limits.cap && schedulePrune(directories, table, limits)) {
            prunesScheduled.push(table);
        }
    }
    return { prunesScheduled };
}

/**
 * A table with no row count in meta has had no row written since it was created, so it starts from 0.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} key
 * @param {number} delta
 */
function addToRowCount(db, key, delta) {
    if (delta === 0) return;
    addTreeMetaSync(db, key, delta);
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {TokenTable} table
 * @returns {number}
 */
function readRowCount(db, table) {
    const row = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: ROW_COUNT_KEYS[table] }));
    return row === undefined ? 0 : Number(row.value);
}

// ---------------------------------------------------------------------------
//  Row cap: counting after listen, pruning least recently used first
// ---------------------------------------------------------------------------

/** Rows each table may hold before the least recently used are pruned. */
export const TOKEN_COUNT_ROW_CAP = 1_000_000;
/** Rows one page of the count, or one prune batch, reads. */
export const PRUNE_BATCH_ROWS = 5000;
/** The pause between pages and between batches. */
export const PRUNE_PAUSE_MS = 50;

/** @typedef {'token_counts' | 'token_ids'} TokenTable */
/** @typedef {{ cap: number, batchRows: number, pauseMs: number }} TokenTableLimits */

/** @type {readonly TokenTable[]} */
const TOKEN_TABLES = Object.freeze(['token_counts', 'token_ids']);

/** @type {TokenTableLimits} */
const DEFAULT_TOKEN_TABLE_LIMITS = Object.freeze({ cap: TOKEN_COUNT_ROW_CAP, batchRows: PRUNE_BATCH_ROWS, pauseMs: PRUNE_PAUSE_MS });

/**
 * The count or prune running for a table of a store, by {@link jobKey}; at most one per table. A job removes itself
 * in the same synchronous step as its last check, so a write-back never sees one that has finished its work.
 * @type {Map<string, Promise<void>>}
 */
const tableJobs = new Map();

/**
 * A table's row count being set, by {@link jobKey}: the keys up to `after` (in primary key order) are counted
 * already, so a row inserted at or before it is added to `behind`; one after it is counted by a later page.
 * @type {Map<string, { after: { identity: string, hash: string } | null, behind: number }>}
 */
const rowCountFills = new Map();

/**
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {TokenTable} table
 */
function jobKey(directories, table) {
    return `${directories.root}\0${table}`;
}

/**
 * Whether a key sorts at or before the fill's page boundary, in SQLite's BINARY order (UTF-8 bytes).
 * @param {{ after: { identity: string, hash: string } | null }} fill
 * @param {string} identity
 * @param {string} hash
 */
function isBehindFill(fill, identity, hash) {
    if (fill.after === null) return false;
    const byIdentity = Buffer.compare(Buffer.from(identity), Buffer.from(fill.after.identity));
    return byIdentity < 0 || (byIdentity === 0 && Buffer.compare(Buffer.from(hash), Buffer.from(fill.after.hash)) <= 0);
}

/**
 * Starts `work` as the table's job. `release` removes it from {@link tableJobs}; `work` calls it in the same
 * synchronous step as its last check, and it is called anyway once `work` settles.
 * @param {string} key
 * @param {(release: () => void) => Promise<void>} work
 * @param {string} label For the log when the job fails.
 * @returns {Promise<void>}
 */
function startTableJob(key, work, label) {
    /** @type {Promise<void>} */
    let job;
    const release = () => {
        if (tableJobs.get(key) === job) tableJobs.delete(key);
    };
    job = Promise.resolve().then(() => work(release)).catch((err) => {
        console.error(`[token-count-store] ${label} failed:`, err);
    }).finally(release);
    tableJobs.set(key, job);
    return job;
}

/**
 * Schedules a prune of the table, unless it has a job already.
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {TokenTable} table
 * @param {TokenTableLimits} limits
 * @returns {boolean} Whether one was scheduled.
 */
function schedulePrune(directories, table, limits) {
    const key = jobKey(directories, table);
    if (tableJobs.has(key)) return false;
    startTableJob(key, release => pruneTokenTable(directories, table, limits, release), `Pruning ${table} of ${directories.root}`);
    return true;
}

/**
 * Deletes one batch of the table's least recently used rows: as many as it is over the cap, at most `batchRows`.
 * The read finishes before the delete, and the delete and the lower running count are one transaction.
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {TokenTable} table
 * @param {TokenTableLimits} [limits]
 * @returns {Promise<number>} The rows deleted; 0 at or under the cap.
 */
export async function pruneBatch(directories, table, limits = DEFAULT_TOKEN_TABLE_LIMITS) {
    if (!TOKEN_TABLES.includes(table)) throw new Error(`Not a token table: ${table}`);
    const db = await getMessageTreeDb(directories);
    return db ? pruneBatchSync(db, directories, table, limits) : 0;
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {TokenTable} table
 * @param {TokenTableLimits} limits
 * @returns {number} The rows deleted.
 */
function pruneBatchSync(db, directories, table, { cap, batchRows }) {
    const over = readRowCount(db, table) - cap;
    if (over <= 0) return 0;
    const limit = Math.min(batchRows, over);
    const rows = /** @type {{ identity: string, text_hash: string, last_used: number }[]} */ (db.readBounded(
        `SELECT identity, text_hash, last_used FROM ${table} ORDER BY last_used LIMIT @limit`, { limit }, limit));
    if (rows.length === 0) {
        throw new Error(`${table} of ${directories.root} has a running count of ${readRowCount(db, table)} but no rows`);
    }
    const state = { deleted: 0 };
    db.transaction(() => {
        // Reset here: a transaction that hits busy is rolled back and rerun.
        state.deleted = 0;
        for (const row of rows) {
            state.deleted += db.run(
                `DELETE FROM ${table} WHERE identity = @identity AND text_hash = @hash AND last_used = @lastUsed`,
                { identity: row.identity, hash: row.text_hash, lastUsed: row.last_used }).changes;
        }
        addToRowCount(db, ROW_COUNT_KEYS[table], -state.deleted);
    });
    return state.deleted;
}

/**
 * Prunes the table a batch at a time, with a pause between batches, until it is at or under the cap, and logs how
 * many rows it deleted when it deleted any.
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {TokenTable} table
 * @param {TokenTableLimits} [limits]
 * @param {() => void} [release] Called in the same synchronous step as the check that finds the table at or under
 *   the cap.
 * @returns {Promise<number>} The batches that deleted rows.
 */
export async function pruneTokenTable(directories, table, limits = DEFAULT_TOKEN_TABLE_LIMITS, release = () => {}) {
    if (!TOKEN_TABLES.includes(table)) throw new Error(`Not a token table: ${table}`);
    let batches = 0;
    let deleted = 0;
    for (;;) {
        const db = await getMessageTreeDb(directories);
        const batchDeleted = db ? pruneBatchSync(db, directories, table, limits) : 0;
        if (batchDeleted === 0) {
            release();
            if (deleted > 0) {
                console.log(`[token-count-store] Pruned ${deleted} rows from ${table} of ${directories.root}, least recently used first, to its cap of ${limits.cap}.`);
            }
            return batches;
        }
        deleted += batchDeleted;
        batches++;
        await delay(limits.pauseMs);
    }
}

/**
 * Sets the table's running row count from a count read in primary key pages of `batchRows`, with a pause between
 * pages. Rows written meanwhile are counted once (see {@link rowCountFills}). Writes only when the count differs.
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {TokenTable} table
 * @param {TokenTableLimits} limits
 */
async function setRowCountFromTable(directories, table, { batchRows, pauseMs }) {
    const db = await getMessageTreeDb(directories);
    if (!db) return;
    const key = jobKey(directories, table);
    /** @type {{ after: { identity: string, hash: string } | null, behind: number }} */
    const fill = { after: null, behind: 0 };
    rowCountFills.set(key, fill);
    try {
        let counted = 0;
        for (;;) {
            const page = /** @type {{ identity: string, text_hash: string }[]} */ (fill.after === null
                ? db.readBounded(`SELECT identity, text_hash FROM ${table} ORDER BY identity, text_hash LIMIT @limit`, { limit: batchRows }, batchRows)
                : db.readBounded(
                    `SELECT identity, text_hash FROM ${table} WHERE (identity, text_hash) > (@identity, @hash) ORDER BY identity, text_hash LIMIT @limit`,
                    { identity: fill.after.identity, hash: fill.after.hash, limit: batchRows }, batchRows));
            counted += page.length;
            if (page.length < batchRows) break;
            const last = page[page.length - 1];
            fill.after = { identity: last.identity, hash: last.text_hash };
            await delay(pauseMs);
        }
        const total = counted + fill.behind;
        if (readRowCount(db, table) !== total) {
            setTreeMetaSync(db, ROW_COUNT_KEYS[table], String(total));
        }
    } finally {
        rowCountFills.delete(key);
    }
}

/**
 * After listen, for each store in turn and each of its tables: waits for a prune already running, sets the running
 * row count from the table ({@link setRowCountFromTable}), then prunes it if it is over the cap. Meant to be called
 * without awaiting it.
 * @param {import('./message-tree-db.js').Directories[]} directoriesList
 * @param {TokenTableLimits} [limits]
 * @returns {Promise<void>} Settles once every store is done.
 */
export async function startTokenCountMaintenance(directoriesList, limits = DEFAULT_TOKEN_TABLE_LIMITS) {
    for (const directories of directoriesList) {
        for (const table of TOKEN_TABLES) {
            const key = jobKey(directories, table);
            while (tableJobs.has(key)) await tableJobs.get(key);
            await startTableJob(key, async (release) => {
                await setRowCountFromTable(directories, table, limits);
                await pruneTokenTable(directories, table, limits, release);
            }, `Counting and pruning ${table} of ${directories.root}`);
        }
    }
}

/**
 * @param {import('./message-tree-db.js').Directories} directories
 * @returns {Promise<void>} Settles once neither of the store's tables has a count or prune running.
 */
export async function tokenCountMaintenanceIdle(directories) {
    for (const table of TOKEN_TABLES) {
        const key = jobKey(directories, table);
        while (tableJobs.has(key)) await tableJobs.get(key);
    }
}

/**
 * A read of the token tables, where a failure is logged and answers null, a miss: upstream never reads these
 * tables, so a request mustn't fail because they can't be read.
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
 * Counts and encodes through the `token_counts` and `token_ids` tables, for one request. With a null
 * identity everything is counted or encoded as it is without the tables, and nothing is read or pending.
 * Otherwise a text already stored under `identity` is read, not counted, and its row is pending so write-back
 * marks it used; a text not stored is counted, and its row is pending under the identity of the tokenizer
 * that answered, so a local copy's answer is stored under the copy's identity and an estimate or null ids
 * aren't stored. A read that fails is logged and counts as not stored. Each key is read or counted once per counter.
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
        const read = await readOrMiss(() => (kind === TOKEN_KEY_KINDS.IDS
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
