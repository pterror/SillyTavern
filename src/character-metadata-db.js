import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import _ from 'lodash';
import sanitize from 'sanitize-filename';

import { color, getConfigValue, mapWithConcurrency, parseCreateDateToEpochMs } from './util.js';
import extract from 'png-chunks-extract';
import { parse as parseCharacterCard, readCharaChunkPristineFromChunks, computeAvatarIdentityHashFromChunks } from './character-card-parser.js';
import { getCharaCardV2, computeContentIdentityHash } from './character-card-normalize.js';
import { calculateChatSize, calculateDataSize, calculateGroupChatStats, resolveGroupOwner, toShallow } from './character-shallow.js';
import { readTagsData } from './endpoints/tags-data.js';
import { getSqliteEngine } from './endpoints/sqlite-engine.js';
import { TAGS_FILE } from './constants.js';
// getStringHash must match public/scripts/random-sort.js's compareByRandomSeed() exactly, or server/client random-sort ordering diverges.
import { getStringHash, DEFAULT_DIGEST_BUCKET_COUNT, bucketOf, contentHashOf, emptyDigest, combineDigest, characterDigestFavHash, characterDigestFieldsHash, characterDigestTagIdsHash, groupDigestFavHash, groupDigestTagIdsHash, groupDigestContentHash } from '../public/scripts/hash-utils.js';
import { runDigestWorkerTask } from './character-metadata-digest-dispatch.js';

export const characterChangeEmitter = new EventEmitter();

// Bounds memory growth from seed churn.
const MAX_RANDOM_CACHE_ENTRIES = 10;
/** @type {Map<string, { seq: number, sortedIds: string[], db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle }>} */
const randomSortCache = new Map();

let randomCacheWarmTimer = null;

// Debounced so a batch of rapid changes triggers only one recomputation.
characterChangeEmitter.on('change', () => {
    clearTimeout(randomCacheWarmTimer);
    randomCacheWarmTimer = setTimeout(() => {
        for (const [key, entry] of randomSortCache) {
            const seqRow = entry.db.get('SELECT COALESCE(MAX(seq), 0) as seq FROM changes');
            const currentSeq = Number(seqRow?.seq ?? 0);
            if (entry.seq !== currentSeq) {
                const colonIdx = key.lastIndexOf(':');
                const seed = Number(key.slice(colonIdx + 1));
                const charIds = entry.db.all('SELECT id FROM characters').map(r => r.id);
                const groupIds = entry.db.all('SELECT id FROM groups').map(r => r.id);
                const allIds = [...charIds, ...groupIds];
                const hashed = allIds.map(id => ({ id, h: getStringHash(String(id), seed) }));
                hashed.sort((a, b) => a.h - b.h);
                entry.sortedIds = hashed.map(r => r.id);
                entry.seq = currentSeq;
            }
        }
    }, 500);
});

function insertChange(db, id, op, fields) {
    const { lastInsertRowid } = db.run('INSERT INTO changes (id, op, fields) VALUES (@id, @op, @fields)', { id, op, fields });
    characterChangeEmitter.emit('change');
    return Number(lastInsertRowid);
}

// Per-user SQLite index for character metadata. FTS lives in characters-search-index.js, not here.
// Import direction is one-way: characters.js/tags.js import this module, never the reverse.
// date_added is write-once: every upsert's ON CONFLICT omits it from the SET list.

const BATCH_FLUSH_SIZE = 500;

// Shares characterIndexBuildConcurrency with characters-search-index.js's build - same disk-bound workload.
const BOOTSTRAP_READ_CONCURRENCY = getConfigValue('performance.characterIndexBuildConcurrency', 64, 'number');

const BOOTSTRAP_PROGRESS_LOG_INTERVAL_MS = 5000;

// Backfilling identity hashes requires reading every poisoned row's PNG off disk; this lets an install opt out.
export const allowExpensiveDuplicateFallback = !!getConfigValue('performance.allowExpensiveDuplicateFallback', true, 'boolean');

// Coalesces duplicate raw fs events (e.g. a rename-over-target firing both 'rename' and 'change') per filename.
const WATCH_DEBOUNCE_MS = 300;

/**
 * @typedef {object} MetadataDbEntry
 * @property {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @property {import('./users.js').UserDirectoryList} directories
 * @property {import('node:fs').FSWatcher | null} watcher
 * @property {Map<string, NodeJS.Timeout>} watchTimers
 * @property {{ pending: Map<string, PendingRow> } | null} batch Non-null while batch-import mode is active
 * @property {Promise<void> | null} bootstrapPromise
 * @property {{ tagNameToId: Map<string, string>, tagIdToDefinition: Map<string, object> } | null} [tagCache]
 */

/**
 * @typedef {object} PendingRow
 * @property {object} row
 * @property {boolean} forceDateAdded True if row.date_added must be used verbatim even on conflict (rename)
 * @property {string[]} tagIds
 */

/** @type {Map<string, MetadataDbEntry>} Keyed by directories.root. */
const entries = new Map();

