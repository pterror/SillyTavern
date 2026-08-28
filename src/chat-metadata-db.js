import fs from 'node:fs';
import path from 'node:path';

import { color } from './util.js';
import { getSqliteEngine } from './endpoints/sqlite-engine.js';

/**
 * Per-user SQLite store of per-chat-file metadata (message count, last message preview, mtime/size), keyed by the
 * chat file's own absolute path. Exists to replace the "readline the entire file, on every request, for every
 * chat" cost that `/api/chats/recent` and the no-query listing branch of `/api/chats/search` (chats.js) both pay
 * today via `getChatInfo()` - confirmed against a real install with 15,459 chat files (1.7G, one character alone
 * ~3,900 chats) that this happens on EVERY request to either endpoint, not just once.
 *
 * DELIBERATELY NOT KEYED BY OWNER (character avatar / group id): every caller that needs "which chat files
 * belong to this character/group" already resolves that cheaply today (a `readdir` of the character's chat
 * directory, or reading the group's own JSON `chats` array) - neither of those is the expensive part, the
 * per-file readline is. So this store's only job is "given a chat file's path and its current mtime, do we have
 * a cached parse of its last message / count, or does the caller need to compute it" - no owner column, no
 * per-owner query surface, just a path -> row cache. This also sidesteps ever having to resolve which group owns
 * a chat file (bumpGroupChatStats() in character-metadata-db.js has to do exactly that resolution, and its own
 * doc comment is proof it's non-trivial) for something that was never actually needed here.
 *
 * ONE-WAY IMPORT ARROW, same rule character-metadata-db.js's own header documents and for the same reason: this
 * module must never import chats.js (it would need `getChatInfo()` to fall back to a full parse on a cache miss,
 * but chats.js already imports the write-path hooks below) - that's the exact two-way cycle tags-data.js was
 * once bitten by. So this module knows nothing about how to parse a `.jsonl` chat file; it only stores/retrieves
 * already-computed rows. The fallback-parse-on-miss orchestration lives in chats.js itself.
 *
 * CHANGE LOG (`changes` table, monotonic `seq`): written by every upsert/delete alongside the row, mirroring
 * character-metadata-db.js's own `changes` table shape (seq INTEGER PRIMARY KEY AUTOINCREMENT). This
 * table has no reader in this phase of the build - it exists as the durable, ordered "what changed since seq N"
 * feed the per-message tantivy content index needs for incremental catch-up (same shape
 * characters-search-index.js already consumes from character-metadata-db.js's own `changes` table), landing in
 * this store now so the write-path hook only has to be wired up once.
 *
 * NO WATCHER, NO BACKGROUND RECONCILER (unlike character-metadata-db.js's three-freshness-mechanism design) -
 * deliberately scoped down for this phase. Freshness here is self-healing purely on read: every read helper in
 * chats.js compares a row's stored `mtime` against the file's current mtime and transparently falls back to a
 * full parse (updating the row) on any mismatch or miss - see getOrComputeChatInfo() in chats.js. That covers
 * every case a watcher/reconciler pair would (a file edited outside the write-path hook, a cold start with no
 * rows yet) at the cost of the FIRST read after such a change still paying a full parse, which is an accepted
 * trade for not replicating character-metadata-db.js's full watcher/debounce/reconcile-interval machinery for a
 * store whose only current writer (trySaveChat(), plus the /delete and /rename routes) already covers the
 * overwhelming majority of real writes.
 */

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS chats (
        file_path          TEXT PRIMARY KEY,
        file_name          TEXT NOT NULL,
        mtime              INTEGER NOT NULL,
        file_size          INTEGER NOT NULL,
        message_count      INTEGER NOT NULL,
        last_mes           TEXT,
        preview            TEXT,
        chat_metadata_json TEXT,
        change_seq         INTEGER NOT NULL,
        -- How many of this chat's messages the planned tantivy content index (chat-content-search-index.js) has
        -- already indexed, as of its own last catch-up pass - -1 means "never indexed" (distinct from a real
        -- 0-message chat). NOT touched by upsertRow()/deleteChatRow()/renameChatRow() above and NOT logged as a
        -- change (see setIndexedMessageCount() below) - this is index bookkeeping, not a "this chat changed"
        -- event, so writing it must never itself bump 'change_seq' (that would make the content index perpetually see
        -- its own catch-up as new work to catch up on again). This is what lets that index's incremental catch-up
        -- add tantivy documents only for messages at index >= this watermark on an ordinary append (the common
        -- case: sending a message), instead of re-indexing a chat's entire text on every save - see that
        -- module's own header for the full rationale.
        indexed_message_count INTEGER NOT NULL DEFAULT -1
    );
    CREATE INDEX IF NOT EXISTS idx_chats_mtime ON chats(mtime);

    CREATE TABLE IF NOT EXISTS changes (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        op        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changes_file_path ON changes(file_path);

    -- Generic key/value store, mirroring character-metadata-db.js's own 'meta' table - the planned per-message
    -- tantivy content index (chat-content-search-index.js) uses this to persist its own "caught up to seq N"
    -- watermark (same TANTIVY_SEQ_META_KEY pattern that module's character equivalent already uses), so a
    -- persisted index can be reopened and incrementally caught up instead of rebuilt from scratch on every
    -- process restart.
    CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
    );
`;

const UPSERT_SQL = `
    INSERT INTO chats (
        file_path, file_name, mtime, file_size, message_count, last_mes, preview, chat_metadata_json, change_seq
    ) VALUES (
        @filePath, @fileName, @mtime, @fileSize, @messageCount, @lastMes, @preview, @chatMetadataJson, @changeSeq
    )
    ON CONFLICT(file_path) DO UPDATE SET
        file_name = excluded.file_name,
        mtime = excluded.mtime,
        file_size = excluded.file_size,
        message_count = excluded.message_count,
        last_mes = excluded.last_mes,
        preview = excluded.preview,
        chat_metadata_json = excluded.chat_metadata_json,
        change_seq = excluded.change_seq
`;

/** @type {Map<string, { db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle }>} Keyed by directories.root */
const entries = new Map();

/** True once a "no usable SQLite backend" warning has been printed, so it only happens once per process. */
let warnedNoEngine = false;

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {string}
 */
function getDbPath(directories) {
    return path.join(directories.root, 'chat-metadata.sqlite');
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<{ db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle } | null>} `null` if no
 * usable SQLite backend exists on this install - callers must treat that as "the chat metadata store is
 * unavailable this run" and no-op / fall back to a full parse, same posture character-metadata-db.js's own
 * getEntry() documents.
 */
async function getEntry(directories) {
    const key = directories.root;
    const existing = entries.get(key);
    if (existing) {
        return existing;
    }

    const engine = await getSqliteEngine();
    if (!engine) {
        if (!warnedNoEngine) {
            warnedNoEngine = true;
            console.error(color.red('[chat-metadata] No usable SQLite backend on this install - the chat metadata store is unavailable this run, falling back to full-file parses.'));
        }
        return null;
    }

    if (!fs.existsSync(directories.root)) {
        fs.mkdirSync(directories.root, { recursive: true });
    }
    const db = engine.openDatabase(getDbPath(directories));
    db.exec(SCHEMA_SQL);
    const chatCols = db.all("PRAGMA table_info('chats')").map(c => c.name);
    if (chatCols.includes('rev') && !chatCols.includes('change_seq')) {
        db.exec("ALTER TABLE chats RENAME COLUMN rev TO change_seq");
    }
    const changeCols = db.all("PRAGMA table_info('changes')").map(c => c.name);
    if (changeCols.includes('rev') && !changeCols.includes('seq')) {
        db.exec("ALTER TABLE changes RENAME COLUMN rev TO seq");
    }
    db.run("UPDATE meta SET key = 'chat_content_index_seq' WHERE key = 'chat_content_index_rev'");
    const entry = { db };
    entries.set(key, entry);
    return entry;
}

/**
 * @typedef {object} ChatRow
 * @property {string} file_path
 * @property {string} file_name
 * @property {number} mtime
 * @property {number} file_size
 * @property {number} message_count
 * @property {string|null} last_mes
 * @property {string|null} preview
 * @property {string|null} chat_metadata_json
 * @property {number} change_seq
 */

/**
 * @typedef {object} ChatRowFields Everything UPSERT_SQL needs except `filePath`/`changeSeq` (rev is only known once the
 * change-log entry is inserted, filePath is always the caller's own key).
 * @property {string} fileName
 * @property {number} mtime
 * @property {number} fileSize
 * @property {number} messageCount
 * @property {string|null} lastMes
 * @property {string|null} preview
 * @property {string|null} chatMetadataJson
 */

/**
 * Writes one row plus its change-log entry, inside a transaction so a crash between the two can never leave a
 * row without a corresponding `changes` entry (the invariant the planned tantivy catch-up will rely on, same as
 * character-metadata-db.js's writeRowSync() alongside its own `changes` table).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filePath
 * @param {ChatRowFields} fields
 * @returns {Promise<void>}
 */
async function upsertRow(directories, filePath, fields) {
    const entry = await getEntry(directories);
    if (!entry) return;

    entry.db.transaction(() => {
        const { lastInsertRowid } = entry.db.run('INSERT INTO changes (file_path, op) VALUES (@filePath, @op)', { filePath, op: 'upsert' });
        entry.db.run(UPSERT_SQL, {
            filePath,
            fileName: fields.fileName,
            mtime: fields.mtime,
            fileSize: fields.fileSize,
            messageCount: fields.messageCount,
            lastMes: fields.lastMes ?? null,
            preview: fields.preview ?? null,
            chatMetadataJson: fields.chatMetadataJson ?? null,
            changeSeq: Number(lastInsertRowid),
        });
    });
}

/**
 * Write-path hook for trySaveChat() (chats.js) - computes the row directly from the chat array that's already
 * in memory (the same array that was just serialized and written to disk), so this pays ZERO extra file I/O:
 * no re-read, no re-parse, not even a re-stat (the caller already knows the exact byte length it just wrote and
 * the file's post-write mtime from its own fs.statSync() immediately after the write). This is the fast path
 * that makes the write-time cost of keeping this store fresh negligible compared to the read-time cost it
 * replaces.
 *
 * Mirrors getChatInfo()'s (chats.js) own last-line-wins parsing rules exactly, so a row computed here and a row
 * computed by chats.js's full-parse fallback (getOrComputeChatInfo()) are indistinguishable to a reader:
 *   - message_count = the array length minus the first (header) item
 *   - last_mes/preview come from the LAST item's `send_date`/`mes`
 *   - chat_metadata comes from the FIRST item's `chat_metadata`, if it's an object
 * A malformed/empty array degrades the same way getChatInfo() does for a truncated/empty file (message_count 0,
 * a placeholder preview) rather than throwing - a metadata-store write must never be the reason a chat save
 * itself fails.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filePath
 * @param {Array<object>} chatData The chat array that was just saved (same array trySaveChat() serialized)
 * @param {number} mtimeMs The saved file's mtime, read by the caller right after the write
 * @param {number} fileSizeBytes The saved file's byte size, already known by the caller (Buffer.byteLength of
 * the serialized jsonl) - no extra stat needed for this.
 * @returns {Promise<void>}
 */
export async function upsertChatFromSave(directories, filePath, chatData, mtimeMs, fileSizeBytes) {
    const fileName = path.basename(filePath);

    if (!Array.isArray(chatData) || chatData.length === 0) {
        await upsertRow(directories, filePath, {
            fileName,
            mtime: Math.round(mtimeMs),
            fileSize: fileSizeBytes,
            messageCount: 0,
            lastMes: null,
            preview: '[The chat is empty]',
            chatMetadataJson: null,
        });
        return;
    }

    const firstItem = chatData[0];
    const lastItem = chatData[chatData.length - 1];
    const chatMetadataJson = (firstItem && typeof firstItem.chat_metadata === 'object' && firstItem.chat_metadata !== null)
        ? JSON.stringify(firstItem.chat_metadata)
        : null;

    await upsertRow(directories, filePath, {
        fileName,
        mtime: Math.round(mtimeMs),
        fileSize: fileSizeBytes,
        messageCount: chatData.length - 1,
        lastMes: lastItem?.send_date != null ? String(lastItem.send_date) : new Date(Math.round(mtimeMs)).toISOString(),
        preview: lastItem?.mes || '[The message is empty]',
        chatMetadataJson,
    });
}

/**
 * Self-heal / cold-start write path for chats.js's getOrComputeChatInfo(): after a full parse (cache miss or
 * stale mtime), the freshly computed ChatInfo gets stored here so the next read is a cache hit. Kept separate
 * from upsertChatFromSave() because the shapes differ slightly (ChatInfo already has `mes`/`last_mes`/
 * `chat_items`/`chat_metadata` computed - this just re-shapes those into a row instead of re-deriving them from
 * a raw array).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filePath
 * @param {{ mtimeMs: number, size: number }} stats
 * @param {{ chat_items?: number, mes?: string, last_mes?: number|string, chat_metadata?: object }} chatInfo
 * @returns {Promise<void>}
 */
export async function upsertChatFromParse(directories, filePath, stats, chatInfo) {
    await upsertRow(directories, filePath, {
        fileName: path.basename(filePath),
        mtime: Math.round(stats.mtimeMs),
        fileSize: stats.size,
        messageCount: chatInfo.chat_items ?? 0,
        lastMes: chatInfo.last_mes != null ? String(chatInfo.last_mes) : null,
        preview: chatInfo.mes ?? null,
        chatMetadataJson: chatInfo.chat_metadata ? JSON.stringify(chatInfo.chat_metadata) : null,
    });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filePath
 * @returns {Promise<ChatRow | undefined>}
 */
export async function getChatRow(directories, filePath) {
    const entry = await getEntry(directories);
    if (!entry) return undefined;
    return entry.db.get('SELECT * FROM chats WHERE file_path = @filePath', { filePath });
}

/**
 * Write-path hook for chats.js's /delete route.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filePath
 * @returns {Promise<void>}
 */
export async function deleteChatRow(directories, filePath) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.transaction(() => {
        entry.db.run('DELETE FROM chats WHERE file_path = @filePath', { filePath });
        entry.db.run('INSERT INTO changes (file_path, op) VALUES (@filePath, @op)', { filePath, op: 'delete' });
    });
}

/**
 * Write-path hook for chats.js's /rename route - moves the row (and stamps a fresh change-log entry under the
 * new path) rather than deleting-then-relying-on-a-later-upsert, so a rename doesn't cost the new path its cache
 * warmth (a plain delete would make the very next read of the renamed file pay a full parse for no reason - the
 * content and mtime carry over untouched by a rename, only the path changes).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} oldFilePath
 * @param {string} newFilePath
 * @returns {Promise<void>}
 */
export async function renameChatRow(directories, oldFilePath, newFilePath) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const existingRow = entry.db.get('SELECT * FROM chats WHERE file_path = @filePath', { filePath: oldFilePath });
    entry.db.transaction(() => {
        entry.db.run('DELETE FROM chats WHERE file_path = @filePath', { filePath: oldFilePath });
        entry.db.run('INSERT INTO changes (file_path, op) VALUES (@filePath, @op)', { filePath: oldFilePath, op: 'delete' });
        if (existingRow) {
            const { lastInsertRowid } = entry.db.run('INSERT INTO changes (file_path, op) VALUES (@filePath, @op)', { filePath: newFilePath, op: 'upsert' });
            entry.db.run(UPSERT_SQL, {
                filePath: newFilePath,
                fileName: path.basename(newFilePath),
                mtime: existingRow.mtime,
                fileSize: existingRow.file_size,
                messageCount: existingRow.message_count,
                lastMes: existingRow.last_mes,
                preview: existingRow.preview,
                chatMetadataJson: existingRow.chat_metadata_json,
                changeSeq: Number(lastInsertRowid),
            });
        }
    });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<number>} The highest seq currently recorded, or 0 if the store is empty/unavailable - the
 * freshness signature the planned tantivy content index will diff its own last-caught-up seq against.
 */
export async function getLatestSeq(directories) {
    const entry = await getEntry(directories);
    if (!entry) return 0;
    const row = entry.db.get('SELECT MAX(seq) as seq FROM changes');
    return Number(row?.seq ?? 0);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} sinceSeq Exclusive lower bound - only changes strictly newer than this are returned.
 * @returns {Promise<{ seq: number, file_path: string, op: string }[]>} Ordered oldest-first, so a caller
 * replaying them to catch an index up applies them in the order they actually happened.
 */
export async function getChangesSince(directories, sinceSeq) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return entry.db.all('SELECT seq, file_path, op FROM changes WHERE seq > @sinceSeq ORDER BY seq ASC', { sinceSeq });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filePath
 * @returns {Promise<number>} How many of this chat's messages chat-content-search-index.js has already indexed
 * (-1 if never indexed, or if this file isn't tracked at all - both mean "start from scratch").
 */
export async function getIndexedMessageCount(directories, filePath) {
    const entry = await getEntry(directories);
    if (!entry) return -1;
    const row = entry.db.get('SELECT indexed_message_count FROM chats WHERE file_path = @filePath', { filePath });
    return row ? Number(row.indexed_message_count) : -1;
}

/**
 * Write-path hook for chat-content-search-index.js's incremental catch-up - records how many messages of this
 * chat have now been indexed. Deliberately a plain UPDATE with no `changes` table insert (see this column's own
 * SCHEMA_SQL comment: this is index bookkeeping, not a "chat changed" event, and logging it as one would make
 * the content index perpetually catch up on its own catch-up). A no-op if the row no longer exists (the chat was
 * deleted between the catch-up pass reading its change and writing this back) - nothing to update.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filePath
 * @param {number} count
 * @returns {Promise<void>}
 */
export async function setIndexedMessageCount(directories, filePath, count) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run('UPDATE chats SET indexed_message_count = @count WHERE file_path = @filePath', { filePath, count });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} key
 * @returns {Promise<string | null>}
 */
export async function getMetaValue(directories, key) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = entry.db.get('SELECT value FROM meta WHERE key = @key', { key });
    return row ? row.value : null;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} key
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function setMetaValue(directories, key, value) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key, value });
}

/**
 * Closes every open db handle this module has opened and forgets them - test cleanup, mirroring
 * character-metadata-db.js's own disposeMetadataStores() (same reasoning: each test uses a fresh tempDir/cache
 * key, so this never affects another test's state, it just keeps native SQLite handles from accumulating across
 * a whole suite run).
 */
export function disposeChatMetadataStores() {
    for (const entry of entries.values()) {
        try {
            entry.db.close();
        } catch {
            // Best-effort on shutdown.
        }
    }
    entries.clear();
}
