import fs from 'node:fs';
import path from 'node:path';

import { color } from './util.js';
import { getSqliteEngine } from './endpoints/sqlite-engine.js';

/**
 * Per-user SQLite cache of per-chat-file metadata (message count, last message preview, mtime/size), keyed by the
 * chat file's absolute path. Avoids re-parsing whole chat files on every `/api/chats/recent` and
 * `/api/chats/search` request.
 *
 * Not keyed by owner (character/group) - resolving "which files belong to this owner" is already cheap
 * (readdir / group JSON), so this is purely a path -> row cache.
 *
 * Must never be imported by chats.js's parse path in reverse - chats.js imports the write-path hooks below, not
 * the other way, to avoid an import cycle.
 *
 * Freshness is self-healing on read: callers compare a row's stored `mtime` against the file's current mtime and
 * fall back to a full parse on mismatch/miss (see getOrComputeChatInfo() in chats.js). No watcher/reconciler.
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
        -- Catch-up watermark for a content index; -1 means never indexed. Never bumps change_seq itself, or the
        -- index would see its own catch-up as new work.
        indexed_message_count INTEGER NOT NULL DEFAULT -1
    );
    CREATE INDEX IF NOT EXISTS idx_chats_mtime ON chats(mtime);

    CREATE TABLE IF NOT EXISTS changes (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        op        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changes_file_path ON changes(file_path);

    -- Generic key/value store for persisting index catch-up watermarks across restarts.
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

let warnedNoEngine = false;

function getDbPath(directories) {
    return path.join(directories.root, 'chat-metadata.sqlite');
}

/**
 * @returns {Promise<{ db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle } | null>} `null` if no
 * usable SQLite backend exists - callers must fall back to a full parse.
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
    const chatCols = db.all('PRAGMA table_info(\'chats\')').map(c => c.name);
    if (chatCols.includes('rev') && !chatCols.includes('change_seq')) {
        db.exec('ALTER TABLE chats RENAME COLUMN rev TO change_seq');
    }
    const changeCols = db.all('PRAGMA table_info(\'changes\')').map(c => c.name);
    if (changeCols.includes('rev') && !changeCols.includes('seq')) {
        db.exec('ALTER TABLE changes RENAME COLUMN rev TO seq');
    }
    db.run('UPDATE meta SET key = \'chat_content_index_seq\' WHERE key = \'chat_content_index_rev\'');
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
 * @typedef {object} ChatRowFields
 * @property {string} fileName
 * @property {number} mtime
 * @property {number} fileSize
 * @property {number} messageCount
 * @property {string|null} lastMes
 * @property {string|null} preview
 * @property {string|null} chatMetadataJson
 */

/** Writes the row and its change-log entry in one transaction, so a crash can't leave one without the other. */
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
 * Computes the row from the already-in-memory chat array instead of re-reading the file. Mirrors chats.js's
 * getChatInfo() parsing rules exactly, so this row and a full-parse row are indistinguishable.
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

/** Stores a freshly-parsed ChatInfo (cache miss/stale mtime) so the next read is a cache hit. */
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

/** @returns {Promise<ChatRow | undefined>} */
export async function getChatRow(directories, filePath) {
    const entry = await getEntry(directories);
    if (!entry) return undefined;
    return entry.db.get('SELECT * FROM chats WHERE file_path = @filePath', { filePath });
}

export async function deleteChatRow(directories, filePath) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.transaction(() => {
        entry.db.run('DELETE FROM chats WHERE file_path = @filePath', { filePath });
        entry.db.run('INSERT INTO changes (file_path, op) VALUES (@filePath, @op)', { filePath, op: 'delete' });
    });
}

/** Moves the row to the new path instead of delete+re-parse, since content/mtime are unchanged by a rename. */
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

/** @returns {Promise<number>} The highest seq currently recorded, or 0 if empty/unavailable. */
export async function getLatestSeq(directories) {
    const entry = await getEntry(directories);
    if (!entry) return 0;
    const row = entry.db.get('SELECT MAX(seq) as seq FROM changes');
    return Number(row?.seq ?? 0);
}

/**
 * @param {number} sinceSeq Exclusive lower bound.
 * @returns {Promise<{ seq: number, file_path: string, op: string }[]>} Ordered oldest-first.
 */
export async function getChangesSince(directories, sinceSeq) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return entry.db.all('SELECT seq, file_path, op FROM changes WHERE seq > @sinceSeq ORDER BY seq ASC', { sinceSeq });
}

/** @returns {Promise<number>} How many messages have been indexed (-1 means never/untracked). */
export async function getIndexedMessageCount(directories, filePath) {
    const entry = await getEntry(directories);
    if (!entry) return -1;
    const row = entry.db.get('SELECT indexed_message_count FROM chats WHERE file_path = @filePath', { filePath });
    return row ? Number(row.indexed_message_count) : -1;
}

/** Plain UPDATE, deliberately not logged to `changes` (would make the index catch up on its own catch-up). */
export async function setIndexedMessageCount(directories, filePath, count) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run('UPDATE chats SET indexed_message_count = @count WHERE file_path = @filePath', { filePath, count });
}

export async function getMetaValue(directories, key) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = entry.db.get('SELECT value FROM meta WHERE key = @key', { key });
    return row ? row.value : null;
}

export async function setMetaValue(directories, key, value) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key, value });
}

/** Test cleanup: closes every open db handle so native SQLite handles don't accumulate across a suite run. */
export function disposeChatMetadataStores() {
    for (const entry of entries.values()) {
        try {
            entry.db.close();
        } catch {
            // Best-effort.
        }
    }
    entries.clear();
}