let warnedNoEngine = false;

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS characters (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        name_fold      TEXT NOT NULL,
        fav            INTEGER NOT NULL,
        date_added     INTEGER NOT NULL,
        -- Epoch ms, parsed via parseCreateDateToEpochMs(); NULL if the card's create_date is missing/unparseable.
        -- Must stay INTEGER (not TEXT) or a mixed-type UNION ORDER BY with groups.date_added misorders rows.
        create_date    INTEGER,
        date_last_chat INTEGER NOT NULL,
        chat_size      INTEGER NOT NULL,
        data_size      INTEGER NOT NULL,
        file_mtime     INTEGER NOT NULL,
        world          TEXT,
        creator        TEXT,
        version        TEXT,
        creator_notes  TEXT,
        shallow_json   TEXT NOT NULL,
        change_seq     INTEGER NOT NULL,
        -- NULL is ambiguous: "confirmed no chat" vs "not examined yet" look identical, which would make a
        -- resumability query re-read every no-chat card off disk on every boot. active_chat_checked disambiguates.
        active_chat    TEXT,
        -- 0 = not examined, 1 = resolved one way or the other (real chat name or confirmed none). Never regresses 1->0.
        active_chat_checked INTEGER NOT NULL DEFAULT 0,
        -- Pre-computed per-field digest hashes for the anti-entropy worker (hash-utils.js's characterDigest* fns).
        digest_fav     INTEGER,
        digest_tag_ids INTEGER,
        digest_content INTEGER,
        -- Full Spec-V2 card JSON, authoritative when the PNG's embedded tEXt chunk is stale. NULL means "PNG chunk
        -- is current, read from there" - a metadata-only edit stores JSON here without rewriting the PNG (keeps
        -- storage proportional to cards actually edited, not library size); any write that rewrites the PNG
        -- clears this to NULL. readCardContent() (characters.js) is the read seam; it bypasses the mtime-keyed
        -- PNG cache for the non-NULL case since a db-only write doesn't move the file's mtime. Export paths
        -- materialize this column into the PNG chunk so exported files stay self-contained.
        card_json      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_characters_name_fold ON characters(name_fold);
    CREATE INDEX IF NOT EXISTS idx_characters_date_added ON characters(date_added);
    CREATE INDEX IF NOT EXISTS idx_characters_date_last_chat ON characters(date_last_chat);
    CREATE INDEX IF NOT EXISTS idx_characters_create_date ON characters(create_date);
    CREATE INDEX IF NOT EXISTS idx_characters_data_size ON characters(data_size);
    CREATE INDEX IF NOT EXISTS idx_characters_chat_size ON characters(chat_size);
    CREATE INDEX IF NOT EXISTS idx_characters_fav_name_fold ON characters(fav, name_fold);
    CREATE INDEX IF NOT EXISTS idx_characters_world ON characters(world);
    -- content_hash: sha256 of the raw uploaded import source bytes. NULL for anything not imported through that
    -- path or predating the column; never backfilled, so NULL/NULL is never treated as a match.
    --
    -- content_identity_hash: a different hash - fingerprints semantic content with install-local fields stripped
    -- (stripInstallLocalFields()), recomputed on every successful write, so two independently-imported copies of
    -- the same card can be recognized as the same character. Only valid if the file went through the current
    -- minimal-mutation write path; import_poisoned=1 flags rows where it might not have (old, more-mutating
    -- import logic). Every pre-existing row starts poisoned; only upsertCharacterFromWrite() clears it, since
    -- only an actual write through the current path proves the file is current.
    --
    -- backfillContentIdentityHashes() populates content_identity_hash a third way, from the PNG's pristine
    -- 'chara' chunk, but deliberately does NOT clear import_poisoned - the flag also means "file may carry other
    -- old-write-path artifacts" (forced ccv3 upgrade, old avatar re-encode), which stays true regardless.
    --
    -- avatar_identity_hash: computeAvatarIdentityHashFromChunks() - sha256 over raw IDAT payload bytes, not a
    -- decoded-pixel hash. Independent from content_identity_hash (same text, different portrait can share one but
    -- not the other); a real identity match requires both (findCharacterIdByIdentityHashes()). Populated on every
    -- write, and via a one-time backfill (scripts/backfill-avatar-identity-hashes.mjs) that reads/writes rows
    -- independently (WHERE avatar_identity_hash IS NULL) so a concurrent live write for the same row just wins.

    CREATE TABLE IF NOT EXISTS character_tags (
        character_id TEXT NOT NULL,
        tag_id       TEXT NOT NULL,
        PRIMARY KEY (character_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_character_tags_tag ON character_tags(tag_id, character_id);

    -- Maintained by the two triggers below, not by application code, so it can never drift from
    -- character_tags regardless of which code path inserts/deletes a row there.
    CREATE TABLE IF NOT EXISTS tag_usage (
        tag_id TEXT PRIMARY KEY,
        count  INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS trg_character_tags_ai AFTER INSERT ON character_tags BEGIN
        INSERT INTO tag_usage (tag_id, count) VALUES (NEW.tag_id, 1)
        ON CONFLICT(tag_id) DO UPDATE SET count = count + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_character_tags_ad AFTER DELETE ON character_tags BEGIN
        UPDATE tag_usage SET count = count - 1 WHERE tag_id = OLD.tag_id;
    END;

    CREATE TABLE IF NOT EXISTS changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id  TEXT NOT NULL,
        op  TEXT NOT NULL,
        fields TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_changes_id ON changes(id);

    CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
    );

    -- Mirrors characters' fav/date_added/date_last_chat/chat_size/name_fold so queryEntities() can UNION ALL
    -- both tables under one ORDER BY. No 'world' column (groups have no lorebook binding). Group ids are stable
    -- for their whole lifetime, so date_added needs no rename-time carry-forward like characters get.
    CREATE TABLE IF NOT EXISTS groups (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        name_fold      TEXT NOT NULL DEFAULT '',
        fav            INTEGER NOT NULL DEFAULT 0,
        date_added     INTEGER NOT NULL DEFAULT 0,
        date_last_chat INTEGER NOT NULL DEFAULT 0,
        chat_size      INTEGER NOT NULL DEFAULT 0
    );
    -- Indexes for groups are created by migrateGroupsColumns() instead, after it ALTERs a pre-existing
    -- id/name-only groups table - an unconditional CREATE INDEX here would fail against those missing columns.

    CREATE TABLE IF NOT EXISTS group_tags (
        group_id TEXT NOT NULL,
        tag_id   TEXT NOT NULL,
        PRIMARY KEY (group_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_tags_tag ON group_tags(tag_id, group_id);

    -- Shares tag_usage with character_tags' triggers - one combined usage count across characters and groups.
    CREATE TRIGGER IF NOT EXISTS trg_group_tags_ai AFTER INSERT ON group_tags BEGIN
        INSERT INTO tag_usage (tag_id, count) VALUES (NEW.tag_id, 1)
        ON CONFLICT(tag_id) DO UPDATE SET count = count + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_group_tags_ad AFTER DELETE ON group_tags BEGIN
        UPDATE tag_usage SET count = count - 1 WHERE tag_id = OLD.tag_id;
    END;

    -- Tag *definitions* (name/color/folder_type/sort_order/... - everything tags.json's 'tags' array used to
    -- hold). 'data' is the whole Tag object as JSON, mirroring the shallow_json pattern characters already use
    -- above, rather than enumerating every field as its own column - this table is small (thousands of rows at
    -- the very most) and nothing here needs to be queried/sorted server-side, so there is no cost to keeping it
    -- schema-flexible instead of chasing every field the client's Tag typedef might ever grow.
    CREATE TABLE IF NOT EXISTS tags (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
    );

    -- One row per tag *name* edit (saveTagDefinitions() below), never per tag creation/deletion/non-name field -
    -- a change log a caller can page through with seq > sinceSeq, the same shape as 'changes' above, so reading
    -- "which tag ids had their name changed since I last looked" costs work proportional to how many name edits
    -- happened in that window, never to how many tags exist in total.
    CREATE TABLE IF NOT EXISTS tag_name_changes (
        seq    INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_id TEXT NOT NULL
    );

    -- Bookkeeping for the one-time filename-migration script (name-derived filenames -> minted UUIDv7 ids).
    -- completed = 0: new_id is minted (a resumed run must reuse it) but the per-character move may not be finished.
    -- completed = 1 also gates the script's cross-cutting rewrites (groups/world_info/note.chara/active_character).
    CREATE TABLE IF NOT EXISTS id_migration (
        old_id    TEXT PRIMARY KEY,
        new_id    TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_id_migration_new ON id_migration(new_id);
    CREATE INDEX IF NOT EXISTS idx_id_migration_completed ON id_migration(completed);

    -- Durable "this source file will never be importable" record, keyed by full absolute path (multiple
    -- localImport.directories can share a filename). Classifies a non-character file once instead of
    -- re-attempting every scan pass forever. A lookup only honors the skip while mtime_ms still matches the
    -- file's current mtime, so replacing a skipped file invalidates it automatically.
    CREATE TABLE IF NOT EXISTS local_import_skips (
        source_path TEXT PRIMARY KEY,
        mtime_ms    INTEGER NOT NULL,
        reason      TEXT NOT NULL,
        checked_at  INTEGER NOT NULL
    );

    -- Durable per-file "already processed at this mtime" record, backing DirectoryScanState.lastSeenMtimeMs
    -- (in-memory, bounded, cold on restart) so a restart doesn't force a full read+hash+dedup pass over an
    -- unchanged ~300k-file corpus. getLocalImportMtime() is the fallback lookup when the in-memory cache misses.
    CREATE TABLE IF NOT EXISTS local_import_mtimes (
        source_path TEXT PRIMARY KEY,
        mtime_ms    INTEGER NOT NULL
    );
`;

const UPSERT_SQL = `
    INSERT INTO characters (
        id, name, name_fold, fav, date_added, create_date, date_last_chat, chat_size, data_size,
        file_mtime, world, creator, version, creator_notes, shallow_json, content_hash,
        content_identity_hash, avatar_identity_hash, import_poisoned, active_chat, active_chat_checked, change_seq,
        digest_fav, digest_tag_ids, digest_content, card_json
    ) VALUES (
        @id, @name, @name_fold, @fav, @date_added, @create_date, @date_last_chat, @chat_size, @data_size,
        @file_mtime, @world, @creator, @version, @creator_notes, @shallow_json, @content_hash,
        @content_identity_hash, @avatar_identity_hash, @import_poisoned, @active_chat, @active_chat_checked, @changeSeq,
        @digest_fav, @digest_tag_ids, @digest_content, @card_json
    )
    ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        name_fold = excluded.name_fold,
        fav = excluded.fav,
        create_date = excluded.create_date,
        -- date_last_chat absent deliberately: owned by bumpCharacterDateLastChat(), not this function's callers.
        -- Their candidate comes from the chats directory's mtime, which no longer moves once messages live in
        -- the tree, so including it here would reset a freshly bumped row back to a stale timestamp on rescan.
        chat_size = excluded.chat_size,
        data_size = excluded.data_size,
        file_mtime = excluded.file_mtime,
        world = excluded.world,
        creator = excluded.creator,
        version = excluded.version,
        creator_notes = excluded.creator_notes,
        shallow_json = excluded.shallow_json,
        -- COALESCE: most writers pass no content hash (undefined), and a plain overwrite would clobber an
        -- import-time hash to NULL on the next unrelated edit. Only a fresh hash (re-import, same id) overwrites.
        content_hash = COALESCE(excluded.content_hash, characters.content_hash),
        content_identity_hash = COALESCE(excluded.content_identity_hash, characters.content_identity_hash),
        avatar_identity_hash = COALESCE(excluded.avatar_identity_hash, characters.avatar_identity_hash),
        -- import_poisoned is NOT NULL so there's no NULL "no signal" value: a genuine write (0) always clears
        -- poison; reconcile/watch/bootstrap bind 1 as their no-signal value and leave the existing state alone.
        import_poisoned = CASE WHEN excluded.import_poisoned = 0 THEN 0 ELSE characters.import_poisoned END,
        -- Plain overwrite: writeRowSync() already pre-resolves the correct value before this SQL runs.
        active_chat = excluded.active_chat,
        -- Never regresses 1 -> 0.
        active_chat_checked = CASE WHEN excluded.active_chat_checked = 1 THEN 1 ELSE characters.active_chat_checked END,
        digest_fav = excluded.digest_fav,
        digest_tag_ids = excluded.digest_tag_ids,
        digest_content = excluded.digest_content,
        -- Plain overwrite, not COALESCE: NULL here is a real signal ("file now current, stop preferring the
        -- parked copy"), not an absence of one - a COALESCE would keep serving stale edits after an avatar
        -- replace with no way to ever clear them.
        card_json = excluded.card_json,
        change_seq = excluded.change_seq
    -- date_added intentionally absent: write-once, see this module's header.
`;

// NFKD-normalizes and strips combining marks so "É"/"e" sort/prefix-match the same as "é"/"e".
function foldName(name) {
    return String(name ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '');
}

function getDbPath(directories) {
    return path.join(directories.root, 'character-metadata.sqlite');
}

// SQLite has no ALTER TABLE ADD COLUMN IF NOT EXISTS, so this checks PRAGMA table_info and runs the ALTER once.
// Never backfills existing rows' hashes - they stay NULL.
function migrateContentHashColumn(db) {
    const columns = db.all('PRAGMA table_info(characters)');
    const hasColumn = columns.some(c => c.name === 'content_hash');
    if (!hasColumn) {
        db.exec('ALTER TABLE characters ADD COLUMN content_hash TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_content_hash ON characters(content_hash)');
}

// import_poisoned defaults to 1: rows that predate this column came from the old, more-mutating import logic.
function migrateContentIdentityColumns(db) {
    const columns = db.all('PRAGMA table_info(characters)');
    if (!columns.some(c => c.name === 'content_identity_hash')) {
        db.exec('ALTER TABLE characters ADD COLUMN content_identity_hash TEXT');
    }
    if (!columns.some(c => c.name === 'import_poisoned')) {
        db.exec('ALTER TABLE characters ADD COLUMN import_poisoned INTEGER NOT NULL DEFAULT 1');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_content_identity_hash ON characters(content_identity_hash)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_import_poisoned ON characters(import_poisoned)');
}

function migrateAvatarIdentityColumn(db) {
    const columns = db.all('PRAGMA table_info(characters)');
    if (!columns.some(c => c.name === 'avatar_identity_hash')) {
        db.exec('ALTER TABLE characters ADD COLUMN avatar_identity_hash TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_avatar_identity_hash ON characters(avatar_identity_hash)');
}

// A pre-existing active_chat column means those rows were already resolved in prior boots, so active_chat_checked
// is retroactively set to 1 for them instead of DEFAULT 0, which would force a full corpus re-read.
function migrateActiveChatColumn(db) {
    const columns = db.all('PRAGMA table_info(characters)');
    const hadActiveChatAlready = columns.some(c => c.name === 'active_chat');
    if (!hadActiveChatAlready) {
        db.exec('ALTER TABLE characters ADD COLUMN active_chat TEXT');
    }
    if (!columns.some(c => c.name === 'active_chat_checked')) {
        db.exec('ALTER TABLE characters ADD COLUMN active_chat_checked INTEGER NOT NULL DEFAULT 0');
        if (hadActiveChatAlready) {
            db.exec('UPDATE characters SET active_chat_checked = 1');
        }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_active_chat_checked ON characters(active_chat_checked)');
}

// Converts create_date from TEXT to INTEGER epoch ms. SQLite has no ALTER COLUMN, so: add a new INTEGER column,
// backfill it in JS (parseCreateDateToEpochMs handles the "ST humanized" formats SQL alone can't), then DROP the
// old column and RENAME the new one into place. Unparseable values become NULL and are logged.
function migrateCreateDateColumn(db) {
    const columns = db.all('PRAGMA table_info(characters)');
    const createDateColumn = columns.find(c => c.name === 'create_date');
    const createDateMsColumn = columns.find(c => c.name === 'create_date_ms');

    // create_date_ms exists but create_date doesn't: a previous run was interrupted after DROP, before RENAME.
    if (!createDateColumn && createDateMsColumn) {
        db.exec('ALTER TABLE characters RENAME COLUMN create_date_ms TO create_date');
        db.exec('CREATE INDEX IF NOT EXISTS idx_characters_create_date ON characters(create_date)');
        return;
    }

    if (!createDateColumn || createDateColumn.type === 'INTEGER') return;

    // If create_date_ms already exists (interrupted run), skip ADD + backfill and go straight to DROP + RENAME.
    if (!createDateMsColumn) {
        const rows = db.all('SELECT id, create_date FROM characters WHERE create_date IS NOT NULL');

        // SQLite refuses to DROP COLUMN while an index still references it.
        db.exec('DROP INDEX IF EXISTS idx_characters_create_date');
        db.exec('ALTER TABLE characters ADD COLUMN create_date_ms INTEGER');

        const unparseable = [];
        db.transaction(() => {
            for (const row of rows) {
                const ms = parseCreateDateToEpochMs(row.create_date);
                if (ms === null) {
                    unparseable.push({ id: row.id, value: row.create_date });
                    continue;
                }
                db.run('UPDATE characters SET create_date_ms = @createDateMs WHERE id = @id', { id: row.id, createDateMs: ms });
            }
        });

        if (unparseable.length > 0) {
            console.error(color.yellow(
                `[character-metadata] create_date migration: ${unparseable.length} of ${rows.length} row(s) had a ` +
                'create_date value that could not be parsed as a date (neither ISO 8601 nor the ST "humanized" ' +
                'format) and were set to NULL instead. Affected rows: ' +
                JSON.stringify(unparseable),
            ));
        }
    } else {
        db.exec('DROP INDEX IF EXISTS idx_characters_create_date');
    }

    db.exec('ALTER TABLE characters DROP COLUMN create_date');
    db.exec('ALTER TABLE characters RENAME COLUMN create_date_ms TO create_date');
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_create_date ON characters(create_date)');
}

// deleteRowSync() cascades a character deletion into deleting rows that named it as duplicate_of, so a stale
// skip can never outlive the character it depends on.
function migrateLocalImportMtimesDuplicateOfColumn(db) {
    const columns = db.all('PRAGMA table_info(local_import_mtimes)');
    if (!columns.some(c => c.name === 'duplicate_of')) {
        db.exec('ALTER TABLE local_import_mtimes ADD COLUMN duplicate_of TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_local_import_mtimes_duplicate_of ON local_import_mtimes(duplicate_of)');
}

export { computeContentIdentityHash };

// Backfills real values into rows from the old id/name-only shape via a plain UPDATE, since
// bootstrapGroupsIfNeeded()'s upsert path never overwrites an existing date_added.
function migrateGroupsColumns(db, directories) {
    const columns = db.all('PRAGMA table_info(groups)');
    const columnNames = new Set(columns.map(c => c.name));
    const isPreExistingTable = columnNames.size > 0 && !columnNames.has('date_added');

    if (!columnNames.has('name_fold')) db.exec('ALTER TABLE groups ADD COLUMN name_fold TEXT NOT NULL DEFAULT \'\'');
    if (!columnNames.has('fav')) db.exec('ALTER TABLE groups ADD COLUMN fav INTEGER NOT NULL DEFAULT 0');
    if (!columnNames.has('date_added')) db.exec('ALTER TABLE groups ADD COLUMN date_added INTEGER NOT NULL DEFAULT 0');
    if (!columnNames.has('date_last_chat')) db.exec('ALTER TABLE groups ADD COLUMN date_last_chat INTEGER NOT NULL DEFAULT 0');
    if (!columnNames.has('chat_size')) db.exec('ALTER TABLE groups ADD COLUMN chat_size INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_groups_name_fold ON groups(name_fold)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_groups_date_added ON groups(date_added)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_groups_date_last_chat ON groups(date_last_chat)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_groups_chat_size ON groups(chat_size)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_groups_fav_name_fold ON groups(fav, name_fold)');

    if (!isPreExistingTable) return;

    const existingIds = db.all('SELECT id FROM groups').map(r => r.id);
    if (existingIds.length === 0) return;

    db.transaction(() => {
        for (const id of existingIds) {
            try {
                const filePath = path.join(directories.groups, `${id}.json`);
                const raw = fs.readFileSync(filePath, 'utf8');
                const group = JSON.parse(raw);
                const stat = fs.statSync(filePath);
                const { chatSize, dateLastChat } = calculateGroupChatStats(directories.groupChats, group.chats);
                db.run(
                    'UPDATE groups SET name = @name, name_fold = @nameFold, fav = @fav, date_added = @dateAdded, date_last_chat = @dateLastChat, chat_size = @chatSize WHERE id = @id',
                    { id, name: group.name ?? '', nameFold: foldName(group.name), fav: group.fav ? 1 : 0, dateAdded: Math.round(stat.birthtimeMs), dateLastChat, chatSize },
                );
            } catch (err) {
                console.error(`[character-metadata] Column-migration backfill failed to process group ${id}, leaving it at its zeroed defaults:`, err.message);
            }
        }
    });
}

// Backfills digests immediately, unlike migrateDigestColumns()'s lazy NULL-until-next-write shape - groups are
// few enough that eager backfill is cheap.
function migrateGroupDigestColumns(db, directories) {
    const columns = db.all('PRAGMA table_info(groups)');
    const columnNames = new Set(columns.map(c => c.name));
    const isNewColumn = !columnNames.has('digest_fav');
    if (!columnNames.has('digest_fav')) db.exec('ALTER TABLE groups ADD COLUMN digest_fav INTEGER');
    if (!columnNames.has('digest_tag_ids')) db.exec('ALTER TABLE groups ADD COLUMN digest_tag_ids INTEGER');
    if (!columnNames.has('digest_content')) db.exec('ALTER TABLE groups ADD COLUMN digest_content INTEGER');

    if (!isNewColumn) return;

    const existingIds = db.all('SELECT id FROM groups').map(r => r.id);
    if (existingIds.length === 0) return;

    db.transaction(() => {
        for (const id of existingIds) {
            try {
                const filePath = path.join(directories.groups, `${id}.json`);
                const raw = fs.readFileSync(filePath, 'utf8');
                const group = JSON.parse(raw);
                const tagIds = db.all('SELECT tag_id FROM group_tags WHERE group_id = @id', { id }).map(r => r.tag_id);
                const fingerprintSource = { ...group, tag_ids: tagIds };
                db.run(
                    'UPDATE groups SET digest_fav = @favHash, digest_tag_ids = @tagIdsHash, digest_content = @contentHash WHERE id = @id',
                    {
                        id,
                        favHash: groupDigestFavHash(fingerprintSource),
                        tagIdsHash: groupDigestTagIdsHash(fingerprintSource),
                        contentHash: groupDigestContentHash(fingerprintSource),
                    },
                );
            } catch (err) {
                console.error(`[character-metadata] Group digest backfill failed for ${id}, leaving digests NULL (hash-mode falls back to computing live):`, err.message);
            }
        }
    });
}

// fields: JSON array of changed field names (e.g. '["fav"]'), or NULL meaning the whole record changed.
function migrateChangesFieldsColumn(db) {
    const columns = db.all('PRAGMA table_info(changes)');
    if (!columns.some(c => c.name === 'fields')) {
        db.exec('ALTER TABLE changes ADD COLUMN fields TEXT');
    }
}

function migrateRevToSeqColumns(db) {
    const charCols = db.all('PRAGMA table_info(\'characters\')').map(c => c.name);
    if (charCols.includes('rev') && !charCols.includes('change_seq')) {
        db.exec('ALTER TABLE characters RENAME COLUMN rev TO change_seq');
    }
    const changeCols = db.all('PRAGMA table_info(\'changes\')').map(c => c.name);
    if (changeCols.includes('rev') && !changeCols.includes('seq')) {
        db.exec('ALTER TABLE changes RENAME COLUMN rev TO seq');
    }
    db.run('UPDATE meta SET key = \'tags_hash\' WHERE key = \'tags_rev\'');
    db.run('UPDATE meta SET key = \'tantivy_char_index_seq\' WHERE key = \'tantivy_char_index_rev\'');
    db.run('UPDATE meta SET key = \'tantivy_char_index_tags_hash\' WHERE key = \'tantivy_char_index_tags_rev\'');
}

// NULL is populated lazily by the next write per row; the tree-descend worker computes from shallow_json on demand.
function migrateDigestColumns(db) {
    const columns = db.all('PRAGMA table_info(characters)');
    const columnNames = new Set(columns.map(c => c.name));
    if (!columnNames.has('digest_fav')) db.exec('ALTER TABLE characters ADD COLUMN digest_fav INTEGER');
    if (!columnNames.has('digest_tag_ids')) db.exec('ALTER TABLE characters ADD COLUMN digest_tag_ids INTEGER');
    if (!columnNames.has('digest_content')) db.exec('ALTER TABLE characters ADD COLUMN digest_content INTEGER');
}

// NULL means "no preference recorded yet"; existing values migrate from client accountStorage on first load.
function migrateAllowGlobalStylesColumn(db) {
    const columns = db.all('PRAGMA table_info(characters)');
    if (!columns.some(c => c.name === 'allow_global_styles')) {
        db.exec('ALTER TABLE characters ADD COLUMN allow_global_styles INTEGER');
    }
}

// NULL correctly means "PNG chunk is current" for every pre-migration row. The partial index keeps
// getStaleCardJsonMap()'s scan proportional to edited cards, not library size.
function migrateCardJsonColumn(db) {
    const columns = db.all('PRAGMA table_info(characters)');
    if (!columns.some(c => c.name === 'card_json')) {
        db.exec('ALTER TABLE characters ADD COLUMN card_json TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_card_json_present ON characters(id) WHERE card_json IS NOT NULL');
}

// idx_characters_fav_name_fold has default ASC on both columns, which SQLite can't use for a DESC/ASC ORDER BY.
function migrateFavSortIndex(db) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_fav_desc_name_fold_asc ON characters(fav DESC, name_fold ASC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_groups_fav_desc_name_fold_asc ON groups(fav DESC, name_fold ASC)');
}

// Returns null if no SQLite engine is usable on this install - callers must no-op rather than throw.
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
            console.error(color.red('[character-metadata] No usable SQLite backend on this install - the character metadata store (sort keys, tag relations, change log) is unavailable this run.'));
        }
        return null;
    }

    if (!fs.existsSync(directories.root)) {
        fs.mkdirSync(directories.root, { recursive: true });
    }
    const db = engine.openDatabase(getDbPath(directories));
    db.exec(SCHEMA_SQL);
    migrateContentHashColumn(db);
    migrateContentIdentityColumns(db);
    migrateAvatarIdentityColumn(db);
    migrateActiveChatColumn(db);
    migrateCreateDateColumn(db);
    migrateLocalImportMtimesDuplicateOfColumn(db);
    migrateChangesFieldsColumn(db);
    migrateRevToSeqColumns(db);
    migrateDigestColumns(db);
    migrateAllowGlobalStylesColumn(db);
    migrateCardJsonColumn(db);
    migrateGroupsColumns(db, directories);
    migrateGroupDigestColumns(db, directories);
    migrateFavSortIndex(db);
    // Registers cyrb53 as a SQL function so random-sort order can be a per-query ORDER BY RANDHASH(id, seed),
    // composing with LIMIT/OFFSET pagination instead of a JS-side sort over every row.
    db.defineFunction('RANDHASH', (id, seed) => getStringHash(String(id ?? ''), Number(seed ?? 0)));
    /** @type {MetadataDbEntry} */
    const entry = { db, directories, watcher: null, watchTimers: new Map(), batch: null, bootstrapPromise: null };
    entries.set(key, entry);
    return entry;
}

// dateAddedCandidate is only used on a genuine insert.
function buildRow(id, character, { dateAddedCandidate, fileMtime, chatSize, dateLastChat, contentHash, contentIdentityHash, avatarIdentityHash, tagIds = [], cardJson = null }) {
    const includeCreatorNotes = !!getConfigValue('performance.shallowCharactersIncludeCreatorNotes', false, 'boolean');
    const dataSize = calculateDataSize(character?.data);
    const shallowSource = {
        ...character,
        avatar: id,
        date_added: dateAddedCandidate,
        date_last_chat: dateLastChat,
        chat_size: chatSize,
        data_size: dataSize,
        tag_ids: tagIds,
    };
    const shallow = toShallow(shallowSource);
    return {
        id,
        name: character.name ?? '',
        name_fold: foldName(character.name),
        fav: character.fav ? 1 : 0,
        date_added: dateAddedCandidate,
        create_date: parseCreateDateToEpochMs(character.create_date),
        date_last_chat: dateLastChat,
        chat_size: chatSize,
        data_size: dataSize,
        file_mtime: fileMtime,
        world: _.get(character, 'data.extensions.world', '') || null,
        creator: _.get(character, 'data.creator', '') || null,
        version: _.get(character, 'data.character_version', '') || null,
        creator_notes: includeCreatorNotes ? (_.get(character, 'data.creator_notes', '') || null) : null,
        shallow_json: JSON.stringify(shallow),
        content_hash: contentHash ?? null,
        content_identity_hash: contentIdentityHash ?? null,
        avatar_identity_hash: avatarIdentityHash ?? null,
        import_poisoned: contentIdentityHash ? 0 : 1,
        active_chat: character.chat ?? null,
        active_chat_checked: 1,
        digest_fav: characterDigestFavHash(shallow) % 4294967296,
        digest_tag_ids: characterDigestTagIdsHash(shallow) % 4294967296,
        digest_content: characterDigestFieldsHash(shallow) % 4294967296,
        card_json: cardJson ?? null,
    };
}

// Meant to run inside db.transaction(...). tagIds only seeds a genuinely new row's tags on first INSERT -
// character_tags is the source of truth thereafter, so an UPDATE never touches it. fav and active_chat get the
// same one-time-seed treatment: once a row exists, a stale/foreign value from the card can't override them.
function writeRowSync(db, row, tagIds) {
    const existingRow = db.get('SELECT fav, active_chat, shallow_json FROM characters WHERE id = @id', { id: row.id });
    const existed = !!existingRow;

    if (existed) {
        const currentFav = existingRow.fav ? 1 : 0;
        const favChanged = row.fav !== currentFav;
        // Only a non-NULL existing active_chat gets forced back; NULL means not-yet-examined or confirmed-no-chat,
        // so this write's freshly-resolved candidate is allowed to seed it.
        const forceActiveChat = existingRow.active_chat !== null && row.active_chat !== existingRow.active_chat;
        const currentTagIds = db.all('SELECT tag_id FROM character_tags WHERE character_id = @id', { id: row.id }).map(r => r.tag_id);

        const shallow = JSON.parse(row.shallow_json);
        shallow.tag_ids = currentTagIds;
        if (favChanged) {
            shallow.fav = !!currentFav;
        }
        if (forceActiveChat) {
            shallow.chat = existingRow.active_chat;
        }
        // card_json deliberately skips the fav/active_chat forcing shallow_json just got: it's the exported
        // card's own bytes, and fav/chat are stripped from cards on write (characters.js's omitFavField()/
        // omitChatField()) since both are db-authoritative and must not round-trip into exports.
        row = {
            ...row,
            fav: favChanged ? currentFav : row.fav,
            active_chat: forceActiveChat ? existingRow.active_chat : row.active_chat,
            shallow_json: JSON.stringify(shallow),
        };
    }

    const lastInsertRowid = insertChange(db, row.id, 'upsert', null);
    db.run(UPSERT_SQL, { ...row, changeSeq: Number(lastInsertRowid) });

    if (!existed) {
        for (const tagId of tagIds) {
            db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@characterId, @tagId)', { characterId: row.id, tagId });
        }
    }
}

function deleteRowSync(db, id) {
    db.run('DELETE FROM characters WHERE id = @id', { id });
    db.run('DELETE FROM character_tags WHERE character_id = @id', { id });
    // Cascades: a local_import_mtimes row recorded as duplicate_of this character must not outlive it.
    db.run('DELETE FROM local_import_mtimes WHERE duplicate_of = @id', { id });
    insertChange(db, id, 'delete', null);
}

// tags.json remains the write source of truth for tag assignment; this reads its mirror.
function getTagIdsFor(directories, avatar) {
    const { tag_map } = readTagsData(directories);
    return tag_map[avatar] ?? [];
}

/**
 * @param {string|null} [contentHash] sha256 of the raw uploaded source-file bytes; only the import route has one.
 * @param {string|null} [avatarIdentityHash] Hash of the image bytes actually written; null if no new image bytes.
 */
export async function upsertCharacterFromWrite(directories, avatar, cardJson, fileMtimeMs, contentHash = null, avatarIdentityHash = null) {
    const entry = await getEntry(directories);
    if (!entry) return;

    let character;
    try {
        character = JSON.parse(cardJson);
    } catch (err) {
        console.error(`[character-metadata] Failed to parse just-written card for ${avatar}, skipping metadata upsert:`, err);
        return;
    }

    const contentIdentityHash = computeContentIdentityHash(character);
    const { chatSize, dateLastChat } = calculateChatSize(path.join(directories.chats, avatar.replace(/\.png$/, '')));
    const tagIds = getTagIdsFor(directories, avatar);
    const row = buildRow(avatar, character, { dateAddedCandidate: Date.now(), fileMtime: fileMtimeMs, chatSize, dateLastChat, contentHash, contentIdentityHash, avatarIdentityHash, tagIds, cardJson });

    applyOrBuffer(entry, row, tagIds);
}

// The one writer (besides a row's first INSERT) allowed to change fav. Pure metadata-store mutation - no PNG
// touch. Patches shallow_json's embedded fav too, so /query stays consistent with the column.
export async function setCharacterFav(directories, avatar, fav) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    const existing = entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: avatar });
    if (!existing) return false;

    const shallow = JSON.parse(existing.shallow_json);
    shallow.fav = !!fav;

    const lastInsertRowid = insertChange(entry.db, avatar, 'upsert', JSON.stringify(['fav']));
    entry.db.run(
        'UPDATE characters SET fav = @fav, shallow_json = @shallow_json, change_seq = @changeSeq, digest_fav = @digestFav WHERE id = @id',
        { id: avatar, fav: fav ? 1 : 0, shallow_json: JSON.stringify(shallow), changeSeq: Number(lastInsertRowid), digestFav: characterDigestFavHash(shallow) % 4294967296 },
    );
    return true;
}

// Mirrors setCharacterFav(): DB column + shallow_json mirror, no card file write.
export async function setCharacterAllowGlobalStyles(directories, avatar, allowed) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    const existing = entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: avatar });
    if (!existing) return false;

    const shallow = JSON.parse(existing.shallow_json);
    shallow.allow_global_styles = !!allowed;

    entry.db.run(
        'UPDATE characters SET allow_global_styles = @val, shallow_json = @shallowJson WHERE id = @id',
        { id: avatar, val: allowed ? 1 : 0, shallowJson: JSON.stringify(shallow) },
    );
    return true;
}

// The one writer, other than a row's first INSERT, allowed to change active_chat. Mirrors setCharacterFav():
// never touches the PNG card file, pure metadata-store mutation. Patches shallow_json's embedded chat to match.
// No-op if this avatar isn't tracked yet - a row must exist for active_chat to mean anything.
export async function setCharacterActiveChat(directories, avatar, chat) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    const existing = entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: avatar });
    if (!existing) return false;

    const shallow = JSON.parse(existing.shallow_json);
    shallow.chat = chat;

    const lastInsertRowid = insertChange(entry.db, avatar, 'upsert', JSON.stringify(['active_chat']));
    entry.db.run(
        // active_chat_checked = 1: this write is as authoritative a resolution as backfillActiveChatFromCards().
        'UPDATE characters SET active_chat = @activeChat, active_chat_checked = 1, shallow_json = @shallowJson, change_seq = @changeSeq WHERE id = @id',
        { id: avatar, activeChat: chat, shallowJson: JSON.stringify(shallow), changeSeq: Number(lastInsertRowid) },
    );
    return true;
}

// Kept well under SQLite's SQLITE_MAX_VARIABLE_NUMBER (999-32766 depending on build) so a chunked IN (...) query
// never exceeds it regardless of which sqlite-engine.js backend resolved.
const FAV_LOOKUP_BATCH_SIZE = 500;

export async function getCharacterFavsByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    /** @type {{[id: string]: boolean}} */
    const result = {};
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const rows = entry.db.all(`SELECT id, fav FROM characters WHERE id IN (${placeholders})`, batch);
        for (const row of rows) {
            result[row.id] = !!row.fav;
        }
    }
    return result;
}

export async function getGroupFavsByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    /** @type {{[id: string]: boolean}} */
    const result = {};
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const rows = entry.db.all(`SELECT id, fav FROM groups WHERE id IN (${placeholders})`, batch);
        for (const row of rows) {
            result[row.id] = !!row.fav;
        }
    }
    return result;
}

export async function getCharacterAllowGlobalStylesByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    /** @type {{[id: string]: boolean}} */
    const result = {};
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const rows = entry.db.all(`SELECT id, allow_global_styles FROM characters WHERE id IN (${placeholders})`, batch);
        for (const row of rows) {
            if (row.allow_global_styles != null) {
                result[row.id] = !!row.allow_global_styles;
            }
        }
    }
    return result;
}

export async function getCharacterTagIdsByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    // Distinguish "tracked but no tags" (-> []) from "not tracked" (-> omitted).
    /** @type {Set<string>} */
    const trackedIds = new Set();
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const rows = entry.db.all(`SELECT id FROM characters WHERE id IN (${placeholders})`, batch);
        for (const row of rows) {
            trackedIds.add(row.id);
        }
    }

    /** @type {{[id: string]: string[]}} */
    const result = {};
    for (const id of trackedIds) {
        result[id] = [];
    }

    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const rows = entry.db.all(`SELECT character_id, tag_id FROM character_tags WHERE character_id IN (${placeholders})`, batch);
        for (const row of rows) {
            if (result[row.character_id]) {
                result[row.character_id].push(row.tag_id);
            }
        }
    }
    return result;
}

// Unlike getCharacterFavsByIds() (which reports every tracked id's real boolean), this omits a tracked-but-NULL
// row from the result, not just an untracked one: "absent" uniformly means "no chat to stamp, leave it alone".
export async function getCharacterActiveChatsByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    /** @type {{[id: string]: string}} */
    const result = {};
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const rows = entry.db.all(`SELECT id, active_chat FROM characters WHERE id IN (${placeholders}) AND active_chat IS NOT NULL`, batch);
        for (const row of rows) {
            result[row.id] = row.active_chat;
        }
    }
    return result;
}

export async function getShallowByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    /** @type {{[id: string]: object}} */
    const result = {};
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const rows = entry.db.all(`SELECT id, shallow_json FROM characters WHERE id IN (${placeholders})`, batch);
        for (const row of rows) {
            try {
                result[row.id] = JSON.parse(row.shallow_json);
            } catch {
                // Skip unparseable rows - same tolerance every other shallow_json consumer has.
            }
        }
    }
    return result;
}

// null means "PNG chunk is current, read the file". Deliberately uncached: readCharacterData()'s mtime-keyed
// cache can't represent a db-only edit since neither path nor mtime moves.
export async function getCharacterCardJson(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = entry.db.get('SELECT card_json FROM characters WHERE id = @id', { id: avatar });
    return row?.card_json ?? null;
}

export async function getStaleCardJsonMap(directories) {
    const entry = await getEntry(directories);
    if (!entry) return new Map();
    const rows = entry.db.all('SELECT id, card_json FROM characters WHERE card_json IS NOT NULL');
    return new Map(rows.map(row => [row.id, row.card_json]));
}

export async function deleteCharacterRow(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return;

    if (entry.batch) {
        entry.batch.pending.delete(avatar);
    }
    entry.db.transaction(() => deleteRowSync(entry.db, avatar));
}

// Corrects date_added on a rename (the generic write hook treats newAvatar as brand-new) and unions
// oldAvatar's tags into newAvatar.
export async function renameCharacterRow(directories, oldAvatar, newAvatar) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const oldRow = entry.db.get('SELECT date_added FROM characters WHERE id = @id', { id: oldAvatar });
    if (oldRow) {
        const dateAdded = Number(oldRow.date_added);
        // A rename landing mid-batch-import means newAvatar may still be in the buffer, not the table.
        const pending = entry.batch?.pending.get(newAvatar);
        if (pending) {
            pending.row.date_added = dateAdded;
            pending.row.shallow_json = withPatchedDateAdded(pending.row.shallow_json, dateAdded);
        } else {
            const newRow = entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: newAvatar });
            if (newRow) {
                const shallowJson = withPatchedDateAdded(newRow.shallow_json, dateAdded);
                entry.db.run('UPDATE characters SET date_added = @dateAdded, shallow_json = @shallowJson WHERE id = @id', { dateAdded, shallowJson, id: newAvatar });
            } else {
                entry.db.run('UPDATE characters SET date_added = @dateAdded WHERE id = @id', { dateAdded, id: newAvatar });
            }
        }
    }

    // Must read before the transaction below deletes oldAvatar's rows.
    const oldTagIds = entry.db.all('SELECT tag_id FROM character_tags WHERE character_id = @id', { id: oldAvatar }).map(r => r.tag_id);
    if (oldTagIds.length > 0) {
        const pending = entry.batch?.pending.get(newAvatar);
        if (pending) {
            pending.tagIds = [...new Set([...pending.tagIds, ...oldTagIds])];
        } else {
            entry.db.transaction(() => {
                for (const tagId of oldTagIds) {
                    entry.db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@newAvatar, @tagId)', { newAvatar, tagId });
                }
            });
        }
    }

    entry.db.transaction(() => deleteRowSync(entry.db, oldAvatar));
}

/** Returns `shallowJson` with its `date_added` field overwritten; unmodified if it doesn't parse. */
function withPatchedDateAdded(shallowJson, dateAdded) {
    try {
        const parsed = JSON.parse(shallowJson);
        parsed.date_added = dateAdded;
        return JSON.stringify(parsed);
    } catch {
        return shallowJson;
    }
}

/** Overwrites date_added unconditionally - the one exception to it being write-once elsewhere in this module. */
export async function setCharacterDateAdded(directories, id, dateAddedMs) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const pending = entry.batch?.pending.get(id);
    if (pending) {
        pending.row.date_added = dateAddedMs;
        pending.row.shallow_json = withPatchedDateAdded(pending.row.shallow_json, dateAddedMs);
        return;
    }

    const row = entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id });
    if (!row) return;
    const shallowJson = withPatchedDateAdded(row.shallow_json, dateAddedMs);
    entry.db.run('UPDATE characters SET date_added = @dateAddedMs, shallow_json = @shallowJson WHERE id = @id', { dateAddedMs, shallowJson, id });
}

function applyOrBuffer(entry, row, tagIds) {
    if (entry.batch) {
        entry.batch.pending.set(row.id, { row, tagIds });
        if (entry.batch.pending.size >= BATCH_FLUSH_SIZE) {
            flushBatch(entry);
        }
        return;
    }

    entry.db.transaction(() => writeRowSync(entry.db, row, tagIds));
}

function flushBatch(entry) {
    if (!entry.batch || entry.batch.pending.size === 0) return;
    const rows = [...entry.batch.pending.values()];
    entry.batch.pending.clear();
    entry.db.transaction(() => {
        for (const { row, tagIds } of rows) {
            writeRowSync(entry.db, row, tagIds);
        }
    });
}

// Suspends the directory watcher (a burst import can overflow inotify's queue) and buffers writes. Idempotent.
export async function beginBatchImport(directories) {
    const entry = await getEntry(directories);
    if (!entry || entry.batch) return;

    entry.batch = { pending: new Map() };
    stopWatcher(entry);
}

export async function endBatchImport(directories) {
    const entry = await getEntry(directories);
    if (!entry || !entry.batch) return;

    flushBatch(entry);
    entry.batch = null;
    startWatcher(entry);
}

// One-time backfill for a library predating this metadata store. Seeds date_added from ctimeMs, recorded in meta so it runs once.
export async function bootstrapIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = entry.db.get('SELECT value FROM meta WHERE key = @key', { key: 'bootstrap_completed' });
    if (already) return;

    if (!fs.existsSync(directories.characters)) {
        entry.db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key: 'bootstrap_completed', value: String(Date.now()) });
        return;
    }

    const files = (await fsPromises.readdir(directories.characters)).filter(f => f.endsWith('.png'));

    const { tag_map } = readTagsData(directories);

    const bootstrapStart = Date.now();
    let lastProgressLog = bootstrapStart;
    let processedFiles = 0;

    // Chunked with bounded concurrency per chunk to bound peak memory to one chunk's worth of computed rows.
    for (let i = 0; i < files.length; i += BATCH_FLUSH_SIZE) {
        const chunkFiles = files.slice(i, i + BATCH_FLUSH_SIZE);
        const chunkResults = await mapWithConcurrency(chunkFiles, BOOTSTRAP_READ_CONCURRENCY, async (file) => {
            try {
                const filePath = path.join(directories.characters, file);
                const stat = await fsPromises.stat(filePath);
                const imgData = await parseCharacterCard(filePath, 'png');
                if (imgData === undefined) return null;
                const character = getCharaCardV2(JSON.parse(imgData), directories, false);
                const { chatSize, dateLastChat } = calculateChatSize(path.join(directories.chats, file.replace(/\.png$/, '')));
                const tagIds = tag_map[file] ?? [];
                const row = buildRow(file, character, { dateAddedCandidate: Math.round(stat.ctimeMs), fileMtime: stat.mtimeMs, chatSize, dateLastChat, tagIds, cardJson: imgData });
                return { row, tagIds };
            } catch (err) {
                console.error(`[character-metadata] Bootstrap failed to process ${file}, skipping it this pass (the reconciler will retry it):`, err.message);
                return null;
            }
        });

        const pending = chunkResults.filter(Boolean);
        if (pending.length > 0) {
            entry.db.transaction(() => {
                for (const { row, tagIds } of pending) {
                    writeRowSync(entry.db, row, tagIds);
                }
            });
        }

        processedFiles += chunkFiles.length;

        const now = Date.now();
        if (now - lastProgressLog >= BOOTSTRAP_PROGRESS_LOG_INTERVAL_MS) {
            const elapsedSec = (now - bootstrapStart) / 1000;
            const rate = processedFiles / elapsedSec;
            const remaining = files.length - processedFiles;
            const etaSec = rate > 0 ? Math.round(remaining / rate) : null;
            console.log(color.cyan(`[character-metadata] Bootstrap progress: ${processedFiles}/${files.length} (${rate.toFixed(1)} cards/sec, ETA ${etaSec === null ? 'unknown' : `${etaSec}s`})`));
            lastProgressLog = now;
        }

        await new Promise(resolve => setImmediate(resolve));
    }

    if (files.length > 0) {
        const totalSec = (Date.now() - bootstrapStart) / 1000;
        console.log(color.cyan(`[character-metadata] Bootstrap complete: ${files.length} cards in ${totalSec.toFixed(1)}s (${(files.length / totalSec).toFixed(1)} cards/sec).`));
    }

    entry.db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key: 'bootstrap_completed', value: String(Date.now()) });
    await resyncTags(directories);
}

// Backfills content_identity_hash for poisoned rows without clearing import_poisoned (see SCHEMA_SQL). Reads
// the PNG's pristine 'chara' chunk, which stays valid even when 'ccv3' doesn't.
// Resumable without a meta flag: re-queries import_poisoned=1 AND content_identity_hash IS NULL every call.
export async function backfillContentIdentityHashes(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    if (!getConfigValue('performance.allowExpensiveDuplicateFallback', true, 'boolean')) return;

    if (!fs.existsSync(directories.characters)) return;

    const poisonedIds = entry.db.all('SELECT id FROM characters WHERE import_poisoned = 1 AND content_identity_hash IS NULL').map(r => r.id);
    if (poisonedIds.length === 0) return;

    const backfillStart = Date.now();
    let lastProgressLog = backfillStart;
    let processedRows = 0;

    for (let i = 0; i < poisonedIds.length; i += BATCH_FLUSH_SIZE) {
        const chunkIds = poisonedIds.slice(i, i + BATCH_FLUSH_SIZE);
        const chunkResults = await mapWithConcurrency(chunkIds, BOOTSTRAP_READ_CONCURRENCY, async (id) => {
            try {
                const filePath = path.join(directories.characters, id);
                const buffer = await fs.promises.readFile(filePath);
                const chunks = extract(new Uint8Array(buffer));
                const pristine = readCharaChunkPristineFromChunks(chunks);
                const character = getCharaCardV2(JSON.parse(pristine), directories, false);
                return { id, hash: computeContentIdentityHash(character), avatarHash: computeAvatarIdentityHashFromChunks(chunks) };
            } catch (err) {
                console.error(`[character-metadata] Content-identity backfill failed to process ${id}, leaving it poisoned (will retry next boot):`, err.message);
                return null;
            }
        });

        const updates = chunkResults.filter(Boolean);
        if (updates.length > 0) {
            entry.db.transaction(() => {
                for (const { id, hash, avatarHash } of updates) {
                    entry.db.run('UPDATE characters SET content_identity_hash = @hash, avatar_identity_hash = COALESCE(avatar_identity_hash, @avatarHash) WHERE id = @id', { hash, avatarHash, id });
                }
            });
        }

        processedRows += chunkIds.length;

        const now = Date.now();
        if (now - lastProgressLog >= BOOTSTRAP_PROGRESS_LOG_INTERVAL_MS) {
            const elapsedSec = (now - backfillStart) / 1000;
            const rate = processedRows / elapsedSec;
            const remaining = poisonedIds.length - processedRows;
            const etaSec = rate > 0 ? Math.round(remaining / rate) : null;
            console.log(color.cyan(`[character-metadata] Content-identity backfill progress: ${processedRows}/${poisonedIds.length} (${rate.toFixed(1)} cards/sec, ETA ${etaSec === null ? 'unknown' : `${etaSec}s`})`));
            lastProgressLog = now;
        }

        await new Promise(resolve => setImmediate(resolve));
    }

    const totalSec = (Date.now() - backfillStart) / 1000;
    console.log(color.cyan(`[character-metadata] Content-identity backfill complete: processed ${poisonedIds.length} poisoned row(s) in ${totalSec.toFixed(1)}s (${(poisonedIds.length / totalSec).toFixed(1)} cards/sec).`));
}

// Keyed on active_chat_checked, not active_chat IS NULL, since the latter can't distinguish "confirmed no
// chat" from "not examined". Resumable without a flag: re-queries active_chat_checked = 0 every call.
export async function backfillActiveChatFromCards(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    if (!fs.existsSync(directories.characters)) return;

    const uncheckedIds = entry.db.all('SELECT id FROM characters WHERE active_chat_checked = 0').map(r => r.id);
    if (uncheckedIds.length === 0) return;

    const backfillStart = Date.now();
    let lastProgressLog = backfillStart;
    let processedRows = 0;

    for (let i = 0; i < uncheckedIds.length; i += BATCH_FLUSH_SIZE) {
        const chunkIds = uncheckedIds.slice(i, i + BATCH_FLUSH_SIZE);
        const chunkResults = await mapWithConcurrency(chunkIds, BOOTSTRAP_READ_CONCURRENCY, async (id) => {
            try {
                const filePath = path.join(directories.characters, id);
                const imgData = await parseCharacterCard(filePath, 'png');
                if (imgData === undefined) return { id, resolved: false };
                const character = JSON.parse(imgData);
                const chat = character.chat ?? null;
                return { id, chat, resolved: true };
            } catch (err) {
                console.error(`[character-metadata] Active-chat backfill failed to process ${id}, leaving it unchecked (will retry next boot):`, err.message);
                return { id, resolved: false };
            }
        });

        const resolved = chunkResults.filter(r => r.resolved);
        if (resolved.length > 0) {
            entry.db.transaction(() => {
                for (const { id, chat } of resolved) {
                    entry.db.run(
                        'UPDATE characters SET active_chat = @chat, active_chat_checked = 1 WHERE id = @id AND active_chat_checked = 0',
                        { chat: chat ?? null, id },
                    );
                }
            });
        }

        processedRows += chunkIds.length;

        const now = Date.now();
        if (now - lastProgressLog >= BOOTSTRAP_PROGRESS_LOG_INTERVAL_MS) {
            const elapsedSec = (now - backfillStart) / 1000;
            const rate = processedRows / elapsedSec;
            const remaining = uncheckedIds.length - processedRows;
            const etaSec = rate > 0 ? Math.round(remaining / rate) : null;
            console.log(color.cyan(`[character-metadata] Active-chat backfill progress: ${processedRows}/${uncheckedIds.length} (${rate.toFixed(1)} cards/sec, ETA ${etaSec === null ? 'unknown' : `${etaSec}s`})`));
            lastProgressLog = now;
        }

        await new Promise(resolve => setImmediate(resolve));
    }

    const totalSec = (Date.now() - backfillStart) / 1000;
    console.log(color.cyan(`[character-metadata] Active-chat backfill complete: processed ${uncheckedIds.length} row(s) in ${totalSec.toFixed(1)}s (${(uncheckedIds.length / totalSec).toFixed(1)} cards/sec).`));
}

// Gated by a meta flag, set only once the NOT LIKE discovery scan (unindexable) finds nothing left to backfill.
export async function backfillTagIdsInShallowJson(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = entry.db.get('SELECT value FROM meta WHERE key = \'tag_ids_shallow_json_backfill_completed\'');
    if (already) return;

    const idsToBackfill = entry.db.all(
        'SELECT id FROM characters WHERE shallow_json NOT LIKE \'%"tag_ids":%\'',
    ).map(r => r.id);

    if (idsToBackfill.length === 0) {
        entry.db.run('INSERT INTO meta (key, value) VALUES (\'tag_ids_shallow_json_backfill_completed\', \'1\') ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        return;
    }

    console.log(color.cyan(`[character-metadata] Backfilling tag_ids into shallow_json for ${idsToBackfill.length} character(s)...`));
    let processed = 0;
    const BACKFILL_BATCH = 100;
    const progressStart = Date.now();
    let lastProgressLog = progressStart;

    for (let i = 0; i < idsToBackfill.length; i += BACKFILL_BATCH) {
        const batchIds = idsToBackfill.slice(i, i + BACKFILL_BATCH);

        const prepared = [];
        for (const id of batchIds) {
            try {
                const row = entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id });
                if (!row) continue;
                if (row.shallow_json.includes('"tag_ids":')) continue;
                const tagIds = entry.db.all('SELECT tag_id FROM character_tags WHERE character_id = @id', { id }).map(r => r.tag_id);
                const shallow = JSON.parse(row.shallow_json);
                shallow.tag_ids = tagIds;
                prepared.push({ id, shallowJson: JSON.stringify(shallow) });
            } catch (err) {
                console.error(`[character-metadata] Failed to prepare tag_ids backfill for ${id}:`, err.message);
            }
        }

        // Write phase (in transaction): only writes, short lock duration (~100 writes * 2 ops).
        if (prepared.length > 0) {
            entry.db.transaction(() => {
                for (const { id, shallowJson } of prepared) {
                    const lastInsertRowid = insertChange(entry.db, id, 'upsert', JSON.stringify(['tag_ids']));
                    entry.db.run('UPDATE characters SET shallow_json = @shallowJson, change_seq = @changeSeq WHERE id = @id', { id, shallowJson, changeSeq: Number(lastInsertRowid) });
                }
            });
        }

        processed += prepared.length;

        const now = Date.now();
        if (now - lastProgressLog >= BOOTSTRAP_PROGRESS_LOG_INTERVAL_MS) {
            console.log(color.cyan(`[character-metadata] tag_ids backfill progress: ${i + batchIds.length}/${idsToBackfill.length} scanned, ${processed} patched`));
            lastProgressLog = now;
        }

        await new Promise(resolve => setImmediate(resolve));
    }

    console.log(color.cyan(`[character-metadata] tag_ids shallow_json backfill complete (${processed} character(s) in ${((Date.now() - progressStart) / 1000).toFixed(1)}s).`));

    // Not `processed === idsToBackfill.length`: a row a concurrent writer already patched needs no work here
    // but never increments processed, so re-check the discovery query directly to decide the flag.
    const remaining = entry.db.get('SELECT 1 FROM characters WHERE shallow_json NOT LIKE \'%"tag_ids":%\' LIMIT 1');
    if (!remaining) {
        entry.db.run('INSERT INTO meta (key, value) VALUES (\'tag_ids_shallow_json_backfill_completed\', \'1\') ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    }
}

// Diffs tags.json's tag_map against character_tags and applies only the delta, since most rows already agree.
export async function resyncTags(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const { tag_map } = readTagsData(directories);
    const knownIds = new Set(entry.db.all('SELECT id FROM characters').map(r => r.id));

    /** @type {Set<string>} */
    const desired = new Set();
    for (const [characterId, tagIds] of Object.entries(tag_map)) {
        if (!knownIds.has(characterId)) continue; // no dangling rows for characters this store doesn't have
        for (const tagId of tagIds) desired.add(`${characterId} ${tagId}`);
    }

    const current = entry.db.all('SELECT character_id, tag_id FROM character_tags');
    const currentSet = new Set(current.map(r => `${r.character_id} ${r.tag_id}`));

    const toAdd = [...desired].filter(k => !currentSet.has(k));
    const toRemove = current.filter(r => !desired.has(`${r.character_id} ${r.tag_id}`));

    if (toAdd.length === 0 && toRemove.length === 0) return;

    entry.db.transaction(() => {
        for (const key of toAdd) {
            const [characterId, tagId] = key.split(' ');
            entry.db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@characterId, @tagId)', { characterId, tagId });
        }
        for (const row of toRemove) {
            entry.db.run('DELETE FROM character_tags WHERE character_id = @characterId AND tag_id = @tagId', { characterId: row.character_id, tagId: row.tag_id });
        }
    });
}

// Content-only changes to existing files are the watcher's job, not this function's.
export async function reconcile(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    // A directory's mtime changes only when entries are added/removed/renamed within it (POSIX), so this
    // detects churn without stat'ing every individual file.
    let currentDirMtimeMs;
    try {
        currentDirMtimeMs = (await fsPromises.stat(directories.characters)).mtimeMs;
    } catch {
        return;
    }
    const storedRow = entry.db.get('SELECT value FROM meta WHERE key = \'last_reconcile_dir_mtime_ms\'');
    if (storedRow !== undefined && Number(storedRow.value) === currentDirMtimeMs) {
        return;
    }

    const files = (await fsPromises.readdir(directories.characters)).filter(f => f.endsWith('.png'));
    const onDisk = new Set(files);
    const existingIds = new Set(entry.db.all('SELECT id FROM characters').map(r => r.id));

    // Rows whose file no longer exists on disk.
    for (const id of existingIds) {
        if (!onDisk.has(id)) {
            entry.db.transaction(() => deleteRowSync(entry.db, id));
        }
    }

    const newFiles = files.filter(f => !existingIds.has(f));

    if (newFiles.length > 0) {
        const reconcileStart = Date.now();
        let lastProgressLog = reconcileStart;
        let processedFiles = 0;
        let loggedProgress = false;

        for (let i = 0; i < newFiles.length; i += BATCH_FLUSH_SIZE) {
            const chunkFiles = newFiles.slice(i, i + BATCH_FLUSH_SIZE);
            const chunkResults = await mapWithConcurrency(chunkFiles, BOOTSTRAP_READ_CONCURRENCY, async (file) => {
                try {
                    const filePath = path.join(directories.characters, file);
                    const stat = await fsPromises.stat(filePath);
                    const imgData = await parseCharacterCard(filePath, 'png');
                    if (imgData === undefined) return null;
                    const character = getCharaCardV2(JSON.parse(imgData), directories, false);
                    const { chatSize, dateLastChat } = calculateChatSize(path.join(directories.chats, file.replace(/\.png$/, '')));
                    const tagIds = getTagIdsFor(directories, file);
                    const row = buildRow(file, character, { dateAddedCandidate: Date.now(), fileMtime: stat.mtimeMs, chatSize, dateLastChat, tagIds, cardJson: imgData });
                    return { row, tagIds };
                } catch (err) {
                    console.error(`[character-metadata] Reconcile failed to process ${file}, will retry next boot:`, err.message);
                    return null;
                }
            });

            for (const result of chunkResults) {
                if (result) {
                    applyOrBuffer(entry, result.row, result.tagIds);
                }
            }

            processedFiles += chunkFiles.length;

            const now = Date.now();
            if (now - lastProgressLog >= BOOTSTRAP_PROGRESS_LOG_INTERVAL_MS) {
                const elapsedSec = (now - reconcileStart) / 1000;
                const rate = processedFiles / elapsedSec;
                const remaining = newFiles.length - processedFiles;
                const etaSec = rate > 0 ? Math.round(remaining / rate) : null;
                console.log(color.cyan(`[character-metadata] Reconcile progress: ${processedFiles}/${newFiles.length} new files (${rate.toFixed(1)} files/sec, ETA ${etaSec === null ? 'unknown' : `${etaSec}s`})`));
                lastProgressLog = now;
                loggedProgress = true;
            }

            if (i + BATCH_FLUSH_SIZE < newFiles.length) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }

        if (loggedProgress || newFiles.length > 0) {
            const totalSec = (Date.now() - reconcileStart) / 1000;
            console.log(color.cyan(`[character-metadata] Reconcile complete: ${newFiles.length} new file(s) processed in ${totalSec.toFixed(1)}s.`));
        }

        if (entry.batch) {
            flushBatch(entry);
        }
    }

    entry.db.run(
        'INSERT INTO meta (key, value) VALUES (\'last_reconcile_dir_mtime_ms\', @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        { value: String(currentDirMtimeMs) },
    );
}

function startWatcher(entry) {
    if (entry.watcher || !fs.existsSync(entry.directories.characters)) return;

    try {
        entry.watcher = fs.watch(entry.directories.characters, (_eventType, filename) => {
            if (!filename || !filename.endsWith('.png')) return;

            const existingTimer = entry.watchTimers.get(filename);
            if (existingTimer) clearTimeout(existingTimer);
            entry.watchTimers.set(filename, setTimeout(() => {
                entry.watchTimers.delete(filename);
                handleWatchEvent(entry, filename).catch(err => {
                    console.error(`[character-metadata] Watcher-triggered update failed for ${filename} (the reconciler will catch it next pass):`, err.message);
                });
            }, WATCH_DEBOUNCE_MS));
        });
        entry.watcher.on('error', (err) => {
            console.error('[character-metadata] Directory watcher error (the reconciler remains the source of truth):', err.message);
        });
    } catch (err) {
        console.error('[character-metadata] Failed to start directory watcher (the reconciler remains the source of truth):', err.message);
    }
}

function stopWatcher(entry) {
    if (entry.watcher) {
        entry.watcher.close();
        entry.watcher = null;
    }
    for (const timer of entry.watchTimers.values()) clearTimeout(timer);
    entry.watchTimers.clear();
}

async function handleWatchEvent(entry, filename) {
    const filePath = path.join(entry.directories.characters, filename);
    let stat;
    try {
        stat = await fsPromises.stat(filePath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            entry.db.transaction(() => deleteRowSync(entry.db, filename));
            return;
        }
        throw err;
    }

    const existing = entry.db.get('SELECT file_mtime FROM characters WHERE id = @id', { id: filename });
    if (existing && Number(existing.file_mtime) === stat.mtimeMs) {
        return; // Already up to date (e.g. a write-path hook already handled this exact change).
    }

    const imgData = await parseCharacterCard(filePath, 'png');
    if (imgData === undefined) return;
    const character = getCharaCardV2(JSON.parse(imgData), entry.directories, false);
    const { chatSize, dateLastChat } = calculateChatSize(path.join(entry.directories.chats, filename.replace(/\.png$/, '')));
    const tagIds = getTagIdsFor(entry.directories, filename);
    const row = buildRow(filename, character, { dateAddedCandidate: Date.now(), fileMtime: stat.mtimeMs, chatSize, dateLastChat, tagIds, cardJson: imgData });
    applyOrBuffer(entry, row, tagIds);
}

// Bootstrap runs in the background so a large corpus doesn't delay the server listening.
export async function initializeMetadataStores(directoriesList) {
    for (const directories of directoriesList) {
        const entry = await getEntry(directories);
        if (!entry) continue;
        if (entry.bootstrapPromise) continue;

        startWatcher(entry);

        const __chainStart = process.hrtime.bigint();
        const __stage = async (label, fn) => {
            const s = process.hrtime.bigint();
            const result = await fn();
            console.log(`[boot-timing] [metadata-chain] ${label}: ${Number(process.hrtime.bigint() - s) / 1e6}ms (chain total so far: ${Number(process.hrtime.bigint() - __chainStart) / 1e6}ms)`);
            return result;
        };

        // migrateTagsJsonIfNeeded() classifies tag_map's keys against characters/groups, so both bootstraps
        // must populate them first.
        entry.bootstrapPromise = __stage('bootstrapIfNeeded', () => bootstrapIfNeeded(directories))
            .then(() => __stage('bootstrapGroupsIfNeeded', () => bootstrapGroupsIfNeeded(directories)))
            .then(() => __stage('migrateTagsJsonIfNeeded', () => migrateTagsJsonIfNeeded(directories)))
            .then(() => __stage('backfillCardTagsIfNeeded', () => backfillCardTagsIfNeeded(directories)))
            .then(() => __stage('backfillTagIdsInShallowJson', () => backfillTagIdsInShallowJson(directories)))
            .then(() => __stage('reconcile', () => reconcile(directories)))
            // After reconcile() so this pass sees any rows reconcile() itself just inserted.
            .then(() => __stage('backfillContentIdentityHashes', () => backfillContentIdentityHashes(directories)))
            .then(() => __stage('backfillActiveChatFromCards', () => backfillActiveChatFromCards(directories)))
            .catch(err => console.error(`[character-metadata] Bootstrap failed for ${directories.root}:`, err));
    }
}

export function disposeMetadataStores() {
    for (const entry of entries.values()) {
        stopWatcher(entry);
        try {
            entry.db.close();
        } catch {
            // Best-effort on shutdown.
        }
    }
    entries.clear();
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<object | undefined>}
 */
export async function getCharacterMetadataRow(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return undefined;
    return entry.db.get('SELECT * FROM characters WHERE id = @id', { id: avatar });
}

// Also checks the pending batch buffer: a bulk import can drop two identical files in the same
// still-unflushed batch. Fails open to null, which callers must treat as "can't determine", not "no duplicate".
export async function findCharacterIdByContentHash(directories, hash) {
    if (!hash) return null;
    const entry = await getEntry(directories);
    if (!entry) return null;

    if (entry.batch) {
        for (const pending of entry.batch.pending.values()) {
            if (pending.row.content_hash === hash) {
                return pending.row.id;
            }
        }
    }

    const row = entry.db.get('SELECT id FROM characters WHERE content_hash = @hash', { hash });
    return row ? row.id : null;
}

// Matches semantic content even if bytes differ.
export async function findCharacterIdByContentIdentityHash(directories, hash) {
    if (!hash) return null;
    const entry = await getEntry(directories);
    if (!entry) return null;

    if (entry.batch) {
        for (const pending of entry.batch.pending.values()) {
            if (pending.row.content_identity_hash === hash) {
                return pending.row.id;
            }
        }
    }

    const row = entry.db.get('SELECT id FROM characters WHERE content_identity_hash = @hash', { hash });
    return row ? row.id : null;
}

/**
 * Requires both hashes to match the same row - content_identity_hash alone would wrongly treat
 * same-text-different-portrait characters as duplicates.
 */
export async function findCharacterIdByIdentityHashes(directories, contentIdentityHash, avatarIdentityHash) {
    if (!contentIdentityHash || !avatarIdentityHash) return null;
    const entry = await getEntry(directories);
    if (!entry) return null;

    if (entry.batch) {
        for (const pending of entry.batch.pending.values()) {
            if (pending.row.content_identity_hash === contentIdentityHash && pending.row.avatar_identity_hash === avatarIdentityHash) {
                return pending.row.id;
            }
        }
    }

    const exactRow = entry.db.get(
        'SELECT id FROM characters WHERE content_identity_hash = @contentIdentityHash AND avatar_identity_hash = @avatarIdentityHash',
        { contentIdentityHash, avatarIdentityHash },
    );
    if (exactRow) return exactRow.id;

    // Fallback for rows sharing content_identity_hash but with avatar_identity_hash still NULL: a plain SQL
    // `=` comparison silently excludes NULL, which would miss real duplicates on an unbackfilled library.
    if (!fs.existsSync(directories.characters)) return null;
    const unbackfilledCandidates = entry.db.all(
        'SELECT id FROM characters WHERE content_identity_hash = @contentIdentityHash AND avatar_identity_hash IS NULL',
        { contentIdentityHash },
    );
    for (const { id } of unbackfilledCandidates) {
        let rowAvatarHash;
        try {
            const filePath = path.join(directories.characters, id);
            const buffer = await fsPromises.readFile(filePath);
            rowAvatarHash = computeAvatarIdentityHashFromChunks(extract(new Uint8Array(buffer)));
        } catch (err) {
            console.debug(`[character-metadata] Identity-hash fallback verification failed reading ${id}, treating as no match:`, /** @type {any} */ (err)?.message ?? err);
            continue;
        }

        // COALESCE-guarded so a concurrent live write for this row always wins over this stale read.
        entry.db.run(
            'UPDATE characters SET avatar_identity_hash = COALESCE(avatar_identity_hash, @hash) WHERE id = @id',
            { hash: rowAvatarHash, id },
        );

        if (rowAvatarHash === avatarIdentityHash) return id;
    }

    return null;
}

// Fails open to null (unavailable store) - callers must treat that as "can't determine", not "not skipped".
export async function getLocalImportSkip(directories, sourcePath) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const row = entry.db.get('SELECT mtime_ms, reason FROM local_import_skips WHERE source_path = @sourcePath', { sourcePath });
    return row ? { mtimeMs: Number(row.mtime_ms), reason: row.reason } : null;
}

export async function setLocalImportSkip(directories, sourcePath, mtimeMs, reason) {
    const entry = await getEntry(directories);
    if (!entry) return;

    entry.db.run(
        `INSERT INTO local_import_skips (source_path, mtime_ms, reason, checked_at)
         VALUES (@sourcePath, @mtimeMs, @reason, @checkedAt)
         ON CONFLICT(source_path) DO UPDATE SET
            mtime_ms = excluded.mtime_ms,
            reason = excluded.reason,
            checked_at = excluded.checked_at`,
        { sourcePath, mtimeMs, reason, checkedAt: Date.now() },
    );
}

export async function clearLocalImportSkip(directories, sourcePath) {
    const entry = await getEntry(directories);
    if (!entry) return;

    entry.db.run('DELETE FROM local_import_skips WHERE source_path = @sourcePath', { sourcePath });
}

// Lazy per-cache-miss point lookup, replacing the old bulk-load-whole-table-at-boot getAllLocalImportMtimes()
// (unbounded memory growth against an ever-growing external corpus).
export async function getLocalImportMtime(directories, sourcePath) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const row = entry.db.get('SELECT mtime_ms FROM local_import_mtimes WHERE source_path = @sourcePath', { sourcePath });
    return row ? { mtimeMs: Number(row.mtime_ms) } : null;
}

// Batched counterpart to getLocalImportMtime(): one query per chunk of paths. Returns a plain Map scoped to
// just the given paths, not a whole-table cache.
export async function getLocalImportMtimesForPaths(directories, sourcePaths) {
    const result = new Map();
    if (!sourcePaths.length) return result;

    const entry = await getEntry(directories);
    if (!entry) return result;

    const placeholders = sourcePaths.map(() => '?').join(',');
    for (const row of entry.db.all(`SELECT source_path, mtime_ms FROM local_import_mtimes WHERE source_path IN (${placeholders})`, sourcePaths)) {
        result.set(row.source_path, Number(row.mtime_ms));
    }
    return result;
}

// Keyset-paginated (source_path > afterSourcePath), not LIMIT/OFFSET: the sweep DELETEs rows as it walks, and
// OFFSET pagination would silently skip rows as offsets shift underneath it.
export async function getLocalImportMtimeSourcePathsAfter(directories, afterSourcePath, limit) {
    const entry = await getEntry(directories);
    if (!entry) return [];

    const rows = entry.db.all(
        'SELECT source_path FROM local_import_mtimes WHERE source_path > @after ORDER BY source_path LIMIT @limit',
        { after: afterSourcePath, limit },
    );
    return rows.map(row => row.source_path);
}

// duplicateOf, when given, records that this row's validity depends on that character id still existing -
// deleteRowSync() cascades the deletion.
export async function setLocalImportMtime(directories, sourcePath, mtimeMs, duplicateOf = null) {
    const entry = await getEntry(directories);
    if (!entry) return;

    entry.db.run(
        `INSERT INTO local_import_mtimes (source_path, mtime_ms, duplicate_of)
         VALUES (@sourcePath, @mtimeMs, @duplicateOf)
         ON CONFLICT(source_path) DO UPDATE SET mtime_ms = excluded.mtime_ms, duplicate_of = excluded.duplicate_of`,
        { sourcePath, mtimeMs, duplicateOf },
    );
}

export async function clearLocalImportMtime(directories, sourcePath) {
    const entry = await getEntry(directories);
    if (!entry) return;

    entry.db.run('DELETE FROM local_import_mtimes WHERE source_path = @sourcePath', { sourcePath });
}

export async function getCharacterTagIds(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return entry.db.all('SELECT tag_id FROM character_tags WHERE character_id = @id', { id: avatar }).map(r => r.tag_id);
}

export async function getTagUsageCount(directories, tagId) {
    const entry = await getEntry(directories);
    if (!entry) return 0;
    const row = entry.db.get('SELECT count FROM tag_usage WHERE tag_id = @tagId', { tagId });
    return row ? Number(row.count) : 0;
}

// Content hash of all tag definitions, the freshness signature replacing tags.json's mtime.
function updateTagsHashSync(db) {
    const rows = db.all('SELECT id, data FROM tags ORDER BY id');
    const content = rows.map(r => r.id + '\0' + r.data).join('\0');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    db.run(
        'INSERT INTO meta (key, value) VALUES (\'tags_hash\', @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        { value: hash },
    );
}

export async function getTagsHash(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = entry.db.get('SELECT value FROM meta WHERE key = \'tags_hash\'');
    return row ? row.value : null;
}

// General-purpose key/value accessor pair over the meta table.
export async function getMetaValue(directories, key) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = entry.db.get('SELECT value FROM meta WHERE key = ?', [key]);
    return row ? String(row.value) : null;
}

export async function setMetaValue(directories, key, value) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run(
        'INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        { key, value: String(value) },
    );
}

// Tag ids whose *name* changed since sinceSeq - mirrors getChangesSince()'s truncation handling.
export async function getTagNameChangesSince(directories, sinceSeq) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const numericSince = Number.isFinite(sinceSeq) && sinceSeq >= 0 ? Math.trunc(sinceSeq) : 0;
    const bounds = entry.db.get('SELECT MIN(seq) as minSeq, MAX(seq) as maxSeq FROM tag_name_changes');
    const minSeq = bounds?.minSeq != null ? Number(bounds.minSeq) : undefined;
    const maxSeq = bounds?.maxSeq != null ? Number(bounds.maxSeq) : 0;

    const truncated = minSeq !== undefined && numericSince < minSeq - 1;
    if (truncated) {
        return { seq: maxSeq, tagIds: [], truncated: true };
    }

    const rows = entry.db.all('SELECT DISTINCT tag_id FROM tag_name_changes WHERE seq > ?', [numericSince]);
    return { seq: maxSeq, tagIds: rows.map(row => row.tag_id), truncated: false };
}

export async function getCharacterIdsForTagIds(directories, tagIds) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const ids = [...new Set(tagIds)];
    if (!ids.length) return [];
    const out = new Set();
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        for (const row of entry.db.all(`SELECT DISTINCT character_id FROM character_tags WHERE tag_id IN (${placeholders})`, slice)) {
            out.add(row.character_id);
        }
    }
    return [...out];
}

// INSERT OR IGNORE: a resumed migration run reuses the id minted first rather than minting a fresh one.
export async function recordIdMigrationMapping(directories, oldId, newId) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run('INSERT OR IGNORE INTO id_migration (old_id, new_id, completed) VALUES (@oldId, @newId, 0)', { oldId, newId });
}

export async function getIdMigrationMapping(directories, oldId) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = entry.db.get('SELECT new_id FROM id_migration WHERE old_id = @oldId', { oldId });
    return row ? String(row.new_id) : null;
}

export async function isIdMigrationTargetTaken(directories, newId) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return !!entry.db.get('SELECT 1 FROM id_migration WHERE new_id = @newId', { newId });
}

export async function markIdMigrationComplete(directories, oldId) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run('UPDATE id_migration SET completed = 1 WHERE old_id = @oldId', { oldId });
}

export async function getPendingIdMigrations(directories) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return entry.db.all('SELECT old_id, new_id FROM id_migration WHERE completed = 0');
}

export async function getCompletedIdMigrations(directories) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return entry.db.all('SELECT old_id, new_id FROM id_migration WHERE completed = 1');
}

// ids can mix character avatars and group ids. Every requested id is a key in the result ([] if no tags), so
// a caller never has to distinguish "no tags" from "id absent".
export async function getEntityTagIdsForMany(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    /** @type {Record<string, string[]>} */
    const result = {};
    for (const id of ids) {
        result[id] = [];
    }

    // Chunked for the same reason checkCharactersExist() is - stay clear of SQLite's bound-parameter ceiling.
    for (let i = 0; i < ids.length; i += BATCH_FLUSH_SIZE) {
        const chunk = ids.slice(i, i + BATCH_FLUSH_SIZE).filter(id => typeof id === 'string' && id.length > 0);
        if (chunk.length === 0) continue;
        const placeholders = chunk.map(() => '?').join(', ');
        const characterRows = entry.db.all(`SELECT character_id as entity_id, tag_id FROM character_tags WHERE character_id IN (${placeholders})`, chunk);
        const groupRows = entry.db.all(`SELECT group_id as entity_id, tag_id FROM group_tags WHERE group_id IN (${placeholders})`, chunk);
        for (const row of [...characterRows, ...groupRows]) {
            result[row.entity_id]?.push(row.tag_id);
        }

        if (i + BATCH_FLUSH_SIZE < ids.length) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    return result;
}

// Patches a still-buffered batch-import row's tag ids so a read landing before flush still sees the assignment.

function patchPendingRowTagIds(pending) {
    const shallow = JSON.parse(pending.row.shallow_json);
    shallow.tag_ids = pending.tagIds;
    pending.row.shallow_json = JSON.stringify(shallow);
    pending.row.digest_tag_ids = characterDigestTagIdsHash(shallow) % 4294967296;
}

// Requires the entity to exist (checked against characters then groups) since neither table has an FK to
// enforce it. Checks the batch-import pending buffer too: a just-imported, still-buffered row's auto-assign
// would otherwise race the flush and silently lose the tag.
export async function assignEntityTag(directories, id, tagId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const pending = entry.batch?.pending.get(id);
    if (pending) {
        if (!pending.tagIds.includes(tagId)) {
            pending.tagIds.push(tagId);
        }
        patchPendingRowTagIds(pending);
        return 'ok';
    }

    if (entry.db.get('SELECT 1 FROM characters WHERE id = @id', { id })) {
        entry.db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@id, @tagId)', { id, tagId });
        // No updateTagsHashSync() here: this only touches character_tags, never the tags table that hashes, so
        // it would be a full O(library-wide tag count) scan for zero signal.
        const charRow = entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id });
        if (charRow) {
            const currentTagIds = entry.db.all('SELECT tag_id FROM character_tags WHERE character_id = @id', { id }).map(r => r.tag_id);
            const shallow = JSON.parse(charRow.shallow_json);
            shallow.tag_ids = currentTagIds;
            const lastInsertRowid = insertChange(entry.db, id, 'upsert', JSON.stringify(['tag_ids']));
            entry.db.run('UPDATE characters SET shallow_json = @shallowJson, change_seq = @changeSeq, digest_tag_ids = @digestTagIds WHERE id = @id', { id, shallowJson: JSON.stringify(shallow), changeSeq: Number(lastInsertRowid), digestTagIds: characterDigestTagIdsHash(shallow) % 4294967296 });
        }
        return 'ok';
    }
    if (entry.db.get('SELECT 1 FROM groups WHERE id = @id', { id })) {
        entry.db.run('INSERT OR IGNORE INTO group_tags (group_id, tag_id) VALUES (@id, @tagId)', { id, tagId });
        const currentTagIds = entry.db.all('SELECT tag_id FROM group_tags WHERE group_id = @id', { id }).map(r => r.tag_id);
        entry.db.run('UPDATE groups SET digest_tag_ids = @digestTagIds WHERE id = @id', { id, digestTagIds: groupDigestTagIdsHash({ tag_ids: currentTagIds }) });
        return 'ok';
    }
    return 'not_found';
}

// Not a 404 on a nonexistent entity: nothing to reject. Runs the delete against both tables unconditionally,
// cheaper than resolving which one first. Checks the batch-import pending buffer too, same reasoning as
// assignEntityTag().
export async function unassignEntityTag(directories, id, tagId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const pending = entry.batch?.pending.get(id);
    if (pending) {
        pending.tagIds = pending.tagIds.filter(t => t !== tagId);
        patchPendingRowTagIds(pending);
        return 'ok';
    }

    entry.db.run('DELETE FROM character_tags WHERE character_id = @id AND tag_id = @tagId', { id, tagId });
    entry.db.run('DELETE FROM group_tags WHERE group_id = @id AND tag_id = @tagId', { id, tagId });
    entry.db.run(
        'UPDATE groups SET digest_tag_ids = @digestTagIds WHERE id = @id',
        { id, digestTagIds: groupDigestTagIdsHash({ tag_ids: entry.db.all('SELECT tag_id FROM group_tags WHERE group_id = @id', { id }).map(r => r.tag_id) }) },
    );
    const charRow = entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id });
    if (charRow) {
        const currentTagIds = entry.db.all('SELECT tag_id FROM character_tags WHERE character_id = @id', { id }).map(r => r.tag_id);
        const shallow = JSON.parse(charRow.shallow_json);
        shallow.tag_ids = currentTagIds;
        const lastInsertRowid = insertChange(entry.db, id, 'upsert', JSON.stringify(['tag_ids']));
        entry.db.run('UPDATE characters SET shallow_json = @shallowJson, change_seq = @changeSeq, digest_tag_ids = @digestTagIds WHERE id = @id', { id, shallowJson: JSON.stringify(shallow), changeSeq: Number(lastInsertRowid), digestTagIds: characterDigestTagIdsHash(shallow) % 4294967296 });
    }
    return 'ok';
}

export async function getGroupTagIds(directories, groupId) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return entry.db.all('SELECT tag_id FROM group_tags WHERE group_id = @id', { id: groupId }).map(r => r.tag_id);
}

export async function getAllTagUsage(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const rows = entry.db.all('SELECT tag_id, count FROM tag_usage');
    /** @type {Record<string, number>} */
    const result = {};
    for (const row of rows) {
        result[row.tag_id] = Number(row.count);
    }
    return result;
}

const GROUP_UPSERT_SQL = `
    INSERT INTO groups (id, name, name_fold, fav, date_added, date_last_chat, chat_size, digest_fav, digest_content)
    VALUES (@id, @name, @nameFold, @fav, @dateAdded, @dateLastChat, @chatSize, @digestFav, @digestContent)
    ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        name_fold = excluded.name_fold,
        fav = excluded.fav,
        digest_fav = excluded.digest_fav,
        digest_content = excluded.digest_content
    -- digest_tag_ids absent: owned by assignEntityTag()/unassignEntityTag()'s group branch, not this upsert.
    -- date_added absent: write-once. date_last_chat/chat_size absent: owned by bumpGroupChatStats() and the
    -- backfill passes, not by /create or /edit requests.
`;

// row.group feeds digest_content only; its other fields live in the group's own JSON file, not a groups row column.
function upsertGroupRowSync(db, { id, name, fav, group, dateAdded, dateLastChat, chatSize }) {
    db.run(GROUP_UPSERT_SQL, {
        id,
        name: name ?? '',
        nameFold: foldName(name),
        fav: fav ? 1 : 0,
        dateAdded,
        dateLastChat,
        chatSize,
        digestFav: groupDigestFavHash({ fav: !!fav }),
        digestContent: groupDigestContentHash(group ?? {}),
    });
}

export async function upsertGroupRow(directories, id, name, { fav, group } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return;
    upsertGroupRowSync(entry.db, { id, name, fav, group, dateAdded: Date.now(), dateLastChat: 0, chatSize: 0 });
}

export async function bumpCharacterDateLastChat(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const now = Date.now();
    entry.db.run('UPDATE characters SET date_last_chat = @now WHERE id = @id', { now, id: avatar });
}

/** `stats`, when supplied, is used verbatim instead of statting the group's chat files, which get renamed away. */
export async function bumpGroupChatStats(directories, chatId, { groupId, stats } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const group = resolveGroupOwner(directories.groups, { chatId, groupId });
    if (!group) return; // Not a group chat this store knows about - nothing to bump.

    const { chatSize, dateLastChat } = stats ?? calculateGroupChatStats(directories.groupChats, group.chats);
    entry.db.run('UPDATE groups SET date_last_chat = @dateLastChat, chat_size = @chatSize WHERE id = @id', { dateLastChat, chatSize, id: group.id });
}

// group_tags has no real foreign key; cascade is application code, same as deleteRowSync() for characters.
export async function deleteGroupRow(directories, id) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.transaction(() => {
        entry.db.run('DELETE FROM groups WHERE id = @id', { id });
        entry.db.run('DELETE FROM group_tags WHERE group_id = @id', { id });
    });
}

// One-time backfill of `groups` for a library that predates the table; gated by its own meta flag.
export async function bootstrapGroupsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = entry.db.get('SELECT value FROM meta WHERE key = \'groups_bootstrap_completed\'');
    if (already) return;

    if (fs.existsSync(directories.groups)) {
        const files = fs.readdirSync(directories.groups).filter(f => f.endsWith('.json'));
        entry.db.transaction(() => {
            for (const file of files) {
                try {
                    const filePath = path.join(directories.groups, file);
                    const raw = fs.readFileSync(filePath, 'utf8');
                    const group = JSON.parse(raw);
                    if (group && typeof group.id === 'string' && group.id) {
                        const stat = fs.statSync(filePath);
                        const { chatSize, dateLastChat } = calculateGroupChatStats(directories.groupChats, group.chats);
                        upsertGroupRowSync(entry.db, {
                            id: group.id,
                            name: group.name,
                            fav: !!group.fav,
                            group,
                            dateAdded: Math.round(stat.birthtimeMs),
                            dateLastChat,
                            chatSize,
                        });
                    }
                } catch (err) {
                    console.error(`[character-metadata] Bootstrap failed to process group file ${file}, skipping it (group tags for it won't resolve until it's next created/edited):`, err.message);
                }
            }
        });
    }

    entry.db.run(
        'INSERT INTO meta (key, value) VALUES (\'groups_bootstrap_completed\', @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        { value: String(Date.now()) },
    );
}

// Returns tag definitions in no particular order - sorting is a client concern (compareTagsForSort(), tags.js).
export async function getTagDefinitions(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    return entry.db.all('SELECT data FROM tags').map(r => JSON.parse(r.data));
}

// Bucketed digest over every tag definition, computed on demand and stored nowhere - a tag row is small
// enough (~110 bytes, ~130ms at 62k rows) that there's no need for derived state that could drift.
export async function getTagsDigest(directories, bucketCount = DEFAULT_DIGEST_BUCKET_COUNT) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const buckets = Array.from({ length: bucketCount }, () => emptyDigest());
    for (const row of entry.db.all('SELECT id, data FROM tags')) {
        let parsed;
        try { parsed = JSON.parse(row.data); } catch { continue; }
        const b = bucketOf(row.id, bucketCount);
        buckets[b] = combineDigest(buckets[b], row.id, contentHashOf(parsed));
    }
    return { bucketCount, buckets };
}

// Every {id, hash} in one bucket, for a client to diff locally against a stale digest. Deletions need no
// tombstone: a tag no longer present is simply absent from its bucket's membership.
export async function getTagsBucketMembers(directories, bucket, bucketCount = DEFAULT_DIGEST_BUCKET_COUNT) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const members = [];
    for (const row of entry.db.all('SELECT id, data FROM tags')) {
        if (bucketOf(row.id, bucketCount) !== bucket) continue;
        let parsed;
        try { parsed = JSON.parse(row.data); } catch { continue; }
        members.push({ id: row.id, hash: contentHashOf(parsed) });
    }
    return { bucket, bucketCount, members };
}

export async function getTagDefinitionsByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const wanted = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
    if (!wanted.length) return [];

    const out = [];
    const CHUNK = 500;
    for (let i = 0; i < wanted.length; i += CHUNK) {
        const slice = wanted.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        for (const r of entry.db.all(`SELECT data FROM tags WHERE id IN (${placeholders})`, slice)) {
            try { out.push(JSON.parse(r.data)); } catch { /* a row that will not parse cannot be repaired here */ }
        }
    }
    return out;
}

// Every tag id currently assigned to at least one entity, read off the trigger-maintained `tag_usage` table.
export async function getAssignedTagIds(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const rows = entry.db.all('SELECT tag_id FROM tag_usage WHERE count > 0');
    return rows.map(row => row.tag_id);
}

/**
 * Every entity-to-tag assignment across both tables. Returned compactly: `avatars`/`tagIds` intern each unique
 * id/tag string to an integer index, and `map[i]` lists the tag-id indices assigned to `avatars[i]`.
 * @returns {Promise<{avatars: string[], tagIds: string[], map: number[][]} | null>}
 */
export async function getAllEntityTagAssignments(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const characterRows = entry.db.all('SELECT character_id, tag_id FROM character_tags');

    // Yield to the event loop between the two scans, same as getEntityTagIdsForMany() does between chunks, so
    // this full-table read can't starve other requests behind it.
    await new Promise(resolve => setImmediate(resolve));

    const groupRows = entry.db.all('SELECT group_id, tag_id FROM group_tags');

    /** @type {Map<string, number>} */
    const avatarIndex = new Map();
    /** @type {Map<string, number>} */
    const tagIdIndex = new Map();
    /** @type {number[][]} */
    const map = [];

    const addAssignment = (entityId, tagId) => {
        let entityIdx = avatarIndex.get(entityId);
        if (entityIdx === undefined) {
            entityIdx = avatarIndex.size;
            avatarIndex.set(entityId, entityIdx);
            map.push([]);
        }
        let tagIdx = tagIdIndex.get(tagId);
        if (tagIdx === undefined) {
            tagIdx = tagIdIndex.size;
            tagIdIndex.set(tagId, tagIdx);
        }
        map[entityIdx].push(tagIdx);
    };

    for (const row of characterRows) {
        addAssignment(row.character_id, row.tag_id);
    }
    for (const row of groupRows) {
        addAssignment(row.group_id, row.tag_id);
    }

    return {
        avatars: [...avatarIndex.keys()],
        tagIds: [...tagIdIndex.keys()],
        map,
    };
}

/**
 * Replaces the entire `tags` table's contents with `tagsArray` (full replace, not a diff). Appends one
 * `tag_name_changes` row per tag id whose `name` changed, so search-index catch-up can reindex just those
 * assignees instead of scanning the whole table.
 */
export async function saveTagDefinitions(directories, tagsArray) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    entry.db.transaction(() => {
        const oldNames = new Map(entry.db.all('SELECT id, data FROM tags').map(row => {
            let parsed = null;
            try { parsed = JSON.parse(row.data); } catch { /* an unparseable old row has no name to compare against */ }
            return [row.id, parsed?.name ?? ''];
        }));

        entry.db.run('DELETE FROM tags');
        for (const tag of tagsArray) {
            if (!tag || typeof tag.id !== 'string' || !tag.id) continue;
            entry.db.run('INSERT INTO tags (id, data) VALUES (@id, @data)', { id: tag.id, data: JSON.stringify(tag) });
            if (oldNames.has(tag.id) && oldNames.get(tag.id) !== (tag.name ?? '')) {
                entry.db.run('INSERT INTO tag_name_changes (tag_id) VALUES (@tagId)', { tagId: tag.id });
            }
        }
        updateTagsHashSync(entry.db);
    });
    // Invalidate: a whole-table replace can't be patched into getTagCache()'s Maps incrementally.
    entry.tagCache = null;
    return 'ok';
}

// One-time migration off tags.json (removed entirely, not just drained). Must run after bootstrapIfNeeded()
// AND bootstrapGroupsIfNeeded() since it classifies tag_map keys against those tables; an unmatched key is
// dropped with a warning. On success tags.json is renamed to `tags.json.migrated`, not deleted. Gated by a meta
// flag; a parse failure does not set it, so a corrupt tags.json is retried next boot.
export async function migrateTagsJsonIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = entry.db.get('SELECT value FROM meta WHERE key = \'tags_json_migrated\'');
    if (already) return;

    const tagsJsonPath = path.join(directories.root, TAGS_FILE);
    if (!fs.existsSync(tagsJsonPath)) {
        entry.db.run(
            'INSERT INTO meta (key, value) VALUES (\'tags_json_migrated\', @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            { value: String(Date.now()) },
        );
        return;
    }

    /** @type {{ tags?: object[], tag_map?: Record<string, string[]> }} */
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(tagsJsonPath, 'utf8'));
    } catch (err) {
        console.error('[character-metadata] Failed to parse tags.json during migration - leaving it in place and retrying next boot:', err.message);
        return;
    }

    const tagsArray = Array.isArray(parsed.tags) ? parsed.tags : [];
    const tagMap = parsed.tag_map && typeof parsed.tag_map === 'object' ? parsed.tag_map : {};

    await saveTagDefinitions(directories, tagsArray);
    const droppedKeys = importTagMapSync(entry, tagMap);
    entry.db.run(
        'INSERT INTO meta (key, value) VALUES (\'tags_json_migrated\', @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        { value: String(Date.now()) },
    );

    if (droppedKeys.length > 0) {
        console.warn(`[character-metadata] tags.json migration: ${droppedKeys.length} tag_map key(s) matched neither a known character nor a known group, dropped: ${droppedKeys.slice(0, 20).join(', ')}${droppedKeys.length > 20 ? ', ...' : ''}`);
    }

    try {
        fs.renameSync(tagsJsonPath, `${tagsJsonPath}.migrated`);
    } catch (err) {
        console.error('[character-metadata] Migrated tags.json successfully but could not rename it out of the way (safe to ignore - it is never read again):', err.message);
    }
}

// Imports a `{[id]: tagId[]}` map into character_tags/group_tags, classifying each key against the current
// characters/groups tables. Returns keys that matched neither.
function importTagMapSync(entry, tagMap) {
    const knownCharacterIds = new Set(entry.db.all('SELECT id FROM characters').map(r => r.id));
    const knownGroupIds = new Set(entry.db.all('SELECT id FROM groups').map(r => r.id));
    const droppedKeys = [];

    entry.db.transaction(() => {
        for (const [key, tagIds] of Object.entries(tagMap)) {
            if (!Array.isArray(tagIds)) continue;
            if (knownCharacterIds.has(key)) {
                for (const tagId of tagIds) {
                    entry.db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@key, @tagId)', { key, tagId });
                }
            } else if (knownGroupIds.has(key)) {
                for (const tagId of tagIds) {
                    entry.db.run('INSERT OR IGNORE INTO group_tags (group_id, tag_id) VALUES (@key, @tagId)', { key, tagId });
                }
            } else {
                droppedKeys.push(key);
            }
        }
        updateTagsHashSync(entry.db);
    });

    return droppedKeys;
}

// A card's own `data.tags` array is user-authored free text, not a curated tag set - ROOT/TAVERN are structural
// markers some card sources embed that were never meant to become a visible tag, and 50 is a sanity cap against
// a malformed or abusive card claiming hundreds of "tags" and bloating the tags table on backfill.
const CARD_TAGS_EXCLUDED = new Set(['ROOT', 'TAVERN']);
const CARD_TAGS_MAX_PER_CARD = 50;

// Resolves a card's data.tags array to tag ids, minting new tag definitions as needed (case-insensitive).
// `tagNameToId` is mutated in place so a name introduced earlier in a batch is reused, not re-created.
/**
 * @param {(params: { id: string, data: string }) => void} insertTag Never called when `onlyExisting` is true.
 */
function resolveCardTagIds(cardTags, tagNameToId, insertTag, { onlyExisting = false } = {}) {
    const filtered = cardTags
        .filter(t => typeof t === 'string')
        .map(t => t.trim())
        .filter(t => t.length > 0 && !CARD_TAGS_EXCLUDED.has(t))
        .slice(0, CARD_TAGS_MAX_PER_CARD);

    const tagIds = [];
    for (const tagName of filtered) {
        const key = tagName.toLowerCase();
        let tagId = tagNameToId.get(key);
        if (!tagId) {
            if (onlyExisting) continue;
            tagId = crypto.randomUUID();
            insertTag({ id: tagId, data: JSON.stringify({ id: tagId, name: tagName, create_date: Date.now() }) });
            tagNameToId.set(key, tagId);
        }
        tagIds.push(tagId);
    }
    return tagIds;
}

// Seeds character_tags from one character's card-embedded data.tags. Deliberately does not touch
// shallow_json.tag_ids/digest_tag_ids - callers are responsible for reconciling those once they know the
// row's final tag id set (see syncShallowTagIdsFromTable()).
function seedCardTagsForCharacter(db, avatar, cardTags, tagNameToId, insertTag, insertAssignment, options) {
    const tagIds = resolveCardTagIds(cardTags, tagNameToId, insertTag, options);
    for (const tagId of tagIds) {
        insertAssignment({ characterId: avatar, tagId });
    }
    return tagIds;
}

// Patches one character row's shallow_json.tag_ids/digest_tag_ids to match character_tags. Re-reads
// character_tags rather than trusting a caller's resolved list, so other pre-existing assignments survive.
/**
 * @returns {boolean} Whether the row was found and patched.
 */
function syncShallowTagIdsFromTable(db, avatar) {
    const row = db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: avatar });
    if (!row) return false;
    const currentTagIds = db.all('SELECT tag_id FROM character_tags WHERE character_id = @id', { id: avatar }).map(r => r.tag_id);
    const shallow = JSON.parse(row.shallow_json);
    shallow.tag_ids = currentTagIds;
    const lastInsertRowid = insertChange(db, avatar, 'upsert', JSON.stringify(['tag_ids']));
    db.run(
        'UPDATE characters SET shallow_json = @shallowJson, change_seq = @changeSeq, digest_tag_ids = @digestTagIds WHERE id = @id',
        { id: avatar, shallowJson: JSON.stringify(shallow), changeSeq: Number(lastInsertRowid), digestTagIds: characterDigestTagIdsHash(shallow) % 4294967296 },
    );
    return true;
}

// Repairs rows where shallow_json.tag_ids is stale but character_tags is correct (can happen when
// seedCardTagsForCharacter() seeds tags without a matching syncShallowTagIdsFromTable() call). Safe to call
// more than once; only touches rows a full-table comparison finds mismatched.
/**
 * @param {{ dryRun?: boolean }} [options] `dryRun: true` reports what would be touched without writing anything.
 * @returns {Promise<{ scanned: number, mismatched: string[] }>} `mismatched` are the affected character ids
 * (found regardless of `dryRun`; only actually repaired when `dryRun` is false).
 */
export async function repairStaleShallowTagIds(directories, { dryRun = false } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return { scanned: 0, mismatched: [] };

    const rows = entry.db.all(
        `SELECT c.id, c.shallow_json, GROUP_CONCAT(ct.tag_id) AS tagIds
         FROM characters c LEFT JOIN character_tags ct ON ct.character_id = c.id
         GROUP BY c.id`,
    );

    const mismatched = [];
    for (const row of rows) {
        let shallow;
        try {
            shallow = JSON.parse(row.shallow_json);
        } catch {
            continue; // Unparseable shallow_json is a separate, pre-existing problem - not this pass's job.
        }
        const shallowSet = new Set(Array.isArray(shallow.tag_ids) ? shallow.tag_ids : []);
        const tableSet = new Set(row.tagIds ? row.tagIds.split(',') : []);
        const same = shallowSet.size === tableSet.size && [...shallowSet].every(id => tableSet.has(id));
        if (!same) mismatched.push(row.id);
    }

    if (!dryRun) {
        entry.db.transaction(() => {
            for (const id of mismatched) {
                syncShallowTagIdsFromTable(entry.db, id);
            }
        });
    }

    return { scanned: rows.length, mismatched };
}

// Accepts either shape a card may carry tags in: { data: { tags: [...] } } or a bare { tags: [...] }.
// Returns [] (never null/undefined) so callers can iterate unconditionally.
function extractCardTags(shallowJson) {
    let parsed;
    try {
        parsed = JSON.parse(shallowJson);
    } catch {
        return [];
    }
    if (!parsed || typeof parsed !== 'object') return [];
    if (parsed.data && typeof parsed.data === 'object' && Array.isArray(parsed.data.tags)) {
        return parsed.data.tags;
    }
    if (Array.isArray(parsed.tags)) {
        return parsed.tags;
    }
    return [];
}

// One-time backfill of character_tags from each card's already-parsed shallow_json.data.tags (no disk read
// needed). Gated by its own meta flag; INSERT OR IGNORE makes an interrupted-and-retried pass safe.
export async function backfillCardTagsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = entry.db.get('SELECT value FROM meta WHERE key = \'card_tags_backfill_completed\'');
    if (already) return;

    console.log(color.cyan('[character-metadata] Backfilling tag assignments from card-embedded tags...'));

    /** @type {Map<string, string>} */
    const tagNameToId = new Map();
    for (const row of entry.db.all('SELECT id, data FROM tags')) {
        try {
            const tag = JSON.parse(row.data);
            if (tag && typeof tag.name === 'string' && tag.name) {
                tagNameToId.set(tag.name.toLowerCase(), row.id);
            }
        } catch {
            // Malformed tag definition row - skip it, it can't be matched against by name anyway.
        }
    }

    const rows = entry.db.all('SELECT id, shallow_json FROM characters');

    const insertTag = (params) => entry.db.run('INSERT OR IGNORE INTO tags (id, data) VALUES (@id, @data)', params);
    const insertAssignment = (params) => entry.db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@characterId, @tagId)', params);

    // Computed as before/after deltas since INSERT OR IGNORE gives no per-call signal of whether a row was added.
    const tagDefinitionsBefore = tagNameToId.size;
    const assignmentsBefore = entry.db.get('SELECT COUNT(*) AS n FROM character_tags')?.n ?? 0;

    const backfillStart = Date.now();
    let lastProgressLog = backfillStart;
    let processedRows = 0;

    for (let i = 0; i < rows.length; i += BATCH_FLUSH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_FLUSH_SIZE);

        entry.db.transaction(() => {
            for (const row of chunk) {
                const cardTags = extractCardTags(row.shallow_json);
                if (cardTags.length === 0) continue;
                const tagIds = seedCardTagsForCharacter(entry.db, row.id, cardTags, tagNameToId, insertTag, insertAssignment);
                // Sync shallow_json.tag_ids here rather than relying on backfillTagIdsInShallowJson()'s separate
                // pass, which only targets rows missing a tag_ids key and would skip a row that already had one.
                if (tagIds.length > 0) {
                    syncShallowTagIdsFromTable(entry.db, row.id);
                }
            }
        });

        processedRows += chunk.length;

        const now = Date.now();
        if (now - lastProgressLog >= BOOTSTRAP_PROGRESS_LOG_INTERVAL_MS) {
            console.log(color.cyan(`[character-metadata] Card-tags backfill progress: ${processedRows}/${rows.length}`));
            lastProgressLog = now;
        }

        await new Promise(resolve => setImmediate(resolve));
    }

    updateTagsHashSync(entry.db);
    entry.db.run('INSERT INTO meta (key, value) VALUES (\'card_tags_backfill_completed\', \'1\') ON CONFLICT(key) DO UPDATE SET value = excluded.value');

    const newTagDefinitions = tagNameToId.size - tagDefinitionsBefore;
    const assignmentsAfter = entry.db.get('SELECT COUNT(*) AS n FROM character_tags')?.n ?? 0;
    const newAssignments = assignmentsAfter - assignmentsBefore;

    console.log(color.cyan(`[character-metadata] Card-tags backfill complete: ${newTagDefinitions} new tag definitions, ${newAssignments} new assignments.`));
}

// Builds entry's tag cache from a full table scan once, then reuses/mutates the same Maps for the process's life
// (previously re-scanned+re-parsed the whole tags table per character, causing OOM on large libraries).
/**
 * @param {MetadataDbEntry} entry
 * @returns {{ tagNameToId: Map<string, string>, tagIdToDefinition: Map<string, object> }}
 */
function getTagCache(entry) {
    if (entry.tagCache) return entry.tagCache;

    /** @type {Map<string, string>} */
    const tagNameToId = new Map();
    /** @type {Map<string, object>} */
    const tagIdToDefinition = new Map();
    for (const tagRow of entry.db.all('SELECT id, data FROM tags')) {
        try {
            const tag = JSON.parse(tagRow.data);
            if (tag && typeof tag.name === 'string' && tag.name) {
                tagNameToId.set(tag.name.toLowerCase(), tagRow.id);
                tagIdToDefinition.set(tagRow.id, tag);
            }
        } catch {
            // Malformed tag definition row - skip it.
        }
    }
    entry.tagCache = { tagNameToId, tagIdToDefinition };
    return entry.tagCache;
}

// Must check entry.batch.pending: a character imported inside a multi-file drop can still be buffered there
// rather than committed to the characters table when this runs.
/**
 * @param {{ onlyExisting?: boolean }} [options] onlyExisting resolves only tags matching an existing definition,
 * never minting a new one.
 * @returns {Promise<{ tagIds: string[], tagDefinitions: object[] }>} tagDefinitions is returned alongside tagIds
 * because the client can't resolve an id to a tag it has never seen a definition for.
 */
export async function seedCardTagsForSingleCharacter(directories, avatar, { onlyExisting = false } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return { tagIds: [], tagDefinitions: [] };

    const pending = entry.batch?.pending.get(avatar);
    const shallowJson = pending ? pending.row.shallow_json : entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: avatar })?.shallow_json;
    if (!shallowJson) return { tagIds: [], tagDefinitions: [] };

    const cardTags = extractCardTags(shallowJson);
    if (cardTags.length === 0) return { tagIds: [], tagDefinitions: [] };

    const { tagNameToId, tagIdToDefinition } = getTagCache(entry);

    // Tag *definitions* always go straight to the `tags` table, batch mode or not - only `characters`/
    // `character_tags` rows for a not-yet-flushed import are what batch mode buffers (see pending branch below).
    const tagDefinitionsBefore = tagNameToId.size;
    const insertTag = (params) => {
        entry.db.run('INSERT OR IGNORE INTO tags (id, data) VALUES (@id, @data)', params);
        tagIdToDefinition.set(params.id, JSON.parse(params.data));
    };
    const tagIds = resolveCardTagIds(cardTags, tagNameToId, insertTag, { onlyExisting });
    if (tagIds.length === 0) return { tagIds: [], tagDefinitions: [] };

    const tagDefinitions = tagIds.map(id => tagIdToDefinition.get(id)).filter(Boolean);

    // Only rehash when a new tag definition was actually minted; a pure re-assignment doesn't change tags_hash.
    if (tagNameToId.size > tagDefinitionsBefore) {
        updateTagsHashSync(entry.db);
    }

    if (pending) {
        // Row doesn't exist in `characters` yet for a not-yet-flushed pending write, so patch the buffer instead.
        for (const tagId of tagIds) {
            if (!pending.tagIds.includes(tagId)) pending.tagIds.push(tagId);
        }
        patchPendingRowTagIds(pending);
        return { tagIds, tagDefinitions };
    }

    entry.db.transaction(() => {
        for (const tagId of tagIds) {
            entry.db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@characterId, @tagId)', { characterId: avatar, tagId });
        }
        syncShallowTagIdsFromTable(entry.db, avatar);
    });

    return { tagIds, tagDefinitions };
}

// Full {[id]: tagId[]} export of every character's/group's tag assignments. Not called anywhere in the live
// app currently; kept as a general export primitive symmetric with restoreTagMap() below.
/**
 * @returns {Promise<Record<string, string[]> | null>} `null` if the metadata store is unavailable.
 */
export async function getFullTagMapExport(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    // GROUP_CONCAT'd in SQL rather than pushed onto a JS array per (id, tag_id) pair - avoids millions of
    // individual array pushes on a large library. \x1f (unit separator) instead of comma to avoid any collision
    // with a tag_id, even though tag ids are UUIDs in practice.
    const SEP = '\x1f';
    /** @type {Record<string, string[]>} */
    const result = {};
    for (const row of entry.db.all(`SELECT character_id as id, group_concat(tag_id, '${SEP}') as tags FROM character_tags GROUP BY character_id`)) {
        result[row.id] = row.tags.split(SEP);
    }
    for (const row of entry.db.all(`SELECT group_id as id, group_concat(tag_id, '${SEP}') as tags FROM group_tags GROUP BY group_id`)) {
        result[row.id] = row.tags.split(SEP);
    }
    return result;
}

// Inverse of getFullTagMapExport(); additive (OR IGNORE), not a replace-everything. Not called anywhere in
// the live app currently; kept as a general import primitive.
/**
 * @returns {Promise<string[] | null>} Dropped keys (matched neither a known character nor group), or `null` if
 * the metadata store is unavailable.
 */
export async function restoreTagMap(directories, tagMap) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    return importTagMapSync(entry, tagMap && typeof tagMap === 'object' ? tagMap : {});
}

// Columns queryCharacters() may sort by via a plain `ORDER BY <column>`. Deliberately excludes 'random'
// (sorts by RANDHASH(id, seed), not a column) and 'search' (relevance order supplied by the caller as idOrder).
const QUERYABLE_SORT_COLUMNS = {
    name: 'name_fold',
    date_added: 'date_added',
    date_last_chat: 'date_last_chat',
    chat_size: 'chat_size',
    fav: 'fav',
    // Sorts numerically as epoch ms - TEXT-collated until migrateCreateDateColumn() fixed the column type.
    create_date: 'create_date',
    data_size: 'data_size',
};

// `ids: []` is handled specially by the caller (queryCharacters()): "match zero ids" is different from "no id
// filter requested". This function only ever sees a non-empty `ids` array, or none.
function buildWhereClause({ tags, fav, world, excludeIds, ids } = {}) {
    const clauses = [];
    const args = [];

    if (Array.isArray(ids) && ids.length > 0) {
        clauses.push('id IN (SELECT value FROM json_each(?))');
        args.push(JSON.stringify(ids));
    }
    if (Array.isArray(excludeIds) && excludeIds.length > 0) {
        clauses.push('id NOT IN (SELECT value FROM json_each(?))');
        args.push(JSON.stringify(excludeIds));
    }
    if (typeof fav === 'boolean') {
        clauses.push('fav = ?');
        args.push(fav ? 1 : 0);
    }
    if (typeof world === 'string' && world) {
        clauses.push('world = ?');
        args.push(world);
    }
    if (tags) {
        const include = Array.isArray(tags.include) ? tags.include.filter(Boolean) : [];
        const exclude = Array.isArray(tags.exclude) ? tags.exclude.filter(Boolean) : [];
        const mode = tags.mode === 'or' ? 'or' : 'and';
        if (include.length > 0) {
            if (mode === 'and') {
                clauses.push(`id IN (SELECT character_id FROM character_tags WHERE tag_id IN (${include.map(() => '?').join(', ')}) GROUP BY character_id HAVING COUNT(DISTINCT tag_id) = ?)`);
                args.push(...include, include.length);
            } else {
                clauses.push(`id IN (SELECT character_id FROM character_tags WHERE tag_id IN (${include.map(() => '?').join(', ')}))`);
                args.push(...include);
            }
        }
        if (exclude.length > 0) {
            clauses.push(`id NOT IN (SELECT character_id FROM character_tags WHERE tag_id IN (${exclude.map(() => '?').join(', ')}))`);
            args.push(...exclude);
        }
    }

    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

/**
 * Indexed lookup, not a filesystem scan.
 * @returns {Promise<Array<{id: string, world: string}>|null>} `null` if the metadata store is unavailable.
 */
export async function getCharactersWithLinkedWorld(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    return entry.db.all("SELECT id, world FROM characters WHERE world IS NOT NULL AND world != ''");
}

// A boot-time migration reading this store must check this first - bootstrapIfNeeded() runs in the
// background and isn't awaited, so an early query could see a partially-backfilled table.
export async function isBootstrapComplete(directories) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return !!entry.db.get('SELECT value FROM meta WHERE key = @key', { key: 'bootstrap_completed' });
}

/** Generic one-time-per-user completion marker, keyed by the caller's own namespaced `key`. */
export async function isMigrationMarkedComplete(directories, key) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return !!entry.db.get('SELECT value FROM meta WHERE key = @key', { key });
}

export async function markMigrationComplete(directories, key) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key, value: String(Date.now()) });
}

/**
 * Browse/sort/filter query backing `POST /api/characters/query`, entirely SQLite-backed.
 * @param {object} params
 * @param {string[]} [params.ids] Present-but-empty short-circuits to an empty result.
 * @param {string} [params.sortField] A QUERYABLE_SORT_COLUMNS key, or 'random' (needs `seed`), or 'search'
 * (needs `idOrder`).
 * @param {number} [params.seed] Must stay stable across pages of the same query or pages return inconsistent
 * permutations.
 * @param {string[]} [params.idOrder] Relevance-ordered id list from the search engine when sortField === 'search'.
 * @param {boolean} [params.wantHashes] Returns `hashRows` (per-row content hashes) instead of `rows`, computed
 * live from shallow_json rather than the stored digest_* columns, which can drift from a fresh recompute.
 * @returns {Promise<{ rows: object[] | undefined, hashRows: object[] | undefined, total: number | undefined, seq: number } | null>}
 * `null` means the metadata store is unavailable - callers must not fall back to a live filesystem scan.
 */
export async function queryCharacters(directories, params = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const {
        tags, fav, world, excludeIds, ids,
        sortField, sortOrder, seed, idOrder,
        offset, limit,
        wantRows = true, wantTotal = true,
        wantHashes = false,
    } = params;

    const seqRow = entry.db.get('SELECT COALESCE(MAX(seq), 0) as seq FROM changes');
    const seq = Number(seqRow?.seq ?? 0);

    if (Array.isArray(ids) && ids.length === 0) {
        return { rows: wantRows ? [] : undefined, hashRows: wantHashes ? [] : undefined, total: wantTotal ? 0 : undefined, seq };
    }

    const { where, args } = buildWhereClause({ tags, fav, world, excludeIds, ids });

    let total;
    if (wantTotal) {
        const countRow = entry.db.get(`SELECT COUNT(*) as total FROM characters ${where}`, args);
        total = Number(countRow?.total ?? 0);
    }

    // digest_fav/digest_tag_ids/digest_content are deliberately not read here: spot checks found stored values
    // that disagree with a fresh recompute from the row's own shallow_json, with no version column to detect
    // the drift. Always recompute live instead.
    const HASH_COLUMNS = 'id, active_chat, date_added, create_date, date_last_chat, chat_size, data_size, shallow_json';
    const toHashRow = (r) => {
        const shallow = JSON.parse(r.shallow_json);
        const favHash = characterDigestFavHash(shallow) % 4294967296;
        const tagIdsHash = characterDigestTagIdsHash(shallow);
        const contentHash = characterDigestFieldsHash(shallow) % 4294967296;
        return {
            id: r.id,
            chat: r.active_chat,
            date_added: r.date_added,
            create_date: r.create_date,
            date_last_chat: r.date_last_chat,
            chat_size: r.chat_size,
            data_size: r.data_size,
            favHash: favHash >>> 0,
            tagIdsHash: tagIdsHash >>> 0,
            contentHash: contentHash >>> 0,
        };
    };

    let rows, hashRows;
    if ((wantRows || wantHashes) && sortField === 'search') {
        const orderedIds = Array.isArray(idOrder) ? idOrder : [];
        const numericOffset = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
        const numericLimit = Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : DEFAULT_QUERY_LIMIT;
        if (wantHashes) {
            const rawRows = entry.db.all(`SELECT ${HASH_COLUMNS} FROM characters ${where}`, args);
            const rowById = new Map(rawRows.map(r => [r.id, r]));
            hashRows = orderedIds
                .filter(id => rowById.has(id))
                .slice(numericOffset, numericOffset + numericLimit)
                .map(id => toHashRow(rowById.get(id)));
        } else {
            const rawRows = entry.db.all(`SELECT id, shallow_json FROM characters ${where}`, args);
            const shallowById = new Map(rawRows.map(r => [r.id, r.shallow_json]));
            rows = orderedIds
                .filter(id => shallowById.has(id))
                .slice(numericOffset, numericOffset + numericLimit)
                .map(id => JSON.parse(shallowById.get(id)));
        }
    } else if (wantRows || wantHashes) {
        const orderParts = [];
        if (sortField === 'random') {
            const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
            orderParts.push(`RANDHASH(id, ?) ${direction}`);
        } else {
            const column = QUERYABLE_SORT_COLUMNS[sortField];
            const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
            if (column) {
                orderParts.push(`${column} ${direction}`);
                // fav is boolean-valued, so many rows tie on it; name_fold breaks the tie (idx_characters_fav_name_fold).
                if (sortField === 'fav') {
                    orderParts.push('name_fold ASC');
                }
            }
        }
        // Final tie-break by unique id, or ties get inconsistent order across separate paged queries.
        orderParts.push('id ASC');
        const orderBy = `ORDER BY ${orderParts.join(', ')}`;

        const numericOffset = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
        const numericLimit = Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : DEFAULT_QUERY_LIMIT;

        // The RANDHASH(id, ?) placeholder above (when present) is the first `?` after the WHERE clause's own
        // args, so its bind value goes right after `args` and before the LIMIT/OFFSET pair - SQLite binds `?`
        // placeholders strictly in the order they appear in the SQL text.
        const orderArgs = sortField === 'random' ? [Number(seed) || 0] : [];
        if (wantHashes) {
            const rawRows = entry.db.all(`SELECT ${HASH_COLUMNS} FROM characters ${where} ${orderBy} LIMIT ? OFFSET ?`, [...args, ...orderArgs, numericLimit, numericOffset]);
            hashRows = rawRows.map(toHashRow);
        } else {
            const rawRows = entry.db.all(`SELECT shallow_json FROM characters ${where} ${orderBy} LIMIT ? OFFSET ?`, [...args, ...orderArgs, numericLimit, numericOffset]);
            rows = rawRows.map(r => JSON.parse(r.shallow_json));
        }
    }

    return { rows, hashRows, total, seq };
}

// Mirrors characters.js's own DEFAULT_PAGE_LIMIT - a caller genuinely omitting `limit` (rather than the /query
// route, which always computes one from page/pageSize) still gets a bounded result instead of the entire table.
const DEFAULT_QUERY_LIMIT = 500;

// Groups-side WHERE clause; unlike buildWhereClause() it has no `world` filter (groups have no lorebook binding,
// so filter.world never narrows the groups arm of a merged query) and no `search` filter (the /query route
// already resolves filter.search into a plain ids list before calling queryEntities()).
/**
 * @param {object} filter
 * @param {{ include?: string[], exclude?: string[], mode?: 'and'|'or' }} [filter.tags]
 * @param {boolean} [filter.fav]
 * @param {string[]} [filter.excludeIds]
 * @param {string[]} [filter.ids]
 * @returns {{ where: string, args: any[] }}
 */
function buildGroupWhereClause({ tags, fav, excludeIds, ids } = {}) {
    const clauses = [];
    const args = [];

    if (Array.isArray(ids) && ids.length > 0) {
        clauses.push('id IN (SELECT value FROM json_each(?))');
        args.push(JSON.stringify(ids));
    }
    if (Array.isArray(excludeIds) && excludeIds.length > 0) {
        clauses.push('id NOT IN (SELECT value FROM json_each(?))');
        args.push(JSON.stringify(excludeIds));
    }
    if (typeof fav === 'boolean') {
        clauses.push('fav = ?');
        args.push(fav ? 1 : 0);
    }
    if (tags) {
        const include = Array.isArray(tags.include) ? tags.include.filter(Boolean) : [];
        const exclude = Array.isArray(tags.exclude) ? tags.exclude.filter(Boolean) : [];
        const mode = tags.mode === 'or' ? 'or' : 'and';
        if (include.length > 0) {
            if (mode === 'and') {
                clauses.push(`id IN (SELECT group_id FROM group_tags WHERE tag_id IN (${include.map(() => '?').join(', ')}) GROUP BY group_id HAVING COUNT(DISTINCT tag_id) = ?)`);
                args.push(...include, include.length);
            } else {
                clauses.push(`id IN (SELECT group_id FROM group_tags WHERE tag_id IN (${include.map(() => '?').join(', ')}))`);
                args.push(...include);
            }
        }
        if (exclude.length > 0) {
            clauses.push(`id NOT IN (SELECT group_id FROM group_tags WHERE tag_id IN (${exclude.map(() => '?').join(', ')}))`);
            args.push(...exclude);
        }
    }

    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

/**
 * `filter.includeGroups: true` half of `POST /api/characters/query` - queries characters and groups as two
 * separate per-table queries with a JS merge-sort (see mergeSortedRows()), not a UNION ALL, so each table keeps
 * its own index-backed ORDER BY.
 * @param {string} [params.world] Applies to the characters arm only - see buildGroupWhereClause()'s doc comment.
 * @param {string[]} [params.ids] Present-but-empty means "resolve nothing" - same rule as queryCharacters().
 * @param {string} [params.sortField] One of QUERYABLE_SORT_COLUMNS' keys, or 'random'. Never 'search'.
 * @returns {Promise<{ rows: {type: 'character'|'group', id: string, fav: boolean, date_added: number, date_last_chat: number, chat_size: number, item: object}[] | undefined, total: number | undefined, seq: number } | null>}
 * A group row's `item` is `null` here - the caller hydrates it; a character row's `item` is the full toShallow().
 */

/** Hash-sorted array of all entity IDs, cached per (handle, seed, seq). */
function getRandomSortedEntityIds(db, handle, seed, seq) {
    const key = `${handle}:${seed}`;
    const entry = randomSortCache.get(key);
    if (entry && entry.seq === seq) {
        randomSortCache.delete(key);
        randomSortCache.set(key, entry);
        return entry.sortedIds;
    }

    const charIds = db.all('SELECT id FROM characters').map(r => r.id);
    const groupIds = db.all('SELECT id FROM groups').map(r => r.id);
    const allIds = [...charIds, ...groupIds];
    const hashed = allIds.map(id => ({ id, h: getStringHash(String(id), Number(seed)) }));
    hashed.sort((a, b) => a.h - b.h);
    const sortedIds = hashed.map(r => r.id);

    if (randomSortCache.size >= MAX_RANDOM_CACHE_ENTRIES && !randomSortCache.has(key)) {
        const oldest = randomSortCache.keys().next().value;
        randomSortCache.delete(oldest);
    }

    randomSortCache.set(key, { seq, sortedIds, db });
    return sortedIds;
}

/** Must match the ORDER BY each side's own SQL query used, so the merge stays a true sorted merge. */
function makeEntityMergeComparator(sortField, sortOrder, seed) {
    const dir = sortOrder === 'desc' ? -1 : 1;
    const tiebreak = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

    if (sortField === 'random') {
        return (a, b) => {
            const ha = getStringHash(String(a.id ?? ''), Number(seed ?? 0));
            const hb = getStringHash(String(b.id ?? ''), Number(seed ?? 0));
            return dir * (ha - hb) || tiebreak(a, b);
        };
    }

    const column = QUERYABLE_SORT_COLUMNS[sortField];
    if (!column) return tiebreak;

    if (column === 'name_fold') {
        return (a, b) => dir * (a.name_fold < b.name_fold ? -1 : a.name_fold > b.name_fold ? 1 : 0) || tiebreak(a, b);
    }
    if (column === 'fav') {
        // Matches the SQL side's extra `name_fold ASC` tiebreak pushed right after `fav` in orderParts.
        return (a, b) => dir * ((a.fav ? 1 : 0) - (b.fav ? 1 : 0))
            || (a.name_fold < b.name_fold ? -1 : a.name_fold > b.name_fold ? 1 : 0)
            || tiebreak(a, b);
    }
    // Remaining columns (date_added, date_last_chat, chat_size, create_date, data_size) are all plain numeric.
    return (a, b) => dir * (Number(a[column] ?? 0) - Number(b[column] ?? 0)) || tiebreak(a, b);
}

// Avoids UNION ALL across characters/groups, which would defeat each table's own index-backed ORDER BY.
function mergeSortedRows(a, b, comparator) {
    const result = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        if (comparator(a[i], b[j]) <= 0) result.push(a[i++]);
        else result.push(b[j++]);
    }
    while (i < a.length) result.push(a[i++]);
    while (j < b.length) result.push(b[j++]);
    return result;
}

export async function queryEntities(directories, params = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const {
        tags, fav, world, excludeIds, ids,
        sortField, sortOrder, seed,
        offset, limit, handle,
        wantRows = true, wantTotal = true,
        wantHashes = false,
    } = params;

    const seqRow = entry.db.get('SELECT COALESCE(MAX(seq), 0) as seq FROM changes');
    const seq = Number(seqRow?.seq ?? 0);

    if (Array.isArray(ids) && ids.length === 0) {
        return { rows: wantRows ? [] : undefined, hashRows: wantHashes ? [] : undefined, total: wantTotal ? 0 : undefined, seq };
    }

    const charWhere = buildWhereClause({ tags, fav, world, excludeIds, ids });
    const groupWhere = buildGroupWhereClause({ tags, fav, excludeIds, ids });

    let total;
    if (wantTotal) {
        const countRow = entry.db.get(
            `SELECT COUNT(*) as total FROM (
                SELECT id FROM characters ${charWhere.where}
                UNION ALL
                SELECT id FROM groups ${groupWhere.where}
            )`,
            [...charWhere.args, ...groupWhere.args],
        );
        total = Number(countRow?.total ?? 0);
    }

    // Group rows trust their stored digest_* columns when non-NULL; a NULL digest falls back to a live recompute.
    const groupIdsNeedingFileFallback = new Set();
    const toHashRow = (r) => {
        let favHash, tagIdsHash, contentHash, chat = null;
        if (r.type === 'character') {
            const shallow = JSON.parse(r.shallow_json);
            favHash = characterDigestFavHash(shallow) % 4294967296;
            tagIdsHash = characterDigestTagIdsHash(shallow);
            contentHash = characterDigestFieldsHash(shallow) % 4294967296;
            chat = shallow.chat ?? null;
        } else if (r.digest_fav != null && r.digest_tag_ids != null && r.digest_content != null) {
            favHash = r.digest_fav;
            tagIdsHash = r.digest_tag_ids;
            contentHash = r.digest_content;
        } else {
            // Can't import groups.js's getGroupsByIds() here (import-direction rule), so re-read the file directly.
            groupIdsNeedingFileFallback.add(r.id);
            favHash = tagIdsHash = contentHash = 0; // corrected in the fallback pass below
        }
        return {
            id: r.id, isGroup: r.type === 'group', chat,
            date_added: Number(r.date_added), create_date: r.create_date === null || r.create_date === undefined ? null : Number(r.create_date),
            date_last_chat: Number(r.date_last_chat), chat_size: Number(r.chat_size),
            data_size: r.data_size === null || r.data_size === undefined ? 0 : Number(r.data_size),
            favHash: favHash >>> 0, tagIdsHash: tagIdsHash >>> 0, contentHash: contentHash >>> 0,
        };
    };
    /** Resolves the placeholder hashes toHashRow() left for NULL-digest group rows, in place. */
    const resolveFileFallbackHashes = (hashRowList) => {
        if (groupIdsNeedingFileFallback.size === 0) return;
        for (const hr of hashRowList) {
            if (!hr.isGroup || !groupIdsNeedingFileFallback.has(hr.id)) continue;
            try {
                const filePath = path.join(directories.groups, sanitize(`${hr.id}.json`));
                const group = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const tagIds = entry.db.all('SELECT tag_id FROM group_tags WHERE group_id = @id', { id: hr.id }).map(r => r.tag_id);
                const fingerprintSource = { ...group, tag_ids: tagIds };
                hr.favHash = groupDigestFavHash(fingerprintSource) >>> 0;
                hr.tagIdsHash = groupDigestTagIdsHash(fingerprintSource) >>> 0;
                hr.contentHash = groupDigestContentHash(fingerprintSource) >>> 0;
            } catch (err) {
                console.error(`[character-metadata] queryEntities() hash-mode file fallback failed for group ${hr.id}, shipping a zero hash (forces the client to always treat this row as stale):`, err.message);
            }
        }
    };

    let rows, hashRows;
    if (wantRows || wantHashes) {
        const orderParts = [];
        if (sortField === 'random') {
            const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
            orderParts.push(`RANDHASH(id, ?) ${direction}`);
        } else {
            const column = QUERYABLE_SORT_COLUMNS[sortField];
            const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
            if (column) {
                orderParts.push(`${column} ${direction}`);
                if (sortField === 'fav') {
                    orderParts.push('name_fold ASC');
                }
            }
        }
        orderParts.push('id ASC');
        const orderBy = `ORDER BY ${orderParts.join(', ')}`;

        const numericOffset = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
        const numericLimit = Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : DEFAULT_QUERY_LIMIT;
        const orderArgs = sortField === 'random' ? [Number(seed) || 0] : [];

        // Two separate per-table queries + a JS merge-sort instead of UNION ALL: a UNION ALL prevented SQLite
        // from using either table's index (full scan + temp B-tree sort).
        const fetchLimit = numericOffset + numericLimit;

        if (sortField === 'random') {
            const sortedAllIds = getRandomSortedEntityIds(entry.db, handle ?? '', Number(seed) || 0, seq);

            const hasFilters = charWhere.where !== '' || groupWhere.where !== '';
            const filterSet = hasFilters ? new Set([
                ...entry.db.all(`SELECT id FROM characters ${charWhere.where}`, charWhere.args).map(r => r.id),
                ...entry.db.all(`SELECT id FROM groups ${groupWhere.where}`, groupWhere.args).map(r => r.id),
            ]) : null;

            const descending = sortOrder === 'desc';
            const len = sortedAllIds.length;
            const pageIds = [];
            let skipped = 0;
            for (let i = 0; i < len; i++) {
                const id = sortedAllIds[descending ? len - 1 - i : i];
                if (filterSet && !filterSet.has(id)) continue;
                if (skipped < numericOffset) { skipped++; continue; }
                pageIds.push(id);
                if (pageIds.length >= numericLimit) break;
            }

            if (pageIds.length === 0) {
                rows = wantRows ? [] : undefined;
                hashRows = wantHashes ? [] : undefined;
            } else {
                const pageIdsJson = JSON.stringify(pageIds);
                const charPageRows = entry.db.all(
                    `SELECT id, 'character' as type, name_fold, fav, date_added, date_last_chat, chat_size, create_date, data_size, shallow_json
                    FROM characters WHERE id IN (SELECT value FROM json_each(?))`,
                    [pageIdsJson],
                );
                const groupPageRows = entry.db.all(
                    `SELECT id, 'group' as type, name_fold, fav, date_added, date_last_chat, chat_size, date_added as create_date, NULL as data_size, NULL as shallow_json, digest_fav, digest_tag_ids, digest_content
                    FROM groups WHERE id IN (SELECT value FROM json_each(?))`,
                    [pageIdsJson],
                );
                const rowById = new Map([...charPageRows, ...groupPageRows].map(r => [r.id, r]));
                const rawRows = pageIds.map(id => rowById.get(id)).filter(Boolean);
                if (wantHashes) {
                    hashRows = rawRows.map(toHashRow);
                    resolveFileFallbackHashes(hashRows);
                } else {
                    rows = rawRows.map(r => ({
                        type: r.type,
                        id: r.id,
                        fav: !!r.fav,
                        date_added: Number(r.date_added),
                        date_last_chat: Number(r.date_last_chat),
                        chat_size: Number(r.chat_size),
                        item: r.type === 'character' ? JSON.parse(r.shallow_json) : null,
                    }));
                }
            }
        } else {
            // create_date: a group's own date_added stands in, projected as create_date, so it interleaves
            // correctly with characters instead of parking every group at one end of the sort (NULL would).
            //
            // data_size: no equivalent for groups, stays NULL on the group side - every group sorts equal on
            // that key and falls through to the tiebreaker.
            const groupOrderBy = orderBy
                .replace(/\bcreate_date\b/g, 'date_added');

            const charArgs = [...charWhere.args, ...orderArgs, fetchLimit];
            const charRawRows = entry.db.all(
                `SELECT id, 'character' as type, name_fold, fav, date_added, date_last_chat, chat_size, create_date, data_size, shallow_json
                FROM characters ${charWhere.where}
                ${orderBy}
                LIMIT ?`,
                charArgs,
            );

            const groupArgs = [...groupWhere.args, ...orderArgs, fetchLimit];
            const groupRawRows = entry.db.all(
                `SELECT id, 'group' as type, name_fold, fav, date_added, date_last_chat, chat_size, date_added as create_date, NULL as data_size, NULL as shallow_json, digest_fav, digest_tag_ids, digest_content
                FROM groups ${groupWhere.where}
                ${groupOrderBy}
                LIMIT ?`,
                groupArgs,
            );

            const comparator = makeEntityMergeComparator(sortField, sortOrder, seed);
            const merged = mergeSortedRows(charRawRows, groupRawRows, comparator);
            const rawRows = merged.slice(numericOffset, numericOffset + numericLimit);

            if (wantHashes) {
                hashRows = rawRows.map(toHashRow);
                resolveFileFallbackHashes(hashRows);
            } else {
                rows = rawRows.map(r => ({
                    type: r.type,
                    id: r.id,
                    fav: !!r.fav,
                    date_added: Number(r.date_added),
                    date_last_chat: Number(r.date_last_chat),
                    chat_size: Number(r.chat_size),
                    item: r.type === 'character' ? JSON.parse(r.shallow_json) : null,
                }));
            }
        }
    }

    return { rows, hashRows, total, seq };
}

/**
 * Every requested id is a key in the returned object - `true`/`false`, never absent - so callers never have to
 * distinguish "false" from "key missing".
 * @returns {Promise<Record<string, boolean> | null>} `null` if the metadata store is unavailable.
 */
export async function checkCharactersExist(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    /** @type {Record<string, boolean>} */
    const result = {};
    for (const id of ids) {
        result[id] = false;
    }

    // Chunked to stay clear of SQLite's bound-parameter ceiling (SQLITE_MAX_VARIABLE_NUMBER).
    for (let i = 0; i < ids.length; i += BATCH_FLUSH_SIZE) {
        const chunk = ids.slice(i, i + BATCH_FLUSH_SIZE).filter(id => typeof id === 'string' && id.length > 0);
        if (chunk.length === 0) continue;
        const rows = entry.db.all(`SELECT id FROM characters WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk);
        for (const row of rows) {
            result[row.id] = true;
        }
    }

    return result;
}

/** @returns {Promise<number | null>} The change log's current high-water mark, or `null` if unavailable. */
export async function getCurrentSeq(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = entry.db.get('SELECT COALESCE(MAX(seq), 0) as seq FROM changes');
    return Number(row?.seq ?? 0);
}

/**
 * @returns {Promise<{ seq: number, changes: { id: string, op: 'upsert'|'delete', fields?: string[]|null }[], truncated: boolean } | null>}
 * `truncated: true` means `sinceSeq` predates the oldest change-log row still kept (the log is never pruned
 * today, so this can currently only trigger for a `sinceSeq` from a different store).
 */
export async function getChangesSince(directories, sinceSeq) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const numericSince = Number.isFinite(sinceSeq) && sinceSeq >= 0 ? Math.trunc(sinceSeq) : 0;
    const bounds = entry.db.get('SELECT MIN(seq) as minSeq, MAX(seq) as maxSeq FROM changes');
    const minSeq = bounds?.minSeq != null ? Number(bounds.minSeq) : undefined;
    const maxSeq = bounds?.maxSeq != null ? Number(bounds.maxSeq) : 0;

    const truncated = minSeq !== undefined && numericSince < minSeq - 1;
    if (truncated) {
        return { seq: maxSeq, changes: [], truncated: true };
    }

    const rawChanges = entry.db.all('SELECT seq, id, op, fields FROM changes WHERE seq > ? ORDER BY seq ASC', [numericSince]);
    // Collapse to one entry per id: a delete anywhere in the window forces a full refetch even if the id
    // is later re-created, since the client's cached copy predates the delete.
    /** @type {Map<string, { op: string, hasDelete: boolean, hasNullFields: boolean, fieldSet: Set<string> }>} */
    const collapsedById = new Map();
    for (const row of rawChanges) {
        let agg = collapsedById.get(row.id);
        if (!agg) {
            agg = { op: row.op, hasDelete: false, hasNullFields: false, fieldSet: new Set() };
            collapsedById.set(row.id, agg);
        }
        agg.op = row.op; // latest wins
        if (row.op === 'delete') {
            agg.hasDelete = true;
        } else {
            if (row.fields === null) {
                agg.hasNullFields = true;
            } else {
                try {
                    const parsed = JSON.parse(row.fields);
                    if (Array.isArray(parsed)) {
                        for (const f of parsed) agg.fieldSet.add(f);
                    }
                } catch {
                    agg.hasNullFields = true; // unparseable fields treated as whole-record
                }
            }
        }
    }
    const changes = [...collapsedById.entries()].map(([id, { op, hasDelete, hasNullFields, fieldSet }]) => {
        if (op === 'delete') return { id, op };
        const fields = (hasDelete || hasNullFields) ? null : [...fieldSet];
        return { id, op, fields };
    });

    return { seq: maxSeq, changes, truncated: false };
}

/**
 * Superseded by treeDescend() below; kept but no longer wired into any endpoint or client.
 * Runs on character-metadata-digest-worker.js, not inline, since a full-table scan measured ~2.2s of
 * synchronous JS that would otherwise stall every other request this process is serving.
 * @returns {Promise<{ favBuckets: { hi: number, lo: number }[], contentBuckets: { hi: number, lo: number }[] } | null>}
 * Two parallel bucket-digest streams so a client can tell a fav-only mismatch from a content mismatch.
 */
export async function getStateDigest(directories, bucketCount = DEFAULT_DIGEST_BUCKET_COUNT) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    return runDigestWorkerTask({ type: 'state-digest', dbPath: getDbPath(directories), bucketCount });
}

/**
 * Superseded by treeDescend() below; kept but no longer wired into any endpoint or client.
 * Repair half of getStateDigest(): returns the members of one diverged bucket so a client can find exactly
 * which ids differ without re-fetching the whole library.
 * @returns {Promise<{ members: { id: string, favHash: number, fieldsHash: number, fav: boolean }[] } | null>}
 */
export async function getBucketMembers(directories, bucket, bucketCount = DEFAULT_DIGEST_BUCKET_COUNT) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    return runDigestWorkerTask({ type: 'bucket-members', dbPath: getDbPath(directories), bucket, bucketCount });
}

/**
 * POST /api/characters/tree-descend: recursive hash-tree descent. Given tree-node paths to expand, scans the
 * characters table and for each node returns either children hashes (if the subtree is larger than
 * leafThreshold) or leaf member data with fingerprint values (if small enough to resolve directly).
 * Stateless - each call is independent, no caching between requests.
 */
export async function treeDescend(directories, nodes, branching = DEFAULT_DIGEST_BUCKET_COUNT, leafThreshold = DEFAULT_DIGEST_BUCKET_COUNT) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    return runDigestWorkerTask({ type: 'tree-descend', dbPath: getDbPath(directories), nodes, branching, leafThreshold });
}

/**
 * Global 128-bit XOR-fold digest of the characters table - same value as folding all level-0 children from a
 * root tree-descend call, computed in one pass without bucketing.
 * @returns {Promise<{a: number, b: number, c: number, d: number} | null>}
 */
export async function computeRootDigest(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const result = await runDigestWorkerTask({ type: 'root-digest', dbPath: getDbPath(directories) });
    return result?.digest ?? null;
}

/**
 * Repair half of tree-descend(): resolves fingerprint field values for ids the client has already narrowed
 * drift down to, reading from `shallow_json` (no PNG disk reads).
 * @returns {Promise<{ records: { id: string, fingerprint: object }[] } | null>}
 */
export async function resolveFingerprints(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    return runDigestWorkerTask({ type: 'resolve-fingerprints', dbPath: getDbPath(directories), ids });
}
