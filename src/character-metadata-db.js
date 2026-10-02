import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';

import _ from 'lodash';
import sanitize from 'sanitize-filename';

import { color, delay, generateTimestamp, getConfigValue, mapWithConcurrency, parseCreateDateToEpochMs } from './util.js';
import { ProgressLog } from './progress-log.js';
import { changedValues, writeRowIfChanged } from './row-values.js';
import extract from 'png-chunks-extract';
import { parse as parseCharacterCard, read as readCharacterCardFromBuffer, readCharaChunkPristineFromChunks, computeAvatarIdentityHashFromChunks } from './character-card-parser.js';
import { getCharaCardV2, computeContentIdentityHash } from './character-card-normalize.js';
import { calculateDataSize, toShallow } from './character-shallow.js';
import { readTagsData } from './endpoints/tags-data.js';
import { getSqliteEngine, isBusyError, openNativeDatabase, streamRows } from './endpoints/sqlite-engine.js';
import { getBetterSqlite3 } from './endpoints/native-sqlite.js';
import { isReadOnlyMode } from './read-only-mode.js';
import { TAGS_FILE } from './constants.js';
import { legacySettingsPath, settingsDirPath } from './settings-store.js';
import { normalizeGroupRecord, tagEntityTypeOf } from './group-id.js';
import { expandTagFilter, resolveTagId, resolveTagIds, NO_TAG_DELETIONS } from './tag-deletions.js';
import { SEARCH_WORK_CAP, SEARCH_WALK_WINDOW } from './endpoints/search-walk.js';
import { orderKey, permute, unpermute } from './random-order.js';
import { characterAvatarsForOwnerId, characterOwnerIdOf, dropOwnerCreatedAtIndex, fillMessageStats, listOwnersWithoutKind, openOwnerStatsView, recordOwnerKinds } from './message-tree-db.js';
// getStringHash must match public/scripts/random-sort.js's compareByRandomSeed() exactly, or server/client random-sort ordering diverges.
import { getStringHash, characterDigestFavHash, characterDigestFieldsHash, characterDigestTagIdsHash, groupDigestFavHash, groupDigestTagIdsHash, groupDigestContentHash, normalizeFav, normalizeTagIds, tagNameKey } from '../public/scripts/hash-utils.js';

export const characterChangeEmitter = new EventEmitter();

// Bounds memory growth from seed churn.
const MAX_RANDOM_CACHE_ENTRIES = 10;
/**
 * Keyed on both the change log's seq and the groups version (readGroupsVersionSync()), since the ids include every
 * group's.
 * @type {Map<string, { seq: number, groupsVersion: number, sortedIds: string[], db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle }>}
 */
const randomSortCache = new Map();

/** @type {NodeJS.Timeout | undefined} */
let randomCacheWarmTimer = undefined;

// Debounced so a batch of rapid changes triggers only one recomputation.
characterChangeEmitter.on('change', () => {
    clearTimeout(randomCacheWarmTimer);
    randomCacheWarmTimer = setTimeout(() => {
        for (const [key, entry] of randomSortCache) {
            const seqRow = (/** @type {{ seq: number } | undefined} */ (entry.db.get('SELECT COALESCE(MAX(seq), 0) as seq FROM changes')));
            const currentSeq = Number(seqRow?.seq ?? 0);
            const currentGroupsVersion = readGroupsVersionSync(entry.db);
            if (currentGroupsVersion === null) {
                // Nothing to key a rebuilt entry on; getRandomSortedEntityIds() never serves one without it.
                randomSortCache.delete(key);
                continue;
            }
            if (entry.seq !== currentSeq || entry.groupsVersion !== currentGroupsVersion) {
                const colonIdx = key.lastIndexOf(':');
                const seed = Number(key.slice(colonIdx + 1));
                const charIds = (/** @type {{ id: string }[]} */ (entry.db.all('SELECT id FROM characters'))).map(r => r.id);
                const groupIds = (/** @type {{ id: string }[]} */ (entry.db.all('SELECT id FROM groups'))).map(r => r.id);
                const allIds = [...charIds, ...groupIds];
                const hashed = allIds.map(id => ({ id, h: getStringHash(String(id), seed) }));
                hashed.sort((a, b) => a.h - b.h);
                entry.sortedIds = hashed.map(r => r.id);
                entry.seq = currentSeq;
                entry.groupsVersion = currentGroupsVersion;
            }
        }
    }, 500);
});

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @param {'upsert'|'delete'} op
 * @param {string | null} fields JSON array of changed field names, or null.
 * @returns {number} The new change row's seq.
 */
function insertChange(db, id, op, fields) {
    const { lastInsertRowid } = db.run('INSERT INTO changes (id, op, fields) VALUES (@id, @op, @fields)', { id, op, fields });
    characterChangeEmitter.emit('change');
    return Number(lastInsertRowid);
}

/**
 * Adds a groups version log row (see group_changes in SCHEMA_SQL). Callers add it only when their write changed
 * something, in that write's transaction.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string | null} groupId null: a group file with no id.
 * @param {string | null} [fileName] The name of the group JSON file the write wrote, replaced or removed, within the
 *   groups folder; null when it touched no file.
 */
function insertGroupChange(db, groupId, fileName = null) {
    db.run('INSERT INTO group_changes (group_id, file_name) VALUES (@groupId, @fileName)', { groupId, fileName });
    characterChangeEmitter.emit(GROUP_CHANGES_EVENT);
}

// Emitted on characterChangeEmitter when a group_changes row was added, inside the write's transaction. Like 'change'
// it names no store: every client asks, and one whose store has nothing new is answered with nothing.
export const GROUP_CHANGES_EVENT = 'group-changes';

/** Connections whose groups version read has already failed and been logged, so it's logged once each. */
const loggedGroupsVersionFailures = new WeakSet();

/**
 * The groups version (MAX(group_changes.version), 0 when empty), or null when it can't be read: for example in
 * read-only mode, on a db opened before group_changes existed. null means "unknown": a response built on it is
 * never answered unchanged and nothing is cached under it.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @returns {number | null}
 */
function readGroupsVersionSync(db) {
    try {
        const row = (/** @type {{ version: number } | undefined} */ (db.get('SELECT COALESCE(MAX(version), 0) as version FROM group_changes')));
        return Number(row?.version ?? 0);
    } catch (err) {
        if (!loggedGroupsVersionFailures.has(db)) {
            loggedGroupsVersionFailures.add(db);
            console.error(color.yellow(`[character-metadata] Reading the groups version failed, so results that include groups are never answered unchanged: ${/** @type {any} */ (err).message}`));
        }
        return null;
    }
}

/**
 * Runs `fn` inside the caller's open transaction as one item that lands whole or not at all: if it throws, only its
 * own writes are rolled back, and the error is rethrown for the caller to skip the item.
 * @template T
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {() => T} fn
 * @returns {T}
 */
function inItemSavepoint(db, fn) {
    db.exec('SAVEPOINT group_item');
    try {
        const result = fn();
        db.exec('RELEASE group_item');
        return result;
    } catch (err) {
        db.exec('ROLLBACK TO group_item');
        db.exec('RELEASE group_item');
        throw err;
    }
}

// Per-user SQLite index for character metadata. FTS lives in characters-search-index.js, not here.
// Import direction is one-way: characters.js/tags.js import this module, never the reverse.
// date_added is write-once: every upsert's ON CONFLICT omits it from the SET list.

const BATCH_FLUSH_SIZE = 500;

// Rows per keyset read (WHERE id > ? ORDER BY id LIMIT ?) in the read-then-write migrations and writers.
const KEYSET_CHUNK = 1000;

// Rows applyOrBuffer() lets accumulate in entry.batch.pending before flushBatch() commits them. Bounds the
// restart-loss window and the buffer's peak memory during a large batch-import pass (350k+ files here) -
// NOT chosen to amortize flush overhead, since a bare transaction commit measures ~0.01-0.05ms under WAL
// (negligible next to ~0.02-0.06ms/row of actual write work). Deliberately separate from SCAN_BATCH_SIZE
// (readdir/dispatch chunking) and BATCH_FLUSH_SIZE above (SQL IN-clause chunking) - unrelated concerns.
const BATCH_IMPORT_FLUSH_SIZE = 500;

// Shares characterIndexBuildConcurrency with characters-search-index.js's build - same disk-bound workload.
const BOOTSTRAP_READ_CONCURRENCY = getConfigValue('performance.characterIndexBuildConcurrency', 64, 'number');


// Backfilling identity hashes requires reading every poisoned row's PNG off disk; this lets an install opt out.
export const allowExpensiveDuplicateFallback = !!getConfigValue('performance.allowExpensiveDuplicateFallback', true, 'boolean');

/**
 * @typedef {object} MetadataDbEntry
 * @property {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @property {import('./users.js').UserDirectoryList} directories
 * @property {{ pending: Map<string, PendingRow> } | null} batch Non-null while batch-import mode is active
 * @property {Promise<void> | null} bootstrapPromise
 * @property {boolean} [tagNameKeysReady] Set once tagNameKeysReady() is true, which stays true.
 * @property {boolean} [tagFolderUsageIndex] Set once the tags_folder_usage_count index is found, which stays.
 * @property {boolean} [entitySortIndexes] Set once every ENTITY_SORT_INDEXES index is found, which stays.
 * @property {boolean} [tagSortFilled] Set once fillTagSortTablesIfNeeded() has finished, which stays.
 * @property {boolean} [randomRanksFilled] Set once fillRandomRanksIfNeeded() has finished, which stays.
 * @property {boolean} [nameOrderFilled] Set once fillNameOrderIfNeeded() has finished, which stays.
 * @property {boolean} [tagQueryColumnsReady] Set once tagQueryColumnsReady() is true, which stays true.
 * @property {number} [activityQueued] Writes queued into activity_pending since the queue was last written out.
 * @property {boolean} [activityFoldScheduled] Set while a background write-out of the whole queue is scheduled.
 */

/**
 * @typedef {object} PendingRow A still-buffered batch-import row, not yet flushed to the `characters` table.
 * @property {CharacterUpsertRow} row
 * @property {string[]} tagIds
 */

/**
 * @typedef {string | null} NodeId Identifies a node in a chat's message tree (see message-tree-db.js). `null`
 * means "no active chat" or "not yet resolved" (see `active_chat`/`active_chat_checked` below).
 * TODO(coordination): message-tree-db.js's own strict-typing pass may introduce a canonical NodeId type under
 * src/types/*.d.ts; if/when it does, this alias should be replaced with that one so both modules share it.
 */

/**
 * @typedef {object} CharacterRow Full `characters` table row shape (see SCHEMA_SQL above).
 * @property {string} id
 * @property {string} name
 * @property {string} name_fold
 * @property {number} fav 0 or 1
 * @property {number} date_added Epoch ms. Write-once: every upsert's ON CONFLICT omits it from the SET list.
 * @property {number | null} create_date Epoch ms, parsed via parseCreateDateToEpochMs().
 * @property {number} date_last_chat Epoch ms
 * @property {number} chat_size
 * @property {number} data_size
 * @property {string | null} world
 * @property {string | null} creator
 * @property {string | null} version
 * @property {string | null} creator_notes
 * @property {string} shallow_json JSON-serialized shallow character object (character-shallow.js's toShallow()).
 * @property {number} digest_fav Per-field digest of shallow_json's fav fields - see writeShallowJson().
 * @property {number} digest_tag_ids Per-field digest of shallow_json's tag_ids - see writeShallowJson().
 * @property {number} digest_content Per-field digest of shallow_json's content fields - see writeShallowJson().
 * @property {number} change_seq
 * @property {NodeId} active_chat
 * @property {number} active_chat_checked 0 = not examined, 1 = resolved one way or the other. Never regresses 1->0.
 * @property {string | null} card_json Full Spec-V2 card JSON when it overrides the PNG chunk; null otherwise.
 * @property {string | null} content_hash sha256 of the raw uploaded import source bytes.
 * @property {string | null} content_identity_hash Fingerprint of semantic content with install-local fields stripped.
 * @property {string | null} avatar_identity_hash sha256 over the PNG's raw IDAT payload bytes.
 * @property {number} import_poisoned 0 or 1 - whether this row may carry old-import-path artifacts.
 * @property {number | null} allow_global_styles 0, 1, or null ("no preference recorded yet").
 */

/**
 * @typedef {Omit<CharacterRow, 'change_seq' | 'allow_global_styles'>} CharacterUpsertRow buildRow()'s output -
 * every UPSERT_SQL-bound column except `change_seq` (assigned by insertChange() at write time, not by buildRow())
 * and `allow_global_styles` (not part of UPSERT_SQL at all - owned solely by setCharacterAllowGlobalStyles()).
 */

/**
 * @typedef {object} GroupRow Full `groups` table row shape.
 * @property {string} id
 * @property {string} name
 * @property {string} name_fold
 * @property {number} fav
 * @property {number} date_added
 * @property {number} date_last_chat
 * @property {number} chat_size
 * @property {number | null} [digest_fav]
 * @property {number | null} [digest_tag_ids]
 * @property {number | null} [digest_content]
 */

/**
 * @typedef {object} TagRow
 * @property {string} id
 * @property {string} data JSON-serialized Tag definition object - see the `tags` table's comment in SCHEMA_SQL.
 */

/**
 * @typedef {{ id: string, name?: string, [key: string]: unknown }} TagDefinitionInput A tag definition as
 * written by a client (tags.js's Tag shape) - only `id`/`name` are relied on here, the rest is passed through.
 */

/**
 * @typedef {object} ChangeRow
 * @property {number} seq
 * @property {string} id
 * @property {'upsert'|'delete'} op
 * @property {string | null} fields JSON array of changed field names, or null (whole record changed, or delete).
 */

/**
 * @typedef {object} MetaRow
 * @property {string} key
 * @property {string} value
 */

/** @typedef {{ character_id: string, tag_id: string }} CharacterTagRow */
/** @typedef {{ group_id: string, tag_id: string }} GroupTagRow */
/** @typedef {{ tag_id: string, count: number }} TagUsageRow */
/** @typedef {{ seq: number, tag_id: string }} TagNameChangeRow */

/**
 * @typedef {object} IdMigrationRow
 * @property {string} old_id
 * @property {string} new_id
 * @property {number} completed 0 or 1
 */

/**
 * @typedef {object} LocalImportSkipRow
 * @property {string} source_path
 * @property {number} mtime_ms
 * @property {string} reason
 * @property {number} checked_at
 */

/**
 * @typedef {object} LocalImportMtimeRow
 * @property {string} source_path
 * @property {number} mtime_ms
 * @property {string | null} [duplicate_of]
 */

/**
 * @typedef {{
 *   name?: string,
 *   fav?: boolean,
 *   chat?: NodeId,
 *   create_date?: string | number,
 *   data?: {
 *     creator?: string,
 *     character_version?: string,
 *     creator_notes?: string,
 *     extensions?: Record<string, unknown>,
 *     tags?: unknown[],
 *   } & Record<string, unknown>,
 * } & Record<string, unknown>} HoistedCharacterCard
 * Card object shape read off disk / from a just-written PNG chunk, V1 fields hoisted to the top level by
 * getCharaCardV2()/parse(). `data.extensions` and other card fields are genuinely caller-arbitrary per the
 * Spec-V2 card format, so this type is intentionally loose there rather than pretending to a precision the
 * format doesn't have.
 */

/**
 * @typedef {object} HashSourceRow Columns selected via HASH_COLUMNS - the fields queryCharacters()'s toHashRow()
 * reads. digest_fav/digest_tag_ids/digest_content are plain column reads, not recomputed here - writeShallowJson()
 * is the only place a character row's shallow_json and its digests can be written, always together, so a stored
 * value here can never be stale relative to shallow_json.
 * @property {string} id
 * @property {NodeId} active_chat
 * @property {number} date_added
 * @property {number | null} create_date
 * @property {number} date_last_chat
 * @property {number} chat_size
 * @property {number} data_size
 * @property {number} digest_fav
 * @property {number} digest_tag_ids
 * @property {number} digest_content
 */

/**
 * @typedef {object} EntityRow One row of queryEntities()'s per-table characters/groups queries, both projected
 * to the same column set so mergeSortedRows()/makeEntityMergeComparator() can treat them uniformly.
 * @property {string} id
 * @property {'character' | 'group'} type
 * @property {string} name_fold
 * @property {number} fav
 * @property {number} date_added
 * @property {number} date_last_chat
 * @property {number} chat_size
 * @property {number | null} create_date `date_added` on the group side (groups have no separate card create_date).
 * @property {number | null} data_size `null` for a group row (no equivalent).
 * @property {string | null} shallow_json `null` for a group row.
 * @property {number | null} [digest_fav] Character rows: always present. Group rows: null means "not yet backfilled".
 * @property {number | null} [digest_tag_ids] Character rows: always present. Group rows: null means "not yet backfilled".
 * @property {number | null} [digest_content] Character rows: always present. Group rows: null means "not yet backfilled".
 */

/**
 * @typedef {object} EntityHashRow queryEntities()'s toHashRow() output. A NULL-digest group row's
 * favHash/tagIdsHash/contentHash start as placeholder zeros, corrected in place by resolveFileFallbackHashes().
 * @property {string} id
 * @property {boolean} isGroup
 * @property {NodeId} chat
 * @property {number} date_added
 * @property {number | null} create_date
 * @property {number} date_last_chat
 * @property {number} chat_size
 * @property {number} data_size
 * @property {number} favHash
 * @property {number} tagIdsHash
 * @property {number} contentHash
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
        world          TEXT,
        creator        TEXT,
        version        TEXT,
        creator_notes  TEXT,
        shallow_json   TEXT NOT NULL,
        -- Per-field digests of shallow_json, read directly by queryCharacters()'s/queryEntities()'s hash mode -
        -- never recomputed there. writeShallowJson() is the only place shallow_json is written outside buildRow()/
        -- writeRowSync()'s own row-construction, and it always writes these three columns in the same statement,
        -- so they cannot drift out of step with shallow_json the way they once did (see migrateCharacterDigestColumns()).
        digest_fav     INTEGER NOT NULL,
        digest_tag_ids INTEGER NOT NULL,
        digest_content INTEGER NOT NULL,
        change_seq     INTEGER NOT NULL,
        -- NULL is ambiguous: "confirmed no chat" vs "not examined yet" look identical, which would make a
        -- resumability query re-read every no-chat card off disk on every boot. active_chat_checked disambiguates.
        active_chat    TEXT,
        -- 0 = not examined, 1 = resolved one way or the other (real chat name or confirmed none). Never regresses 1->0.
        active_chat_checked INTEGER NOT NULL DEFAULT 0,
        -- Full Spec-V2 card JSON - the single source of truth for character data. The PNG is never read as a
        -- data source for an already-imported character; readCardContent() (characters.js) is the read seam.
        -- Export paths materialize this column into the PNG chunk so exported files stay self-contained.
        card_json      TEXT NOT NULL
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
    -- not the other); a real identity match requires both (findCharacterIdByIdentityHashes()). Every row-creating
    -- call site computes and passes it.

    CREATE TABLE IF NOT EXISTS character_tags (
        character_id TEXT NOT NULL,
        tag_id       TEXT NOT NULL,
        PRIMARY KEY (character_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_character_tags_tag ON character_tags(tag_id, character_id);

    -- Maintained by the TAG_USAGE_TRIGGERS on character_tags and group_tags, not by application code, so it can
    -- never drift from them regardless of which code path inserts/deletes a row there.
    CREATE TABLE IF NOT EXISTS tag_usage (
        tag_id TEXT PRIMARY KEY,
        count  INTEGER NOT NULL
    );

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

    -- Cards a one-time migration still has to write, per migration: a later boot retries only these. settled = 1 marks
    -- a row the running retry pass is done with; commitMigrationSettled() deletes those rows in the same transaction that
    -- stores the pass's notice, so after a crash before it every row is looked at again.
    CREATE TABLE IF NOT EXISTS migration_pending (
        migration TEXT NOT NULL,
        id        TEXT NOT NULL,
        settled   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (migration, id)
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

    -- The groups version log: one row per write that changed a group's groups row, its group_tags rows or a group
    -- JSON file, in the same transaction as that write. Tag renames log no row here: the groups index follows
    -- tag_name_changes itself. The groups version is MAX(version) (getGroupsVersion()), as the characters' is
    -- MAX(changes.seq). A write that changes nothing adds no row.
    -- file_name: the name, within the groups folder, of the group JSON file the write wrote, replaced or removed
    -- (writeGroupFileAndRow(), writeGroupFileAtOtherPath(), deleteGroupRow() with fileDeleted); NULL when it touched
    -- no file. group_id is the group's id; a file whose JSON has no id logs group_id NULL with its file_name.
    -- A row with both NULL was logged by an older version for a tag rename or a file with no id.
    CREATE TABLE IF NOT EXISTS group_changes (
        version   INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id  TEXT,
        file_name TEXT
    );

    -- Exact counts of what queryEntities() counts, kept by the triggers ENTITY_COUNT_TRIGGERS_SQL creates. kind is
    -- 'character' or 'group'. entity_counts holds the rows of characters / groups by fav. entity_tag_counts holds the
    -- tag rows whose entity row exists, by that entity's fav; a group_tags row whose group_id ends in .png counts for
    -- no tag, as GROUP_TAG_ROW_IS_GROUP_SQL keeps it out of the tag filter. Tag rows are counted as they are stored:
    -- a tag marked in tag_deletions keeps its own counts until finishDeletedTags() moves its rows. A missing row
    -- reads as 0; a counter that reaches 0 is removed.
    CREATE TABLE IF NOT EXISTS entity_counts (
        kind  TEXT NOT NULL,
        fav   INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (kind, fav)
    );
    CREATE TABLE IF NOT EXISTS entity_tag_counts (
        tag_id TEXT NOT NULL,
        kind   TEXT NOT NULL,
        fav    INTEGER NOT NULL,
        count  INTEGER NOT NULL,
        PRIMARY KEY (tag_id, kind, fav)
    );
    -- How far the counters of each kind are filled: every entity whose id is <= upto (BINARY order, the primary
    -- key's), or every entity once done = 1. The triggers change counters only for those entities, so the counters
    -- are exact for that range at every moment; a pass that fills the next range adds its counts and moves upto in
    -- the same transaction. upto NULL with done = 0 is nothing filled.
    CREATE TABLE IF NOT EXISTS entity_count_fill (
        kind TEXT PRIMARY KEY,
        upto TEXT,
        done INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO entity_count_fill (kind) VALUES ('character'), ('group');

    -- Tag *definitions* (name/color/folder_type/sort_order/... - everything tags.json's 'tags' array used to
    -- hold). 'data' is the whole Tag object as JSON, the source of truth. The columns tags are queried by
    -- (name_key, sort_order, folder_type, is_folder, usage_count) are added by migrateTagNameKeyColumn() and
    -- migrateTagDerivedColumns(); they are derived from data and tag_usage, and data is never written from them.
    CREATE TABLE IF NOT EXISTS tags (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
    );

    -- A tag definition deleted by deleteTagDefinition(), whose tags row and tag rows are still waiting to be removed.
    -- Every read treats tag_id as merge_into (or as absent when NULL); see tag-deletions.js. merge_into is never
    -- itself a row here: marking a tag rewrites the rows that merged into it. Kept apart from tags because a
    -- whole-set saveTagDefinitions() deletes and re-inserts tags rows.
    CREATE TABLE IF NOT EXISTS tag_deletions (
        tag_id     TEXT PRIMARY KEY,
        merge_into TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tag_deletions_merge_into ON tag_deletions(merge_into);

    -- A tag move (moveTagDefinition(), reorderTagDefinitions()) or sort_order value (createTagDefinition(),
    -- editTagDefinition()) that arrived before fillTagSortOrdersIfNeeded() finished, while a reorder pass is
    -- recorded, or while anything was still queued, waiting to be applied (tag-actions D16, D18, D19, D25.3,
    -- D25.9-10, D28). seq is the arrival order, the order they apply in. An entry is either anchored (side and
    -- anchor_id: put tag_id right before/after anchor_id) or a value (value: the raw sort_order as JSON, written into
    -- tag_id's data as is), never both.
    ${tagPendingMovesTableSql('tag_pending_moves')};

    -- Where each tag a tag_pending_moves entry placed will be once the queue is drained, kept as each entry is queued
    -- (foldTagPendingSync()), so a manual read walks it by index instead of replaying the queue. One row per tag.
    -- A tag moved next to an anchor sits in that anchor's gap: anchor_id, g (-1 right before it, 1 right after it),
    -- and i, its order in the gap; every gap of one anchor and side shares one i order. valued 0: the gap is at the
    -- anchor's row; valued 1: at the place (vphase, vs, vk, vr), the anchor's queued value (vk and vr its name_key
    -- and rowid). A tag given a value by an entry has anchor_id NULL, g 0, i 0, valued 1, at its value with its own
    -- name_key and rowid. frozen 1: the anchor's row was removed, and the gap stays at its last place: manual
    -- (vphase, vs, vk, vr), a reorder pass's mode (vk, vc, vr). Emptied when tag_pending_moves is.
    CREATE TABLE IF NOT EXISTS tag_pending_places (
        tag_id    TEXT PRIMARY KEY,
        anchor_id TEXT,
        g         INTEGER NOT NULL,
        i         REAL NOT NULL,
        valued    INTEGER NOT NULL,
        frozen    INTEGER NOT NULL DEFAULT 0,
        vphase    INTEGER,
        vs        REAL,
        vk        TEXT,
        vc        INTEGER,
        vr        INTEGER
    );
    CREATE INDEX IF NOT EXISTS tag_pending_places_gap ON tag_pending_places(anchor_id, g, i) WHERE anchor_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS tag_pending_places_row_gap ON tag_pending_places(anchor_id, g, i) WHERE valued = 0;
    CREATE INDEX IF NOT EXISTS tag_pending_places_ordered ON tag_pending_places(vs, vr, g, i) WHERE valued = 1 AND vphase = 1;
    CREATE INDEX IF NOT EXISTS tag_pending_places_unordered ON tag_pending_places(vk, vr, g, i) WHERE valued = 1 AND vphase = 2;
    CREATE INDEX IF NOT EXISTS tag_pending_places_frozen_name ON tag_pending_places(vk, vr, g, i) WHERE frozen = 1;
    CREATE INDEX IF NOT EXISTS tag_pending_places_frozen_usage ON tag_pending_places(vc DESC, vk, vr, g, i) WHERE frozen = 1;
    CREATE INDEX IF NOT EXISTS tag_pending_places_vr ON tag_pending_places(vr) WHERE valued = 1 AND frozen = 0;

    -- One row per change to the name a tag's rows read as: a tag *name* edit (saveTagDefinitions() below), or a tag
    -- marked deleted, which then reads as its merge target or as nothing (deleteTagDefinition()). Never per tag
    -- creation or non-name field - a change log a caller can page through with seq > sinceSeq, the same shape as
    -- 'changes' above, so reading "which tag ids had their name changed since I last looked" costs work proportional
    -- to how many such changes happened in that window, never to how many tags exist in total.
    CREATE TABLE IF NOT EXISTS tag_name_changes (
        seq    INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_id TEXT NOT NULL
    );

    -- One row per change to what a reader gets as a tag's definition, in the transaction that made it: a tag
    -- created, a stored field changed, a tag marked deleted or pruned (logTagChangesSync()). A client pages through
    -- it with seq > its cursor (getTagChangesSince()), so hearing of other tabs' changes costs work proportional to
    -- how many there were, never to how many tags exist. tag_id NULL is one batch of a background pass, or the end
    -- of a reorder: many definitions changed and a reader re-reads the ones it shows instead of being told each.
    CREATE TABLE IF NOT EXISTS tag_changes (
        seq    INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_id TEXT
    );

    -- A card tag name that couldn't be resolved yet because some tags rows have no name_key (see
    -- tagNameKeysReady()). fillTagNameKeysIfNeeded() resolves and assigns each one once they all do.
    -- only_existing = 1: assigned only if a tag with that name exists, never created.
    CREATE TABLE IF NOT EXISTS tag_names_held (
        character_id  TEXT NOT NULL,
        name          TEXT NOT NULL,
        only_existing INTEGER NOT NULL,
        PRIMARY KEY (character_id, name)
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

    -- Character and group rows whose chat_size/date_last_chat haven't been counted from their owner's messages
    -- since the row was inserted at 0/0. Added in the same transaction as the insert, removed in the same one as
    -- the reconcile's write (reconcileQueuedChatStatsSync()).
    CREATE TABLE IF NOT EXISTS chat_stats_pending (
        kind TEXT NOT NULL CHECK (kind IN ('character', 'group')),
        id   TEXT NOT NULL,
        PRIMARY KEY (kind, id)
    );

    -- Message writes' changes to a row's chat_size and date_last_chat not yet written to the row: one row per
    -- character or group, merged on every write (size_delta added up, added_at the newest created_at inserted, 0 for
    -- none). Readers of those two values add it on top of the row; a read sorted or filtered by them first writes it
    -- into the rows (foldActivitySync()). seq orders queued writes for query tokens (nextActivitySeq()).
    CREATE TABLE IF NOT EXISTS activity_pending (
        kind       TEXT NOT NULL CHECK (kind IN ('character', 'group')),
        id         TEXT NOT NULL,
        size_delta INTEGER NOT NULL,
        added_at   INTEGER NOT NULL,
        seq        INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_activity_pending_seq ON activity_pending(seq);

    -- Characters the search index couldn't re-index, whose previous doc it kept. Retried from next_attempt_at on;
    -- delay_ms is the wait that led there, doubled on each failed attempt. last_error is the last error logged for
    -- the card. Written only by the characters index (characters-search-index.js), in the same transaction as its
    -- cursors.
    CREATE TABLE IF NOT EXISTS character_index_retries (
        id              TEXT PRIMARY KEY,
        next_attempt_at INTEGER NOT NULL,
        delay_ms        INTEGER NOT NULL,
        last_error      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_character_index_retries_next ON character_index_retries(next_attempt_at, id);

    -- A bulk action's selection, fixed when it is prepared (beginBulkSelection()) so the action works on the
    -- characters the user saw counted, whatever the action itself does to the list's order or filter. Rows are
    -- dropped with the job; a job left behind by a closed page is dropped by the next one after a day.
    CREATE TABLE IF NOT EXISTS bulk_jobs (
        job        TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bulk_selections (
        job    TEXT NOT NULL,
        avatar TEXT NOT NULL,
        PRIMARY KEY (job, avatar)
    );

    -- A user's saved views of the character list: a name and the view object the page lists by
    -- (public/scripts/character-view.js), in the user's own order. views_version in meta goes up on every write, so a
    -- page can ask whether anything changed.
    CREATE TABLE IF NOT EXISTS saved_views (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        name_fold  TEXT NOT NULL,
        view_json  TEXT NOT NULL,
        position   REAL NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saved_views_position ON saved_views(position, id);
`;

const UPSERT_SQL = `
    INSERT INTO characters (
        id, name, name_fold, fav, date_added, create_date, date_last_chat, chat_size, data_size,
        world, creator, version, creator_notes, shallow_json, digest_fav, digest_tag_ids, digest_content,
        content_hash, content_identity_hash, avatar_identity_hash, import_poisoned, active_chat, active_chat_checked,
        change_seq, card_json
    ) VALUES (
        @id, @name, @name_fold, @fav, @date_added, @create_date, @date_last_chat, @chat_size, @data_size,
        @world, @creator, @version, @creator_notes, @shallow_json, @digest_fav, @digest_tag_ids, @digest_content,
        @content_hash, @content_identity_hash, @avatar_identity_hash, @import_poisoned, @active_chat, @active_chat_checked,
        @changeSeq, @card_json
    )
    ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        name_fold = excluded.name_fold,
        fav = excluded.fav,
        create_date = excluded.create_date,
        -- date_last_chat and chat_size absent deliberately: owned by applyCharacterChatStats(), which follows every
        -- write to the character's messages. This function's callers get theirs from the chats directory, which no
        -- longer changes once messages live in the tree, so including them would reset the row to stale values.
        data_size = excluded.data_size,
        world = excluded.world,
        creator = excluded.creator,
        version = excluded.version,
        creator_notes = excluded.creator_notes,
        shallow_json = excluded.shallow_json,
        digest_fav = excluded.digest_fav,
        digest_tag_ids = excluded.digest_tag_ids,
        digest_content = excluded.digest_content,
        -- COALESCE: most writers pass no content hash (undefined), and a plain overwrite would clobber an
        -- import-time hash to NULL on the next unrelated edit. Only a fresh hash (re-import, same id) overwrites.
        content_hash = COALESCE(excluded.content_hash, characters.content_hash),
        content_identity_hash = COALESCE(excluded.content_identity_hash, characters.content_identity_hash),
        avatar_identity_hash = COALESCE(excluded.avatar_identity_hash, characters.avatar_identity_hash),
        -- import_poisoned is NOT NULL so there's no NULL "no signal" value: a genuine write (0) always clears
        -- poison; reconcile/bootstrap bind 1 as their no-signal value and leave the existing state alone.
        import_poisoned = CASE WHEN excluded.import_poisoned = 0 THEN 0 ELSE characters.import_poisoned END,
        -- Plain overwrite: writeRowSync() already pre-resolves the correct value before this SQL runs.
        active_chat = excluded.active_chat,
        -- Never regresses 1 -> 0.
        active_chat_checked = CASE WHEN excluded.active_chat_checked = 1 THEN 1 ELSE characters.active_chat_checked END,
        -- Plain overwrite, not COALESCE: NULL here is a real signal ("file now current, stop preferring the
        -- parked copy"), not an absence of one - a COALESCE would keep serving stale edits after an avatar
        -- replace with no way to ever clear them.
        card_json = excluded.card_json,
        change_seq = excluded.change_seq
    -- date_added intentionally absent: write-once, see this module's header.
`;

// NFKD-normalizes and strips combining marks so "É"/"e" sort/prefix-match the same as "é"/"e".
/**
 * @param {unknown} name
 * @returns {string}
 */
function foldName(name) {
    return String(name ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '');
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {string}
 */
function getDbPath(directories) {
    return path.join(directories.root, 'character-metadata.sqlite');
}

// SQLite has no ALTER TABLE ADD COLUMN IF NOT EXISTS, so this checks PRAGMA table_info and runs the ALTER once.
// Never backfills existing rows' hashes - they stay NULL.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateContentHashColumn(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(characters)')));
    const hasColumn = columns.some(c => c.name === 'content_hash');
    if (!hasColumn) {
        db.exec('ALTER TABLE characters ADD COLUMN content_hash TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_content_hash ON characters(content_hash)');
}

// import_poisoned defaults to 1: rows that predate this column came from the old, more-mutating import logic.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateContentIdentityColumns(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(characters)')));
    if (!columns.some(c => c.name === 'content_identity_hash')) {
        db.exec('ALTER TABLE characters ADD COLUMN content_identity_hash TEXT');
    }
    if (!columns.some(c => c.name === 'import_poisoned')) {
        db.exec('ALTER TABLE characters ADD COLUMN import_poisoned INTEGER NOT NULL DEFAULT 1');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_content_identity_hash ON characters(content_identity_hash)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_import_poisoned ON characters(import_poisoned)');
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateAvatarIdentityColumn(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(characters)')));
    if (!columns.some(c => c.name === 'avatar_identity_hash')) {
        db.exec('ALTER TABLE characters ADD COLUMN avatar_identity_hash TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_avatar_identity_hash ON characters(avatar_identity_hash)');
}

// A pre-existing active_chat column means those rows were already resolved in prior boots, so active_chat_checked
// is retroactively set to 1 for them instead of DEFAULT 0, which would force a full corpus re-read.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateActiveChatColumn(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(characters)')));
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
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateCreateDateColumn(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(characters)')));
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
        // SQLite refuses to DROP COLUMN while an index still references it.
        db.exec('DROP INDEX IF EXISTS idx_characters_create_date');
        db.exec('ALTER TABLE characters ADD COLUMN create_date_ms INTEGER');

        /** @type {{ id: string, value: number | null }[]} */
        const unparseable = [];
        let lastId = '';
        let rowsRead = 0;
        db.transaction(() => {
            // transaction() reruns this callback on busy; a rerun starts over from the first row.
            lastId = '';
            rowsRead = 0;
            for (;;) {
                const chunk = (/** @type {{ id: string, create_date: number | null }[]} */ (db.readBounded(
                    'SELECT id, create_date FROM characters WHERE create_date IS NOT NULL AND id > ? ORDER BY id LIMIT ?',
                    [lastId, KEYSET_CHUNK],
                    KEYSET_CHUNK,
                )));
                if (chunk.length === 0) break;
                rowsRead += chunk.length;

                for (const row of chunk) {
                    const ms = parseCreateDateToEpochMs(row.create_date);
                    if (ms === null) {
                        unparseable.push({ id: row.id, value: row.create_date });
                        continue;
                    }
                    writeRowIfChanged(db, 'characters', { id: row.id }, { create_date_ms: ms });
                }

                lastId = chunk[chunk.length - 1].id;
                if (chunk.length < KEYSET_CHUNK) break;
            }
        });

        if (unparseable.length > 0) {
            console.error(color.yellow(
                `[character-metadata] create_date migration: ${unparseable.length} of ${rowsRead} row(s) had a ` +
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

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateDropFileMtimeColumn(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(characters)')));
    if (columns.some(c => c.name === 'file_mtime')) {
        db.exec('ALTER TABLE characters DROP COLUMN file_mtime');
    }
}

// deleteRowSync() cascades a character deletion into deleting rows that named it as duplicate_of, so a stale
// skip can never outlive the character it depends on.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateLocalImportMtimesDuplicateOfColumn(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(local_import_mtimes)')));
    if (!columns.some(c => c.name === 'duplicate_of')) {
        db.exec('ALTER TABLE local_import_mtimes ADD COLUMN duplicate_of TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_local_import_mtimes_duplicate_of ON local_import_mtimes(duplicate_of)');
}

export { computeContentIdentityHash };

// Backfills real values into rows from the old id/name-only shape via a plain UPDATE, since
// bootstrapGroupsIfNeeded()'s upsert path never overwrites an existing date_added.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {import('./users.js').UserDirectoryList} directories
 */
function migrateGroupsColumns(db, directories) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(groups)')));
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

    const readIdChunk = (/** @type {string} */ afterId) => (/** @type {{ id: string }[]} */ (db.readBounded(
        'SELECT id FROM groups WHERE id > ? ORDER BY id LIMIT ?',
        [afterId, KEYSET_CHUNK],
        KEYSET_CHUNK,
    )));

    const firstChunk = readIdChunk('');
    if (firstChunk.length === 0) return;

    let lastId = '';
    db.transaction(() => {
        // transaction() reruns this callback on busy; a rerun starts over from the first chunk.
        lastId = '';
        let chunk = firstChunk;
        for (;;) {
            for (const { id } of chunk) {
                // The chat stats columns were just added at 0/0, whether or not the group's file can be read.
                queueChatStatsReconcileSync(db, 'group', id);
                try {
                    const filePath = path.join(directories.groups, `${id}.json`);
                    const raw = fs.readFileSync(filePath, 'utf8');
                    const group = JSON.parse(raw);
                    const stat = fs.statSync(filePath);
                    inItemSavepoint(db, () => {
                        const changed = writeRowIfChanged(db, 'groups', { id }, {
                            name: group.name ?? '',
                            name_fold: foldName(group.name),
                            fav: normalizeFav(group.fav) ? 1 : 0,
                            date_added: Math.round(stat.birthtimeMs),
                        });
                        if (changed) insertGroupChange(db, id);
                    });
                } catch (err) {
                    console.error(`[character-metadata] Column-migration backfill failed to process group ${id}, leaving it at its zeroed defaults:`, /** @type {any} */ (err).message);
                }
            }

            if (chunk.length < KEYSET_CHUNK) break;
            lastId = chunk[chunk.length - 1].id;
            chunk = readIdChunk(lastId);
            if (chunk.length === 0) break;
        }
    });
}

// Backfills digests immediately - groups are few enough that eager backfill is cheap. Unlike characters, group
// rows still trust this stored value (see queryEntities()'s toHashRow()): a group's digest source is its own
// JSON file, not shallow_json, and nothing has found that drift stale.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {import('./users.js').UserDirectoryList} directories
 */
function migrateGroupDigestColumns(db, directories) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(groups)')));
    const columnNames = new Set(columns.map(c => c.name));
    const isNewColumn = !columnNames.has('digest_fav');
    if (!columnNames.has('digest_fav')) db.exec('ALTER TABLE groups ADD COLUMN digest_fav INTEGER');
    if (!columnNames.has('digest_tag_ids')) db.exec('ALTER TABLE groups ADD COLUMN digest_tag_ids INTEGER');
    if (!columnNames.has('digest_content')) db.exec('ALTER TABLE groups ADD COLUMN digest_content INTEGER');

    if (!isNewColumn) return;

    const readIdChunk = (/** @type {string} */ afterId) => (/** @type {{ id: string }[]} */ (db.readBounded(
        'SELECT id FROM groups WHERE id > ? ORDER BY id LIMIT ?',
        [afterId, KEYSET_CHUNK],
        KEYSET_CHUNK,
    )));

    const firstChunk = readIdChunk('');
    if (firstChunk.length === 0) return;

    let lastId = '';
    db.transaction(() => {
        // transaction() reruns this callback on busy; a rerun starts over from the first chunk.
        lastId = '';
        let chunk = firstChunk;
        for (;;) {
            for (const { id } of chunk) {
                try {
                    const filePath = path.join(directories.groups, `${id}.json`);
                    const raw = fs.readFileSync(filePath, 'utf8');
                    const group = normalizeGroupRecord(JSON.parse(raw));
                    const tagIds = tagEntityTypeOf(id) === 'group' ? Array.from(/** @type {Iterable<{ tag_id: string }>} */ (db.iterate('SELECT tag_id FROM group_tags WHERE group_id = @id ORDER BY tag_id', { id })), r => r.tag_id) : [];
                    const fingerprintSource = { ...group, tag_ids: tagIds };
                    inItemSavepoint(db, () => {
                        const changed = writeRowIfChanged(db, 'groups', { id }, {
                            digest_fav: groupDigestFavHash(fingerprintSource),
                            digest_tag_ids: groupDigestTagIdsHash(fingerprintSource),
                            digest_content: groupDigestContentHash(fingerprintSource),
                        });
                        if (changed) insertGroupChange(db, id);
                    });
                } catch (err) {
                    console.error(`[character-metadata] Group digest backfill failed for ${id}, leaving digests NULL (hash-mode falls back to computing live):`, /** @type {any} */ (err).message);
                }
            }

            if (chunk.length < KEYSET_CHUNK) break;
            lastId = chunk[chunk.length - 1].id;
            chunk = readIdChunk(lastId);
            if (chunk.length === 0) break;
        }
    });
}

// fields: JSON array of changed field names (e.g. '["fav"]'), or NULL meaning the whole record changed.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateChangesFieldsColumn(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(changes)')));
    if (!columns.some(c => c.name === 'fields')) {
        db.exec('ALTER TABLE changes ADD COLUMN fields TEXT');
    }
}

// file_name: see group_changes in SCHEMA_SQL. Rows logged before it existed keep NULL.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateGroupChangesFileNameColumn(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(group_changes)')));
    if (!columns.some(c => c.name === 'file_name')) {
        db.exec('ALTER TABLE group_changes ADD COLUMN file_name TEXT');
    }
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateRevToSeqColumns(db) {
    const charCols = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(\'characters\')')), c => c.name);
    if (charCols.includes('rev') && !charCols.includes('change_seq')) {
        db.exec('ALTER TABLE characters RENAME COLUMN rev TO change_seq');
    }
    const changeCols = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(\'changes\')')), c => c.name);
    if (changeCols.includes('rev') && !changeCols.includes('seq')) {
        db.exec('ALTER TABLE changes RENAME COLUMN rev TO seq');
    }
    db.run('UPDATE meta SET key = \'tags_hash\' WHERE key = \'tags_rev\'');
    db.run('UPDATE meta SET key = \'tantivy_char_index_seq\' WHERE key = \'tantivy_char_index_rev\'');
    db.run('UPDATE meta SET key = \'tantivy_char_index_tags_hash\' WHERE key = \'tantivy_char_index_tags_rev\'');
}

// digest_fav/digest_tag_ids/digest_content used to drift from shallow_json because several call sites wrote
// shallow_json without also updating them (a prior fix dropped the columns entirely rather than closing those
// call sites). writeShallowJson() is now the only place shallow_json is written outside buildRow()/writeRowSync()'s
// own row construction, and it always writes all three digest columns in the same statement - so an install that
// still has these columns from before is fine as-is, and an install missing them gets a one-time eager backfill
// (same shape as migrateGroupDigestColumns()) rather than the old lazy-NULL-until-next-write behavior, since
// nothing here should ever read a NULL digest again.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateCharacterDigestColumns(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(characters)')));
    const columnNames = new Set(columns.map(c => c.name));
    const isNewColumn = !columnNames.has('digest_fav');
    if (!columnNames.has('digest_fav')) db.exec('ALTER TABLE characters ADD COLUMN digest_fav INTEGER NOT NULL DEFAULT 0');
    if (!columnNames.has('digest_tag_ids')) db.exec('ALTER TABLE characters ADD COLUMN digest_tag_ids INTEGER NOT NULL DEFAULT 0');
    if (!columnNames.has('digest_content')) db.exec('ALTER TABLE characters ADD COLUMN digest_content INTEGER NOT NULL DEFAULT 0');

    if (!isNewColumn) return;

    const BACKFILL_CHUNK = 1000;
    let lastId = '';
    for (;;) {
        const chunk = (/** @type {{ id: string, shallow_json: string }[]} */ (db.readBounded(
            'SELECT id, shallow_json FROM characters WHERE id > ? ORDER BY id LIMIT ?',
            [lastId, BACKFILL_CHUNK],
            BACKFILL_CHUNK,
        )));
        if (chunk.length === 0) break;

        db.transaction(() => {
            for (const row of chunk) {
                try {
                    const shallow = JSON.parse(row.shallow_json);
                    const { digest_fav, digest_tag_ids, digest_content } = digestColumnsForShallow(shallow);
                    writeRowIfChanged(db, 'characters', { id: row.id }, { digest_fav, digest_tag_ids, digest_content });
                } catch (err) {
                    console.error(`[character-metadata] Character digest backfill failed for ${row.id}, leaving it at its zeroed defaults:`, /** @type {any} */ (err).message);
                }
            }
        });

        lastId = chunk[chunk.length - 1].id;
        if (chunk.length < BACKFILL_CHUNK) break;
    }
}

// NULL means "no preference recorded yet"; existing values migrate from client accountStorage on first load.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateAllowGlobalStylesColumn(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string, type: string, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(characters)')));
    if (!columns.some(c => c.name === 'allow_global_styles')) {
        db.exec('ALTER TABLE characters ADD COLUMN allow_global_styles INTEGER');
    }
}

// card_json is the single source of truth for character data (never the PNG, post-import) - see SCHEMA_SQL's
// column comment. A pre-existing row from before this column existed has no other source for it than its PNG,
// so this is the one place the app still reads a PNG's embedded chunk for an already-imported character - a
// one-time transition, not a runtime fallback. SQLite has no ALTER COLUMN, so making the column NOT NULL
// (once every row has a value) means rebuilding the table: create the replacement with the same columns,
// copy the data across, drop the old table, rename the new one into place.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {import('./users.js').UserDirectoryList} directories
 */
function migrateCardJsonColumn(db, directories) {
    let columns = Array.from(/** @type {Iterable<{ name: string, type: string, notnull: number, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(characters)')));
    if (!columns.some(c => c.name === 'card_json')) {
        db.exec('ALTER TABLE characters ADD COLUMN card_json TEXT');
        columns = Array.from(/** @type {Iterable<{ name: string, type: string, notnull: number, [key: string]: unknown }>} */ (db.iterate('PRAGMA table_info(characters)')));
    }

    const cardJsonColumn = columns.find(c => c.name === 'card_json');
    if (cardJsonColumn !== undefined && cardJsonColumn.notnull === 1) return; // already migrated

    const readIdChunk = (/** @type {string} */ afterId) => (/** @type {{ id: string }[]} */ (db.readBounded(
        'SELECT id FROM characters WHERE card_json IS NULL AND id > ? ORDER BY id LIMIT ?',
        [afterId, KEYSET_CHUNK],
        KEYSET_CHUNK,
    )));

    const firstChunk = readIdChunk('');
    if (firstChunk.length > 0) {
        let backfilled = 0;
        /** @type {string[]} */
        const unresolved = [];
        let lastId = '';
        let rowsRead = 0;
        db.transaction(() => {
            // transaction() reruns this callback on busy; a rerun starts over from the first chunk.
            lastId = '';
            rowsRead = 0;
            let chunk = firstChunk;
            for (;;) {
                rowsRead += chunk.length;
                for (const row of chunk) {
                    let cardJson;
                    try {
                        cardJson = readCharacterCardFromBuffer(fs.readFileSync(path.join(directories.characters, row.id)));
                    } catch {
                        cardJson = undefined;
                    }
                    if (cardJson === undefined) {
                        unresolved.push(row.id);
                        continue;
                    }
                    writeRowIfChanged(db, 'characters', { id: row.id }, { card_json: cardJson });
                    backfilled++;
                }

                if (chunk.length < KEYSET_CHUNK) break;
                lastId = chunk[chunk.length - 1].id;
                chunk = readIdChunk(lastId);
                if (chunk.length === 0) break;
            }
        });
        console.log(color.cyan(`[character-metadata] card_json migration: backfilled ${backfilled}/${rowsRead} pre-existing row(s) from their PNG.`));
        if (unresolved.length > 0) {
            console.error(color.red(
                `[character-metadata] card_json migration: ${unresolved.length} row(s) have no readable PNG and no other ` +
                `character-data source, so card_json can't be backfilled for them: ${unresolved.slice(0, 20).join(', ')}` +
                `${unresolved.length > 20 ? ', ...' : ''}. Leaving the column nullable until these rows are resolved ` +
                '(fix or remove them, then restart) - NOT NULL cannot be added while any row would violate it.',
            ));
            return;
        }
    }

    // A trigger that names `characters` makes the RENAME below fail while the table is gone. The rows are copied
    // unchanged, so the counters and the tag sort rows stay right; getEntry() creates the triggers again after this.
    db.exec(DROP_ENTITY_COUNT_TRIGGERS_SQL);
    db.exec(DROP_TAG_SORT_TRIGGERS_SQL);
    db.exec(DROP_RANDOM_RANK_TRIGGERS_SQL);
    db.exec(DROP_NAME_ORDER_TRIGGERS_SQL);
    db.exec('CREATE TABLE characters_new (' + columns.map(c => {
        let def = `${/** @type {string} */ (c.name)} ${/** @type {string} */ (c.type)}`;
        if (c.name === 'card_json' || c.notnull) def += ' NOT NULL';
        if (c.dflt_value !== null && c.dflt_value !== undefined) def += ` DEFAULT ${c.dflt_value}`;
        if (c.pk) def += ' PRIMARY KEY';
        return def;
    }).join(', ') + ')');
    const columnList = columns.map(c => c.name).join(', ');
    db.exec(`INSERT INTO characters_new (${columnList}) SELECT ${columnList} FROM characters`);
    db.exec('DROP TABLE characters');
    db.exec('ALTER TABLE characters_new RENAME TO characters');

    // Every index on `characters` created above this point in getEntry()'s migration chain was dropped along
    // with the table just now (SQLite drops a table's indexes with it) and needs recreating - anything created
    // further down getEntry()'s chain (migrateGroupsColumns() onward) still runs after this function returns.
    db.exec(SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_content_hash ON characters(content_hash)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_content_identity_hash ON characters(content_identity_hash)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_import_poisoned ON characters(import_poisoned)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_avatar_identity_hash ON characters(avatar_identity_hash)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_active_chat_checked ON characters(active_chat_checked)');
}

// idx_characters_fav_name_fold has default ASC on both columns, which SQLite can't use for a DESC/ASC ORDER BY.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
// name_key is tagNameKey() of the row's name. Rows written before this column existed have it NULL until
// fillTagNameKeysIfNeeded() fills them; its index is built there too, since both take a pass over every tag.
function migrateTagNameKeyColumn(db) {
    const columns = Array.from(/** @type {Iterable<{ name: string }>} */ (db.iterate('PRAGMA table_info(tags)')));
    if (!columns.some(c => c.name === 'name_key')) {
        db.exec('ALTER TABLE tags ADD COLUMN name_key TEXT');
    }
}

// No defaults: a row written before these columns existed reads NULL until it is filled, so it can never pass for
// a derived value.
const TAG_DERIVED_COLUMNS = [
    ['sort_order', 'REAL'],
    ['folder_type', 'TEXT'],
    ['is_folder', 'INTEGER'],
    ['usage_count', 'INTEGER'],
];

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateTagDerivedColumns(db) {
    const existing = new Set([...db.iterate('PRAGMA table_info(tags)')].map(c => /** @type {{ name: string }} */ (c).name));
    for (const [name, type] of TAG_DERIVED_COLUMNS) {
        if (!existing.has(name)) db.exec(`ALTER TABLE tags ADD COLUMN ${name} ${type}`);
    }
}

// tags.usage_count is set from tag_usage.count in the same trigger, so it equals that count for its id at every
// moment, whatever it held before. Kept as stored in sqlite_master (no IF NOT EXISTS, no trailing ';'), so
// replaceTagUsageTriggers() can tell an old body from this one.
const TAG_USAGE_TRIGGERS = [
    ['trg_character_tags_ai', 'AFTER INSERT ON character_tags', 'NEW'],
    ['trg_character_tags_ad', 'AFTER DELETE ON character_tags', 'OLD'],
    ['trg_group_tags_ai', 'AFTER INSERT ON group_tags', 'NEW'],
    ['trg_group_tags_ad', 'AFTER DELETE ON group_tags', 'OLD'],
].map(([name, when, row]) => ({
    name,
    sql: `CREATE TRIGGER ${name} ${when} BEGIN
    ${row === 'NEW'
        ? 'INSERT INTO tag_usage (tag_id, count) VALUES (NEW.tag_id, 1) ON CONFLICT(tag_id) DO UPDATE SET count = count + 1;'
        : 'UPDATE tag_usage SET count = count - 1 WHERE tag_id = OLD.tag_id;'}
    UPDATE tags SET usage_count = COALESCE((SELECT count FROM tag_usage WHERE tag_id = ${row}.tag_id), 0) WHERE id = ${row}.tag_id;
END`,
}));

/**
 * Creates each TAG_USAGE_TRIGGERS trigger that is missing or has another body. Runs after
 * migrateTagDerivedColumns(), since the bodies write tags.usage_count.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function replaceTagUsageTriggers(db) {
    const isCurrent = (/** @type {{ name: string, sql: string }} */ trigger) => {
        const row = /** @type {{ sql: string } | undefined} */ (db.get('SELECT sql FROM sqlite_master WHERE type = \'trigger\' AND name = @name', { name: trigger.name }));
        return row?.sql === trigger.sql;
    };
    if (TAG_USAGE_TRIGGERS.every(isCurrent)) return;
    db.transaction(() => {
        for (const trigger of TAG_USAGE_TRIGGERS) {
            if (isCurrent(trigger)) continue;
            db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
            db.exec(trigger.sql);
        }
    });
}

/**
 * The CREATE TABLE of tag_pending_moves (see SCHEMA_SQL), under `name`; a declaration, so SCHEMA_SQL can use it.
 * @param {string} name
 */
function tagPendingMovesTableSql(name) {
    return `CREATE TABLE IF NOT EXISTS ${name} (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_id    TEXT NOT NULL,
        side      TEXT CHECK (side IN ('before', 'after')),
        anchor_id TEXT,
        value     TEXT,
        CHECK ((side IS NOT NULL AND anchor_id IS NOT NULL AND value IS NULL)
            OR (side IS NULL AND anchor_id IS NULL AND value IS NOT NULL))
    )`;
}

// tag_pending_places follows the rows it points at whatever writes them: emptied with tag_pending_moves; a removed
// tags row takes its own place with it, and freezes the gaps anchored at it at the place it had; a name_key change
// moves the value places that read it. Kept as stored in sqlite_master (no IF NOT EXISTS, no trailing ';'), so
// replaceTagPendingPlaceTriggers() can tell an old body from this one.
const TAG_PENDING_PLACE_TRIGGERS = [
    {
        name: 'trg_tag_pending_moves_emptied',
        sql: `CREATE TRIGGER trg_tag_pending_moves_emptied AFTER DELETE ON tag_pending_moves
    WHEN NOT EXISTS (SELECT 1 FROM tag_pending_moves) BEGIN
    DELETE FROM tag_pending_places;
END`,
    },
    {
        name: 'trg_tags_pending_places_ad',
        sql: `CREATE TRIGGER trg_tags_pending_places_ad AFTER DELETE ON tags BEGIN
    DELETE FROM tag_pending_places WHERE tag_id = OLD.id;
    UPDATE tag_pending_places SET frozen = 1, vk = OLD.name_key, vc = OLD.usage_count, vr = OLD.rowid,
        vphase = CASE WHEN valued = 1 THEN vphase WHEN OLD.sort_order IS NULL THEN 2 ELSE 1 END,
        vs = CASE WHEN valued = 1 THEN vs ELSE OLD.sort_order END,
        valued = 1
        WHERE anchor_id = OLD.id AND frozen = 0;
END`,
    },
    {
        name: 'trg_tags_pending_places_name_key',
        sql: `CREATE TRIGGER trg_tags_pending_places_name_key AFTER UPDATE OF name_key ON tags BEGIN
    UPDATE tag_pending_places SET vk = NEW.name_key WHERE valued = 1 AND frozen = 0 AND vr = NEW.rowid;
END`,
    },
];

/**
 * Creates each TAG_PENDING_PLACE_TRIGGERS trigger that is missing or has another body. Runs after
 * migrateTagPendingMovesValueColumn(), which can drop tag_pending_moves (and its triggers with it).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function replaceTagPendingPlaceTriggers(db) {
    const isCurrent = (/** @type {{ name: string, sql: string }} */ trigger) => {
        const row = /** @type {{ sql: string } | undefined} */ (db.get('SELECT sql FROM sqlite_master WHERE type = \'trigger\' AND name = @name', { name: trigger.name }));
        return row?.sql === trigger.sql;
    };
    if (TAG_PENDING_PLACE_TRIGGERS.every(isCurrent)) return;
    db.transaction(() => {
        for (const trigger of TAG_PENDING_PLACE_TRIGGERS) {
            if (isCurrent(trigger)) continue;
            db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
            db.exec(trigger.sql);
        }
    });
}

/**
 * Rebuilds a tag_pending_moves made with a `sort_order REAL` value column with `value TEXT` in its place, keeping
 * every entry and its seq; a value becomes its JSON. Runs at boot: the table only holds queued moves, so it's small.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateTagPendingMovesValueColumn(db) {
    const columns = new Set([...db.iterate('PRAGMA table_info(tag_pending_moves)')].map(c => /** @type {{ name: string }} */ (c).name));
    if (!columns.has('sort_order')) return;
    db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS tag_pending_moves_new');
        db.exec(tagPendingMovesTableSql('tag_pending_moves_new'));
        db.exec(`INSERT INTO tag_pending_moves_new (seq, tag_id, side, anchor_id, value)
            SELECT seq, tag_id, side, anchor_id, CASE WHEN sort_order IS NULL THEN NULL ELSE json_quote(sort_order) END
            FROM tag_pending_moves`);
        db.exec('DROP TABLE tag_pending_moves');
        db.exec('ALTER TABLE tag_pending_moves_new RENAME TO tag_pending_moves');
    });
}

/**
 * reorder_pass: the id of the reorder pass (tagReorderPassSync()) that last wrote the tag; NULL when none has.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateTagReorderPassColumn(db) {
    const existing = new Set([...db.iterate('PRAGMA table_info(tags)')].map(c => /** @type {{ name: string }} */ (c).name));
    if (!existing.has('reorder_pass')) db.exec('ALTER TABLE tags ADD COLUMN reorder_pass INTEGER');
}

// Every write of a tags row inserts these columns (`INSERT ... INTO tags ${TAG_ROW_VALUES_SQL}`) with
// tagRowParams(); usage_count is the id's tag_usage.count, 0 without a tag_usage row.
const TAG_ROW_VALUES_SQL = `(id, data, name_key, sort_order, folder_type, is_folder, usage_count)
    VALUES (@id, @data, @nameKey, @sortOrder, @folderType, @isFolder, COALESCE((SELECT count FROM tag_usage WHERE tag_id = @id), 0))`;

/**
 * @param {TagDefinitionInput} tag
 */
function tagRowParams(tag) {
    return { id: tag.id, data: JSON.stringify(tag), nameKey: tagDefinitionNameKey(tag), ...tagDerivedColumns(tag) };
}

/**
 * The tags columns derived from a tag's data (a value as JSON.parse returns it), with upstream's coercion wherever
 * upstream defines it. sort_order: upstream orders by `a.sort_order - b.sort_order` among tags whose sort_order
 * isn't undefined, so null, booleans and numeric strings coerce as that subtraction does; a value it can't order
 * (NaN, a non-numeric string, an object) has no order. folder_type/is_folder follow isBogusFolder() (tags.js):
 * a folder is any present folder_type other than the string 'NONE'.
 * @param {unknown} tag
 * @returns {{ sortOrder: number | null, folderType: string, isFolder: 0 | 1 }}
 */
export function tagDerivedColumns(tag) {
    const fields = tag !== null && typeof tag === 'object' ? /** @type {Record<string, unknown>} */ (tag) : {};
    const rawOrder = fields.sort_order;
    /** @type {number | null} */
    let sortOrder = null;
    if (rawOrder === null) {
        sortOrder = 0;
    } else if (typeof rawOrder === 'number' || typeof rawOrder === 'boolean' || typeof rawOrder === 'string') {
        const n = Number(rawOrder);
        sortOrder = Number.isNaN(n) ? null : n;
    }
    const rawFolder = fields.folder_type;
    const folderType = rawFolder === undefined ? 'NONE' : typeof rawFolder === 'string' ? rawFolder : String(JSON.stringify(rawFolder));
    return { sortOrder, folderType, isFolder: folderType === 'NONE' ? 0 : 1 };
}

function migrateFavSortIndex(db) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_fav_desc_name_fold_asc ON characters(fav DESC, name_fold ASC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_groups_fav_desc_name_fold_asc ON groups(fav DESC, name_fold ASC)');
}

// Returns null if no SQLite engine is usable on this install - callers must no-op rather than throw. In read-only
// mode it throws instead when better-sqlite3 isn't usable (openReadOnlyEntry()).
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<MetadataDbEntry | null>}
 */
async function getEntry(directories) {
    const key = directories.root;
    const existing = entries.get(key);
    if (existing) {
        return existing;
    }

    if (isReadOnlyMode()) {
        return openReadOnlyEntry(directories);
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
    const isNewStore = !fs.existsSync(getDbPath(directories));
    const db = engine.openDatabase(getDbPath(directories));
    db.exec(SCHEMA_SQL);
    if (isNewStore) setMetaSync(db, TAGS_SEED_PENDING_KEY, String(Date.now()));
    migrateContentHashColumn(db);
    migrateContentIdentityColumns(db);
    migrateAvatarIdentityColumn(db);
    migrateActiveChatColumn(db);
    migrateCreateDateColumn(db);
    migrateDropFileMtimeColumn(db);
    migrateLocalImportMtimesDuplicateOfColumn(db);
    migrateChangesFieldsColumn(db);
    // Before any migration below that logs a group change.
    migrateGroupChangesFileNameColumn(db);
    migrateRevToSeqColumns(db);
    migrateCharacterDigestColumns(db);
    migrateAllowGlobalStylesColumn(db);
    migrateCardJsonColumn(db, directories);
    migrateGroupsColumns(db, directories);
    migrateGroupDigestColumns(db, directories);
    migrateFavSortIndex(db);
    migrateTagNameKeyColumn(db);
    migrateTagDerivedColumns(db);
    migrateTagReorderPassColumn(db);
    migrateTagPendingMovesValueColumn(db);
    replaceTagPendingPlaceTriggers(db);
    replaceTagUsageTriggers(db);
    // Last: the group triggers read groups.fav, which migrateGroupsColumns() adds to an old table.
    db.exec(ENTITY_COUNT_TRIGGERS_SQL);
    db.exec(TAG_SORT_TABLES_SQL);
    db.exec(TAG_SORT_TRIGGERS_SQL);
    db.exec(RANDOM_RANKS_TABLE_SQL);
    db.exec(RANDOM_RANK_TRIGGERS_SQL);
    db.exec(NAME_ORDER_TABLE_SQL);
    db.exec(NAME_ORDER_TRIGGERS_SQL);
    defineRandHash(db);
    /** @type {MetadataDbEntry} */
    const entry = { db, directories, batch: null, bootstrapPromise: null };
    entries.set(key, entry);
    return entry;
}

// Registers cyrb53 as a SQL function so random-sort order can be a per-query ORDER BY RANDHASH(id, seed),
// composing with LIMIT/OFFSET pagination instead of a JS-side sort over every row.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function defineRandHash(db) {
    db.defineFunction('RANDHASH', (id, seed) => getStringHash(String(id ?? ''), Number(seed ?? 0)));
}

// Read-only mode (read-only-mode.js): the existing db opens read-only on better-sqlite3, with no mkdir, no
// SCHEMA_SQL and no migrations, so a write through the store fails in SQLite (SQLITE_READONLY).
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<MetadataDbEntry>}
 */
async function openReadOnlyEntry(directories) {
    const DatabaseCtor = await getBetterSqlite3();
    if (!DatabaseCtor) {
        throw new Error('read-only mode needs better-sqlite3, which is not usable on this install');
    }
    const db = openNativeDatabase(DatabaseCtor, getDbPath(directories), { readonly: true });
    defineRandHash(db);
    /** @type {MetadataDbEntry} */
    const entry = { db, directories, batch: null, bootstrapPromise: null };
    entries.set(directories.root, entry);
    return entry;
}

// For one-off tooling that needs the schema/migrations applied (e.g. a pending NOT NULL backfill) without
// starting the server's own bootstrap background work - getEntry() itself starts neither.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export async function ensureSchemaMigrated(directories) {
    await getEntry(directories);
}

// Synchronous so mintCharacterId() can stay synchronous; it only sees a store getEntry() has already opened.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {boolean} `false` when no store is open for `directories`.
 */
export function characterRowOrPendingExistsSync(directories, avatar) {
    const entry = entries.get(directories.root);
    if (!entry?.db) return false;
    if (entry.batch?.pending.has(avatar) === true) return true;
    return Boolean(entry.db.get('SELECT 1 FROM characters WHERE id = @id', { id: avatar }));
}

// The only place a shallow object's digest_fav/digest_tag_ids/digest_content are computed - buildRow(),
// writeRowSync(), patchPendingRowTagIds(), and writeShallowJson() below all call this rather than hashing
// shallow's fields themselves, so there is exactly one computation to keep in sync with hash-utils.js.
/**
 * @param {object} shallow
 * @returns {{ digest_fav: number, digest_tag_ids: number, digest_content: number }}
 */
function digestColumnsForShallow(shallow) {
    return {
        digest_fav: characterDigestFavHash(shallow) % 4294967296,
        digest_tag_ids: characterDigestTagIdsHash(shallow),
        digest_content: characterDigestFieldsHash(shallow) % 4294967296,
    };
}

// The sole writer of an existing character row's shallow_json column (buildRow()'s initial INSERT and
// writeRowSync()'s pre-UPSERT row mutation are the only other places shallow_json is set, since those build a
// whole new row rather than UPDATE one - both call digestColumnsForShallow() directly for the same reason).
// Every UPDATE that touches shallow_json goes through this function, which always recomputes and writes
// digest_fav/digest_tag_ids/digest_content in the same statement: shallow_json cannot be written here without
// its digests, so they cannot drift out of step the way they previously did. It also writes the row's change
// entry, so a fav fix made here is listed in it.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @param {object} shallow
 * @param {string[]} fields The change entry's field list; 'fav' is appended when the fav fix below changed shallow.
 * @param {Record<string, unknown>} [extraColumns] Other columns to SET in the same statement (e.g. fav,
 * active_chat) so a caller's other column writes stay atomic with the shallow_json write.
 */
function writeShallowJson(db, id, shallow, fields, extraColumns = {}) {
    // Absent means never filled (backfillTagIdsInShallowJson() finds such rows by the missing key), so it is filled
    // from character_tags rather than stored as [].
    shallow.tag_ids = normalizeTagIds(Array.isArray(shallow.tag_ids) ? shallow.tag_ids : readCharacterTagIds(db, id));
    // shallow_json read back from a row normalizeCharacterFavIfNeeded() hasn't reached yet may disagree with the fav
    // column, which is authoritative. A fav in extraColumns is what this statement writes to that column.
    const favColumn = 'fav' in extraColumns
        ? extraColumns.fav
        : (/** @type {{ fav: number } | undefined} */ (db.get('SELECT fav FROM characters WHERE id = @id', { id })))?.fav;
    const changeFields = [...fields];
    if (favColumn !== undefined) {
        const fav = !!favColumn;
        const s = /** @type {{ fav?: unknown, data?: { extensions?: { fav?: unknown } } }} */ (shallow);
        if (s.fav !== fav || s.data?.extensions?.fav !== fav) {
            setShallowFav(s, fav);
            if (!changeFields.includes('fav')) changeFields.push('fav');
        }
    }
    // Everything that can throw is computed before the first write, so a row is written in full or not at all.
    const shallowJson = JSON.stringify(shallow);
    const digests = digestColumnsForShallow(shallow);
    const compared = { shallow_json: shallowJson, ...digests, ...extraColumns };
    const stored = /** @type {Record<string, any> | undefined} */ (db.get(
        `SELECT ${Object.keys(compared).join(', ')} FROM characters WHERE id = @id`, { id }));
    if (!stored) return;
    // Only the columns that changed are written; when none did, nothing is.
    const changed = changedValues(stored, compared);
    if (Object.keys(changed).length === 0) return;
    const changeSeq = insertChange(db, id, 'upsert', JSON.stringify(changeFields));
    writeRowIfChanged(db, 'characters', { id }, { ...changed, change_seq: Number(changeSeq) }, { current: stored });
}

/**
 * A stored shallow_json as readers get it: tag_ids resolved through tag_deletions.
 * @param {string} shallowJson
 * @param {import('./tag-deletions.js').TagDeletions} deletions
 * @returns {any}
 */
function parseShallowResolvingTags(shallowJson, deletions) {
    const shallow = JSON.parse(shallowJson);
    if (Array.isArray(shallow?.tag_ids)) shallow.tag_ids = resolveTagIds(shallow.tag_ids, deletions);
    return shallow;
}

/**
 * The tag_ids digest of a character row as readers get it: the stored digest_tag_ids, unless a marked tag is in
 * shallow_json.tag_ids, which is then hashed resolved (the digest parseShallowResolvingTags()' row hashes to).
 * @param {number} storedDigest
 * @param {string | null | undefined} shallowJson Needed only when `deletions` isn't empty.
 * @param {import('./tag-deletions.js').TagDeletions} deletions
 * @returns {number}
 */
function characterTagIdsDigestForReader(storedDigest, shallowJson, deletions) {
    if (!deletions.any || typeof shallowJson !== 'string') return storedDigest >>> 0;
    const tagIds = JSON.parse(shallowJson)?.tag_ids;
    const resolved = resolveTagIds(tagIds, deletions);
    return resolved === tagIds ? storedDigest >>> 0 : characterDigestTagIdsHash({ tag_ids: resolved }) >>> 0;
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @returns {string[]}
 */
function readCharacterTagIds(db, id) {
    return Array.from(db.iterate('SELECT tag_id FROM character_tags WHERE character_id = @id', { id }), row => /** @type {{ tag_id: string }} */ (row).tag_id);
}

// shallow_json's two fav fields both mirror the db-authoritative fav column.
/**
 * @param {{ fav?: unknown, data?: { extensions?: { fav?: unknown } } }} shallow Mutated in place.
 * @param {boolean} fav
 */
function setShallowFav(shallow, fav) {
    shallow.fav = fav;
    shallow.data = shallow.data ?? {};
    shallow.data.extensions = shallow.data.extensions ?? {};
    shallow.data.extensions.fav = fav;
}

// dateAddedCandidate is only used on a genuine insert.
/**
 * @param {string} id
 * @param {HoistedCharacterCard} character
 * @param {object} params
 * @param {number} params.dateAddedCandidate
 * @param {string | null} [params.contentHash]
 * @param {string | null} [params.contentIdentityHash]
 * @param {string | null} [params.avatarIdentityHash]
 * @param {string[]} [params.tagIds]
 * @param {string} params.cardJson
 * @returns {CharacterUpsertRow}
 */
function buildRow(id, character, { dateAddedCandidate, contentHash, contentIdentityHash, avatarIdentityHash, tagIds = [], cardJson }) {
    if (typeof cardJson !== 'string') throw new TypeError(`buildRow(${id}): cardJson is required (card_json is NOT NULL) - got ${typeof cardJson}`);
    const includeCreatorNotes = !!getConfigValue('performance.shallowCharactersIncludeCreatorNotes', false, 'boolean');
    const dataSize = calculateDataSize(character.data ?? {});
    const shallowSource = {
        ...character,
        avatar: id,
        date_added: dateAddedCandidate,
        date_last_chat: 0,
        chat_size: 0,
        data_size: dataSize,
        tag_ids: normalizeTagIds(tagIds),
    };
    const shallow = toShallow(shallowSource);
    // Falls back to the V2 mirror when the V1 top-level field is absent, same drift the other
    // V1_V2_FIELD_MAPPINGS fields get repaired for at read-time (character-card-normalize.js).
    const fav = normalizeFav(character.fav ?? _.get(/** @type {any} */ (character), 'data.extensions.fav'));
    setShallowFav(shallow, fav);
    return {
        id,
        name: character.name ?? '',
        name_fold: foldName(character.name),
        fav: fav ? 1 : 0,
        date_added: dateAddedCandidate,
        create_date: parseCreateDateToEpochMs(character.create_date),
        // A new row starts at 0/0 and is queued for reconcileQueuedChatStatsSync(); an existing row keeps its own.
        date_last_chat: 0,
        chat_size: 0,
        data_size: dataSize,
        // Card `data.*` extension fields are genuinely caller-arbitrary (Spec-V2), hence the `any` cast here.
        world: _.get(/** @type {any} */ (character), 'data.extensions.world', '') || null,
        creator: _.get(/** @type {any} */ (character), 'data.creator', '') || null,
        version: _.get(/** @type {any} */ (character), 'data.character_version', '') || null,
        creator_notes: includeCreatorNotes ? (_.get(/** @type {any} */ (character), 'data.creator_notes', '') || null) : null,
        shallow_json: JSON.stringify(shallow),
        ...digestColumnsForShallow(shallow),
        content_hash: contentHash ?? null,
        content_identity_hash: contentIdentityHash ?? null,
        avatar_identity_hash: avatarIdentityHash ?? null,
        import_poisoned: contentIdentityHash != null ? 0 : 1,
        active_chat: character.chat ?? null,
        active_chat_checked: 1,
        card_json: cardJson,
    };
}

/** The columns UPSERT_SQL sets on an existing row, other than change_seq. */
const UPSERT_UPDATED_COLUMNS = ['name', 'name_fold', 'fav', 'create_date', 'data_size', 'world', 'creator', 'version',
    'creator_notes', 'shallow_json', 'digest_fav', 'digest_tag_ids', 'digest_content', 'content_hash', 'content_identity_hash',
    'avatar_identity_hash', 'import_poisoned', 'active_chat', 'active_chat_checked', 'card_json'];

/**
 * The columns of the stored row `row` changes, by the rules UPSERT_SQL sets them on an existing row: the hash columns
 * and the two flags keep the stored value unless the row brings a new one.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {Record<string, any>} row
 * @returns {{ stored: Record<string, any>, changed: Record<string, any> }} `changed` is empty when the write would
 *   change nothing.
 */
function rowWriteChangesSync(db, row) {
    const stored = /** @type {Record<string, any>} */ (db.get(`SELECT ${UPSERT_UPDATED_COLUMNS.join(', ')}, change_seq FROM characters WHERE id = @id`, { id: row.id }));
    /** @type {Record<string, any>} */
    const next = {};
    for (const column of UPSERT_UPDATED_COLUMNS) next[column] = row[column];
    for (const column of ['content_hash', 'content_identity_hash', 'avatar_identity_hash']) next[column] = row[column] ?? stored[column];
    next.import_poisoned = row.import_poisoned === 0 ? 0 : stored.import_poisoned;
    next.active_chat_checked = row.active_chat_checked === 1 ? 1 : stored.active_chat_checked;
    return { stored, changed: changedValues(stored, next) };
}

// Meant to run inside db.transaction(...). tagIds only seeds a genuinely new row's tags on first INSERT -
// character_tags is the source of truth thereafter, so an UPDATE never touches it. fav and active_chat get the
// same one-time-seed treatment: once a row exists, a stale/foreign value from the card can't override them.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {CharacterUpsertRow} row
 * @param {string[]} tagIds
 */
function writeRowSync(db, row, tagIds) {
    const existingRow = (/** @type {{ fav: number, active_chat: NodeId, shallow_json: string, chat_size: number, date_last_chat: number, date_added: number } | undefined} */ (db.get('SELECT fav, active_chat, shallow_json, chat_size, date_last_chat, date_added FROM characters WHERE id = @id', { id: row.id })));
    const existed = !!existingRow;

    if (existed) {
        const currentFav = existingRow.fav ? 1 : 0;
        const favChanged = row.fav !== currentFav;
        // Only a non-NULL existing active_chat gets forced back; NULL means not-yet-examined or confirmed-no-chat,
        // so this write's freshly-resolved candidate is allowed to seed it.
        const forceActiveChat = existingRow.active_chat !== null && row.active_chat !== existingRow.active_chat;
        const currentTagIds = Array.from(/** @type {Iterable<{ tag_id: string }>} */ (db.iterate('SELECT tag_id FROM character_tags WHERE character_id = @id', { id: row.id })), r => r.tag_id);

        const shallow = JSON.parse(row.shallow_json);
        shallow.tag_ids = normalizeTagIds(currentTagIds);
        // The UPSERT keeps the row's chat stats and its write-once date_added, so the saved copy shows those too.
        shallow.chat_size = existingRow.chat_size;
        shallow.date_last_chat = existingRow.date_last_chat;
        shallow.date_added = existingRow.date_added;
        if (favChanged) {
            setShallowFav(shallow, !!currentFav);
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
            ...digestColumnsForShallow(shallow),
        };
    }

    if (existed) {
        // Only the columns this write changes are written; a write that changes none writes nothing.
        const { stored, changed } = rowWriteChangesSync(db, row);
        if (Object.keys(changed).length === 0) return;
        const changeSeq = Number(insertChange(db, row.id, 'upsert', null));
        writeRowIfChanged(db, 'characters', { id: row.id }, { ...changed, change_seq: changeSeq }, { current: stored });
        return;
    }

    const lastInsertRowid = insertChange(db, row.id, 'upsert', null);
    db.run(UPSERT_SQL, { ...row, changeSeq: Number(lastInsertRowid) });

    queueChatStatsReconcileSync(db, 'character', row.id);

    if (tagIds.length > 0) {
        const deletions = readTagDeletionsSync(db);
        const { tagIds: toAssign, dropped } = resolveTagIdsToAssign(tagIds, deletions);
        for (const tagId of toAssign) {
            db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@characterId, @tagId)', { characterId: row.id, tagId });
        }
        warnDeletedTagsNotAssigned(row.id, dropped);
        // row.shallow_json was built from the unresolved ids.
        if (tagIds.some(tagId => deletions.has(tagId))) syncShallowTagIdsFromTable(db, row.id);
    }
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 */
function deleteRowSync(db, id) {
    let deleted = db.run('DELETE FROM characters WHERE id = @id', { id }).changes;
    db.run('DELETE FROM activity_pending WHERE kind = \'character\' AND id = @id', { id });
    deleted += db.run('DELETE FROM character_tags WHERE character_id = @id', { id }).changes;
    deleted += db.run('DELETE FROM tag_names_held WHERE character_id = @id', { id }).changes;
    // Cascades: a local_import_mtimes row recorded as duplicate_of this character must not outlive it.
    deleted += db.run('DELETE FROM local_import_mtimes WHERE duplicate_of = @id', { id }).changes;
    if (deleted > 0) insertChange(db, id, 'delete', null);
}

// tags.json remains the write source of truth for tag assignment; this reads its mirror.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {string[]}
 */
function getTagIdsFor(directories, avatar) {
    const { tag_map } = readTagsData(directories);
    return tagMapEntryTagIds(tag_map, avatar);
}

/**
 * The tag ids a tag_map entry holds, each once. A value that isn't an array holds none, as upstream's
 * getTagsList() and tag import read it, and gets a warning naming it.
 * @param {Record<string, unknown>} tagMap
 * @param {string} key
 * @returns {string[]}
 */
function tagMapEntryTagIds(tagMap, key) {
    if (!Object.hasOwn(tagMap, key)) return [];
    const value = tagMap[key];
    if (!Array.isArray(value)) {
        warnTagMapEntryNotArray(key, value, 'read as no tags');
        return [];
    }
    return [...new Set(value)];
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {string} outcome What was done with the entry.
 */
function warnTagMapEntryNotArray(key, value, outcome) {
    console.warn(color.yellow(`[character-metadata] tag_map entry for ${key} is not a list, ${outcome}: ${JSON.stringify(value)}`));
}

/**
 * @param {string|null} [contentHash] sha256 of the raw uploaded source-file bytes; only the import route has one.
 * @param {string|null} [avatarIdentityHash] Hash of the image bytes actually written; null if no new image bytes.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {string} cardJson
 * @param {object} [options]
 * @param {boolean} [options.fromImport] Only the import path sets this: its row may wait in an open batch import's
 * buffer. Any other write lands in the table right away, with any buffered copy of the row written first.
 */
export async function upsertCharacterFromWrite(directories, avatar, cardJson, contentHash = null, avatarIdentityHash = null, { fromImport = false } = {}) {
    const entry = await getEntry(directories);
    // The store holds the only complete copy of a card, so a write it can't take must fail, never vanish.
    if (!entry) throw new Error(`The character store is unavailable, so "${avatar}" was not saved.`);

    let card;
    try {
        card = JSON.parse(cardJson);
    } catch (err) {
        throw new Error(`The card for "${avatar}" is not valid JSON, so it was not saved.`, { cause: err });
    }

    const contentIdentityHash = computeContentIdentityHash(card);
    // The row describes the card as every reader of card_json sees it (/batch, bootstrap, reconcile all read it
    // through getCharaCardV2()), except chat and fav: getCharaCardV2() invents a chat for a card without one and
    // drops a V2 card's top-level fav, and both only seed the row's db-authoritative columns.
    const character = {
        ...getCharaCardV2(JSON.parse(cardJson), directories, false),
        chat: card.chat,
        fav: card.fav ?? _.get(card, 'data.extensions.fav'),
    };
    const tagIds = getTagIdsFor(directories, avatar);
    const row = buildRow(avatar, character, { dateAddedCandidate: Date.now(), contentHash, contentIdentityHash, avatarIdentityHash, tagIds, cardJson });

    if (fromImport) {
        applyOrBuffer(entry, row, tagIds);
        return;
    }

    // The buffered copy goes first so its date_added and tag assignments are what this write finds in the table.
    /** @type {PendingRow | undefined} */
    let flushed;
    entry.db.transaction(() => {
        flushed = writeBufferedRowSync(entry, avatar);
        writeRowSync(entry.db, row, tagIds);
    });
    dropFromBuffer(entry, avatar, flushed);
}

// The one writer (besides a row's first INSERT) allowed to change fav. Pure metadata-store mutation - no PNG
// touch. Patches shallow_json's embedded fav too, so /query stays consistent with the column.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {boolean} fav
 * @returns {Promise<boolean>}
 */
export async function setCharacterFav(directories, avatar, fav) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    flushBufferedRow(entry, avatar);
    const existing = (/** @type {{ shallow_json: string } | undefined} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: avatar })));
    if (!existing) return false;

    const normalized = normalizeFav(fav);
    const shallow = JSON.parse(existing.shallow_json);
    setShallowFav(shallow, normalized);

    writeShallowJson(entry.db, avatar, shallow, ['fav'], { fav: normalized ? 1 : 0 });
    return true;
}

/**
 * Flips fav from what is stored, so the caller needs no copy of the character to know its current state.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<boolean|null>} The stored value after the flip, or `null` if no character has this avatar.
 */
export async function toggleCharacterFav(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    flushBufferedRow(entry, avatar);
    const existing = (/** @type {{ shallow_json: string, fav: number } | undefined} */ (entry.db.get('SELECT shallow_json, fav FROM characters WHERE id = @id', { id: avatar })));
    if (!existing) return null;

    const next = !existing.fav;
    const shallow = JSON.parse(existing.shallow_json);
    setShallowFav(shallow, next);

    writeShallowJson(entry.db, avatar, shallow, ['fav'], { fav: next ? 1 : 0 });
    return next;
}

// Mirrors setCharacterFav(): DB column + shallow_json mirror, no card file write.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {boolean} allowed
 * @returns {Promise<boolean>}
 */
export async function setCharacterAllowGlobalStyles(directories, avatar, allowed) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    flushBufferedRow(entry, avatar);
    const existing = (/** @type {{ shallow_json: string } | undefined} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: avatar })));
    if (!existing) return false;

    const shallow = JSON.parse(existing.shallow_json);
    shallow.allow_global_styles = !!allowed;

    writeShallowJson(entry.db, avatar, shallow, ['allow_global_styles'], { allow_global_styles: allowed ? 1 : 0 });
    return true;
}

// The one writer, other than a row's first INSERT, allowed to change active_chat. Mirrors setCharacterFav():
// never touches the PNG card file, pure metadata-store mutation. Patches shallow_json's embedded chat to match.
// No-op if this avatar isn't tracked yet - a row must exist for active_chat to mean anything.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {NodeId} chat
 * @returns {Promise<boolean>}
 */
export async function setCharacterActiveChat(directories, avatar, chat) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    flushBufferedRow(entry, avatar);
    const existing = (/** @type {{ shallow_json: string } | undefined} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: avatar })));
    if (!existing) return false;

    const shallow = JSON.parse(existing.shallow_json);
    shallow.chat = chat;

    // active_chat_checked = 1: this write is as authoritative a resolution as backfillActiveChatFromCards().
    writeShallowJson(entry.db, avatar, shallow, ['active_chat'], { active_chat: chat, active_chat_checked: 1 });
    return true;
}

// Kept well under SQLite's SQLITE_MAX_VARIABLE_NUMBER (999-32766 depending on build) so a chunked IN (...) query
// never exceeds it regardless of which sqlite-engine.js backend resolved.
const FAV_LOOKUP_BATCH_SIZE = 500;

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Record<string, boolean>>}
 */
export async function getCharacterFavsByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    /** @type {{[id: string]: boolean}} */
    const result = {};
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        for (const row of /** @type {Iterable<{ id: string, fav: number }>} */ (entry.db.iterate(`SELECT id, fav FROM characters WHERE id IN (${placeholders})`, batch))) {
            result[row.id] = !!row.fav;
        }
    }
    return result;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Record<string, boolean>>}
 */
export async function getGroupFavsByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    /** @type {{[id: string]: boolean}} */
    const result = {};
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        for (const row of /** @type {Iterable<{ id: string, fav: number }>} */ (entry.db.iterate(`SELECT id, fav FROM groups WHERE id IN (${placeholders})`, batch))) {
            result[row.id] = !!row.fav;
        }
    }
    return result;
}

/**
 * The group rows' chat_size and date_last_chat for `ids` via WHERE id IN (...), never scanning every row.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Map<string, { chatSize: number, dateLastChat: number }>>} Keyed by group id; an id with no row
 *   (or every id, when the metadata store is unavailable) is absent.
 */
export async function getGroupChatStatsByIds(directories, ids) {
    const entry = await getEntry(directories);
    /** @type {Map<string, { chatSize: number, dateLastChat: number }>} */
    const result = new Map();
    if (!entry || !Array.isArray(ids) || ids.length === 0) return result;

    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const rows = Array.from(/** @type {Iterable<{ id: string, chat_size: number, date_last_chat: number }>} */ (entry.db.iterate(`SELECT id, chat_size, date_last_chat FROM groups WHERE id IN (${placeholders})`, batch)));
        overlayActivitySync(entry.db, 'group', rows);
        for (const row of rows) {
            result.set(row.id, { chatSize: Number(row.chat_size), dateLastChat: Number(row.date_last_chat) });
        }
    }
    return result;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Record<string, boolean>>}
 */
export async function getCharacterAllowGlobalStylesByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    /** @type {{[id: string]: boolean}} */
    const result = {};
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        for (const row of /** @type {Iterable<{ id: string, allow_global_styles: number | null }>} */ (entry.db.iterate(`SELECT id, allow_global_styles FROM characters WHERE id IN (${placeholders})`, batch))) {
            if (row.allow_global_styles != null) {
                result[row.id] = !!row.allow_global_styles;
            }
        }
    }
    return result;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Record<string, string[]>>}
 */
export async function getCharacterTagIdsByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    // Distinguish "tracked but no tags" (-> []) from "not tracked" (-> omitted).
    /** @type {Set<string>} */
    const trackedIds = new Set();
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        for (const row of /** @type {Iterable<{ id: string }>} */ (entry.db.iterate(`SELECT id FROM characters WHERE id IN (${placeholders})`, batch))) {
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
        for (const row of /** @type {Iterable<{ character_id: string, tag_id: string }>} */ (entry.db.iterate(`SELECT character_id, tag_id FROM character_tags WHERE character_id IN (${placeholders})`, batch))) {
            if (Object.hasOwn(result, row.character_id)) {
                result[row.character_id].push(row.tag_id);
            }
        }
    }
    // Sorted in JS even after ORDER BY: SQLite compares UTF-8 bytes, normalizeTagIds() UTF-16 code units.
    const deletions = readTagDeletionsSync(entry.db);
    for (const id of Object.keys(result)) {
        result[id] = resolveTagIds(normalizeTagIds(result[id]), deletions);
    }
    return result;
}

// Unlike getCharacterFavsByIds() (which reports every tracked id's real boolean), this omits a tracked-but-NULL
// row from the result, not just an untracked one: "absent" uniformly means "no chat to stamp, leave it alone".
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Record<string, string>>}
 */
export async function getCharacterActiveChatsByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    /** @type {{[id: string]: string}} */
    const result = {};
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        for (const row of /** @type {Iterable<{ id: string, active_chat: string }>} */ (entry.db.iterate(`SELECT id, active_chat FROM characters WHERE id IN (${placeholders}) AND active_chat IS NOT NULL`, batch))) {
            result[row.id] = row.active_chat;
        }
    }
    return result;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Record<string, object>>}
 */
export async function getShallowByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    const deletions = readTagDeletionsSync(entry.db);
    /** @type {{[id: string]: object}} */
    const result = {};
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        /** @type {{ id: string, chat_size: number, date_last_chat: number, shallow: any }[]} */
        const parsed = [];
        for (const row of /** @type {Iterable<{ id: string, shallow_json: string }>} */ (entry.db.iterate(`SELECT id, shallow_json FROM characters WHERE id IN (${placeholders})`, batch))) {
            try {
                const shallow = parseShallowResolvingTags(row.shallow_json, deletions);
                parsed.push({ id: row.id, chat_size: Number(shallow?.chat_size ?? 0), date_last_chat: Number(shallow?.date_last_chat ?? 0), shallow });
            } catch {
                // Skip unparseable rows - same tolerance every other shallow_json consumer has.
            }
        }
        overlayActivitySync(entry.db, 'character', parsed, r => r.shallow);
        for (const row of parsed) result[row.id] = row.shallow;
    }
    return result;
}

/**
 * Each given id's `name` column, for ids that have a row. Callers pass a bounded list; ids without a row are absent
 * from the map.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Map<string, string>>}
 */
export async function getCharacterNamesByIds(directories, ids) {
    /** @type {Map<string, string>} */
    const map = new Map();
    const entry = await getEntry(directories);
    if (!entry || ids.length === 0) return map;
    for (const row of /** @type {Generator<{ id: string, name: string }>} */ (entry.db.iterate('SELECT id, name FROM characters WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)]))) {
        map.set(String(row.id), String(row.name));
    }
    return map;
}

// null means no row exists for this avatar yet (not yet reconciled, or never existed) - once a row exists,
// card_json is NOT NULL.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<string | null>}
 */
export async function getCharacterCardJson(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = (/** @type {{ card_json: string | null } | undefined} */ (entry.db.get('SELECT card_json FROM characters WHERE id = @id', { id: avatar })));
    return row?.card_json ?? null;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<{ chatSize: number, dateLastChat: number } | null>} The row's chat_size and date_last_chat, or
 *   null when it has no row (or the metadata store is unavailable).
 */
export async function getCharacterChatStats(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = (/** @type {{ id: string, chat_size: number, date_last_chat: number } | undefined} */ (entry.db.get('SELECT id, chat_size, date_last_chat FROM characters WHERE id = @id', { id: avatar })));
    if (!row) return null;
    overlayActivitySync(entry.db, 'character', [row]);
    return { chatSize: Number(row.chat_size), dateLastChat: Number(row.date_last_chat) };
}

/**
 * @typedef {{ id: string, name: string, card_json: string, chat_size: number, date_last_chat: number }} CharacterIndexRow
 */

/** The rows of `ids` via WHERE id IN (...), never scanning every row. The caller keeps `ids` bounded (one request's
 * ids, one batch of a stream), so only those rows' card_json is ever in memory.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Map<string, CharacterIndexRow>>}
 */
export async function getCharacterIndexRowsByIds(directories, ids) {
    const entry = await getEntry(directories);
    /** @type {Map<string, CharacterIndexRow>} */
    const result = new Map();
    if (!entry || ids.length === 0) return result;

    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const rows = Array.from(/** @type {Iterable<CharacterIndexRow>} */ (entry.db.iterate(`SELECT id, name, card_json, chat_size, date_last_chat FROM characters WHERE id IN (${placeholders})`, batch)));
        overlayActivitySync(entry.db, 'character', rows);
        for (const row of rows) result.set(row.id, row);
    }
    return result;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 */
export async function deleteCharacterRow(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return;

    if (entry.batch) {
        entry.batch.pending.delete(avatar);
    }
    entry.db.transaction(() => deleteRowSync(entry.db, avatar));
}

// Corrects date_added on a rename (the generic write hook treats newAvatar as brand-new) and unions
// oldAvatar's tags into newAvatar. newAvatar must already have a row (in the table or the batch buffer): without
// one, the copied tags would point at a missing character, so this throws before writing anything.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} oldAvatar
 * @param {string} newAvatar
 * @returns {Promise<{ copiedOrphanTagIds: string[] } | undefined>} copiedOrphanTagIds: the tag ids copied from
 * oldAvatar while oldAvatar itself had no row, so the caller can list them.
 */
export async function renameCharacterRow(directories, oldAvatar, newAvatar) {
    const entry = await getEntry(directories);
    if (!entry) return;

    if (entry.batch?.pending.has(newAvatar) !== true && !entry.db.get('SELECT 1 FROM characters WHERE id = @id', { id: newAvatar })) {
        throw new Error(`Cannot rename character ${oldAvatar} to ${newAvatar}: ${newAvatar} has no metadata row, so nothing was changed`);
    }
    // oldAvatar's buffered copy too: its date_added and tags carry over, and deleting only its table row would
    // leave the copy to be written back when the import ends.
    flushBufferedRow(entry, oldAvatar);
    flushBufferedRow(entry, newAvatar);

    const oldRow = (/** @type {{ date_added: number } | undefined} */ (entry.db.get('SELECT date_added FROM characters WHERE id = @id', { id: oldAvatar })));
    if (oldRow) {
        const dateAdded = Number(oldRow.date_added);
        // Checked to exist at the top and flushed into the table if it was buffered, with no await in between.
        const newRow = (/** @type {{ shallow_json: string }} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: newAvatar })));
        const shallow = JSON.parse(withPatchedDateAdded(newRow.shallow_json, dateAdded));
        writeShallowJson(entry.db, newAvatar, shallow, ['date_added'], { date_added: dateAdded });
    }

    // Must read before the transaction below deletes oldAvatar's rows.
    const oldTagIds = Array.from(/** @type {Iterable<{ tag_id: string }>} */ (entry.db.iterate('SELECT tag_id FROM character_tags WHERE character_id = @id', { id: oldAvatar })), r => r.tag_id);
    if (oldTagIds.length > 0) {
        entry.db.transaction(() => {
            for (const tagId of oldTagIds) {
                entry.db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@newAvatar, @tagId)', { newAvatar, tagId });
            }
            syncShallowTagIdsFromTable(entry.db, newAvatar);
        });
    }

    entry.db.transaction(() => {
        entry.db.run('UPDATE OR IGNORE tag_names_held SET character_id = @newAvatar WHERE character_id = @oldAvatar', { newAvatar, oldAvatar });
        deleteRowSync(entry.db, oldAvatar);
    });
    return { copiedOrphanTagIds: oldRow ? [] : oldTagIds };
}

/**
 * Writes avatar's buffered batch-import row, if it has one, to the characters table. Leaves it in the buffer, since
 * the caller's transaction can still roll back: once that commits, the caller passes the result to dropFromBuffer().
 * @param {MetadataDbEntry} entry
 * @param {string} avatar
 * @returns {PendingRow | undefined} The row written.
 */
function writeBufferedRowSync(entry, avatar) {
    const pending = entry.batch?.pending.get(avatar);
    if (!pending) return undefined;
    writeRowSync(entry.db, pending.row, pending.tagIds);
    return pending;
}

/**
 * writeBufferedRowSync() for an avatar that already has a characters row. A tag change can't wait in such a row's
 * buffer entry: at flush, writeRowSync() keeps an existing row's tags from character_tags, so the buffered ones are
 * dropped. The caller writes its tag change to the table after this, then passes the result to dropFromBuffer().
 * @param {MetadataDbEntry} entry
 * @param {string} avatar
 * @returns {PendingRow | undefined} The row written.
 */
function writeBufferedRowOverExistingSync(entry, avatar) {
    if (entry.batch?.pending.has(avatar) !== true) return undefined;
    if (!entry.db.get('SELECT 1 FROM characters WHERE id = @id', { id: avatar })) return undefined;
    return writeBufferedRowSync(entry, avatar);
}

/**
 * writeBufferedRowSync() in its own transaction, then dropFromBuffer(). A user request's write calls this first, so
 * it lands on the table row right away instead of waiting in the buffer for the import to end.
 * @param {MetadataDbEntry} entry
 * @param {string} avatar
 */
function flushBufferedRow(entry, avatar) {
    if (entry.batch?.pending.has(avatar) !== true) return;
    /** @type {PendingRow | undefined} */
    let flushed;
    entry.db.transaction(() => {
        flushed = writeBufferedRowSync(entry, avatar);
    });
    dropFromBuffer(entry, avatar, flushed);
}

/**
 * @param {MetadataDbEntry} entry
 * @param {string} avatar
 * @param {PendingRow | undefined} written writeBufferedRowSync()'s result, from a committed transaction.
 */
function dropFromBuffer(entry, avatar, written) {
    if (written && entry.batch?.pending.get(avatar) === written) {
        entry.batch.pending.delete(avatar);
    }
}

/** Returns `shallowJson` with its `date_added` field overwritten; unmodified if it doesn't parse. */
/**
 * @param {string} shallowJson
 * @param {number} dateAdded
 * @returns {string}
 */
function withPatchedDateAdded(shallowJson, dateAdded) {
    try {
        const parsed = JSON.parse(shallowJson);
        parsed.date_added = dateAdded;
        return JSON.stringify(parsed);
    } catch {
        return shallowJson;
    }
}

/** Overwrites date_added unconditionally - one of the two exceptions to it being write-once in this module; the
 * other is renameCharacterRow(), which carries oldAvatar's date_added over to newAvatar. */
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {number} dateAddedMs
 */
export async function setCharacterDateAdded(directories, id, dateAddedMs) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const pending = entry.batch?.pending.get(id);
    if (pending) {
        pending.row.date_added = dateAddedMs;
        pending.row.shallow_json = withPatchedDateAdded(pending.row.shallow_json, dateAddedMs);
        return;
    }

    const row = (/** @type {{ shallow_json: string } | undefined} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id })));
    if (!row) return;
    const shallow = JSON.parse(withPatchedDateAdded(row.shallow_json, dateAddedMs));
    writeShallowJson(entry.db, id, shallow, ['date_added'], { date_added: dateAddedMs });
}

/**
 * @param {MetadataDbEntry} entry
 * @param {CharacterUpsertRow} row
 * @param {string[]} tagIds
 */
function applyOrBuffer(entry, row, tagIds) {
    if (entry.batch) {
        entry.batch.pending.set(row.id, { row, tagIds });
        if (entry.batch.pending.size >= BATCH_IMPORT_FLUSH_SIZE) {
            try {
                flushBatch(entry);
            } catch (err) {
                // This row's write fails with the flush and its caller takes the file back, so the row must not
                // be committed by a later flush. The other buffered rows stay for the next flush.
                if (entry.batch.pending.get(row.id)?.row === row) entry.batch.pending.delete(row.id);
                throw err;
            }
        }
        return;
    }

    entry.db.transaction(() => writeRowSync(entry.db, row, tagIds));
}

/**
 * @param {MetadataDbEntry} entry
 */
function flushBatch(entry) {
    if (!entry.batch || entry.batch.pending.size === 0) return;
    const rows = [...entry.batch.pending.values()];
    entry.db.transaction(() => {
        for (const { row, tagIds } of rows) {
            writeRowSync(entry.db, row, tagIds);
        }
    });
    // Cleared only once committed: a failed commit keeps the rows for the next flush instead of dropping them.
    for (const { row } of rows) {
        if (entry.batch.pending.get(row.id)?.row === row) entry.batch.pending.delete(row.id);
    }
}

// Buffers writes - but only up to BATCH_IMPORT_FLUSH_SIZE rows at a time; flushBatch() commits and clears the
// buffer well before endBatchImport(), so a crash mid-pass loses at most one still-open buffer, not the whole
// pass. Idempotent.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export async function beginBatchImport(directories) {
    const entry = await getEntry(directories);
    if (!entry || entry.batch) return;

    entry.batch = { pending: new Map() };
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export async function endBatchImport(directories) {
    const entry = await getEntry(directories);
    if (!entry || !entry.batch) return;

    flushBatch(entry);
    entry.batch = null;
}

// Commits whatever an open batch import has buffered so far and leaves batch mode on - for a caller about to record
// that its own writes are done, which must not outlive a crash that loses the buffer. No-op outside batch mode.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export async function flushBatchImport(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    flushBatch(entry);
}

// One-time backfill for a library predating this metadata store. Seeds date_added from ctimeMs, recorded in meta so it runs once.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export async function bootstrapIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = (/** @type {{ value: string } | undefined} */ (entry.db.get('SELECT value FROM meta WHERE key = @key', { key: 'bootstrap_completed' })));
    if (already) return;

    if (!fs.existsSync(directories.characters)) {
        setMetaSync(entry.db, 'bootstrap_completed', String(Date.now()));
        return;
    }

    const files = (await fsPromises.readdir(directories.characters)).filter(f => f.endsWith('.png'));

    const { tag_map } = readTagsData(directories);

    const progress = new ProgressLog({ what: '[character-metadata] reading character cards into the index', total: files.length });

    // Chunked with bounded concurrency per chunk to bound peak memory to one chunk's worth of computed rows.
    // A file whose character already has a row is never read: the row is the source of truth for its card and
    // tags (a png's own card can be stale or stripped), so a rerun on an existing library only adds what's missing.
    for (let i = 0; i < files.length; i += BATCH_FLUSH_SIZE) {
        const chunkFiles = files.slice(i, i + BATCH_FLUSH_SIZE);
        const existingIds = knownEntityIdsOf(entry.db, 'characters', chunkFiles);
        const newFiles = chunkFiles.filter(file => !existingIds.has(file));
        const chunkResults = await mapWithConcurrency(newFiles, BOOTSTRAP_READ_CONCURRENCY, async (file) => {
            try {
                const filePath = path.join(directories.characters, file);
                const stat = await fsPromises.stat(filePath);
                const rawBuffer = await fsPromises.readFile(filePath);
                const imgData = readCharacterCardFromBuffer(rawBuffer);
                const avatarIdentityHash = computeAvatarIdentityHashFromChunks(extract(new Uint8Array(rawBuffer)));
                const character = getCharaCardV2(JSON.parse(imgData), directories, false);
                const tagIds = tagMapEntryTagIds(tag_map, file);
                const row = buildRow(file, character, { dateAddedCandidate: Math.round(stat.ctimeMs), avatarIdentityHash, tagIds, cardJson: imgData });
                return { row, tagIds };
            } catch (err) {
                console.error(`[character-metadata] Bootstrap failed to process ${file}, skipping it this pass (the reconciler will retry it):`, /** @type {any} */ (err).message);
                return null;
            }
        });

        const pending = chunkResults.filter((r) => r !== null);
        if (pending.length > 0) {
            entry.db.transaction(() => {
                for (const { row, tagIds } of pending) {
                    writeRowSync(entry.db, row, tagIds);
                }
            });
        }

        progress.add(chunkFiles.length);

        await new Promise(resolve => setImmediate(resolve));
    }

    if (files.length > 0) progress.finish();

    setMetaSync(entry.db, 'bootstrap_completed', String(Date.now()));
}

// Backfills content_identity_hash for poisoned rows without clearing import_poisoned (see SCHEMA_SQL). Reads
// the PNG's pristine 'chara' chunk, which stays valid even when 'ccv3' doesn't.
// Resumable without a meta flag: re-queries import_poisoned=1 AND content_identity_hash IS NULL every call.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export async function backfillContentIdentityHashes(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    if (!getConfigValue('performance.allowExpensiveDuplicateFallback', true, 'boolean')) return;

    if (!fs.existsSync(directories.characters)) return;

    const progress = new ProgressLog({ what: '[character-metadata] working out content fingerprints for cards imported with damaged data' });

    // Paged by rowid, not id: idx_characters_import_poisoned keeps rowid order within import_poisoned = 1, so a page
    // seeks instead of sorting every match.
    for await (const rows of streamRows(entry.db, {
        firstPageSql: 'SELECT rowid AS rid, id FROM characters WHERE import_poisoned = 1 AND content_identity_hash IS NULL ORDER BY rowid LIMIT @limit',
        firstPageParams: {},
        nextPageSql: 'SELECT rowid AS rid, id FROM characters WHERE import_poisoned = 1 AND content_identity_hash IS NULL AND rowid > @after ORDER BY rowid LIMIT @limit',
        nextPageParams: {},
        keyColumn: 'rid',
    })) {
        const poisonedIds = (/** @type {{ rid: number, id: string }[]} */ (rows)).map(r => r.id);
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
                    console.error(`[character-metadata] Content-identity backfill failed to process ${id}, leaving it poisoned (will retry next boot):`, /** @type {any} */ (err).message);
                    return null;
                }
            });

            const updates = chunkResults.filter((r) => r !== null);
            if (updates.length > 0) {
                entry.db.transaction(() => {
                    for (const { id, hash, avatarHash } of updates) {
                        const stored = /** @type {{ avatar_identity_hash: string | null } | undefined} */ (entry.db.get('SELECT avatar_identity_hash FROM characters WHERE id = @id', { id }));
                        writeRowIfChanged(entry.db, 'characters', { id }, { content_identity_hash: hash, avatar_identity_hash: stored?.avatar_identity_hash ?? avatarHash });
                    }
                });
            }

            progress.add(chunkIds.length);

            await new Promise(resolve => setImmediate(resolve));
        }
    }

    if (progress.done > 0) progress.finish();
}

// Keyed on active_chat_checked, not active_chat IS NULL, since the latter can't distinguish "confirmed no
// chat" from "not examined". Resumable without a flag: re-queries active_chat_checked = 0 every call.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export async function backfillActiveChatFromCards(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    if (!fs.existsSync(directories.characters)) return;

    const progress = new ProgressLog({ what: '[character-metadata] reading each card\'s last opened chat' });

    // Paged by rowid, not id: idx_characters_active_chat_checked keeps rowid order within active_chat_checked = 0, so a
    // page seeks instead of sorting every match.
    for await (const rows of streamRows(entry.db, {
        firstPageSql: 'SELECT rowid AS rid, id FROM characters WHERE active_chat_checked = 0 ORDER BY rowid LIMIT @limit',
        firstPageParams: {},
        nextPageSql: 'SELECT rowid AS rid, id FROM characters WHERE active_chat_checked = 0 AND rowid > @after ORDER BY rowid LIMIT @limit',
        nextPageParams: {},
        keyColumn: 'rid',
    })) {
        const uncheckedIds = (/** @type {{ rid: number, id: string }[]} */ (rows)).map(r => r.id);
        for (let i = 0; i < uncheckedIds.length; i += BATCH_FLUSH_SIZE) {
            const chunkIds = uncheckedIds.slice(i, i + BATCH_FLUSH_SIZE);
            const chunkResults = await mapWithConcurrency(chunkIds, BOOTSTRAP_READ_CONCURRENCY, async (id) => {
                try {
                    const filePath = path.join(directories.characters, id);
                    const imgData = await parseCharacterCard(filePath, 'png');
                    const character = JSON.parse(imgData);
                    const chat = character.chat ?? null;
                    return { id, chat, resolved: true };
                } catch (err) {
                    console.error(`[character-metadata] Active-chat backfill failed to process ${id}, leaving it unchecked (will retry next boot):`, /** @type {any} */ (err).message);
                    return { id, resolved: false };
                }
            });

            const resolved = chunkResults.filter(r => r.resolved);
            if (resolved.length > 0) {
                entry.db.transaction(() => {
                    for (const { id, chat } of resolved) {
                        const stored = /** @type {{ active_chat_checked: number } | undefined} */ (entry.db.get('SELECT active_chat_checked FROM characters WHERE id = @id', { id }));
                        if (stored && stored.active_chat_checked === 0) writeRowIfChanged(entry.db, 'characters', { id }, { active_chat: chat ?? null, active_chat_checked: 1 });
                    }
                });
            }

            progress.add(chunkIds.length);

            await new Promise(resolve => setImmediate(resolve));
        }
    }

    if (progress.done > 0) progress.finish();
}

const MIGRATION_BATCH_PAUSE_MS = 10;
const MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES = 10;
/**
 * Sets a meta value, writing nothing when it already holds that value.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} key
 * @param {string} value
 */
function setMetaSync(db, key, value) {
    writeRowIfChanged(db, 'meta', { key }, { value }, { insert: true });
}

/** @typedef {{ batches: number, rowsChanged: number }} CharacterPassResult */

/**
 * A one-time pass over every row of a table that resumes after the last batch it committed. The batch's rows are
 * re-read by prepareRow inside the batch's own transaction, so no other connection's write lands between read and
 * write. The pause between batches lets other writers take the lock. A row whose prepareRow throws is left as it is
 * and keeps doneKey unset; progressKey is still cleared at the end, so the next run retries from the first row
 * rather than past it. A write that throws rolls back its whole batch and fails the pass, leaving progressKey at the
 * last committed batch.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {object} options
 * @param {'characters' | 'groups'} [options.table] The table whose rows (by id) the pass walks.
 * @param {string} options.doneKey
 * @param {string} options.doneValue
 * @param {string} options.progressKey
 * @param {string} options.label
 * @param {boolean} [options.logProgress]
 * @param {(id: string) => (null | (() => void))} options.prepareRow Does every read, parse and computation for the
 *   row and returns its writes, or null if it needs none. Neither may change anything outside the database, since a
 *   transaction that hits busy is rolled back and rerun.
 * @param {() => void} [options.onBatchStart] Runs first inside each batch's transaction, including a rerun after
 *   busy, so batch-local state the rows build up can be reset there.
 * @param {() => void} [options.onBatchCommitted] Runs once each batch has committed.
 * @param {() => void} [options.finish] Runs inside the final transaction, before doneKey is written.
 * @returns {Promise<CharacterPassResult>}
 */
async function runResumableCharacterPass(db, { table = 'characters', doneKey, doneValue, progressKey, label, logProgress = false, prepareRow, onBatchStart, onBatchCommitted, finish }) {
    const saved = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: progressKey }));
    const nextPageSql = `SELECT id FROM ${table} WHERE id > @after ORDER BY id LIMIT @limit`;
    const pages = saved
        ? streamRows(db, { firstPageSql: nextPageSql, firstPageParams: { after: saved.value }, nextPageSql, nextPageParams: {}, keyColumn: 'id' })
        : streamRows(db, { firstPageSql: `SELECT id FROM ${table} ORDER BY id LIMIT @limit`, firstPageParams: {}, nextPageSql, nextPageParams: {}, keyColumn: 'id' });
    let batches = 0;
    let rowsChanged = 0;
    let rowsFailed = 0;
    const progress = logProgress
        ? new ProgressLog({
            what: `[character-metadata] ${label}`,
            total: Number(/** @type {{ n: number }} */ (saved
                ? db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE id > @after`, { after: saved.value })
                : db.get(`SELECT COUNT(*) AS n FROM ${table}`, {})).n),
        })
        : null;
    for await (const rows of pages) {
        const ids = /** @type {{ id: string }[]} */ (rows).map(r => r.id);
        let batchChanged = 0;
        /** @type {{ id: string, message: string }[]} */
        let batchFailed = [];
        db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            batchChanged = 0;
            batchFailed = [];
            onBatchStart?.();
            for (const id of ids) {
                let write;
                try {
                    write = prepareRow(id);
                } catch (err) {
                    batchFailed.push({ id, message: String(/** @type {any} */ (err)?.message ?? err) });
                    continue;
                }
                if (write) {
                    write();
                    batchChanged++;
                }
            }
            setMetaSync(db, progressKey, ids[ids.length - 1]);
        });
        onBatchCommitted?.();
        batches++;
        rowsChanged += batchChanged;
        rowsFailed += batchFailed.length;
        if (batchFailed.length > 0) {
            console.warn(color.yellow(`[character-metadata] ${label}: ${batchFailed.length} row(s) failed and were left as they are:\n${batchFailed.map(f => `  ${f.id}: ${f.message}`).join('\n')}`));
        }
        if (batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0) {
            if (!isReadOnlyMode()) db.get('PRAGMA wal_checkpoint(PASSIVE)');
        }
        progress?.add(ids.length);
        await delay(MIGRATION_BATCH_PAUSE_MS);
    }

    db.transaction(() => {
        finish?.();
        if (rowsFailed === 0) {
            setMetaSync(db, doneKey, doneValue);
        }
        db.run('DELETE FROM meta WHERE key = @key', { key: progressKey });
    });
    if (!isReadOnlyMode()) db.checkpoint();
    if (rowsFailed > 0) {
        console.warn(color.yellow(`[character-metadata] ${label}: ${rowsFailed} row(s) failed (listed above); not marked done, so it runs again from the first row next boot.`));
    }
    progress?.finish(`${rowsChanged.toLocaleString('en-US')} changed`);
    return { batches, rowsChanged };
}

// The NOT LIKE test can't use an index, so it is applied per row within each bounded batch rather than as a
// discovery query over the whole table.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>}
 */
export async function backfillTagIdsInShallowJson(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = (/** @type {{ value: string } | undefined} */ (entry.db.get('SELECT value FROM meta WHERE key = \'tag_ids_shallow_json_backfill_completed\'')));
    if (already) return { batches: 0, rowsChanged: 0 };

    return runResumableCharacterPass(entry.db, {
        doneKey: 'tag_ids_shallow_json_backfill_completed',
        doneValue: '1',
        progressKey: 'tag_ids_shallow_json_backfill_progress',
        label: 'tag_ids shallow_json backfill',
        logProgress: true,
        prepareRow: (id) => {
            const row = (/** @type {{ shallow_json: string } | undefined} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id AND shallow_json NOT LIKE \'%"tag_ids":%\'', { id })));
            if (!row) return null;
            if (row.shallow_json.includes('"tag_ids":')) return null;
            const shallow = JSON.parse(row.shallow_json);
            shallow.tag_ids = readCharacterTagIds(entry.db, id);
            return () => writeShallowJson(entry.db, id, shallow, ['tag_ids']);
        },
    });
}

const CHARACTER_FAV_NORMALIZED_FLAG = 'character_fav_normalized_v1';

// One-time pass re-deriving shallow_json's two fav fields (and so digest_fav) from the fav column, which it never
// writes. A row whose shallow_json changes gets a ['fav'] change-log entry and change_seq bump, so clients learn
// of it through the feed; a row whose fields already match only has a stale digest_fav corrected, with no entry.
// Each row is re-read inside its batch's transaction, so a concurrent fav write can't be overwritten with a
// stale value.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>}
 */
export async function normalizeCharacterFavIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    if (entry.db.get('SELECT 1 FROM meta WHERE key = @key', { key: CHARACTER_FAV_NORMALIZED_FLAG })) return { batches: 0, rowsChanged: 0 };

    return runResumableCharacterPass(entry.db, {
        doneKey: CHARACTER_FAV_NORMALIZED_FLAG,
        doneValue: String(Date.now()),
        progressKey: `${CHARACTER_FAV_NORMALIZED_FLAG}_progress`,
        label: 'Character fav normalization',
        prepareRow: (id) => {
            const row = (/** @type {{ fav: number, shallow_json: string, digest_fav: number } | undefined} */ (entry.db.get('SELECT fav, shallow_json, digest_fav FROM characters WHERE id = @id', { id })));
            if (!row) return null;
            const fav = !!row.fav;
            const shallow = JSON.parse(row.shallow_json);
            if (shallow.fav !== fav || shallow.data?.extensions?.fav !== fav) {
                setShallowFav(shallow, fav);
                return () => writeShallowJson(entry.db, id, shallow, ['fav']);
            }
            const { digest_fav } = digestColumnsForShallow(shallow);
            if (Number(row.digest_fav) === digest_fav) return null;
            return () => writeRowIfChanged(entry.db, 'characters', { id }, { digest_fav });
        },
    });
}

const CHARACTER_TAG_IDS_NORMALIZED_FLAG = 'character_tag_ids_normalized_v1';

// One-time pass sorting shallow_json.tag_ids written before writes sorted it. A reordered row gets a ['tag_ids']
// change-log entry and change_seq bump; digest_tag_ids already sorts, so it doesn't change. A row with no tag_ids
// is left to backfillTagIdsInShallowJson(). Each row is re-read inside its batch's transaction, so a concurrent
// tag write can't be overwritten with a stale value.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>}
 */
export async function normalizeCharacterTagIdsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    if (entry.db.get('SELECT 1 FROM meta WHERE key = @key', { key: CHARACTER_TAG_IDS_NORMALIZED_FLAG })) return { batches: 0, rowsChanged: 0 };

    return runResumableCharacterPass(entry.db, {
        doneKey: CHARACTER_TAG_IDS_NORMALIZED_FLAG,
        doneValue: String(Date.now()),
        progressKey: `${CHARACTER_TAG_IDS_NORMALIZED_FLAG}_progress`,
        label: 'Character tag_ids normalization',
        prepareRow: (id) => {
            const row = (/** @type {{ shallow_json: string } | undefined} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id })));
            if (!row) return null;
            const shallow = JSON.parse(row.shallow_json);
            if (!Array.isArray(shallow.tag_ids)) return null;
            if (JSON.stringify(shallow.tag_ids) === JSON.stringify(normalizeTagIds(shallow.tag_ids))) return null;
            return () => writeShallowJson(entry.db, id, shallow, ['tag_ids']);
        },
    });
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {'characters' | 'groups'} table
 * @param {string[]} ids at most FAV_LOOKUP_BATCH_SIZE
 * @returns {Set<string>} the ones with a row in `table`
 */
function knownEntityIdsOf(db, table, ids) {
    /** @type {Set<string>} */
    const known = new Set();
    if (ids.length === 0) return known;
    const placeholders = ids.map(() => '?').join(',');
    for (const row of db.iterate(`SELECT id FROM ${table} WHERE id IN (${placeholders})`, ids)) {
        known.add(/** @type {{ id: string }} */ (row).id);
    }
    return known;
}

// Existing files are never re-read: card_json is authoritative, so only files with no row are parsed.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
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
    const storedRow = (/** @type {{ value: string } | undefined} */ (entry.db.get('SELECT value FROM meta WHERE key = \'last_reconcile_dir_mtime_ms\'')));
    if (storedRow !== undefined && Number(storedRow.value) === currentDirMtimeMs) {
        return;
    }

    // The directory is read BATCH_FLUSH_SIZE names at a time, and each batch is checked against the db with one
    // IN (...) read, so neither the file list nor the set of known ids is ever held whole. The number of new files
    // isn't known until the pass ends, so the progress line has no total or ETA.
    const progress = new ProgressLog({ what: '[character-metadata] adding new card files found in the characters folder' });

    /**
     * @param {string[]} batchFiles
     */
    const processBatch = async (batchFiles) => {
        /** @type {Set<string>} */
        const existingIds = new Set();
        for (const row of /** @type {Generator<{ id: string }>} */ (entry.db.iterate(`SELECT id FROM characters WHERE id IN (${batchFiles.map(() => '?').join(', ')})`, batchFiles))) {
            existingIds.add(row.id);
        }
        const newFiles = batchFiles.filter(f => !existingIds.has(f));

        if (newFiles.length > 0) {
            const chunkResults = await mapWithConcurrency(newFiles, BOOTSTRAP_READ_CONCURRENCY, async (file) => {
                try {
                    const filePath = path.join(directories.characters, file);
                    const rawBuffer = await fsPromises.readFile(filePath);
                    const imgData = readCharacterCardFromBuffer(rawBuffer);
                    const avatarIdentityHash = computeAvatarIdentityHashFromChunks(extract(new Uint8Array(rawBuffer)));
                    const character = getCharaCardV2(JSON.parse(imgData), directories, false);
                    const tagIds = getTagIdsFor(directories, file);
                    const row = buildRow(file, character, { dateAddedCandidate: Date.now(), avatarIdentityHash, tagIds, cardJson: imgData });
                    return { row, tagIds };
                } catch (err) {
                    console.error(`[character-metadata] Reconcile failed to process ${file}, will retry next boot:`, /** @type {any} */ (err).message);
                    return null;
                }
            });

            for (const result of chunkResults) {
                if (result) {
                    applyOrBuffer(entry, result.row, result.tagIds);
                }
            }

            progress.add(newFiles.length);
        }

        // A pause between batches, so a large folder never holds up requests.
        await new Promise(resolve => setImmediate(resolve));
    };

    /** @type {string[]} */
    let batchFiles = [];
    // `for await` closes the directory handle when the loop ends or throws.
    for await (const dirent of await fsPromises.opendir(directories.characters)) {
        if (!dirent.name.endsWith('.png')) continue;
        batchFiles.push(dirent.name);
        if (batchFiles.length >= BATCH_FLUSH_SIZE) {
            await processBatch(batchFiles);
            batchFiles = [];
        }
    }
    if (batchFiles.length > 0) {
        await processBatch(batchFiles);
    }

    if (progress.done > 0) {
        // One new file is a single update, which logs nothing.
        if (progress.done > 1) progress.finish();

        if (entry.batch) {
            flushBatch(entry);
        }
    }

    setMetaSync(entry.db, 'last_reconcile_dir_mtime_ms', String(currentDirMtimeMs));
}

// Emitted on characterChangeEmitter as (root) when tag_changes rows were added for that store: its clients ask for
// what changed since their cursor (getTagChangesSince()).
export const TAG_CHANGES_EVENT = 'tag-changes';

/**
 * @param {string} root The store's directories.root.
 */
export function reportTagChanges(root) {
    characterChangeEmitter.emit(TAG_CHANGES_EVENT, root);
}

/**
 * Adds tag_changes rows (see SCHEMA_SQL) in the caller's transaction and tells this process's listeners. A
 * transaction that is rolled back takes the rows with it; the listeners then find nothing new.
 * @param {MetadataDbEntry} entry
 * @param {string[] | null} tagIds The tags whose definition changed, or null for one batch row.
 */
function logTagChangesSync(entry, tagIds) {
    if (tagIds === null) {
        entry.db.run('INSERT INTO tag_changes (tag_id) VALUES (NULL)');
    } else {
        if (tagIds.length === 0) return;
        for (const tagId of new Set(tagIds)) entry.db.run('INSERT INTO tag_changes (tag_id) VALUES (@tagId)', { tagId });
    }
    reportTagChanges(entry.directories.root);
}

/**
 * @typedef {'deleted' | 'unreadable' | 'unordered' | 'no-room'} TagMoveFailedReason
 * @typedef {{ tagId: string, tagName: string | null, anchorId: string | null, anchorName: string | null,
 *   refusedId: string, reason: TagMoveFailedReason }} TagMoveFailedPayload anchorId and anchorName are null for a
 *   sort_order entry. refusedId is the id the refusal named.
 */

// Emitted on characterChangeEmitter as (root, payload, ack) when a queued tag move can't be applied. A listener that
// hands the warning on (to a client, or to the main process) sets ack.delivered.
export const TAG_MOVE_FAILED_EVENT = 'tag-move-failed';

/**
 * The warning shown for a queued tag move that couldn't be applied. public/script.js's tagMoveFailedText() says
 * the same.
 * @param {TagMoveFailedPayload} payload
 */
function tagMoveFailedText({ tagId, tagName, anchorId, anchorName, refusedId, reason }) {
    const tag = tagName ?? tagId;
    if (anchorId === null) return `Couldn't set the order of tag "${tag}": its stored data couldn't be read.`;
    const anchor = anchorName ?? anchorId;
    const prefix = `Couldn't move tag "${tag}" next to "${anchor}": `;
    switch (reason) {
        case 'deleted': return `${prefix}"${anchor}" was deleted.`;
        case 'unreadable': return `${prefix}the stored data of "${refusedId === tagId ? tag : refusedId === anchorId ? anchor : refusedId}" couldn't be read.`;
        case 'unordered': return `${prefix}"${anchor}" is too far into the tags with no order.`;
        case 'no-room': return `${prefix}there was no room left in the order.`;
    }
}

// Emitted on characterChangeEmitter as (root) when the queued tag moves have all been applied and no reorder pass is
// left: the stored sort_order values are final again.
export const TAG_ORDER_SETTLED_EVENT = 'tag-order-settled';

/**
 * @param {string} root The store's directories.root.
 */
export function reportTagOrderSettled(root) {
    characterChangeEmitter.emit(TAG_ORDER_SETTLED_EVENT, root);
}

/**
 * Hands a queued tag move's failure to whoever listens for TAG_MOVE_FAILED_EVENT, or logs it when none takes it.
 * @param {string} root The store's directories.root.
 * @param {TagMoveFailedPayload} payload
 */
export function reportTagMoveFailed(root, payload) {
    const ack = { delivered: false };
    characterChangeEmitter.emit(TAG_MOVE_FAILED_EVENT, root, payload, ack);
    if (!ack.delivered) console.warn(color.yellow('[character-metadata] ' + tagMoveFailedText(payload)));
}

/**
 * Waits for the store's boot chain from initializeMetadataStores().
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<boolean>} false when the chain failed, or the store has none (it is unavailable or was never
 *   initialized).
 */
export async function waitForMetadataBootChain(directories) {
    const entry = await getEntry(directories);
    if (!entry?.bootstrapPromise) return false;
    try {
        await entry.bootstrapPromise;
        return true;
    } catch {
        return false;
    }
}

// Bootstrap runs in the background so a large corpus doesn't delay the server listening.
/**
 * @param {import('./users.js').UserDirectoryList[]} directoriesList
 * @returns {Promise<Promise<void>[]>} Each store's bootstrap chain, rejecting if it failed. Failures are also
 *   logged, so callers may ignore these. None in read-only mode, which starts no chain.
 */
export async function initializeMetadataStores(directoriesList) {
    if (isReadOnlyMode()) return [];
    /** @type {Promise<void>[]} */
    const chains = [];
    for (const directories of directoriesList) {
        const entry = await getEntry(directories);
        if (!entry) continue;
        if (entry.bootstrapPromise) {
            chains.push(entry.bootstrapPromise);
            continue;
        }

        const __chainStart = process.hrtime.bigint();
        /**
         * @template T
         * @param {string} label
         * @param {() => Promise<T>} fn
         * @returns {Promise<T>}
         */
        const __stage = async (label, fn) => {
            const s = process.hrtime.bigint();
            const result = await fn();
            console.log(`[boot-timing] [metadata-chain] ${label}: ${Number(process.hrtime.bigint() - s) / 1e6}ms (chain total so far: ${Number(process.hrtime.bigint() - __chainStart) / 1e6}ms)`);
            return result;
        };

        // The one-time migration passes run after this chain, in the store's migration worker
        // (metadata-migration-coordinator.js, started once the server listens).
        entry.bootstrapPromise = __stage('bootstrapIfNeeded', () => bootstrapIfNeeded(directories))
            .then(() => __stage('bootstrapGroupsIfNeeded', () => bootstrapGroupsIfNeeded(directories)))
            .then(() => __stage('reconcile', () => reconcile(directories)))
            // After reconcile() so this pass sees any rows reconcile() itself just inserted.
            .then(() => __stage('backfillContentIdentityHashes', () => backfillContentIdentityHashes(directories)))
            .then(() => __stage('backfillActiveChatFromCards', () => backfillActiveChatFromCards(directories)));
        entry.bootstrapPromise.catch(err => console.error(`[character-metadata] Bootstrap failed for ${directories.root}:`, err));
        chains.push(entry.bootstrapPromise);
    }
    return chains;
}

export function disposeMetadataStores() {
    chatStatsReconcileStarted = false;
    // The random-order cache holds these connections; its warm timer must not run on a closed one.
    clearTimeout(randomCacheWarmTimer);
    randomSortCache.clear();
    for (const db of noWaitMetaConnections.values()) {
        try {
            db.close();
        } catch {
            // Best-effort on shutdown.
        }
    }
    noWaitMetaConnections.clear();
    for (const entry of entries.values()) {
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
    const row = /** @type {CharacterRow | undefined} */ (entry.db.get('SELECT * FROM characters WHERE id = @id', { id: avatar }));
    if (row) {
        const asEntity = { ...row, type: 'character' };
        overlayEntityRowsSync(entry.db, [asEntity]);
        row.chat_size = asEntity.chat_size;
        row.date_last_chat = asEntity.date_last_chat;
        row.shallow_json = asEntity.shallow_json;
    }
    return row;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<boolean>} `false` also when the metadata store is unavailable.
 */
export async function characterRowExists(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return Boolean(entry.db.get('SELECT 1 FROM characters WHERE id = @id', { id: avatar }));
}

// Also checks the pending batch buffer: a bulk import can drop two identical files in the same
// still-unflushed batch. Fails open to null, which callers must treat as "can't determine", not "no duplicate".
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string | null} hash
 * @returns {Promise<string | null>}
 */
export async function findCharacterIdByContentHash(directories, hash) {
    if (hash === null) return null;
    const entry = await getEntry(directories);
    if (!entry) return null;

    if (entry.batch) {
        for (const pending of entry.batch.pending.values()) {
            if (pending.row.content_hash === hash) {
                return pending.row.id;
            }
        }
    }

    const row = (/** @type {{ id: string } | undefined} */ (entry.db.get('SELECT id FROM characters WHERE content_hash = @hash', { hash })));
    return row ? row.id : null;
}

// Matches semantic content even if bytes differ.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string | null} hash
 * @returns {Promise<string | null>}
 */
export async function findCharacterIdByContentIdentityHash(directories, hash) {
    if (hash === null) return null;
    const entry = await getEntry(directories);
    if (!entry) return null;

    if (entry.batch) {
        for (const pending of entry.batch.pending.values()) {
            if (pending.row.content_identity_hash === hash) {
                return pending.row.id;
            }
        }
    }

    const row = (/** @type {{ id: string } | undefined} */ (entry.db.get('SELECT id FROM characters WHERE content_identity_hash = @hash', { hash })));
    return row ? row.id : null;
}

// Matches image bytes (raw IDAT payload) regardless of card content - two characters with different data but
// the same portrait (e.g. a fork that kept the original image) share this even though content_identity_hash differs.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string | null} hash
 * @returns {Promise<string | null>}
 */
export async function findCharacterIdByAvatarIdentityHash(directories, hash) {
    if (hash === null) return null;
    const entry = await getEntry(directories);
    if (!entry) return null;

    if (entry.batch) {
        for (const pending of entry.batch.pending.values()) {
            if (pending.row.avatar_identity_hash === hash) {
                return pending.row.id;
            }
        }
    }

    const row = (/** @type {{ id: string } | undefined} */ (entry.db.get('SELECT id FROM characters WHERE avatar_identity_hash = @hash', { hash })));
    return row ? row.id : null;
}

/**
 * Requires both hashes to match the same row - content_identity_hash alone would wrongly treat
 * same-text-different-portrait characters as duplicates.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string | null} contentIdentityHash
 * @param {string | null} avatarIdentityHash
 * @returns {Promise<string | null>}
 */
export async function findCharacterIdByIdentityHashes(directories, contentIdentityHash, avatarIdentityHash) {
    if (contentIdentityHash === null || avatarIdentityHash === null) return null;
    const entry = await getEntry(directories);
    if (!entry) return null;

    if (entry.batch) {
        for (const pending of entry.batch.pending.values()) {
            if (pending.row.content_identity_hash === contentIdentityHash && pending.row.avatar_identity_hash === avatarIdentityHash) {
                return pending.row.id;
            }
        }
    }

    const exactRow = /** @type {{ id: string } | undefined} */ (entry.db.get(
        'SELECT id FROM characters WHERE content_identity_hash = @contentIdentityHash AND avatar_identity_hash = @avatarIdentityHash',
        { contentIdentityHash, avatarIdentityHash },
    ));
    if (exactRow) return exactRow.id;

    // Fallback for rows sharing content_identity_hash but with avatar_identity_hash still NULL: a plain SQL
    // `=` comparison silently excludes NULL, which would miss real duplicates on an unbackfilled library.
    if (!fs.existsSync(directories.characters)) return null;
    const unbackfilledCandidates = /** @type {{ id: string }[]} */ (entry.db.all(
        'SELECT id FROM characters WHERE content_identity_hash = @contentIdentityHash AND avatar_identity_hash IS NULL',
        { contentIdentityHash },
    ));
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

        // Only filled when empty, read and written in one transaction, so a concurrent live write always wins over
        // this stale read.
        entry.db.transaction(() => {
            const stored = /** @type {{ avatar_identity_hash: string | null } | undefined} */ (entry.db.get('SELECT avatar_identity_hash FROM characters WHERE id = @id', { id }));
            if (stored && stored.avatar_identity_hash === null) writeRowIfChanged(entry.db, 'characters', { id }, { avatar_identity_hash: rowAvatarHash });
        });

        if (rowAvatarHash === avatarIdentityHash) return id;
    }

    return null;
}

// Fails open to null (unavailable store) - callers must treat that as "can't determine", not "not skipped".
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath
 * @returns {Promise<{ mtimeMs: number, reason: string } | null>}
 */
export async function getLocalImportSkip(directories, sourcePath) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const row = (/** @type {{ mtime_ms: number, reason: string } | undefined} */ (entry.db.get('SELECT mtime_ms, reason FROM local_import_skips WHERE source_path = @sourcePath', { sourcePath })));
    return row ? { mtimeMs: Number(row.mtime_ms), reason: row.reason } : null;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath
 * @param {number} mtimeMs
 * @param {string} reason
 */
export async function setLocalImportSkip(directories, sourcePath, mtimeMs, reason) {
    const entry = await getEntry(directories);
    if (!entry) return;

    writeRowIfChanged(entry.db, 'local_import_skips', { source_path: sourcePath }, { mtime_ms: mtimeMs, reason, checked_at: Date.now() }, { insert: true });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath
 */
export async function clearLocalImportSkip(directories, sourcePath) {
    const entry = await getEntry(directories);
    if (!entry) return;

    entry.db.run('DELETE FROM local_import_skips WHERE source_path = @sourcePath', { sourcePath });
}

// Lazy per-cache-miss point lookup, replacing the old bulk-load-whole-table-at-boot getAllLocalImportMtimes()
// (unbounded memory growth against an ever-growing external corpus).
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath
 * @returns {Promise<{ mtimeMs: number } | null>}
 */
export async function getLocalImportMtime(directories, sourcePath) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const row = (/** @type {{ mtime_ms: number } | undefined} */ (entry.db.get('SELECT mtime_ms FROM local_import_mtimes WHERE source_path = @sourcePath', { sourcePath })));
    return row ? { mtimeMs: Number(row.mtime_ms) } : null;
}

// Batched counterpart to getLocalImportMtime(): one query per chunk of paths. Returns a plain Map scoped to
// just the given paths, not a whole-table cache.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} sourcePaths
 * @returns {Promise<Map<string, number>>}
 */
export async function getLocalImportMtimesForPaths(directories, sourcePaths) {
    const result = new Map();
    if (!sourcePaths.length) return result;

    const entry = await getEntry(directories);
    if (!entry) return result;

    const placeholders = sourcePaths.map(() => '?').join(',');
    for (const row of /** @type {Iterable<{ source_path: string, mtime_ms: number }>} */ (entry.db.iterate(`SELECT source_path, mtime_ms FROM local_import_mtimes WHERE source_path IN (${placeholders})`, sourcePaths))) {
        result.set(row.source_path, Number(row.mtime_ms));
    }
    return result;
}

// Keyset-paginated (source_path > afterSourcePath), not LIMIT/OFFSET: the sweep DELETEs rows as it walks, and
// OFFSET pagination would silently skip rows as offsets shift underneath it.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} afterSourcePath
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
export async function getLocalImportMtimeSourcePathsAfter(directories, afterSourcePath, limit) {
    const entry = await getEntry(directories);
    if (!entry) return [];

    const rows = /** @type {{ source_path: string }[]} */ (entry.db.readBounded(
        'SELECT source_path FROM local_import_mtimes WHERE source_path > @after ORDER BY source_path LIMIT @limit',
        { after: afterSourcePath, limit },
        limit,
    ));
    return rows.map(row => row.source_path);
}

// duplicateOf, when given, records that this row's validity depends on that character id still existing -
// deleteRowSync() cascades the deletion.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath
 * @param {number} mtimeMs
 * @param {string | null} [duplicateOf]
 */
export async function setLocalImportMtime(directories, sourcePath, mtimeMs, duplicateOf = null) {
    const entry = await getEntry(directories);
    if (!entry) return;

    writeRowIfChanged(entry.db, 'local_import_mtimes', { source_path: sourcePath }, { mtime_ms: mtimeMs, duplicate_of: duplicateOf }, { insert: true });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath
 */
export async function clearLocalImportMtime(directories, sourcePath) {
    const entry = await getEntry(directories);
    if (!entry) return;

    entry.db.run('DELETE FROM local_import_mtimes WHERE source_path = @sourcePath', { sourcePath });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<string[]>}
 */
export async function getCharacterTagIds(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return resolveTagIds(Array.from(/** @type {Iterable<{ tag_id: string }>} */ (entry.db.iterate('SELECT tag_id FROM character_tags WHERE character_id = @id', { id: avatar })), r => r.tag_id), readTagDeletionsSync(entry.db));
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} tagId
 * @returns {Promise<number>}
 */
export async function getTagUsageCount(directories, tagId) {
    const entry = await getEntry(directories);
    if (!entry) return 0;
    // Counted as tagCountsForIdsSync() counts it, without the buffered import rows.
    if (entry.db.get('SELECT 1 FROM tag_deletions WHERE tag_id = @tagId', { tagId })) return 0;
    const row = (/** @type {{ count: number } | undefined} */ (entry.db.get(
        `SELECT (SELECT COALESCE(SUM(count), 0) FROM tag_usage WHERE tag_id = @tagId)
            + (SELECT COALESCE(SUM(u.count), 0) FROM tag_deletions d JOIN tag_usage u ON u.tag_id = d.tag_id WHERE d.merge_into = @tagId) AS count`,
        { tagId },
    )));
    return row ? Number(row.count) : 0;
}

// General-purpose key/value accessor pair over the meta table.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} key
 * @returns {Promise<string | null>}
 */
export async function getMetaValue(directories, key) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = (/** @type {{ value: string } | undefined} */ (entry.db.get('SELECT value FROM meta WHERE key = ?', [key])));
    return row ? String(row.value) : null;
}


/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} key
 * @param {unknown} value
 */
export async function setMetaValue(directories, key, value) {
    const entry = await getEntry(directories);
    if (!entry) return;
    setMetaSync(entry.db, key, String(value));
}

/**
 * Deletes `key` only while it still holds exactly `value`.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} key
 * @param {string} value
 * @returns {Promise<boolean>} true when a row was deleted; false when the value differed, the key was absent, or the
 * metadata store is unavailable.
 */
export async function deleteMetaValueIfEquals(directories, key, value) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return entry.db.run('DELETE FROM meta WHERE key = @key AND value = @value', { key, value }).changes > 0;
}

/** @type {Map<string, import('./endpoints/sqlite-engine.js').SqliteEngineHandle>} Keyed by directories.root. */
const noWaitMetaConnections = new Map();

/**
 * Writes every key in `values` in one transaction, on a connection of its own that fails at once on a lock
 * instead of waiting for it. In read-only mode that connection opens read-only, so the write fails in SQLite
 * (SQLITE_READONLY) and the error is thrown.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Record<string, unknown>} values
 * @returns {Promise<boolean>} false: another connection held the write lock, and nothing was written. With no
 * usable SQLite engine there is nothing to write, and it returns true, as setMetaValue() does nothing then.
 */
export function trySetMetaValues(directories, values) {
    return trySetMetaValuesAndRetryMarks(directories, values, []);
}

/**
 * @typedef {{ nextAttemptAt: number, delayMs: number, lastError: string }} CharacterIndexRetryMark A
 * character_index_retries row (see SCHEMA_SQL).
 */

/**
 * trySetMetaValues(), with the characters index's retry mark writes in the same transaction: each `mark` replaces
 * the card's row, and a null one deletes it.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Record<string, unknown>} values
 * @param {{ id: string, mark: CharacterIndexRetryMark | null }[]} retryMarks
 * @returns {Promise<boolean>} As trySetMetaValues().
 */
export async function trySetMetaValuesAndRetryMarks(directories, values, retryMarks) {
    const entry = await getEntry(directories);
    const engine = await getSqliteEngine();
    if (!entry || !engine) return true;
    const db = noWaitMetaConnections.get(directories.root)
        ?? engine.openDatabase(getDbPath(directories), { busyTimeoutMs: 0, retryOnBusy: false, readonly: isReadOnlyMode() });
    noWaitMetaConnections.set(directories.root, db);
    try {
        db.transaction(() => {
            for (const [key, value] of Object.entries(values)) {
                setMetaSync(db, key, String(value));
            }
            for (const { id, mark } of retryMarks) {
                if (mark) {
                    writeRowIfChanged(db, 'character_index_retries', { id }, {
                        next_attempt_at: mark.nextAttemptAt,
                        delay_ms: mark.delayMs,
                        last_error: mark.lastError,
                    }, { insert: true });
                } else {
                    db.run('DELETE FROM character_index_retries WHERE id = ?', [id]);
                }
            }
        });
    } catch (err) {
        if (isBusyError(err)) return false;
        throw err;
    }
    return true;
}

/**
 * The retry marks of those of `ids` that have one.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Map<string, CharacterIndexRetryMark>>}
 */
export async function getCharacterIndexRetryMarksByIds(directories, ids) {
    const entry = await getEntry(directories);
    /** @type {Map<string, CharacterIndexRetryMark>} */
    const result = new Map();
    if (!entry || ids.length === 0) return result;
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const rows = /** @type {Generator<{ id: string, next_attempt_at: number, delay_ms: number, last_error: string }>} */ (
            entry.db.iterate(`SELECT id, next_attempt_at, delay_ms, last_error FROM character_index_retries WHERE id IN (${placeholders})`, batch));
        for (const row of rows) {
            result.set(row.id, { nextAttemptAt: Number(row.next_attempt_at), delayMs: Number(row.delay_ms), lastError: row.last_error });
        }
    }
    return result;
}

/**
 * Up to `limit` retry marks due at `now`, soonest due first.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} now
 * @param {number} limit
 * @returns {Promise<({ id: string } & CharacterIndexRetryMark)[]>} Empty when the metadata store is unavailable.
 */
export async function getDueCharacterIndexRetries(directories, now, limit) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    const due = [];
    const rows = /** @type {Generator<{ id: string, next_attempt_at: number, delay_ms: number, last_error: string }>} */ (
        entry.db.iterate('SELECT id, next_attempt_at, delay_ms, last_error FROM character_index_retries WHERE next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?', [now, limit]));
    for (const row of rows) {
        due.push({ id: row.id, nextAttemptAt: Number(row.next_attempt_at), delayMs: Number(row.delay_ms), lastError: row.last_error });
    }
    return due;
}

// Tag ids whose *name* changed since sinceSeq - mirrors getChangesSince()'s truncation handling.
/**
 * Reads at most `limit` log rows past sinceSeq: `seq` is the last row read (pass it back as sinceSeq for the next
 * page) and `hasMore` says whether rows remain.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} sinceSeq
 * @param {{ limit: number, untilSeq?: number }} options untilSeq: read no row past it, so a page read again later is
 *   the same page even if rows were added since.
 * @returns {Promise<{ seq: number, tagIds: string[], truncated: boolean, hasMore: boolean } | null>}
 */
export async function getTagNameChangesSince(directories, sinceSeq, { limit, untilSeq }) {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new TypeError('getTagNameChangesSince() needs a positive integer limit');
    }
    const entry = await getEntry(directories);
    if (!entry) return null;

    const numericSince = Number.isFinite(sinceSeq) && sinceSeq >= 0 ? Math.trunc(sinceSeq) : 0;
    const bounds = (/** @type {{ minSeq: number | null, maxSeq: number | null } | undefined} */ (entry.db.get('SELECT (SELECT MIN(seq) FROM tag_name_changes) AS minSeq, (SELECT MAX(seq) FROM tag_name_changes) AS maxSeq')));
    const minSeq = bounds?.minSeq != null ? Number(bounds.minSeq) : undefined;
    const maxSeq = bounds?.maxSeq != null ? Number(bounds.maxSeq) : 0;

    if (minSeq !== undefined && numericSince < minSeq - 1) {
        return { seq: maxSeq, tagIds: [], truncated: true, hasMore: false };
    }

    /** @type {Set<string>} */
    const tagIds = new Set();
    let lastSeq = null;
    let hasMore = false;
    let read = 0;
    const until = Number.isInteger(untilSeq) ? untilSeq : Number.MAX_SAFE_INTEGER;
    for (const row of /** @type {Generator<TagNameChangeRow>} */ (entry.db.iterate('SELECT seq, tag_id FROM tag_name_changes WHERE seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?', [numericSince, until, limit + 1]))) {
        if (read === limit) {
            hasMore = true;
            break;
        }
        read++;
        lastSeq = Number(row.seq);
        tagIds.add(row.tag_id);
    }
    return { seq: lastSeq ?? maxSeq, tagIds: [...tagIds], truncated: false, hasMore };
}

/**
 * @typedef {object} TagChangesPage
 * @property {number} seq The cursor to ask from next.
 * @property {boolean} reset The caller can't be told what changed: it has no usable cursor, the log no longer
 *   reaches back to it, or a batch row lies past it. It re-reads the tags it holds; `seq` is the log's end.
 * @property {object[]} tags The stored definition of each changed tag that still exists.
 * @property {{ id: string, mergedInto: string | null }[]} removed Each changed tag that no longer exists, with the
 *   tag it reads as now when it is marked deleted with a merge target.
 * @property {boolean} hasMore Rows remain past `seq`.
 */

/**
 * One page of the tag definition change log (tag_changes) past `sinceSeq`, at most `limit` rows, as what each
 * changed tag is now. A tag changed several times is listed once.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {unknown} sinceSeq The caller's cursor; anything but a non-negative integer asks only for the log's end.
 * @param {{ limit: number }} options
 * @returns {Promise<TagChangesPage | null>} null when the store is unavailable.
 */
export async function getTagChangesSince(directories, sinceSeq, { limit }) {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new TypeError('getTagChangesSince() requires a positive integer limit');
    }
    const entry = await getEntry(directories);
    if (!entry) return null;

    const bounds = /** @type {{ minSeq: number | null, maxSeq: number | null }} */ (entry.db.get('SELECT (SELECT MIN(seq) FROM tag_changes) AS minSeq, (SELECT MAX(seq) FROM tag_changes) AS maxSeq'));
    const maxSeq = bounds.maxSeq !== null ? Number(bounds.maxSeq) : 0;
    /** @type {TagChangesPage} */
    const reset = { seq: maxSeq, reset: true, tags: [], removed: [], hasMore: false };
    if (typeof sinceSeq !== 'number' || !Number.isInteger(sinceSeq) || sinceSeq < 0) return reset;
    if (sinceSeq > maxSeq) return reset;
    if (bounds.minSeq !== null && sinceSeq < Number(bounds.minSeq) - 1) return reset;

    /** @type {Set<string>} */
    const ids = new Set();
    let lastSeq = sinceSeq;
    let hasMore = false;
    let read = 0;
    for (const row of /** @type {Generator<{ seq: number, tag_id: string | null }>} */ (entry.db.iterate('SELECT seq, tag_id FROM tag_changes WHERE seq > ? ORDER BY seq ASC LIMIT ?', [sinceSeq, limit + 1]))) {
        // The page's LIMIT is limit + 1: reaching the extra row means more remain, and it isn't part of this page.
        if (read === limit) {
            hasMore = true;
            break;
        }
        if (row.tag_id === null) return reset;
        read++;
        lastSeq = Number(row.seq);
        ids.add(row.tag_id);
    }

    const deletions = readTagDeletionsSync(entry.db);
    /** @type {object[]} */
    const tags = [];
    /** @type {TagChangesPage['removed']} */
    const removed = [];
    for (const id of ids) {
        const row = deletions.has(id) ? undefined
            : /** @type {{ data: string } | undefined} */ (entry.db.get('SELECT data FROM tags WHERE id = @id', { id }));
        const tag = row ? parseTagObject(row.data) : null;
        if (tag) {
            tags.push(tag);
        } else if (row) {
            console.warn(color.yellow(`[character-metadata] Tag definition ${id} could not be parsed, left out of the tag changes.`));
        } else {
            removed.push({ id, mergedInto: deletions.get(id) ?? null });
        }
    }
    return { seq: lastSeq, reset: false, tags, removed, hasMore };
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<number | null>} The tag definition change log's end, the cursor a client that has just read the
 *   tags asks from; null when the store is unavailable.
 */
export async function getTagChangesSeq(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = /** @type {{ seq: number }} */ (entry.db.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM tag_changes'));
    return Number(row.seq);
}

/**
 * @typedef {object} EntityTagChangesPage
 * @property {number} seq The characters change log (changes) cursor to ask from next.
 * @property {number} groupsVersion The groups version log (group_changes) cursor to ask from next.
 * @property {number} endSeq Where the characters change log ends.
 * @property {number} endGroupsVersion Where the groups version log ends.
 * @property {boolean} reset The caller can't be told what changed: it has no usable cursor, or a log no longer
 *   reaches back to it. It re-reads the tags of what it holds; `seq` and `groupsVersion` are the logs' ends.
 * @property {string[]} ids The characters and groups whose tags may have changed.
 * @property {boolean} hasMore Rows remain past the cursors.
 */

/**
 * The ends of the two logs getEntityTagChangesSince() reads: the cursors a client that is about to read its
 * characters and groups asks from afterwards.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<{ seq: number, groupsVersion: number | null } | null>} null when the store is unavailable;
 *   groupsVersion null when it can't be read.
 */
export async function getEntityTagChangesEnd(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = /** @type {{ seq: number }} */ (entry.db.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes'));
    return { seq: Number(row.seq), groupsVersion: readGroupsVersionSync(entry.db) };
}

/**
 * One page of which characters and groups may have had their tags changed past the caller's cursors: at most `limit`
 * log rows, from the characters change log (rows that wrote tag_ids or a whole record) and then the groups version
 * log (every row that names a group). An entity is listed once. Deleted characters are left out.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ sinceSeq: unknown, sinceGroupsVersion: unknown }} cursors Anything but two non-negative integers asks
 *   only for the logs' ends.
 * @param {{ limit: number }} options
 * @returns {Promise<EntityTagChangesPage | null>} null when the store is unavailable.
 */
export async function getEntityTagChangesSince(directories, { sinceSeq, sinceGroupsVersion }, { limit }) {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new TypeError('getEntityTagChangesSince() requires a positive integer limit');
    }
    const entry = await getEntry(directories);
    if (!entry) return null;

    const bounds = /** @type {{ minSeq: number | null, maxSeq: number | null, minVersion: number | null }} */ (entry.db.get(
        'SELECT (SELECT MIN(seq) FROM changes) AS minSeq, (SELECT MAX(seq) FROM changes) AS maxSeq, (SELECT MIN(version) FROM group_changes) AS minVersion'));
    const endSeq = bounds.maxSeq !== null ? Number(bounds.maxSeq) : 0;
    const endGroupsVersion = readGroupsVersionSync(entry.db) ?? 0;
    /** @type {EntityTagChangesPage} */
    const reset = { seq: endSeq, groupsVersion: endGroupsVersion, endSeq, endGroupsVersion, reset: true, ids: [], hasMore: false };
    const isCursor = (/** @type {unknown} */ value) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
    if (!isCursor(sinceSeq) || !isCursor(sinceGroupsVersion)) return reset;
    const seq = /** @type {number} */ (sinceSeq);
    const groupsVersion = /** @type {number} */ (sinceGroupsVersion);
    if (seq > endSeq || groupsVersion > endGroupsVersion) return reset;
    if (bounds.minSeq !== null && seq < Number(bounds.minSeq) - 1) return reset;
    if (bounds.minVersion !== null && groupsVersion < Number(bounds.minVersion) - 1) return reset;

    /** @type {Set<string>} */
    const ids = new Set();
    let lastSeq = seq;
    let lastGroupsVersion = groupsVersion;
    let read = 0;
    let hasMore = false;
    // Each LIMIT is one more than what is left of the page: reaching the extra row means more remain.
    for (const row of /** @type {Generator<ChangeRow>} */ (entry.db.iterate('SELECT seq, id, op, fields FROM changes WHERE seq > ? ORDER BY seq ASC LIMIT ?', [seq, limit + 1]))) {
        if (read === limit) {
            hasMore = true;
            break;
        }
        read++;
        lastSeq = Number(row.seq);
        if (row.op === 'delete') {
            ids.delete(row.id);
            continue;
        }
        let fields = null;
        try {
            fields = row.fields === null ? null : JSON.parse(row.fields);
        } catch {
            fields = null;
        }
        if (!Array.isArray(fields) || fields.includes('tag_ids')) ids.add(row.id);
    }
    if (!hasMore) {
        for (const row of /** @type {Generator<{ version: number, group_id: string | null }>} */ (entry.db.iterate('SELECT version, group_id FROM group_changes WHERE version > ? ORDER BY version ASC LIMIT ?', [groupsVersion, limit - read + 1]))) {
            if (read === limit) {
                hasMore = true;
                break;
            }
            read++;
            lastGroupsVersion = Number(row.version);
            if (row.group_id !== null) ids.add(row.group_id);
        }
    }
    return { seq: lastSeq, groupsVersion: lastGroupsVersion, endSeq, endGroupsVersion, reset: false, ids: [...ids], hasMore };
}

/** Ids of the characters carrying any of `tagIds`, in batches in id order, each id once. `tagIds` goes into one
 * IN (...), so the caller bounds it (search-index passes one tag-name-change page).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} tagIds
 * @param {{ after?: string | null }} [options] after: start past this character id.
 * @returns {AsyncGenerator<string[], void, undefined>}
 */
export async function* streamCharacterIdsForTagIds(directories, tagIds, { after = null } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const ids = [...new Set(tagIds)];
    if (!ids.length) return;
    /** @type {Record<string, string>} */
    const params = {};
    ids.forEach((id, i) => { params[`t${i}`] = id; });
    const placeholders = ids.map((_id, i) => `@t${i}`).join(',');
    const nextPageSql = `SELECT DISTINCT character_id FROM character_tags WHERE tag_id IN (${placeholders}) AND character_id > @after ORDER BY character_id LIMIT @limit`;
    for await (const rows of streamRows(entry.db, {
        firstPageSql: after === null ? `SELECT DISTINCT character_id FROM character_tags WHERE tag_id IN (${placeholders}) ORDER BY character_id LIMIT @limit` : nextPageSql,
        firstPageParams: after === null ? params : { ...params, after },
        nextPageSql: `SELECT DISTINCT character_id FROM character_tags WHERE tag_id IN (${placeholders}) AND character_id > @after ORDER BY character_id LIMIT @limit`,
        nextPageParams: params,
        keyColumn: 'character_id',
    })) {
        yield rows.map(row => row.character_id);
    }
}

/** streamCharacterIdsForTagIds()'s counterpart for groups: the group ids of the group_tags rows carrying any of
 * `tagIds`, in batches, each id once. `tagIds` goes into one IN (...), so the caller bounds it.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} tagIds
 * @returns {AsyncGenerator<string[], void, undefined>}
 */
export async function* streamGroupIdsForTagIds(directories, tagIds) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const ids = [...new Set(tagIds)];
    if (!ids.length) return;
    /** @type {Record<string, string>} */
    const params = {};
    ids.forEach((id, i) => { params[`t${i}`] = id; });
    const placeholders = ids.map((_id, i) => `@t${i}`).join(',');
    for await (const rows of streamRows(entry.db, {
        firstPageSql: `SELECT DISTINCT group_id FROM group_tags WHERE tag_id IN (${placeholders}) ORDER BY group_id LIMIT @limit`,
        firstPageParams: params,
        nextPageSql: `SELECT DISTINCT group_id FROM group_tags WHERE tag_id IN (${placeholders}) AND group_id > @after ORDER BY group_id LIMIT @limit`,
        nextPageParams: params,
        keyColumn: 'group_id',
    })) {
        yield rows.map(row => row.group_id);
    }
}

/**
 * One page of the groups version log (group_changes): at most `limit` rows past `sinceVersion`, in version order.
 * `version` is the last row read (pass it back as sinceVersion for the next page), or `sinceVersion` when none was;
 * `hasMore` says whether rows remain past it.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} sinceVersion
 * @param {{ limit: number }} options
 * @returns {Promise<{ version: number, rows: { version: number, groupId: string | null, fileName: string | null }[], hasMore: boolean } | null>}
 * null when the metadata store is unavailable.
 */
export async function getGroupChangesSince(directories, sinceVersion, { limit }) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    if (!Number.isInteger(limit) || limit <= 0) throw new TypeError(`getGroupChangesSince: limit must be a positive integer, got ${limit}`);
    const since = Number.isFinite(sinceVersion) && sinceVersion >= 0 ? Math.trunc(sinceVersion) : 0;
    /** @type {{ version: number, groupId: string | null, fileName: string | null }[]} */
    const rows = [];
    let hasMore = false;
    for (const row of /** @type {Generator<{ version: number, group_id: string | null, file_name: string | null }>} */ (
        entry.db.iterate('SELECT version, group_id, file_name FROM group_changes WHERE version > ? ORDER BY version ASC LIMIT ?', [since, limit + 1]))) {
        if (rows.length === limit) {
            hasMore = true;
            break;
        }
        rows.push({ version: Number(row.version), groupId: row.group_id ?? null, fileName: row.file_name ?? null });
    }
    return { version: rows.length > 0 ? rows[rows.length - 1].version : since, rows, hasMore };
}

// INSERT OR IGNORE: a resumed migration run reuses the id minted first rather than minting a fresh one.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} oldId
 * @param {string} newId
 */
export async function recordIdMigrationMapping(directories, oldId, newId) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run('INSERT OR IGNORE INTO id_migration (old_id, new_id, completed) VALUES (@oldId, @newId, 0)', { oldId, newId });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} oldId
 * @returns {Promise<string | null>}
 */
export async function getIdMigrationMapping(directories, oldId) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = (/** @type {{ new_id: string } | undefined} */ (entry.db.get('SELECT new_id FROM id_migration WHERE old_id = @oldId', { oldId })));
    return row ? String(row.new_id) : null;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} newId
 * @returns {Promise<boolean>}
 */
export async function isIdMigrationTargetTaken(directories, newId) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return !!(/** @type {Record<string, unknown> | undefined} */ (entry.db.get('SELECT 1 FROM id_migration WHERE new_id = @newId', { newId })));
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} oldId
 */
export async function markIdMigrationComplete(directories, oldId) {
    const entry = await getEntry(directories);
    if (!entry) return;
    writeRowIfChanged(entry.db, 'id_migration', { old_id: oldId }, { completed: 1 });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<IdMigrationRow[]>}
 */
export async function getPendingIdMigrations(directories) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return (/** @type {IdMigrationRow[]} */ (entry.db.all('SELECT old_id, new_id FROM id_migration WHERE completed = 0')));
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<IdMigrationRow[]>}
 */
export async function getCompletedIdMigrations(directories) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return (/** @type {IdMigrationRow[]} */ (entry.db.all('SELECT old_id, new_id FROM id_migration WHERE completed = 1')));
}

// ids can mix character avatars and group ids; each is looked up only in its own type's table (tagEntityTypeOf()).
// Every requested id is a key in the result ([] if no tags, or if it isn't a usable id), so a caller never has to
// distinguish "no tags" from "id absent". A repeated id is looked up once.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {unknown[]} ids
 * @param {object} [options]
 * @param {'character' | 'group'} [options.type] For a caller whose ids are all of one type: an id whose own type
 * differs (a legacy group whose id ends in .png) gets [].
 * @returns {Promise<Record<string, string[]> | null>}
 */
export async function getEntityTagIdsForMany(directories, ids, { type: onlyType } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    /** @type {Record<string, string[]>} */
    const result = {};
    /** @type {string[]} */
    const characterIds = [];
    /** @type {string[]} */
    const groupIds = [];
    for (const id of ids) {
        const key = String(id);
        if (Object.hasOwn(result, key)) continue;
        result[key] = [];
        const type = tagEntityTypeOf(id);
        if (onlyType && type !== onlyType) continue;
        if (type === 'character') characterIds.push(key);
        else if (type === 'group') groupIds.push(key);
    }

    const lookups = [
        { ids: characterIds, sql: (placeholders) => `SELECT character_id as entity_id, tag_id FROM character_tags WHERE character_id IN (${placeholders})` },
        { ids: groupIds, sql: (placeholders) => `SELECT group_id as entity_id, tag_id FROM group_tags WHERE group_id IN (${placeholders})` },
    ];
    let first = true;
    for (const lookup of lookups) {
        // Chunked for the same reason checkCharactersExist() is - stay clear of SQLite's bound-parameter ceiling.
        for (let i = 0; i < lookup.ids.length; i += BATCH_FLUSH_SIZE) {
            if (!first) await new Promise(resolve => setImmediate(resolve));
            first = false;
            const chunk = lookup.ids.slice(i, i + BATCH_FLUSH_SIZE);
            const placeholders = chunk.map(() => '?').join(', ');
            for (const row of /** @type {Iterable<{ entity_id: string, tag_id: string }>} */ (entry.db.iterate(lookup.sql(placeholders), chunk))) {
                result[row.entity_id].push(row.tag_id);
            }
        }
    }

    // Sorted in JS even after ORDER BY: SQLite compares UTF-8 bytes, normalizeTagIds() UTF-16 code units.
    const deletions = readTagDeletionsSync(entry.db);
    for (const id of Object.keys(result)) {
        result[id] = resolveTagIds(normalizeTagIds(result[id]), deletions);
    }
    return result;
}

// Patches a still-buffered batch-import row's tag ids so a read landing before flush still sees the assignment.

/**
 * @param {PendingRow} pending
 */
function patchPendingRowTagIds(pending) {
    const shallow = JSON.parse(pending.row.shallow_json);
    shallow.tag_ids = normalizeTagIds(pending.tagIds);
    pending.row.shallow_json = JSON.stringify(shallow);
    Object.assign(pending.row, digestColumnsForShallow(shallow));
}

// Requires the entity to exist in its own type's table (tagEntityTypeOf()) since neither tag table has an FK to
// enforce it. A character still in the batch-import buffer counts as existing, and is written to the table before
// the tag, so the assignment lands right away.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {string} tagId
 * @returns {Promise<'ok' | 'not_found' | null>}
 */
export async function assignEntityTag(directories, id, tagId) {
    const answer = await assignEntityTagReporting(directories, id, tagId);
    return answer === null ? null : answer.result;
}

/**
 * assignEntityTag(), also saying which tag the entity got.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {string} tagId
 * @returns {Promise<{ result: 'ok' | 'not_found', assigned: string | null, reason: 'merged' | 'deleted' | null, defined: boolean } | null>}
 *   assigned: the tag the entity got, or null when nothing was assigned. reason, when that isn't `tagId`: 'merged'
 *   (it is being deleted with a merge target, which the entity got), 'deleted' (it is being deleted with none), or
 *   null for an entity that doesn't exist. defined: whether a stored tag has the assigned id; an id none has is
 *   assigned all the same, as card imports and upstream's tag_map do, and shows nowhere until a tag has it.
 */
export async function assignEntityTagReporting(directories, id, tagId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const type = tagEntityTypeOf(id);
    if (type === null) return { result: 'not_found', assigned: null, reason: null, defined: false };

    // A marked tag is now its merge target, so that is what gets assigned.
    const resolvedTagId = resolveTagId(tagId, readTagDeletionsSync(entry.db));
    if (resolvedTagId === null) {
        const exists = type === 'character'
            ? entry.batch?.pending.has(id) === true || !!entry.db.get('SELECT 1 FROM characters WHERE id = @id', { id })
            : !!entry.db.get('SELECT 1 FROM groups WHERE id = @id', { id });
        if (exists) warnDeletedTagsNotAssigned(id, [tagId]);
        return { result: exists ? 'ok' : 'not_found', assigned: null, reason: exists ? 'deleted' : null, defined: false };
    }
    const reason = resolvedTagId === tagId ? null : 'merged';
    tagId = resolvedTagId;

    if (type === 'character') flushBufferedRow(entry, id);

    // An object, not a let: TypeScript doesn't see the callback's assignment and narrows a let to false.
    const result = { found: false };
    entry.db.transaction(() => {
        result.found = false;
        if (type === 'character' && (/** @type {Record<string, unknown> | undefined} */ (entry.db.get('SELECT 1 FROM characters WHERE id = @id', { id })))) {
            entry.db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@id, @tagId)', { id, tagId });
            const charRow = (/** @type {{ shallow_json: string } | undefined} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id })));
            if (charRow) {
                const currentTagIds = Array.from(/** @type {Iterable<{ tag_id: string }>} */ (entry.db.iterate('SELECT tag_id FROM character_tags WHERE character_id = @id', { id })), r => r.tag_id);
                const shallow = JSON.parse(charRow.shallow_json);
                shallow.tag_ids = currentTagIds;
                writeShallowJson(entry.db, id, shallow, ['tag_ids']);
            }
            result.found = true;
        } else if (type === 'group' && (/** @type {Record<string, unknown> | undefined} */ (entry.db.get('SELECT 1 FROM groups WHERE id = @id', { id })))) {
            const inserted = entry.db.run('INSERT OR IGNORE INTO group_tags (group_id, tag_id) VALUES (@id, @tagId)', { id, tagId }).changes > 0;
            const currentTagIds = Array.from(/** @type {Iterable<{ tag_id: string }>} */ (entry.db.iterate('SELECT tag_id FROM group_tags WHERE group_id = @id ORDER BY tag_id', { id })), r => r.tag_id);
            const digestSet = setGroupDigestTagIdsSync(entry.db, id, groupDigestTagIdsHash({ tag_ids: currentTagIds }));
            if (inserted || digestSet) insertGroupChange(entry.db, id);
            result.found = true;
        }
    });
    if (!result.found) return { result: 'not_found', assigned: null, reason: null, defined: false };
    return { result: 'ok', assigned: tagId, reason, defined: !!entry.db.get('SELECT 1 FROM tags WHERE id = @tagId', { tagId }) };
}

/**
 * The tags a write naming `tagIds` assigns: each marked tag is now its merge target, each once; one deleted with
 * no merge target is left out and listed in `dropped`.
 * @param {unknown[]} tagIds
 * @param {import('./tag-deletions.js').TagDeletions} deletions
 * @returns {{ tagIds: string[], dropped: string[] }}
 */
function resolveTagIdsToAssign(tagIds, deletions) {
    /** @type {Set<string>} */
    const resolved = new Set();
    /** @type {string[]} */
    const dropped = [];
    for (const tagId of tagIds) {
        const target = resolveTagId(/** @type {string} */ (tagId), deletions);
        if (target !== null) resolved.add(target);
        else dropped.push(/** @type {string} */ (tagId));
    }
    return { tagIds: [...resolved], dropped };
}

/**
 * @param {string} entityId
 * @param {string[]} tagIds Tags deleted with no merge target.
 */
function warnDeletedTagsNotAssigned(entityId, tagIds) {
    if (tagIds.length === 0) return;
    console.warn(color.yellow(`[character-metadata] Not assigned to ${entityId}: tag(s) deleted with no merge target: ${tagIds.join(', ')}`));
}

// Not a 404 on a nonexistent entity: nothing to reject. Touches only the id's own type's table
// (tagEntityTypeOf()). A character still in the batch-import buffer is written to the table first, as in
// assignEntityTag().
// Unassigning a marked tag removes that tag's own row, never its merge target's: the client's delete-and-merge sends
// it for every loaded entity carrying the marked tag, including one that already had the target.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {string} tagId
 * @returns {Promise<'ok' | null>}
 */
export async function unassignEntityTag(directories, id, tagId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const type = tagEntityTypeOf(id);
    if (type === null) return 'ok';

    if (type === 'character') flushBufferedRow(entry, id);

    entry.db.transaction(() => {
        if (type === 'group') {
            const deleted = entry.db.run('DELETE FROM group_tags WHERE group_id = @id AND tag_id = @tagId', { id, tagId }).changes > 0;
            const digestSet = setGroupDigestTagIdsSync(
                entry.db,
                id,
                groupDigestTagIdsHash({ tag_ids: Array.from(/** @type {Iterable<{ tag_id: string }>} */ (entry.db.iterate('SELECT tag_id FROM group_tags WHERE group_id = @id ORDER BY tag_id', { id })), r => r.tag_id) }),
            );
            if (deleted || digestSet) insertGroupChange(entry.db, id);
            return;
        }

        entry.db.run('DELETE FROM character_tags WHERE character_id = @id AND tag_id = @tagId', { id, tagId });
        const charRow = (/** @type {{ shallow_json: string } | undefined} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id })));
        if (charRow) {
            const currentTagIds = Array.from(/** @type {Iterable<{ tag_id: string }>} */ (entry.db.iterate('SELECT tag_id FROM character_tags WHERE character_id = @id', { id })), r => r.tag_id);
            const shallow = JSON.parse(charRow.shallow_json);
            shallow.tag_ids = currentTagIds;
            writeShallowJson(entry.db, id, shallow, ['tag_ids']);
        }
    });
    return 'ok';
}

/**
 * Adds the tags `fromId` has to what `toId` has; nothing `toId` already has is removed. A tag being deleted
 * is copied as its merge target, or not at all if it has none.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} fromId
 * @param {string} toId
 * @returns {Promise<'ok' | 'not_found' | null>} 'not_found' if either is not a character or group the store has.
 */
export async function copyEntityTags(directories, fromId, toId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const fromType = tagEntityTypeOf(fromId);
    if (fromType === null || tagEntityTypeOf(toId) === null) return 'not_found';

    if (fromType === 'character') flushBufferedRow(entry, fromId);
    const fromExists = fromType === 'character'
        ? !!entry.db.get('SELECT 1 FROM characters WHERE id = @id', { id: fromId })
        : !!entry.db.get('SELECT 1 FROM groups WHERE id = @id', { id: fromId });
    if (!fromExists) return 'not_found';

    const tagIds = fromType === 'character'
        ? readCharacterTagIds(entry.db, fromId)
        : Array.from(/** @type {Iterable<{ tag_id: string }>} */ (entry.db.iterate('SELECT tag_id FROM group_tags WHERE group_id = @id', { id: fromId })), r => r.tag_id);

    const imported = await importTagMap(entry, { [toId]: tagIds }, { label: 'tag copy', writeBuffered: true });
    if (imported.failed.length > 0) throw new Error(`Could not copy tags to ${toId}: ${imported.failed[0].message}`);
    return imported.droppedKeys.includes(toId) ? 'not_found' : 'ok';
}

/**
 * Adds the tags `fromId` has to what `toId` has, then takes them off `fromId`. Nothing `toId` already has is
 * removed. A tag being deleted is added as its merge target, or not at all if it has none.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} fromId
 * @param {string} toId
 * @returns {Promise<{ result: 'ok' | 'not_found', moved: string[] } | null>} moved: the tag ids taken off `fromId`.
 *   'not_found': `fromId` has tags and `toId` is not a character or group the store has; nothing was written.
 */
export async function moveEntityTags(directories, fromId, toId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const fromType = tagEntityTypeOf(fromId);
    if (fromType === null || fromId === toId) return { result: 'ok', moved: [] };

    if (fromType === 'character') flushBufferedRow(entry, fromId);
    const tagIds = fromType === 'character'
        ? readCharacterTagIds(entry.db, fromId)
        : Array.from(/** @type {Iterable<{ tag_id: string }>} */ (entry.db.iterate('SELECT tag_id FROM group_tags WHERE group_id = @id', { id: fromId })), r => r.tag_id);
    if (tagIds.length === 0) return { result: 'ok', moved: [] };
    if (tagEntityTypeOf(toId) === null) return { result: 'not_found', moved: [] };

    const imported = await importTagMap(entry, { [toId]: tagIds }, { label: 'tag move', writeBuffered: true });
    if (imported.failed.length > 0) throw new Error(`Could not move tags to ${toId}: ${imported.failed[0].message}`);
    if (imported.droppedKeys.includes(toId)) return { result: 'not_found', moved: [] };

    for (const tagId of tagIds) await unassignEntityTag(directories, fromId, tagId);
    return { result: 'ok', moved: tagIds };
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} groupId
 * @returns {Promise<string[]>}
 */
export async function getGroupTagIds(directories, groupId) {
    const entry = await getEntry(directories);
    if (!entry || tagEntityTypeOf(groupId) !== 'group') return [];
    return resolveTagIds(normalizeTagIds(Array.from(/** @type {Iterable<{ tag_id: string }>} */ (entry.db.iterate('SELECT tag_id FROM group_tags WHERE group_id = @id ORDER BY tag_id', { id: groupId })), r => r.tag_id)), readTagDeletionsSync(entry.db));
}

// SQL counterpart to tagEntityTypeOf(id) === 'group' for a group_tags row (case-sensitive, like endsWith()).
/** @param {string} groupIdSql */
const groupTagRowIsGroupSql = groupIdSql => `substr(${groupIdSql}, -4) <> '.png'`;
const GROUP_TAG_ROW_IS_GROUP_SQL = groupTagRowIsGroupSql('group_id');

/**
 * @typedef {object} EntityCountKind One kind of entity in entity_counts / entity_tag_counts (see SCHEMA_SQL).
 * @property {'character' | 'group'} name
 * @property {'characters' | 'groups'} table
 * @property {'character_tags' | 'group_tags'} tagTable
 * @property {'character_id' | 'group_id'} entityColumn
 * @property {(column: string) => string} tagRowCounts Whether a tag row with this entity id counts for its tag.
 */

/** @type {EntityCountKind[]} */
const ENTITY_COUNT_KINDS = [
    { name: 'character', table: 'characters', tagTable: 'character_tags', entityColumn: 'character_id', tagRowCounts: () => 'true' },
    { name: 'group', table: 'groups', tagTable: 'group_tags', entityColumn: 'group_id', tagRowCounts: groupTagRowIsGroupSql },
];

/**
 * The triggers that keep the counters of one kind of entity.
 * @param {EntityCountKind} kind
 * @returns {{ name: string, sql: string }[]}
 */
function entityCountTriggers({ name, table, tagTable, entityColumn, tagRowCounts }) {
    const filled = (/** @type {string} */ idSql) => `EXISTS (SELECT 1 FROM entity_count_fill WHERE kind = '${name}' AND (done = 1 OR ${idSql} <= upto))`;
    const tagRowsOf = (/** @type {string} */ idSql) => `SELECT tag_id FROM ${tagTable} WHERE ${entityColumn} = ${idSql} AND ${tagRowCounts(entityColumn)}`;
    const add = (/** @type {string} */ ref) => `
        INSERT INTO entity_counts (kind, fav, count) VALUES ('${name}', ${ref}.fav, 1)
            ON CONFLICT (kind, fav) DO UPDATE SET count = count + 1;
        INSERT INTO entity_tag_counts (tag_id, kind, fav, count) SELECT tag_id, '${name}', ${ref}.fav, 1 FROM (${tagRowsOf(`${ref}.id`)}) WHERE true
            ON CONFLICT (tag_id, kind, fav) DO UPDATE SET count = count + 1;`;
    const remove = (/** @type {string} */ ref) => `
        UPDATE entity_counts SET count = count - 1 WHERE kind = '${name}' AND fav = ${ref}.fav;
        DELETE FROM entity_counts WHERE kind = '${name}' AND fav = ${ref}.fav AND count = 0;
        UPDATE entity_tag_counts SET count = count - 1 WHERE kind = '${name}' AND fav = ${ref}.fav AND tag_id IN (${tagRowsOf(`${ref}.id`)});
        DELETE FROM entity_tag_counts WHERE kind = '${name}' AND fav = ${ref}.fav AND count = 0 AND tag_id IN (${tagRowsOf(`${ref}.id`)});`;
    const entityFav = (/** @type {string} */ idSql) => `(SELECT fav FROM ${table} WHERE id = ${idSql})`;
    const triggers = [
        [`trg_${table}_count_ai`, `AFTER INSERT ON ${table} WHEN ${filled('NEW.id')}`, add('NEW')],
        [`trg_${table}_count_ad`, `AFTER DELETE ON ${table} WHEN ${filled('OLD.id')}`, remove('OLD')],
        // Entity ids never change by UPDATE (a rename inserts the new row and deletes the old), so OLD.id = NEW.id.
        [`trg_${table}_count_au_fav`, `AFTER UPDATE OF fav ON ${table} WHEN OLD.fav IS NOT NEW.fav AND ${filled('NEW.id')}`, remove('OLD') + add('NEW')],
        // A tag row counts only while its entity row exists: the entity's insert and delete count its tag rows.
        [`trg_${tagTable}_count_ai`, `AFTER INSERT ON ${tagTable} WHEN ${tagRowCounts(`NEW.${entityColumn}`)} AND ${filled(`NEW.${entityColumn}`)}`, `
            INSERT INTO entity_tag_counts (tag_id, kind, fav, count) SELECT NEW.tag_id, '${name}', fav, 1 FROM ${table} WHERE id = NEW.${entityColumn}
                ON CONFLICT (tag_id, kind, fav) DO UPDATE SET count = count + 1;`],
        [`trg_${tagTable}_count_ad`, `AFTER DELETE ON ${tagTable} WHEN ${tagRowCounts(`OLD.${entityColumn}`)} AND ${filled(`OLD.${entityColumn}`)}`, `
            UPDATE entity_tag_counts SET count = count - 1 WHERE tag_id = OLD.tag_id AND kind = '${name}' AND fav = ${entityFav(`OLD.${entityColumn}`)};
            DELETE FROM entity_tag_counts WHERE tag_id = OLD.tag_id AND kind = '${name}' AND fav = ${entityFav(`OLD.${entityColumn}`)} AND count = 0;`],
    ];
    return triggers.map(([triggerName, when, body]) => ({ name: triggerName, sql: `CREATE TRIGGER IF NOT EXISTS ${triggerName} ${when} BEGIN ${body} END;` }));
}

/**
 * One kind of entity's tag sort table (search plan step 5): one row per tag row whose entity exists, holding the
 * entity's sort keys, so an included tag's entities can be read in a sort's order and a page stops after the page.
 * Its columns are prefixed `k_` so a query joining it to the entity table names no column twice.
 * @typedef {object} TagSortKind
 * @property {'character' | 'group'} name
 * @property {'characters' | 'groups'} table
 * @property {'character_tags' | 'group_tags'} tagTable
 * @property {'character_id' | 'group_id'} entityColumn
 * @property {'character_tag_sort' | 'group_tag_sort'} sortTable
 * @property {{ key: string, source: string }[]} columns Each sort key column and the entity column it copies.
 * @property {string} tieKey The tie key, over the sort table's `entity_id`.
 * @property {(column: string) => string} tagRowCounts Whether a tag row with this entity id counts for its tag.
 */

/** @type {TagSortKind[]} */
const TAG_SORT_KINDS = [
    {
        name: 'character', table: 'characters', tagTable: 'character_tags', entityColumn: 'character_id', sortTable: 'character_tag_sort',
        columns: ['fav', 'name_fold', 'date_added', 'date_last_chat', 'create_date', 'data_size', 'chat_size'].map(c => ({ key: `k_${c}`, source: c })),
        tieKey: 'entity_id',
        tagRowCounts: () => 'true',
    },
    {
        name: 'group', table: 'groups', tagTable: 'group_tags', entityColumn: 'group_id', sortTable: 'group_tag_sort',
        columns: ['fav', 'name_fold', 'date_added', 'date_last_chat', 'chat_size'].map(c => ({ key: `k_${c}`, source: c })),
        tieKey: '(entity_id || \'.json\')',
        tagRowCounts: groupTagRowIsGroupSql,
    },
];

/**
 * The tables, indexes and triggers of one kind's tag sort table. The triggers keep a row for every tag row whose
 * entity exists, whatever writes; fillTagSortTablesIfNeeded() adds the rows that existed before them.
 * @param {TagSortKind} kind
 * @returns {{ tableSql: string, triggers: { name: string, sql: string }[] }}
 */
function tagSortSchema({ table, tagTable, entityColumn, sortTable, columns, tieKey, tagRowCounts }) {
    const keyColumns = columns.map(c => c.key).join(', ');
    const sortColumns = columns.filter(c => c.key !== 'k_fav');
    const indexes = [
        ...sortColumns.flatMap(c => ['ASC', 'DESC'].map(dir =>
            `CREATE INDEX IF NOT EXISTS idx_${sortTable}_${c.source}_${dir.toLowerCase()} ON ${sortTable}(tag_id, k_fav, ${c.key} ${dir}, ${tieKey} ASC);`)),
        `CREATE INDEX IF NOT EXISTS idx_${sortTable}_key ON ${sortTable}(tag_id, k_fav, ${tieKey} ASC);`,
        `CREATE INDEX IF NOT EXISTS idx_${sortTable}_entity ON ${sortTable}(entity_id, tag_id);`,
    ];
    const tableSql = `
        CREATE TABLE IF NOT EXISTS ${sortTable} (
            tag_id    TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            ${columns.map(c => `${c.key} ${c.source === 'name_fold' ? 'TEXT' : 'INTEGER'}`).join(',\n            ')},
            PRIMARY KEY (tag_id, entity_id)
        ) WITHOUT ROWID;
        ${indexes.join('\n        ')}`;
    const fromEntity = (/** @type {string} */ ref) => columns.map(c => `${ref}.${c.source}`).join(', ');
    const changed = columns.map(c => `OLD.${c.source} IS NOT NEW.${c.source}`).join(' OR ');
    const triggers = [
        [`trg_${table}_tagsort_ai`, `AFTER INSERT ON ${table}`, `
            INSERT OR REPLACE INTO ${sortTable} (tag_id, entity_id, ${keyColumns})
                SELECT tag_id, NEW.id, ${fromEntity('NEW')} FROM ${tagTable} WHERE ${entityColumn} = NEW.id AND ${tagRowCounts(entityColumn)};`],
        [`trg_${table}_tagsort_ad`, `AFTER DELETE ON ${table}`, `
            DELETE FROM ${sortTable} WHERE entity_id = OLD.id;`],
        [`trg_${table}_tagsort_au`, `AFTER UPDATE OF ${columns.map(c => c.source).join(', ')} ON ${table} WHEN ${changed}`, `
            UPDATE ${sortTable} SET ${columns.map(c => `${c.key} = NEW.${c.source}`).join(', ')} WHERE entity_id = NEW.id;`],
        [`trg_${tagTable}_tagsort_ai`, `AFTER INSERT ON ${tagTable} WHEN ${tagRowCounts(`NEW.${entityColumn}`)}`, `
            INSERT OR REPLACE INTO ${sortTable} (tag_id, entity_id, ${keyColumns})
                SELECT NEW.tag_id, id, ${fromEntity(table)} FROM ${table} WHERE id = NEW.${entityColumn};`],
        [`trg_${tagTable}_tagsort_ad`, `AFTER DELETE ON ${tagTable}`, `
            DELETE FROM ${sortTable} WHERE tag_id = OLD.tag_id AND entity_id = OLD.${entityColumn};`],
        [`trg_${tagTable}_tagsort_au`, `AFTER UPDATE ON ${tagTable}`, `
            DELETE FROM ${sortTable} WHERE tag_id = OLD.tag_id AND entity_id = OLD.${entityColumn};
            INSERT OR REPLACE INTO ${sortTable} (tag_id, entity_id, ${keyColumns})
                SELECT NEW.tag_id, id, ${fromEntity(table)} FROM ${table} WHERE id = NEW.${entityColumn} AND ${tagRowCounts(`NEW.${entityColumn}`)};`],
    ];
    return {
        tableSql,
        triggers: triggers.map(([name, when, body]) => ({ name, sql: `CREATE TRIGGER IF NOT EXISTS ${name} ${when} BEGIN ${body} END;` })),
    };
}

const TAG_SORT_SCHEMAS = TAG_SORT_KINDS.map(tagSortSchema);
const TAG_SORT_TABLES_SQL = TAG_SORT_SCHEMAS.map(schema => schema.tableSql).join('\n');
const TAG_SORT_TRIGGERS_SQL = TAG_SORT_SCHEMAS.flatMap(schema => schema.triggers).map(trigger => trigger.sql).join('\n');
const DROP_TAG_SORT_TRIGGERS_SQL = TAG_SORT_SCHEMAS.flatMap(schema => schema.triggers).map(trigger => `DROP TRIGGER IF EXISTS ${trigger.name};`).join('\n');
/** meta key: every tag sort table holds a row for every tag row that existed before its triggers. */
const TAG_SORT_FILLED_FLAG = 'tag_sort_tables_filled';
/** meta key prefix: the last entity id, per kind, whose tag rows the fill has copied. */
const TAG_SORT_FILL_UPTO_KEY = 'tag_sort_fill_upto_';
const TAG_SORT_FILL_BATCH_SIZE = 500;

/**
 * The random order's numbering (search plan step 7a, 7b): in every space, each member holds a unique rank
 * 0..size-1. The spaces are the whole list ('a'), each fav value ('f0', 'f1'), each tag (`t<US>tag`) and each tag
 * and fav value (`t<US>tag<US>f0`), with characters and groups in the same spaces. A removal moves the space's
 * last member into the freed rank, so the ranks stay dense.
 */
const RANDOM_RANKS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS random_ranks (
        space     TEXT NOT NULL,
        rank      INTEGER NOT NULL,
        kind      TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        PRIMARY KEY (space, rank)
    ) WITHOUT ROWID;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_random_ranks_entity ON random_ranks(kind, entity_id, space);`;

/** The separator inside a space name, as SQL and as JS. */
const RANDOM_SPACE_SEP_SQL = 'char(31)';
const RANDOM_SPACE_SEP = '\u001f';

/** @param {string} tagId @param {number | null} [fav] */
function randomSpaceName(tagId, fav) {
    if (tagId === '') return fav === null || fav === undefined ? 'a' : `f${fav}`;
    return fav === null || fav === undefined ? `t${RANDOM_SPACE_SEP}${tagId}` : `t${RANDOM_SPACE_SEP}${tagId}${RANDOM_SPACE_SEP}f${fav}`;
}

/** @param {string} tagSql */
const randomTagSpaceSql = tagSql => `('t' || ${RANDOM_SPACE_SEP_SQL} || ${tagSql})`;
/** @param {string} tagSql @param {string} favSql */
const randomTagFavSpaceSql = (tagSql, favSql) => `('t' || ${RANDOM_SPACE_SEP_SQL} || ${tagSql} || ${RANDOM_SPACE_SEP_SQL} || 'f' || ${favSql})`;

/**
 * Adds an entity to the spaces a SELECT names (column `sp`), each at rank = size, unless it is there already. Each
 * space appears once in the SELECT, so one statement never gives two rows the same rank.
 * @param {string} spacesSql
 * @param {string} kind
 * @param {string} idSql
 */
function randomRanksAddSql(spacesSql, kind, idSql) {
    return `
        INSERT INTO random_ranks (space, rank, kind, entity_id)
            SELECT s.sp, COALESCE((SELECT MAX(rank) FROM random_ranks WHERE space = s.sp), -1) + 1, '${kind}', ${idSql}
            FROM (${spacesSql}) s
            WHERE s.sp IS NOT NULL AND NOT EXISTS (SELECT 1 FROM random_ranks WHERE kind = '${kind}' AND entity_id = ${idSql} AND space = s.sp);`;
}

/**
 * Takes an entity out of the spaces of its own rows that `filterSql` keeps: its rank is parked as -1 - rank, each
 * space's last member takes the freed rank, and the parked row goes.
 * @param {string} filterSql over the column `space`
 * @param {string} kind
 * @param {string} idSql
 */
function randomRanksRemoveSql(filterSql, kind, idSql) {
    const parked = `(SELECT -1 - e.rank FROM random_ranks e WHERE e.space = random_ranks.space AND e.kind = '${kind}' AND e.entity_id = ${idSql} AND e.rank < 0)`;
    return `
        UPDATE random_ranks SET rank = -1 - rank WHERE kind = '${kind}' AND entity_id = ${idSql} AND rank >= 0 AND (${filterSql});
        UPDATE random_ranks SET rank = ${parked}
            WHERE space IN (SELECT space FROM random_ranks WHERE kind = '${kind}' AND entity_id = ${idSql} AND rank < 0)
              AND rank = (SELECT MAX(m.rank) FROM random_ranks m WHERE m.space = random_ranks.space)
              AND rank > ${parked};
        DELETE FROM random_ranks WHERE kind = '${kind}' AND entity_id = ${idSql} AND rank < 0;`;
}

/**
 * @typedef {object} RandomRankKind
 * @property {'c' | 'g'} code
 * @property {'character' | 'group'} name
 * @property {'characters' | 'groups'} table
 * @property {'character_tags' | 'group_tags'} tagTable
 * @property {'character_id' | 'group_id'} entityColumn
 * @property {(column: string) => string} tagRowCounts
 */

/** @type {RandomRankKind[]} */
const RANDOM_RANK_KINDS = [
    { code: 'c', name: 'character', table: 'characters', tagTable: 'character_tags', entityColumn: 'character_id', tagRowCounts: () => 'true' },
    { code: 'g', name: 'group', table: 'groups', tagTable: 'group_tags', entityColumn: 'group_id', tagRowCounts: groupTagRowIsGroupSql },
];

/**
 * The triggers that keep one kind's ranks, whatever writes.
 * @param {RandomRankKind} kind
 * @returns {{ name: string, sql: string }[]}
 */
function randomRankTriggers({ code, table, tagTable, entityColumn, tagRowCounts }) {
    const tagSpacesOf = (/** @type {string} */ idSql, /** @type {string} */ favSql) => `
        SELECT ${randomTagSpaceSql('tag_id')} AS sp FROM ${tagTable} WHERE ${entityColumn} = ${idSql} AND ${tagRowCounts(entityColumn)}
        UNION ALL
        SELECT ${randomTagFavSpaceSql('tag_id', favSql)} AS sp FROM ${tagTable} WHERE ${entityColumn} = ${idSql} AND ${tagRowCounts(entityColumn)}`;
    const ownFavSpaces = (/** @type {string} */ favSql) => `space = 'f' || ${favSql} OR (substr(space, 1, 1) = 't' AND substr(space, -3) = ${RANDOM_SPACE_SEP_SQL} || 'f' || ${favSql})`;
    const oneTagSpaces = (/** @type {string} */ tagSql) => `space = ${randomTagSpaceSql(tagSql)} OR space = ${randomTagFavSpaceSql(tagSql, '0')} OR space = ${randomTagFavSpaceSql(tagSql, '1')}`;
    const addTagRow = (/** @type {string} */ ref) => randomRanksAddSql(`
        SELECT ${randomTagSpaceSql(`${ref}.tag_id`)} AS sp FROM ${table} WHERE id = ${ref}.${entityColumn} AND ${tagRowCounts(`${ref}.${entityColumn}`)}
        UNION ALL
        SELECT ${randomTagFavSpaceSql(`${ref}.tag_id`, 'fav')} AS sp FROM ${table} WHERE id = ${ref}.${entityColumn} AND ${tagRowCounts(`${ref}.${entityColumn}`)}`, code, `${ref}.${entityColumn}`);
    const triggers = [
        [`trg_${table}_rank_ai`, `AFTER INSERT ON ${table}`,
            randomRanksAddSql(`SELECT 'a' AS sp UNION ALL SELECT 'f' || NEW.fav ${tagSpacesOf('NEW.id', 'NEW.fav').replace(/^\s*/, 'UNION ALL ')}`, code, 'NEW.id')],
        [`trg_${table}_rank_ad`, `AFTER DELETE ON ${table}`, randomRanksRemoveSql('1', code, 'OLD.id')],
        // Entity ids never change by UPDATE (a rename inserts the new row and deletes the old), so OLD.id = NEW.id.
        [`trg_${table}_rank_au_fav`, `AFTER UPDATE OF fav ON ${table} WHEN OLD.fav IS NOT NEW.fav`,
            randomRanksRemoveSql(ownFavSpaces('OLD.fav'), code, 'NEW.id')
            + randomRanksAddSql(`SELECT 'f' || NEW.fav AS sp UNION ALL SELECT ${randomTagFavSpaceSql('tag_id', 'NEW.fav')} AS sp FROM ${tagTable} WHERE ${entityColumn} = NEW.id AND ${tagRowCounts(entityColumn)}`, code, 'NEW.id')],
        [`trg_${tagTable}_rank_ai`, `AFTER INSERT ON ${tagTable}`, addTagRow('NEW')],
        [`trg_${tagTable}_rank_ad`, `AFTER DELETE ON ${tagTable}`, randomRanksRemoveSql(oneTagSpaces('OLD.tag_id'), code, `OLD.${entityColumn}`)],
        [`trg_${tagTable}_rank_au`, `AFTER UPDATE ON ${tagTable}`,
            randomRanksRemoveSql(oneTagSpaces('OLD.tag_id'), code, `OLD.${entityColumn}`) + addTagRow('NEW')],
    ];
    return triggers.map(([name, when, body]) => ({ name, sql: `CREATE TRIGGER IF NOT EXISTS ${name} ${when} BEGIN ${body} END;` }));
}

const RANDOM_RANK_TRIGGERS = RANDOM_RANK_KINDS.flatMap(randomRankTriggers);
const RANDOM_RANK_TRIGGERS_SQL = RANDOM_RANK_TRIGGERS.map(trigger => trigger.sql).join('\n');
const DROP_RANDOM_RANK_TRIGGERS_SQL = RANDOM_RANK_TRIGGERS.map(trigger => `DROP TRIGGER IF EXISTS ${trigger.name};`).join('\n');
/** meta key: every entity that existed before the rank triggers holds its ranks. */
const RANDOM_RANKS_FILLED_FLAG = 'random_ranks_filled';
/** meta key prefix: the last entity id, per kind, the rank fill has numbered. */
const RANDOM_RANKS_FILL_UPTO_KEY = 'random_ranks_fill_upto_';
const RANDOM_RANKS_FILL_BATCH_SIZE = 500;

/**
 * The full name order (search plan step 7f): every character and group holds a gap-spaced position in each of two
 * orders, so the search index can sort by name exactly. Ascending: `name_fold` ASC, then `tie_key`. Descending:
 * `name_fold` DESC, then `tie_key` (ties stay in the same order both ways). `tie_key` is the tie rule of step 4:
 * characters before groups, then the id in UTF-8 bytes, a group's as `<id>.json`.
 * A NULL position is one that still has to be placed: the triggers write NULL on every add and rename, and
 * placeNameOrderRows() places them. name_order_changes logs every character whose position changed after its doc
 * may have been built, so the characters index can update those docs; a row with entity_id NULL means every one.
 */
const NAME_ORDER_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS name_order (
        kind      TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        name_fold TEXT NOT NULL,
        tie_key   TEXT NOT NULL,
        pos_asc   INTEGER,
        pos_desc  INTEGER,
        PRIMARY KEY (kind, entity_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_name_order_asc ON name_order(name_fold ASC, tie_key ASC);
    CREATE INDEX IF NOT EXISTS idx_name_order_desc ON name_order(name_fold DESC, tie_key ASC);
    CREATE INDEX IF NOT EXISTS idx_name_order_unplaced ON name_order(kind, entity_id) WHERE pos_asc IS NULL OR pos_desc IS NULL;
    CREATE TABLE IF NOT EXISTS name_order_changes (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT
    );`;

/** @param {'c' | 'g'} code @param {string} idSql */
const nameOrderTieKeySql = (code, idSql) => code === 'c' ? `'c' || char(31) || ${idSql}` : `'g' || char(31) || ${idSql} || '.json'`;

const NAME_ORDER_TRIGGERS = [['c', 'characters'], ['g', 'groups']].flatMap(([code, table]) => [
    {
        name: `trg_${table}_name_order_ai`,
        sql: `CREATE TRIGGER IF NOT EXISTS trg_${table}_name_order_ai AFTER INSERT ON ${table} BEGIN
            INSERT INTO name_order (kind, entity_id, name_fold, tie_key) VALUES ('${code}', NEW.id, NEW.name_fold, ${nameOrderTieKeySql(/** @type {'c'|'g'} */ (code), 'NEW.id')})
                ON CONFLICT(kind, entity_id) DO UPDATE SET name_fold = excluded.name_fold, pos_asc = NULL, pos_desc = NULL;
        END;`,
    },
    {
        name: `trg_${table}_name_order_au`,
        sql: `CREATE TRIGGER IF NOT EXISTS trg_${table}_name_order_au AFTER UPDATE OF name_fold ON ${table} WHEN OLD.name_fold IS NOT NEW.name_fold BEGIN
            UPDATE name_order SET name_fold = NEW.name_fold, pos_asc = NULL, pos_desc = NULL WHERE kind = '${code}' AND entity_id = NEW.id;
        END;`,
    },
    {
        name: `trg_${table}_name_order_ad`,
        sql: `CREATE TRIGGER IF NOT EXISTS trg_${table}_name_order_ad AFTER DELETE ON ${table} BEGIN
            DELETE FROM name_order WHERE kind = '${code}' AND entity_id = OLD.id;
        END;`,
    },
]);
const NAME_ORDER_TRIGGERS_SQL = NAME_ORDER_TRIGGERS.map(trigger => trigger.sql).join('\n');
const DROP_NAME_ORDER_TRIGGERS_SQL = NAME_ORDER_TRIGGERS.map(trigger => `DROP TRIGGER IF EXISTS ${trigger.name};`).join('\n');
/** meta key: every entity has a name_order row and both orders were numbered once. */
const NAME_ORDER_FILLED_FLAG = 'name_order_filled';
/** meta key prefix: how far the name order fill has got, per phase. */
const NAME_ORDER_FILL_UPTO_KEY = 'name_order_fill_upto_';
const NAME_ORDER_FILL_BATCH_SIZE = 500;
/** The gap a fill or an append leaves between neighbouring positions. */
export const NAME_ORDER_SPACING = 2 ** 16;
/** Positions lie in (0, NAME_ORDER_LIMIT). With the fav bit above, every search index key stays below 2^53. */
export const NAME_ORDER_LIMIT = 2 ** 52;
/** The window a respace starts with, doubled while the window has no room. */
const NAME_ORDER_RESPACE_WINDOW = 64;

const ENTITY_COUNT_TRIGGERS = ENTITY_COUNT_KINDS.flatMap(entityCountTriggers);
const ENTITY_COUNT_TRIGGERS_SQL = ENTITY_COUNT_TRIGGERS.map(trigger => trigger.sql).join('\n');
const DROP_ENTITY_COUNT_TRIGGERS_SQL = ENTITY_COUNT_TRIGGERS.map(trigger => `DROP TRIGGER IF EXISTS ${trigger.name};`).join('\n');

const GROUP_INSERT_IF_MISSING_SQL = `
    INSERT INTO groups (id, name, name_fold, fav, date_added, date_last_chat, chat_size, digest_fav, digest_content)
    VALUES (@id, @name, @nameFold, @fav, @dateAdded, 0, 0, @digestFav, @digestContent)
    ON CONFLICT(id) DO NOTHING
`;

// row.group feeds digest_content only; its other fields live in the group's own JSON file, not a groups row column.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {object} params
 * @param {string} params.id
 * @param {string} [params.name]
 * @param {boolean} [params.fav]
 * @param {object} [params.group] Group's own JSON file contents, for digest_content only.
 * @param {number} params.dateAdded
 * @param {boolean} [params.insertOnly] true: leave an existing row untouched.
 * @returns {boolean} Whether the row was inserted or changed.
 */
function upsertGroupRowSync(db, { id, name, fav, group, dateAdded, insertOnly = false }) {
    const normalizedFav = normalizeFav(fav);
    const existed = !!db.get('SELECT 1 AS ok FROM groups WHERE id = @id', { id });
    if (existed && insertOnly) return false;
    const values = {
        name: name ?? '',
        name_fold: foldName(name),
        fav: normalizedFav ? 1 : 0,
        digest_fav: groupDigestFavHash({ fav: normalizedFav }),
        // Round-tripped so the digest is of what the group's JSON file holds, which is what clients hash.
        digest_content: groupDigestContentHash(group ? JSON.parse(JSON.stringify(group)) : {}),
    };
    // digest_tag_ids isn't written here: owned by assignEntityTag()/unassignEntityTag()'s group branch. date_added is
    // write-once. date_last_chat/chat_size are owned by applyGroupChatStats(), which follows every write to the
    // group's messages, and the backfill passes, not by /create or /edit requests.
    if (existed) return writeRowIfChanged(db, 'groups', { id }, values);
    const inserted = db.run(GROUP_INSERT_IF_MISSING_SQL, {
        id, name: values.name, nameFold: values.name_fold, fav: values.fav, dateAdded,
        digestFav: values.digest_fav, digestContent: values.digest_content,
    }).changes > 0;
    queueChatStatsReconcileSync(db, 'group', id);
    return inserted;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {string} name
 * @param {object} [params]
 * @param {boolean} [params.fav]
 * @param {object} [params.group]
 */
export async function upsertGroupRow(directories, id, name, { fav, group } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.transaction(() => {
        if (upsertGroupRowSync(entry.db, { id, name, fav, group, dateAdded: Date.now() })) insertGroupChange(entry.db, id);
    });
}

/**
 * Writes a group's own `<id>.json` (via `writeFile`) and updates its row from `group`, ordered so that a failure
 * at any step can't leave digest_content describing content the file doesn't hold:
 * 1. digest_content is set to NULL - if this throws, the file is not written.
 * 2. `writeFile()` - if this throws, the digest stays NULL.
 * 3. The row is upserted - if this throws, the digest stays NULL. Its groups version log row, when the file or the
 *    row changed, is added in the same transaction (so neither lands without the other) and not before the file is
 *    written, so no reader sees the new version with the old file.
 * NULL rather than a sentinel: every uint32 is a possible client hash, and hash mode recomputes a NULL digest from
 * the file itself, so a hit against it is a hit on the file's current content. Once the store is open the three
 * steps run synchronously, so no other write to the group can interleave.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} group The exact object `writeFile` serializes.
 * @param {() => void} writeFile
 * @param {object} [options]
 * @param {boolean} [options.createIfMissing] false: don't insert a missing row. For writers that can run before
 * bootstrapGroupsIfNeeded(), whose insert must be the one that sets date_added.
 */
export async function writeGroupFileAndRow(directories, group, writeFile, { createIfMissing = true } = {}) {
    const entry = await getEntry(directories);
    if (!entry) {
        writeFile();
        return;
    }
    const id = group.id;
    const filePath = path.join(directories.groups, sanitize(`${id}.json`));
    const rowBefore = groupRowSnapshot(entry.db, id);
    const fileBefore = readFileForComparison(filePath);
    writeRowIfChanged(entry.db, 'groups', { id }, { digest_content: null });
    writeFile();
    // The file is read too (the groups search index builds from it), so a change to it alone is a group change.
    const fileChanged = !sameFileContents(fileBefore, readFileForComparison(filePath));
    try {
        entry.db.transaction(() => {
            if (createIfMissing || entry.db.get('SELECT 1 FROM groups WHERE id = @id', { id })) {
                upsertGroupRowSync(entry.db, { id, name: group.name, fav: group.fav, group, dateAdded: Date.now() });
            }
            if (fileChanged || groupRowSnapshot(entry.db, id) !== rowBefore) insertGroupChange(entry.db, id, path.basename(filePath));
        });
    } catch (err) {
        console.error(`[character-metadata] Could not update the row for group ${id} after writing its file; its digest stays NULL and is recomputed from the file:`, /** @type {any} */ (err).message);
    }
}

/**
 * Writes a group file that is not the group's own `<id>.json` (via `writeFile`). No row describes that file, but the
 * groups search index reads every file in the folder, so a change to its bytes adds a groups version log row naming
 * that file: for the group's id, or group_id NULL when it has no id a row could be keyed by. Never throws after the
 * file is written.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} group The exact object `writeFile` serializes.
 * @param {string} filePath The file `writeFile` writes.
 * @param {() => void} writeFile
 */
export async function writeGroupFileAtOtherPath(directories, group, filePath, writeFile) {
    const entry = await getEntry(directories);
    if (!entry) {
        writeFile();
        return;
    }
    const fileBefore = readFileForComparison(filePath);
    writeFile();
    if (sameFileContents(fileBefore, readFileForComparison(filePath))) return;
    const groupId = hasGroupIdForRow(group) ? /** @type {any} */ (group).id : null;
    try {
        entry.db.transaction(() => insertGroupChange(entry.db, groupId, path.basename(filePath)));
    } catch (err) {
        console.error(`[character-metadata] Could not add the groups version log row for group file ${filePath} after writing it; results that include groups may stay stale until the next group write:`, /** @type {any} */ (err).message);
    }
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @returns {string} Every column of the group's row, comparable with ===; 'null' when it has none.
 */
function groupRowSnapshot(db, id) {
    const row = db.get('SELECT * FROM groups WHERE id = @id', { id });
    return JSON.stringify(row ?? null, (_key, value) => (typeof value === 'bigint' ? String(value) : value));
}

/**
 * @param {string} filePath
 * @returns {Buffer | null | undefined} null when the file doesn't exist, undefined when it couldn't be read.
 */
function readFileForComparison(filePath) {
    try {
        return fs.readFileSync(filePath);
    } catch (err) {
        return /** @type {NodeJS.ErrnoException} */ (err)?.code === 'ENOENT' ? null : undefined;
    }
}

/**
 * @param {Buffer | null | undefined} a
 * @param {Buffer | null | undefined} b
 * @returns {boolean} false when either couldn't be read.
 */
function sameFileContents(a, b) {
    if (a === undefined || b === undefined) return false;
    if (a === null || b === null) return a === b;
    return a.equals(b);
}

/** The highest activity_pending seq handed out by this process; see {@link nextActivitySeq}. */
let lastActivitySeq = 0;

/**
 * A seq for a queued activity write, above every one handed out before, in this process and (being at least the
 * clock) before it. Query tokens carry the queue's highest seq, so the queue's state is part of every token.
 */
function nextActivitySeq() {
    lastActivitySeq = Math.max(Date.now(), lastActivitySeq + 1);
    return lastActivitySeq;
}

/** @typedef {{ sizeDelta: number, addedAt: number }} PendingActivity */

/**
 * The queued activity of `ids`, keyed by id; an id with nothing queued is absent.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {'character' | 'group'} kind
 * @param {string[]} ids
 * @returns {Map<string, PendingActivity>}
 */
function readActivityPendingSync(db, kind, ids) {
    /** @type {Map<string, PendingActivity>} */
    const result = new Map();
    if (ids.length === 0) return result;
    const any = /** @type {{ x: number } | undefined} */ (db.get('SELECT 1 AS x FROM activity_pending LIMIT 1'));
    if (!any) return result;
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        for (const row of /** @type {Iterable<{ id: string, size_delta: number, added_at: number }>} */ (db.iterate(
            'SELECT id, size_delta, added_at FROM activity_pending WHERE kind = @kind AND id IN (SELECT value FROM json_each(@ids))',
            { kind, ids: JSON.stringify(batch) }))) {
            result.set(String(row.id), { sizeDelta: Number(row.size_delta), addedAt: Number(row.added_at) });
        }
    }
    return result;
}

/**
 * A row's chat stats with its queued activity on top: what the row would hold had every queued write been written.
 * @param {{ chatSize: number, dateLastChat: number }} stored
 * @param {PendingActivity | undefined} pending
 * @returns {{ chatSize: number, dateLastChat: number }}
 */
function withPendingActivity(stored, pending) {
    if (!pending) return stored;
    return { chatSize: stored.chatSize + pending.sizeDelta, dateLastChat: Math.max(stored.dateLastChat, pending.addedAt) };
}

/**
 * Puts each row's queued activity on top of its chat_size and date_last_chat, and its shallow copy's, in place.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {'character' | 'group'} kind
 * @param {Array<{ id: string, chat_size?: number, date_last_chat?: number }>} rows Rows read from the kind's table.
 * @param {(row: any) => any} [shallowOf] The parsed shallow copy of a row, when it has one to correct too.
 */
function overlayActivitySync(db, kind, rows, shallowOf) {
    const pending = readActivityPendingSync(db, kind, rows.map(r => String(r.id)));
    if (pending.size === 0) return;
    for (const row of rows) {
        const queued = pending.get(String(row.id));
        if (!queued) continue;
        const stats = withPendingActivity({ chatSize: Number(row.chat_size ?? 0), dateLastChat: Number(row.date_last_chat ?? 0) }, queued);
        if ('chat_size' in row) row.chat_size = stats.chatSize;
        if ('date_last_chat' in row) row.date_last_chat = stats.dateLastChat;
        const shallow = shallowOf ? shallowOf(row) : null;
        if (shallow && typeof shallow === 'object') {
            shallow.chat_size = stats.chatSize;
            shallow.date_last_chat = stats.dateLastChat;
        }
    }
}

/**
 * {@link overlayActivitySync} for parsed character shallow copies, keyed by their `avatar`.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {any[] | undefined} shallowRows
 */
function overlayShallowRowsSync(db, shallowRows) {
    if (!shallowRows || shallowRows.length === 0) return;
    const wrapped = shallowRows.filter(r => r && typeof r.avatar === 'string')
        .map(r => ({ id: r.avatar, chat_size: Number(r.chat_size ?? 0), date_last_chat: Number(r.date_last_chat ?? 0), shallow: r }));
    overlayActivitySync(db, 'character', wrapped, r => r.shallow);
}

/**
 * Queued activity on top of queryCharacters()' wire rows (parsed shallow copies) or hash rows, in place.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {any[] | undefined} rows
 * @param {Array<{ id: string, chat_size: number, date_last_chat: number }> | undefined} hashRows
 */
function overlayQueryRowsSync(db, rows, hashRows) {
    overlayShallowRowsSync(db, rows);
    if (hashRows && hashRows.length > 0) overlayActivitySync(db, 'character', hashRows);
}

/**
 * {@link overlayActivitySync} for raw entity rows (characters and groups mixed, `type` per row), before they are mapped
 * to wire or hash rows: the columns and, for a character, its stored shallow copy.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {Array<{ id: string, type: string, chat_size?: number, date_last_chat?: number, shallow_json?: string | null }>} rows
 */
function overlayEntityRowsSync(db, rows) {
    for (const kind of /** @type {const} */ (['character', 'group'])) {
        const ofKind = rows.filter(r => r.type === kind);
        if (ofKind.length === 0) continue;
        const pending = readActivityPendingSync(db, kind, ofKind.map(r => String(r.id)));
        if (pending.size === 0) continue;
        for (const row of ofKind) {
            const queued = pending.get(String(row.id));
            if (!queued) continue;
            const stats = withPendingActivity({ chatSize: Number(row.chat_size ?? 0), dateLastChat: Number(row.date_last_chat ?? 0) }, queued);
            row.chat_size = stats.chatSize;
            row.date_last_chat = stats.dateLastChat;
            if (typeof row.shallow_json === 'string') {
                try {
                    const shallow = JSON.parse(row.shallow_json);
                    shallow.chat_size = stats.chatSize;
                    shallow.date_last_chat = stats.dateLastChat;
                    row.shallow_json = JSON.stringify(shallow);
                } catch {
                    // An unreadable copy is left to its reader, which skips it.
                }
            }
        }
    }
}

/**
 * Writes queued activity into its rows (characters' chat stats and shallow copy, groups' chat stats), then drops it.
 * With `ids`, only those entities' activity; without, every queued row, for a read whose order or filter depends on
 * the values. Runs synchronously in transactions of at most FOLD_BATCH_ROWS rows.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {{ kind: 'character' | 'group', ids: string[] }} [only]
 * @returns {number} How many rows' queued activity was written.
 */
function foldActivitySync(db, only) {
    let folded = 0;
    for (;;) {
        /** @type {{ kind: 'character' | 'group', id: string, size_delta: number, added_at: number }[]} */
        const batch = only
            ? (only.ids.length === 0 ? [] : /** @type {any[]} */ (db.readBounded(
                'SELECT kind, id, size_delta, added_at FROM activity_pending WHERE kind = @kind AND id IN (SELECT value FROM json_each(@ids)) LIMIT @limit',
                { kind: only.kind, ids: JSON.stringify(only.ids.slice(0, FOLD_BATCH_ROWS)), limit: FOLD_BATCH_ROWS }, FOLD_BATCH_ROWS)))
            : /** @type {any[]} */ (db.readBounded('SELECT kind, id, size_delta, added_at FROM activity_pending ORDER BY seq LIMIT @limit', { limit: FOLD_BATCH_ROWS }, FOLD_BATCH_ROWS));
        if (batch.length === 0) return folded;
        db.transaction(() => {
            for (const row of batch) {
                const pending = { sizeDelta: Number(row.size_delta), addedAt: Number(row.added_at) };
                if (row.kind === 'character') {
                    const stored = /** @type {{ chat_size: number, date_last_chat: number } | undefined} */ (db.get(
                        'SELECT chat_size, date_last_chat FROM characters WHERE id = @id', { id: row.id }));
                    if (stored) writeCharacterChatStatsSync(db, row.id, withPendingActivity({ chatSize: Number(stored.chat_size), dateLastChat: Number(stored.date_last_chat) }, pending));
                } else {
                    const stored = /** @type {{ chat_size: number, date_last_chat: number } | undefined} */ (db.get(
                        'SELECT chat_size, date_last_chat FROM groups WHERE id = @id', { id: row.id }));
                    if (stored) writeGroupChatStatsSync(db, row.id, withPendingActivity({ chatSize: Number(stored.chat_size), dateLastChat: Number(stored.date_last_chat) }, pending));
                }
                db.run('DELETE FROM activity_pending WHERE kind = @kind AND id = @id', { kind: row.kind, id: row.id });
            }
        });
        folded += batch.length;
        if (only && only.ids.length <= FOLD_BATCH_ROWS) return folded;
        if (only) only = { kind: only.kind, ids: only.ids.slice(FOLD_BATCH_ROWS) };
    }
}

/** Queued rows written per transaction by {@link foldActivitySync}. */
const FOLD_BATCH_ROWS = 500;

/** Past this many queued rows, the whole queue is written out in the background ({@link queueActivitySync}). */
const ACTIVITY_QUEUE_LIMIT = 10000;

/**
 * Records one committed message write's change to an entity's chat stats. A write that inserted or edited only adds
 * to the entity's queued activity (no write to its row); a write that deleted a row writes the entity's row now,
 * queued activity included, since its date_last_chat has to be read back from the tree.
 * @param {MetadataDbEntry} entry
 * @param {'character' | 'group'} kind
 * @param {string} id
 * @param {{ sizeChange: number, addedCreatedAt: number | null, readLastCreatedAt: (() => number) | null }} change
 */
function queueActivitySync(entry, kind, id, { sizeChange, addedCreatedAt, readLastCreatedAt }) {
    const db = entry.db;
    const table = kind === 'character' ? 'characters' : 'groups';
    const stored = /** @type {{ chat_size: number, date_last_chat: number } | undefined} */ (db.get(
        `SELECT chat_size, date_last_chat FROM ${table} WHERE id = @id`, { id }));
    if (!stored) {
        console.warn(color.yellow(`[character-metadata] Chat stats change for ${kind === 'group' ? `group ${id}` : id} (${sizeChange} bytes) not applied: it has no ${kind} row.`));
        return;
    }
    if (readLastCreatedAt) {
        const pending = readActivityPendingSync(db, kind, [id]).get(id);
        const chatSize = Number(stored.chat_size) + (pending?.sizeDelta ?? 0) + sizeChange;
        const dateLastChat = readLastCreatedAt();
        db.transaction(() => {
            if (kind === 'character') writeCharacterChatStatsSync(db, id, { chatSize, dateLastChat });
            else writeGroupChatStatsSync(db, id, { chatSize, dateLastChat });
            db.run('DELETE FROM activity_pending WHERE kind = @kind AND id = @id', { kind, id });
        });
        return;
    }
    if (sizeChange === 0) {
        const pending = readActivityPendingSync(db, kind, [id]).get(id);
        const dateBefore = Math.max(Number(stored.date_last_chat), pending?.addedAt ?? 0);
        if (addedCreatedAt === null || addedCreatedAt <= dateBefore) return;
    }
    db.run(`INSERT INTO activity_pending (kind, id, size_delta, added_at, seq) VALUES (@kind, @id, @sizeChange, @addedAt, @seq)
        ON CONFLICT (kind, id) DO UPDATE SET size_delta = size_delta + excluded.size_delta,
            added_at = MAX(added_at, excluded.added_at), seq = excluded.seq`,
    { kind, id, sizeChange, addedAt: addedCreatedAt ?? 0, seq: nextActivitySeq() });
    if (kind === 'group') characterChangeEmitter.emit(GROUP_CHANGES_EVENT);
    else characterChangeEmitter.emit('change');
    entry.activityQueued = (entry.activityQueued ?? 0) + 1;
    if (entry.activityQueued > ACTIVITY_QUEUE_LIMIT && entry.activityFoldScheduled !== true) {
        entry.activityFoldScheduled = true;
        setImmediate(() => {
            entry.activityFoldScheduled = false;
            entry.activityQueued = 0;
            try {
                foldActivitySync(db);
            } catch (err) {
                console.error(color.red('[character-metadata] Could not write the queued chat stats:'), err);
            }
        });
    }
}

/**
 * Records one committed message write's change to a character's chat stats: `chat_size` by the write's size change,
 * and `date_last_chat` to its newest message's `created_at`. Queued unless the write deleted a row
 * ({@link queueActivitySync}).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {object} change
 * @param {number} change.sizeChange
 * @param {number | null} change.addedCreatedAt The newest `created_at` the write inserted, if it inserted any.
 * @param {(() => number) | null} change.readLastCreatedAt Set when the write deleted a row: reads the character's
 *   newest message `created_at` (0 with none left) at the moment of this write.
 */
export async function applyCharacterChatStats(directories, avatar, { sizeChange, addedCreatedAt, readLastCreatedAt }) {
    const entry = await getEntry(directories);
    if (!entry) return;
    flushBufferedRow(entry, avatar);
    queueActivitySync(entry, 'character', avatar, { sizeChange, addedCreatedAt, readLastCreatedAt });
}

/**
 * Records one committed write's change to a group's chat stats, the same way {@link applyCharacterChatStats} does for
 * a character. A group's row change adds a groups version log row when it is written.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} groupId
 * @param {object} change
 * @param {number} change.sizeChange
 * @param {number | null} change.addedCreatedAt The newest `created_at` the write inserted, if it inserted any.
 * @param {(() => number) | null} change.readLastCreatedAt Set when the write deleted a row: reads the group's newest
 *   message `created_at` (0 with none left) at the moment of this write.
 */
export async function applyGroupChatStats(directories, groupId, { sizeChange, addedCreatedAt, readLastCreatedAt }) {
    const entry = await getEntry(directories);
    if (!entry) return;
    queueActivitySync(entry, 'group', groupId, { sizeChange, addedCreatedAt, readLastCreatedAt });
}

/**
 * The highest seq in the activity queue, 0 when it's empty: a query token component, read before the rows.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<number | null>} null when the store is unavailable.
 */
export async function getActivitySeq(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = /** @type {{ seq: number | null } | undefined} */ (entry.db.get('SELECT MAX(seq) AS seq FROM activity_pending'));
    return Number(row?.seq ?? 0);
}

/**
 * Writes every queued chat stats change into its row, for a read sorted or filtered by chat_size or date_last_chat.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<number>} How many rows' queued activity was written.
 */
export async function foldAllActivity(directories) {
    const entry = await getEntry(directories);
    if (!entry || isReadOnlyMode()) return 0;
    const folded = foldActivitySync(entry.db);
    if (folded > 0) entry.activityQueued = 0;
    return folded;
}

/** Sort fields and range fields whose values come from message writes and can be queued. */
const ACTIVITY_FIELDS = new Set(['date_last_chat', 'chat_size']);

/**
 * Whether a read sorted by `sortField` or filtered by `ranges` depends on queued activity, so the queue is written
 * into the rows before it.
 * @param {string | undefined} sortField
 * @param {unknown} ranges
 * @returns {boolean}
 */
export function readDependsOnActivity(sortField, ranges) {
    if (sortField !== undefined && ACTIVITY_FIELDS.has(sortField)) return true;
    if (Array.isArray(ranges)) return ranges.some(r => r && ACTIVITY_FIELDS.has(String(/** @type {any} */ (r).field)));
    if (ranges && typeof ranges === 'object') return Object.keys(ranges).some(k => ACTIVITY_FIELDS.has(k));
    return false;
}

/** @typedef {{ kind: 'character' | 'group', id: string }} QueuedChatStats */

/** How many queued rows one read of chat_stats_pending takes. */
const CHAT_STATS_QUEUE_PAGE_SIZE = 64;
/** Work time after which a page stops early and the rest of it waits for the next one. */
const CHAT_STATS_QUEUE_BUDGET_MS = 20;
/** The pause between pages. */
const CHAT_STATS_QUEUE_PAUSE_MS = 10;
/** How long a round that left rows queued behind an in-flight write waits before going round again. */
const CHAT_STATS_QUEUE_RETRY_MS = 100;

/** Set once the server listens (startChatStatsReconcile()) and cleared by disposeMetadataStores(); while unset,
 * queued rows only wait. */
let chatStatsReconcileStarted = false;

/**
 * Each store's running drain of chat_stats_pending, by store root. `again` asks it to go round once more, from the
 * start, when it finishes the round it's on.
 * @type {Map<string, { again: boolean, done: Promise<void> }>}
 */
const chatStatsDrains = new Map();

/**
 * Queues a row just inserted at chat_size 0 and date_last_chat 0 to be counted from its owner's messages. Meant to
 * run inside the transaction that inserts it.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {'character' | 'group'} kind
 * @param {string} id
 */
function queueChatStatsReconcileSync(db, kind, id) {
    db.run('INSERT OR IGNORE INTO chat_stats_pending (kind, id) VALUES (@kind, @id)', { kind, id });
    for (const entry of entries.values()) {
        // Runs once the current synchronous work, and so the inserting transaction, has finished.
        if (entry.db === db) setImmediate(() => kickChatStatsReconcile(entry.directories));
    }
}

/**
 * For writers that change a message tree owner's messages without going through the owner write hook
 * (message-tree-db.js reportOwnerWrite()): gets a function that queues the rows holding an owner's chat stats. It is
 * synchronous, so a caller on the main thread can queue in the same synchronous step as its tree transaction, and no
 * drain runs in between. Only rows that exist are queued. With `owner` unknown, that is every row the owner id could
 * belong to; the reconcile gives the stats to the one the owner is recorded as (reconcileQueuedChatStatsSync()).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} [options]
 * @param {boolean} [options.existingOnly] Don't create a store that doesn't exist yet. For callers that can run
 *   without one, where a new store's bootstrap queues every row anyway.
 * @returns {Promise<((ownerId: string, owner?: import('./message-tree-db.js').OwnerDescriptor) => void) | null>} null
 *   when the metadata store is unavailable, read-only, or (with `existingOnly`) doesn't exist.
 */
export async function openOwnerChatStatsQueue(directories, { existingOnly = false } = {}) {
    if (isReadOnlyMode()) return null;
    if (existingOnly && !entries.has(directories.root) && !fs.existsSync(getDbPath(directories))) return null;
    const entry = await getEntry(directories);
    if (!entry) return null;
    const { db } = entry;
    return (ownerId, owner) => {
        const rows = owner
            ? [{ kind: owner.kind, table: owner.kind === 'group' ? 'groups' : 'characters', ids: [owner.rowId] }]
            : [
                { kind: /** @type {const} */ ('character'), table: 'characters', ids: characterAvatarsForOwnerId(ownerId) },
                { kind: /** @type {const} */ ('group'), table: 'groups', ids: [ownerId] },
            ];
        db.transaction(() => {
            for (const { kind, table, ids } of rows) {
                for (const id of existingRowIds(db, table, ids)) queueChatStatsReconcileSync(db, kind, id);
            }
        });
    };
}

/**
 * Starts draining every store's chat_stats_pending, and lets rows queued from now on start a drain. Called once the
 * server listens.
 * @param {import('./users.js').UserDirectoryList[]} directoriesList
 */
export function startChatStatsReconcile(directoriesList) {
    chatStatsReconcileStarted = true;
    for (const directories of directoriesList) {
        kickChatStatsReconcile(directories);
        startChatStatsFullPass(directories);
    }
}

/** The meta key holding the one-time full pass's progress: the last row it counted, as JSON, or 'done'. */
const CHAT_STATS_FULL_PASS_META_KEY = 'chat_stats_full_pass';
/** The row kinds the full pass walks, in the order it walks them. */
const CHAT_STATS_FULL_PASS_KINDS = /** @type {const} */ ([
    { kind: 'character', table: 'characters' },
    { kind: 'group', table: 'groups' },
]);

/**
 * Each store's running one-time full pass, by store root.
 * @type {Map<string, Promise<void>>}
 */
const chatStatsFullPasses = new Map();

/**
 * Starts the store's one-time full pass (runChatStatsFullPass()) unless it's done or already running.
 * @param {import('./users.js').UserDirectoryList} directories
 */
function startChatStatsFullPass(directories) {
    if (!chatStatsReconcileStarted || !isMainThread || isReadOnlyMode()) return;
    if (chatStatsFullPasses.has(directories.root)) return;
    const done = runChatStatsFullPass(directories)
        .catch(err => console.error(color.red(`[character-metadata] The one-time chat stats pass for ${directories.root} failed; it resumes on the next boot:`), err))
        .finally(() => {
            if (chatStatsFullPasses.get(directories.root) === done) chatStatsFullPasses.delete(directories.root);
        });
    chatStatsFullPasses.set(directories.root, done);
}

/**
 * Counts every character and group row's chat stats from its owner's messages once, to fix values that drifted before
 * every writer kept them current; after it, chat_stats_pending alone keeps them right. On this thread for the same
 * reason as the drain (kickChatStatsReconcile()). A row whose owner has a stats change in flight, or whose count
 * fails, goes into chat_stats_pending, where the drain retries it.
 * @param {import('./users.js').UserDirectoryList} directories
 */
async function runChatStatsFullPass(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const saved = (/** @type {{ value: string } | undefined} */ (entry.db.get('SELECT value FROM meta WHERE key = @key', { key: CHAT_STATS_FULL_PASS_META_KEY })))?.value;
    if (saved === 'done') return;
    /** @type {QueuedChatStats | null} */
    let after = saved === undefined ? null : JSON.parse(saved);
    const progress = new ProgressLog({ what: '[character-metadata] counting chat sizes and last-chat dates', total: countChatStatsFullPassLeft(entry.db, after) });
    let changed = 0;

    for (;;) {
        // Stopped by disposeMetadataStores(); it resumes from the saved row on the next start.
        if (!chatStatsReconcileStarted) return;
        const current = await getEntry(directories);
        if (!current) return;
        const { db } = current;
        const view = await openOwnerStatsView(directories);
        const page = readChatStatsFullPassPage(db, after);
        if (page.length === 0) {
            setMetaSync(db, CHAT_STATS_FULL_PASS_META_KEY, 'done');
            progress.finish(`${changed.toLocaleString('en-US')} corrected`);
            return;
        }
        const started = performance.now();
        for (const row of page) {
            after = row;
            progress.add();
            try {
                const outcome = reconcileQueuedChatStatsSync(db, view, row);
                if (outcome === 'waiting') queueChatStatsReconcileSync(db, row.kind, row.id);
                else if (outcome === 'changed') changed++;
            } catch (err) {
                console.error(color.red(`[character-metadata] Counting the chat stats of ${row.kind} ${row.id} failed; it is queued to be retried:`), err);
                queueChatStatsReconcileSync(db, row.kind, row.id);
            }
            if (performance.now() - started >= CHAT_STATS_QUEUE_BUDGET_MS) break;
        }
        setMetaSync(db, CHAT_STATS_FULL_PASS_META_KEY, JSON.stringify(after));
        await delay(CHAT_STATS_QUEUE_PAUSE_MS);
    }
}

/**
 * How many character and group rows the full pass has left after `after`.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {QueuedChatStats | null} after
 * @returns {number}
 */
function countChatStatsFullPassLeft(db, after) {
    const start = after === null ? 0 : CHAT_STATS_FULL_PASS_KINDS.findIndex(k => k.kind === after.kind);
    let left = 0;
    for (let i = start; i < CHAT_STATS_FULL_PASS_KINDS.length; i++) {
        const { table } = CHAT_STATS_FULL_PASS_KINDS[i];
        const row = /** @type {{ n: number }} */ (after !== null && i === start
            ? db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE id > @id`, { id: after.id })
            : db.get(`SELECT COUNT(*) AS n FROM ${table}`, {}));
        left += Number(row.n);
    }
    return left;
}

/**
 * The next page of character and group rows after `after`, characters first, each kind by id.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {QueuedChatStats | null} after
 * @returns {QueuedChatStats[]}
 */
function readChatStatsFullPassPage(db, after) {
    /** @type {QueuedChatStats[]} */
    const page = [];
    const start = after === null ? 0 : CHAT_STATS_FULL_PASS_KINDS.findIndex(k => k.kind === after.kind);
    for (let i = start; i < CHAT_STATS_FULL_PASS_KINDS.length && page.length < CHAT_STATS_QUEUE_PAGE_SIZE; i++) {
        const { kind, table } = CHAT_STATS_FULL_PASS_KINDS[i];
        const limit = CHAT_STATS_QUEUE_PAGE_SIZE - page.length;
        const rows = after !== null && i === start
            ? db.iterate(`SELECT id FROM ${table} WHERE id > @id ORDER BY id LIMIT @limit`, { id: after.id, limit })
            : db.iterate(`SELECT id FROM ${table} ORDER BY id LIMIT @limit`, { limit });
        for (const row of /** @type {Iterable<{ id: string }>} */ (rows)) page.push({ kind, id: row.id });
    }
    return page;
}

/**
 * Makes sure the store's chat_stats_pending gets drained: starts a drain, or has the running one go round again.
 * Only on the main thread, where every message write's stats change is applied (message-tree-db.js
 * reportOwnerWrite()), so the drain can tell which owners have one in flight. Rows queued in a worker wait for the
 * next kick here.
 * @param {import('./users.js').UserDirectoryList} directories
 */
export function kickChatStatsReconcile(directories) {
    if (!chatStatsReconcileStarted || !isMainThread || isReadOnlyMode()) return;
    const running = chatStatsDrains.get(directories.root);
    if (running) {
        running.again = true;
        return;
    }
    const drain = { again: false, done: Promise.resolve() };
    chatStatsDrains.set(directories.root, drain);
    drain.done = drainChatStatsQueue(directories, drain)
        .catch(err => console.error(color.red(`[character-metadata] Counting queued chat stats for ${directories.root} failed; they stay queued:`), err))
        .finally(() => {
            if (chatStatsDrains.get(directories.root) === drain) chatStatsDrains.delete(directories.root);
        });
}

/**
 * Settles once the store has no drain and no one-time full pass running.
 * @param {import('./users.js').UserDirectoryList} directories
 */
export async function chatStatsReconcileIdle(directories) {
    for (;;) {
        const running = chatStatsFullPasses.get(directories.root) ?? chatStatsDrains.get(directories.root)?.done;
        if (!running) return;
        await running;
        // A row the full pass queued kicks the drain on the next turn.
        await new Promise(resolve => setImmediate(resolve));
    }
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ again: boolean }} drain
 */
async function drainChatStatsQueue(directories, drain) {
    const first = await getEntry(directories);
    if (!first) return;
    const pending = /** @type {{ n: number }} */ (first.db.get('SELECT COUNT(*) AS n FROM chat_stats_pending', {}));
    const progress = new ProgressLog({ what: '[character-metadata] counting queued chat sizes and last-chat dates', total: Number(pending.n) });
    let changed = 0;
    do {
        drain.again = false;
        let waiting = 0;
        /** @type {QueuedChatStats | null} */
        let after = null;
        for (;;) {
            // Stopped by disposeMetadataStores(); the rows stay queued for the next start.
            if (!chatStatsReconcileStarted) return;
            const entry = await getEntry(directories);
            if (!entry) return;
            const view = await openOwnerStatsView(directories);
            const page = readChatStatsQueuePage(entry.db, after);
            if (page.length === 0) break;
            const started = performance.now();
            for (const queued of page) {
                after = queued;
                try {
                    const outcome = reconcileQueuedChatStatsSync(entry.db, view, queued);
                    if (outcome === 'waiting') waiting++;
                    else {
                        progress.add();
                        if (outcome === 'changed') changed++;
                    }
                } catch (err) {
                    console.error(color.red(`[character-metadata] Counting the chat stats of ${queued.kind} ${queued.id} failed; it stays queued:`), err);
                }
                if (performance.now() - started >= CHAT_STATS_QUEUE_BUDGET_MS) break;
            }
            await delay(CHAT_STATS_QUEUE_PAUSE_MS);
        }
        if (waiting > 0) {
            drain.again = true;
            await delay(CHAT_STATS_QUEUE_RETRY_MS);
        }
    } while (drain.again);
    // One queued row is a single update, which logs nothing.
    if (progress.done > 1) progress.finish(`${changed.toLocaleString('en-US')} corrected`);
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {QueuedChatStats | null} after
 * @returns {QueuedChatStats[]}
 */
function readChatStatsQueuePage(db, after) {
    const rows = after === null
        ? db.iterate('SELECT kind, id FROM chat_stats_pending ORDER BY kind, id LIMIT @limit', { limit: CHAT_STATS_QUEUE_PAGE_SIZE })
        : db.iterate('SELECT kind, id FROM chat_stats_pending WHERE kind > @kind OR (kind = @kind AND id > @id) ORDER BY kind, id LIMIT @limit',
            { kind: after.kind, id: after.id, limit: CHAT_STATS_QUEUE_PAGE_SIZE });
    return Array.from(rows, row => /** @type {QueuedChatStats} */ (row));
}

/**
 * Counts one queued row's chat stats from its owner's messages and removes it from the queue, all in one synchronous
 * step, so no message write's stats change can land between the count and the write. The row gets the owner's
 * stats only when the owner is recorded as this row; an owner with messages but no recorded kind is first recorded
 * by the rows that exist (ownerKindFromRowsSync()), so later writes keep the row current.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {import('./message-tree-db.js').OwnerStatsView | null} view null when the tree store is unavailable.
 * @param {QueuedChatStats} queued
 * @returns {'waiting' | 'changed' | 'unchanged'} 'waiting' when it was left queued because a write to its owner has a
 *   stats change in flight.
 */
function reconcileQueuedChatStatsSync(db, view, { kind, id }) {
    const ownerId = kind === 'group' ? id : characterOwnerIdOf(id);
    if (view !== null && view.hookInFlight(ownerId)) return 'waiting';

    let stats = { chatSize: 0, dateLastChat: 0 };
    if (view) {
        let owner = view.kindOf(ownerId);
        if (!owner && view.exists(ownerId)) {
            const found = ownerKindFromRowsSync(db, ownerId);
            if (found && view.recordKind(ownerId, found)) owner = found;
        }
        if (owner?.kind === kind && owner.rowId === id) stats = view.readStats(ownerId);
    }

    const result = { changed: false };
    db.transaction(() => {
        result.changed = kind === 'character' ? writeCharacterChatStatsSync(db, id, stats) : writeGroupChatStatsSync(db, id, stats);
        db.run('DELETE FROM chat_stats_pending WHERE kind = @kind AND id = @id', { kind, id });
        // Counted from the messages, so it already includes every queued write.
        db.run('DELETE FROM activity_pending WHERE kind = @kind AND id = @id', { kind, id });
    });
    return result.changed ? 'changed' : 'unchanged';
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} avatar
 * @param {{ chatSize: number, dateLastChat: number }} stats
 * @returns {boolean} whether the row changed.
 */
function writeCharacterChatStatsSync(db, avatar, stats) {
    const row = (/** @type {{ chat_size: number, date_last_chat: number, shallow_json: string } | undefined} */ (db.get(
        'SELECT chat_size, date_last_chat, shallow_json FROM characters WHERE id = @id', { id: avatar })));
    if (!row) return false;
    /** @type {string[]} */
    const fields = [];
    if (Number(row.chat_size) !== stats.chatSize) fields.push('chat_size');
    if (Number(row.date_last_chat) !== stats.dateLastChat) fields.push('date_last_chat');
    if (fields.length === 0) return false;

    const shallow = JSON.parse(row.shallow_json);
    shallow.chat_size = stats.chatSize;
    shallow.date_last_chat = stats.dateLastChat;
    writeShallowJson(db, avatar, shallow, fields, { chat_size: stats.chatSize, date_last_chat: stats.dateLastChat });
    return true;
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} groupId
 * @param {{ chatSize: number, dateLastChat: number }} stats
 * @returns {boolean} whether the row changed.
 */
function writeGroupChatStatsSync(db, groupId, stats) {
    const row = (/** @type {{ chat_size: number, date_last_chat: number } | undefined} */ (db.get(
        'SELECT chat_size, date_last_chat FROM groups WHERE id = @id', { id: groupId })));
    if (!row) return false;
    if (Number(row.chat_size) === stats.chatSize && Number(row.date_last_chat) === stats.dateLastChat) return false;

    writeRowIfChanged(db, 'groups', { id: groupId }, { chat_size: stats.chatSize, date_last_chat: stats.dateLastChat });
    insertGroupChange(db, groupId);
    return true;
}

// group_tags has no real foreign key; cascade is application code, same as deleteRowSync() for characters.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {object} [options]
 * @param {boolean} [options.fileDeleted] The caller deleted the group's own `<id>.json`, which the groups search index
 * reads, so the delete is a group change even when the group had no rows, and its log row names that file.
 */
export async function deleteGroupRow(directories, id, { fileDeleted = false } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.transaction(() => {
        const rowDeleted = entry.db.run('DELETE FROM groups WHERE id = @id', { id }).changes > 0;
        entry.db.run('DELETE FROM activity_pending WHERE kind = \'group\' AND id = @id', { id });
        const tagsDeleted = entry.db.run('DELETE FROM group_tags WHERE group_id = @id', { id }).changes > 0;
        if (rowDeleted || tagsDeleted || fileDeleted) insertGroupChange(entry.db, id, fileDeleted ? sanitize(`${id}.json`) : null);
    });
}

// One-time backfill of `groups` for a library that predates the table; gated by its own meta flag.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export async function bootstrapGroupsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = (/** @type {{ value: string } | undefined} */ (entry.db.get('SELECT value FROM meta WHERE key = \'groups_bootstrap_completed\'')));
    if (already) return;

    if (fs.existsSync(directories.groups)) {
        const files = fs.readdirSync(directories.groups).filter(f => f.endsWith('.json'));
        entry.db.transaction(() => {
            for (const file of files) {
                try {
                    const filePath = path.join(directories.groups, file);
                    const raw = fs.readFileSync(filePath, 'utf8');
                    const group = normalizeGroupRecord(JSON.parse(raw));
                    if (hasGroupIdForRow(group)) {
                        const stat = fs.statSync(filePath);
                        inItemSavepoint(entry.db, () => {
                            const changed = upsertGroupRowSync(entry.db, {
                                id: group.id,
                                name: group.name,
                                fav: normalizeFav(group.fav),
                                group,
                                dateAdded: Math.round(stat.birthtimeMs),
                                // A group that already has a row keeps it as it is.
                                insertOnly: true,
                            });
                            if (changed) insertGroupChange(entry.db, group.id);
                        });
                    }
                } catch (err) {
                    console.error(`[character-metadata] Bootstrap failed to process group file ${file}, skipping it (group tags for it won't resolve until it's next created/edited):`, /** @type {any} */ (err).message);
                }
            }
        });
    }

    setMetaSync(entry.db, 'groups_bootstrap_completed', String(Date.now()));
}

/**
 * Whether a group read from its file (after normalizeGroupRecord()) has an id its row can be keyed by. Any non-empty
 * string counts, not just a valid new-group id: a group that exists on disk keeps working whatever its id.
 * @param {any} group
 * @returns {boolean}
 */
function hasGroupIdForRow(group) {
    return typeof group?.id === 'string' && group.id !== '';
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function groupRowExists(directories, id) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return !!entry.db.get('SELECT 1 FROM groups WHERE id = @id', { id });
}

export const GROUP_NUMERIC_ID_RECOVERY_FLAG = 'group_numeric_id_recovery_v1';

// One-time pass for stores whose groups bootstrap skipped every group file holding its id as a number (the legacy
// format): inserts a row for each such group that has none. Existing rows are never touched. Groups are few and the
// pass is idempotent, so it saves no position: it reruns from the first file until its flag is set, which happens
// only once no file failed.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>}
 */
export async function recoverNumericIdGroupsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    if (entry.db.get('SELECT 1 FROM meta WHERE key = @key', { key: GROUP_NUMERIC_ID_RECOVERY_FLAG })) return { batches: 0, rowsChanged: 0 };

    const label = 'Numeric-id group recovery';
    let batches = 0;
    let rowsChanged = 0;
    let filesFailed = 0;

    /** @param {string} file */
    const prepareFile = (file) => {
        const filePath = path.join(directories.groups, file);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (typeof raw?.id !== 'number') return null;
        const group = normalizeGroupRecord(raw);
        if (!hasGroupIdForRow(group)) return null;
        if (entry.db.get('SELECT 1 FROM groups WHERE id = @id', { id: group.id })) return null;
        const stat = fs.statSync(filePath);
        return () => {
            const inserted = upsertGroupRowSync(entry.db, {
                id: group.id,
                name: group.name,
                fav: normalizeFav(group.fav),
                group,
                dateAdded: Math.round(stat.birthtimeMs),
                insertOnly: true,
            });
            if (inserted) insertGroupChange(entry.db, group.id);
        };
    };

    /** @param {string[]} files */
    const runBatch = async (files) => {
        let batchChanged = 0;
        /** @type {{ file: string, message: string }[]} */
        let batchFailed = [];
        entry.db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            batchChanged = 0;
            batchFailed = [];
            for (const file of files) {
                let write;
                try {
                    write = prepareFile(file);
                } catch (err) {
                    batchFailed.push({ file, message: String(/** @type {any} */ (err)?.message ?? err) });
                    continue;
                }
                if (write) {
                    write();
                    batchChanged++;
                }
            }
        });
        batches++;
        rowsChanged += batchChanged;
        filesFailed += batchFailed.length;
        if (batchFailed.length > 0) {
            console.warn(color.yellow(`[character-metadata] ${label}: ${batchFailed.length} group file(s) failed and were skipped:\n${batchFailed.map(f => `  ${f.file}: ${f.message}`).join('\n')}`));
        }
        if (batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0) {
            if (!isReadOnlyMode()) entry.db.get('PRAGMA wal_checkpoint(PASSIVE)');
        }
        await delay(MIGRATION_BATCH_PAUSE_MS);
    };

    if (fs.existsSync(directories.groups)) {
        const BATCH_SIZE = 500;
        const dir = await fsPromises.opendir(directories.groups);
        /** @type {string[]} */
        let batch = [];
        for await (const dirent of dir) {
            if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
            batch.push(dirent.name);
            if (batch.length >= BATCH_SIZE) {
                await runBatch(batch);
                batch = [];
            }
        }
        if (batch.length > 0) await runBatch(batch);
    }

    if (filesFailed === 0) {
        setMetaSync(entry.db, GROUP_NUMERIC_ID_RECOVERY_FLAG, String(Date.now()));
    }
    if (!isReadOnlyMode()) entry.db.checkpoint();
    if (filesFailed > 0) {
        console.warn(color.yellow(`[character-metadata] ${label}: ${filesFailed} group file(s) failed (listed above); not marked done, so it runs again next boot.`));
    }
    return { batches, rowsChanged };
}

export const GROUP_FAV_NORMALIZED_FLAG = 'group_fav_normalized_v1';

// One-time pass re-deriving each group's fav column and digest_fav from its normalized JSON file (the source of
// truth), since older writers stored the raw file value by truthiness (a file holding "false" read as a favourite).
// A group's file is read inside its batch's transaction, so a group write in this process can't land between the
// read and the row write. A group whose file can't be read is left as it is and keeps the pass from being marked done.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>}
 */
export async function normalizeGroupFavIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    if (entry.db.get('SELECT 1 FROM meta WHERE key = @key', { key: GROUP_FAV_NORMALIZED_FLAG })) return { batches: 0, rowsChanged: 0 };

    return runResumableCharacterPass(entry.db, {
        table: 'groups',
        doneKey: GROUP_FAV_NORMALIZED_FLAG,
        doneValue: String(Date.now()),
        progressKey: `${GROUP_FAV_NORMALIZED_FLAG}_progress`,
        label: 'Group fav normalization',
        prepareRow: (id) => {
            if (!entry.db.get('SELECT 1 FROM groups WHERE id = @id', { id })) return null;
            const group = JSON.parse(fs.readFileSync(path.join(directories.groups, sanitize(`${id}.json`)), 'utf8'));
            const fav = normalizeFav(group?.fav);
            const values = { fav: fav ? 1 : 0, digest_fav: groupDigestFavHash({ fav }) };
            if (!entry.db.get('SELECT 1 FROM groups WHERE id = @id AND (fav IS NOT @fav OR digest_fav IS NOT @digestFav)', { id, fav: values.fav, digestFav: values.digest_fav })) return null;
            return () => {
                writeRowIfChanged(entry.db, 'groups', { id }, values);
                insertGroupChange(entry.db, id);
            };
        },
    });
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @returns {import('./tag-deletions.js').TagDeletions}
 */
function readTagDeletionsSync(db) {
    if (!db.get('SELECT 1 FROM tag_deletions LIMIT 1')) return NO_TAG_DELETIONS;
    /** @type {Map<string, string | null | undefined>} Looked-up ids; undefined for an id that isn't marked. */
    const looked = new Map();
    /** @param {string} tagId */
    const lookUp = (tagId) => {
        if (!looked.has(tagId)) {
            const row = /** @type {{ merge_into: string | null } | undefined} */ (db.get('SELECT merge_into FROM tag_deletions WHERE tag_id = @tagId', { tagId }));
            looked.set(tagId, row ? row.merge_into ?? null : undefined);
        }
        return looked.get(tagId);
    };
    return {
        any: true,
        has: (tagId) => lookUp(tagId) !== undefined,
        get: (tagId) => lookUp(tagId),
        hasMergingInto: (target) => Boolean(db.get('SELECT 1 FROM tag_deletions WHERE merge_into = @target LIMIT 1', { target })),
        mergingIntoUpTo: (target, limit) => {
            const rows = /** @type {{ tag_id: string }[]} */ (db.readBounded(
                'SELECT tag_id FROM tag_deletions WHERE merge_into = @target ORDER BY tag_id LIMIT @limit',
                { target, limit: limit + 1 }, limit + 1));
            return rows.length > limit ? null : rows.map(row => row.tag_id);
        },
    };
}

/**
 * The marks as tag-deletions.js reads them, for callers outside this module. Each question is a lookup by key; the
 * answer is only good until the caller next awaits.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<import('./tag-deletions.js').TagDeletions>}
 */
export async function getTagDeletions(directories) {
    const entry = await getEntry(directories);
    if (!entry) return NO_TAG_DELETIONS;
    return readTagDeletionsSync(entry.db);
}

const NOT_MARKED_DELETED_SQL = 'id NOT IN (SELECT tag_id FROM tag_deletions)';

/**
 * Whether any tag not marked deleted is a closed folder. Reads one row: through the folder indexes once the derived
 * columns are filled, else from the tags' data.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<boolean | null>} null when no SQLite engine is usable.
 */
export async function hasClosedFolderTags(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const closedWhere = tagQueryColumnsReady(entry)
        ? 'is_folder = 1 AND folder_type = \'CLOSED\''
        : 'CASE WHEN json_valid(data) THEN json_extract(data, \'$.folder_type\') END = \'CLOSED\'';
    return !!entry.db.get(`SELECT 1 FROM tags WHERE ${closedWhere} AND ${NOT_MARKED_DELETED_SQL} LIMIT 1`);
}

/**
 * Every tag definition not marked deleted, in batches of at most 1000, in rowid (creation) order. Each batch is one
 * keyset page, finished before it is yielded, so the caller may await between batches. For the backup, which is a
 * download of every tag.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<AsyncGenerator<object[], void, undefined> | null>} null when the store is unavailable.
 */
export async function streamTagDefinitionBatches(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const pages = streamRows(entry.db, {
        firstPageSql: `SELECT rowid AS k, data FROM tags WHERE ${NOT_MARKED_DELETED_SQL} ORDER BY rowid LIMIT @limit`,
        firstPageParams: {},
        nextPageSql: `SELECT rowid AS k, data FROM tags WHERE rowid > @after AND ${NOT_MARKED_DELETED_SQL} ORDER BY rowid LIMIT @limit`,
        nextPageParams: {},
        keyColumn: 'k',
    });
    return (async function* () {
        for await (const rows of pages) {
            yield (/** @type {{ data: string }[]} */ (rows)).map(row => JSON.parse(row.data));
        }
    })();
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {unknown[]} ids
 * @returns {Promise<object[] | null>}
 */
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
        for (const r of (/** @type {Generator<TagRow>} */ (entry.db.iterate(`SELECT id, data FROM tags WHERE id IN (${placeholders}) AND ${NOT_MARKED_DELETED_SQL}`, slice)))) {
            try {
                out.push(JSON.parse(r.data));
            } catch (err) {
                console.warn(`[character-metadata] Tag definition ${r.id} could not be parsed, skipped it: ${/** @type {Error} */ (err).message}`);
            }
        }
    }
    return out;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {unknown[]} ids
 * @returns {Promise<string[] | null>} the ids no tag has: never stored, deleted, or marked deleted. A tag whose
 *   stored definition can't be parsed still has its id. null when the store is unavailable.
 */
export async function getGoneTagIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const wanted = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
    const present = new Set();
    const CHUNK = 500;
    for (let i = 0; i < wanted.length; i += CHUNK) {
        const slice = wanted.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        for (const row of (/** @type {Generator<{ id: string }>} */ (entry.db.iterate(`SELECT id FROM tags WHERE id IN (${placeholders}) AND ${NOT_MARKED_DELETED_SQL}`, slice)))) {
            present.add(row.id);
        }
    }
    return wanted.filter(id => !present.has(id));
}

/**
 * The tag each name stands for, looked up as a card's tag names are (resolveCardTagNamesSync()): names compared by
 * tagNameKey(), the first by rowid when several tags have the name, and a tag being deleted with a merge target
 * standing for that target.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} names
 * @returns {Promise<{ name: string, tag: object | null }[] | 'names-not-ready' | null>} one entry per distinct name
 *   given, in the order given; `tag` null when no tag has the name or its stored definition can't be parsed.
 *   'names-not-ready': names can't be looked up yet. null when the store is unavailable.
 */
export async function findTagsByNames(directories, names) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    if (!tagNameKeysReady(entry)) return 'names-not-ready';

    const out = [];
    const seen = new Set();
    for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        const resolved = resolveCardTagNamesSync(entry.db, [name], { ready: true, onlyExisting: true });
        let tag = null;
        if (resolved.learned.length > 0) {
            const learned = resolved.learned[0];
            try {
                tag = JSON.parse(learned.data);
            } catch (err) {
                console.warn(`[character-metadata] Tag definition ${learned.id} could not be parsed: ${/** @type {Error} */ (err).message}`);
            }
        }
        out.push({ name, tag });
    }
    return out;
}

/**
 * The stored definitions of `ids`: a tag marked deleted is left out, and a definition that can't be parsed throws.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<object[] | null>} null when the store is unavailable.
 */
export async function getTagDefinitionsForIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const wanted = [...new Set(ids)];
    const definitions = [];
    for (let i = 0; i < wanted.length; i += BATCH_FLUSH_SIZE) {
        const chunk = wanted.slice(i, i + BATCH_FLUSH_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        for (const row of /** @type {Iterable<{ data: string }>} */ (entry.db.iterate(`SELECT data FROM tags WHERE id IN (${placeholders}) AND ${NOT_MARKED_DELETED_SQL}`, chunk))) {
            definitions.push(JSON.parse(row.data));
        }
    }
    return definitions;
}

/** Assignment rows per batch of streamEntityTagAssignmentBatches(). */
const TAG_ASSIGNMENT_BATCH_ROWS = 1000;

/**
 * Every character's and group's tag ids, for the tag backup file: character_tags then group_tags, each in key order,
 * one keyset page at a time. A tag being deleted reads as its merge target, or is left out when it has none. An
 * entity's rows can span two batches: consecutive batches of the same key continue the same entity.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<AsyncGenerator<{ key: string, tagIds: string[] }[], void, undefined> | null>} null when the store is
 *   unavailable.
 */
export async function streamEntityTagAssignmentBatches(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const db = entry.db;
    const tables = [
        { table: 'character_tags', column: 'character_id' },
        { table: 'group_tags', column: 'group_id' },
    ];
    return (async function* () {
        for (const { table, column } of tables) {
            /** @type {{ e: string, t: string } | null} */
            let after = null;
            for (;;) {
                const sql = after
                    ? `SELECT ${column} AS e, tag_id AS t FROM ${table} WHERE (${column}, tag_id) > (@e, @t) ORDER BY ${column}, tag_id LIMIT @limit`
                    : `SELECT ${column} AS e, tag_id AS t FROM ${table} ORDER BY ${column}, tag_id LIMIT @limit`;
                const rows = /** @type {{ e: string, t: string }[]} */ (Array.from(db.iterate(sql, { ...(after ?? {}), limit: TAG_ASSIGNMENT_BATCH_ROWS })));
                if (!rows.length) break;
                const deletions = readTagDeletionsSync(db);
                /** @type {{ key: string, tagIds: string[] }[]} */
                const batch = [];
                for (const row of rows) {
                    const tagId = resolveTagId(row.t, deletions);
                    if (tagId === null) continue;
                    /** @type {{ key: string, tagIds: string[] } | undefined} */
                    let last = batch.at(-1);
                    if (last === undefined || last.key !== row.e) {
                        last = { key: row.e, tagIds: [] };
                        batch.push(last);
                    }
                    if (!last.tagIds.includes(tagId)) last.tagIds.push(tagId);
                }
                yield batch;
                if (rows.length < TAG_ASSIGNMENT_BATCH_ROWS) break;
                after = { e: rows[rows.length - 1].e, t: rows[rows.length - 1].t };
            }
        }
    })();
}

/**
 * Replaces the entire `tags` table's contents with `tagsArray` (full replace, not a diff). Appends one
 * `tag_name_changes` row per tag id whose `name` changed, so search-index catch-up can reindex just those
 * assignees instead of scanning the whole table.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {unknown[]} tagsArray Raw request-body array - each element is client-controlled and not
 *   guaranteed to actually match {@link TagDefinitionInput}'s shape (could be `null`, a primitive, or
 *   an object missing `id`), so every element is validated below before use.
 * @returns {Promise<'ok' | null>}
 */
export async function saveTagDefinitions(directories, tagsArray) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    /** @type {string[]} */
    let skipped = [];
    entry.db.transaction(() => {
        skipped = [];
        const deletions = readTagDeletionsSync(entry.db);
        /** @type {Set<string>} */
        const savedIds = new Set();
        for (const raw of tagsArray) {
            const tag = /** @type {TagDefinitionInput | null | undefined} */ (raw);
            if (!tag || typeof tag.id !== 'string' || !tag.id) continue;
            if (deletions.has(tag.id)) continue;
            savedIds.add(tag.id);
        }
        const idsToLookUp = [...savedIds];
        /** @type {Map<string, string>} */
        const oldNames = new Map();
        for (let start = 0; start < idsToLookUp.length; start += KEYSET_CHUNK) {
            const slice = idsToLookUp.slice(start, start + KEYSET_CHUNK);
            const rows = /** @type {TagRow[]} */ (entry.db.readBounded(
                'SELECT id, data FROM tags WHERE id IN (SELECT value FROM json_each(?))',
                [JSON.stringify(slice)],
                slice.length,
            ));
            for (const row of rows) {
                let parsed = null;
                try { parsed = JSON.parse(row.data); } catch { /* an unparseable old row has no name to compare against */ }
                oldNames.set(row.id, parsed?.name ?? '');
            }
        }

        entry.db.run('DELETE FROM tags');
        for (const raw of tagsArray) {
            const tag = /** @type {TagDefinitionInput | null | undefined} */ (raw);
            if (!tag || typeof tag.id !== 'string' || !tag.id) continue;
            if (deletions.has(tag.id)) {
                skipped.push(tag.id);
                continue;
            }
            entry.db.run(`INSERT INTO tags ${TAG_ROW_VALUES_SQL}`, tagRowParams(tag));
            if (oldNames.has(tag.id) && oldNames.get(tag.id) !== (tag.name ?? '')) {
                entry.db.run('INSERT INTO tag_name_changes (tag_id) VALUES (@tagId)', { tagId: tag.id });
            }
        }
        logTagChangesSync(entry, null);
    });
    warnStaleDeletedTagSave(skipped);
    return 'ok';
}

/**
 * @typedef {'deleted' | 'exists' | 'missing' | 'unreadable' | 'same' | 'unordered' | 'no-room'} TagWriteRefusalReason
 * @typedef {{ refused: { id: string, reason: TagWriteRefusalReason }[] }} TagWriteResult
 */

// A min/max search of tags_sort_order; MAX() skips the NULLs of tags with no order.
const NEXT_TAG_SORT_ORDER_SQL = 'SELECT MAX(0, COALESCE(MAX(sort_order), 0)) + 1 AS next FROM tags';

/**
 * The sort_order upstream's newTag() gives a new tag: `Math.max(0, ...orders) + 1` over the tags that have one.
 * Marked tags count too, which still puts it after every live tag.
 *
 * null until fillTagDerivedColumnsIfNeeded() has finished: before that the sort_order column isn't filled, and the
 * max could only be found by reading every tag. A tag created then gets no sort_order of its own, and
 * fillTagSortOrdersIfNeeded(), which only starts once the column is filled, numbers it after every ordered tag.
 * @param {MetadataDbEntry} entry
 * @returns {number | null}
 */
function nextTagSortOrderSync(entry) {
    if (!entry.db.get('SELECT 1 FROM meta WHERE key = @key', { key: TAG_DERIVED_COLUMNS_FILLED_FLAG })) return null;
    const row = /** @type {{ next: number }} */ (entry.db.get(NEXT_TAG_SORT_ORDER_SQL));
    return Number(row.next);
}

/**
 * A tag with no own sort_order gets nextTagSortOrderSync(); a given one, null included, is kept as is. Whenever moves
 * queue (tagSortOrdersSettledSync()), a given one is also queued as a value entry, so neither a pass that writes
 * sort_orders nor an earlier queued move for the tag overrides it: the last entry for a tag wins (tag-actions D18,
 * D28).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {unknown} rawTag Raw request-body value - client-controlled and not guaranteed to actually
 *   match {@link TagDefinitionInput}'s shape, so it's validated below before use.
 * @param {object} [options]
 * @param {boolean} [options.freeName] The given name is only a base: the tag gets freeTagNameSync()'s name for it.
 *   Needs tagNameKeysReady().
 * @returns {Promise<(TagWriteResult & { tag?: TagDefinitionInput }) | 'names-not-ready' | null>} tag: the definition
 *   as stored, when it was. 'names-not-ready': a free name was asked for before names can be looked up; nothing is
 *   written.
 */
export async function createTagDefinition(directories, rawTag, { freeName = false } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const tag = /** @type {TagDefinitionInput | null | undefined} */ (rawTag);
    if (!tag || typeof tag !== 'object' || typeof tag.id !== 'string' || !tag.id) return null;
    const id = tag.id;
    const assignOrder = !Object.hasOwn(tag, 'sort_order');
    const baseName = typeof tag.name === 'string' ? tag.name : '';

    /** @type {TagWriteResult} */
    const result = { refused: [] };
    const names = { ready: true };
    entry.db.transaction(() => {
        // Reset here: a transaction that hits busy is rolled back and rerun.
        result.refused = [];
        names.ready = true;
        if (entry.db.get('SELECT 1 FROM tag_deletions WHERE tag_id = @id', { id })) {
            result.refused.push({ id, reason: 'deleted' });
            return;
        }
        if (entry.db.get('SELECT 1 FROM tags WHERE id = @id', { id })) {
            result.refused.push({ id, reason: 'exists' });
            return;
        }
        if (freeName) {
            if (!tagNameKeysReady(entry)) {
                names.ready = false;
                return;
            }
            tag.name = freeTagNameSync(entry.db, baseName);
        }
        if (assignOrder) {
            const next = nextTagSortOrderSync(entry);
            if (next !== null) tag.sort_order = next;
        }
        entry.db.run(`INSERT INTO tags ${TAG_ROW_VALUES_SQL}`, tagRowParams(tag));
        if (!assignOrder && !tagSortOrdersSettledSync(entry.db)) queueTagSortOrderValueSync(entry.db, id, tag.sort_order);
        logTagChangesSync(entry, [id]);
    });
    if (!names.ready) return 'names-not-ready';
    if (result.refused.length > 0) {
        if (result.refused[0].reason === 'deleted') warnStaleDeletedTagSave([id]);
        return result;
    }
    return { ...result, tag };
}

/** How many numbered names freeTagNameSync() tries, one name_key lookup each, before it stops looking. */
const FREE_TAG_NAME_TRIES = 20000;

/**
 * A name no live tag has, made from `base` as the page's getFreeName() makes one: `base` itself, else the first free
 * of `base #1`, `base #2`, ... Names are compared as tag names are looked up (tagNameKey()). Past FREE_TAG_NAME_TRIES
 * it is `base #<a new uuid>`, free without looking.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} base
 * @returns {string}
 */
function freeTagNameSync(db, base) {
    if (liveTagIdByNameKeySync(db, tagNameKey(base), '') === null) return base;
    for (let n = 1; n <= FREE_TAG_NAME_TRIES; n++) {
        const name = `${base} #${n}`;
        if (liveTagIdByNameKeySync(db, tagNameKey(name), '') === null) return name;
    }
    return `${base} #${crypto.randomUUID()}`;
}

/**
 * editTagDefinition()'s write, inside the caller's transaction.
 * @param {MetadataDbEntry} entry
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {{ refused: 'deleted' | 'missing' | 'unreadable' | null, written: boolean }}
 */
function editTagSync(entry, id, patch) {
    if (entry.db.get('SELECT 1 FROM tag_deletions WHERE tag_id = @id', { id })) return { refused: 'deleted', written: false };
    const oldRow = /** @type {{ data: string } | undefined} */ (entry.db.get('SELECT data FROM tags WHERE id = @id', { id }));
    if (!oldRow) return { refused: 'missing', written: false };
    /** @type {unknown} */
    let oldParsed;
    try {
        oldParsed = JSON.parse(oldRow.data);
    } catch {
        oldParsed = undefined;
    }
    if (oldParsed === null || typeof oldParsed !== 'object' || Array.isArray(oldParsed)) return { refused: 'unreadable', written: false };
    const old = /** @type {Record<string, unknown>} */ (oldParsed);
    const { sort_order: patchedOrder, ...rest } = patch;
    const queueOrder = Object.hasOwn(patch, 'sort_order') && !tagSortOrdersSettledSync(entry.db);
    if (queueOrder) queueTagSortOrderValueSync(entry.db, id, patchedOrder);
    const merged = /** @type {TagDefinitionInput} */ ({ ...old, ...(queueOrder ? rest : patch), id });
    if (JSON.stringify(merged) === JSON.stringify(old)) return { refused: null, written: false };

    const params = tagRowParams(merged);
    writeRowIfChanged(entry.db, 'tags', { id }, {
        data: params.data, name_key: params.nameKey, sort_order: params.sortOrder, folder_type: params.folderType, is_folder: params.isFolder,
    });
    if ((old.name ?? '') !== (merged.name ?? '')) {
        entry.db.run('INSERT INTO tag_name_changes (tag_id) VALUES (@tagId)', { tagId: id });
    }
    logTagChangesSync(entry, [id]);
    return { refused: null, written: true };
}

/**
 * Fields the patch doesn't name keep their stored values, so a stale tab can't revert another tab's edit. Stored
 * data that isn't a JSON object is refused as 'unreadable', since merging into it would lose it. Whenever moves
 * queue (tagSortOrdersSettledSync()), a patched sort_order isn't written but queued as a value entry, applied in
 * arrival order with the queued moves, so the last entry for a tag wins (tag-actions D18, D25.9, D28); the other
 * fields are written at once.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {unknown} id
 * @param {unknown} rawPatch Raw request-body value - client-controlled, so it's validated below before use.
 * @returns {Promise<TagWriteResult | null>}
 */
export async function editTagDefinition(directories, id, rawPatch) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    if (typeof id !== 'string' || !id) return null;
    if (rawPatch === null || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) return null;
    const patch = /** @type {Record<string, unknown>} */ (rawPatch);
    if (Object.hasOwn(patch, 'id') && patch.id !== id) return null;

    /** @type {{ outcome: ReturnType<typeof editTagSync> }} */
    const state = { outcome: { refused: null, written: false } };
    // A transaction that hits busy is rolled back and rerun, so the outcome is the last run's.
    entry.db.transaction(() => {
        state.outcome = editTagSync(entry, id, patch);
    });
    const { refused } = state.outcome;
    if (refused === 'deleted') warnStaleDeletedTagSave([id]);
    return { refused: refused === null ? [] : [{ id, reason: refused }] };
}

// A deleted tag's id is never reused (a new tag always gets a new id), so a save naming one is a stale copy.
/** @param {string[]} ids */
function warnStaleDeletedTagSave(ids) {
    if (ids.length === 0) return;
    console.warn(color.yellow(`[character-metadata] Skipped saving deleted tag(s), a stale copy: ${ids.join(', ')}`));
}

// A tag is in use if tag_usage counts an assignment for it or for a marked tag merging into it, or a batch-import
// row not yet flushed into character_tags carries it. `@pending` is that buffer's tag ids as JSON (at most
// BATCH_IMPORT_FLUSH_SIZE rows), already resolved through tag_deletions. A marked tag is never listed: it is
// already deleted.
const UNUSED_TAGS_WHERE = `
    NOT EXISTS (SELECT 1 FROM tag_usage u WHERE u.tag_id = t.id AND u.count > 0)
    AND NOT EXISTS (SELECT 1 FROM tag_deletions d JOIN tag_usage u ON u.tag_id = d.tag_id WHERE d.merge_into = t.id AND u.count > 0)
    AND t.id NOT IN (SELECT tag_id FROM tag_deletions)
    AND t.id NOT IN (SELECT value FROM json_each(@pending))`;

/** @param {MetadataDbEntry} entry @returns {string} */
function pendingImportTagIdsJson(entry) {
    const ids = new Set();
    for (const pending of entry.batch?.pending.values() ?? []) {
        for (const tagId of pending.tagIds) ids.add(tagId);
    }
    return JSON.stringify(resolveTagIds([...ids], readTagDeletionsSync(entry.db)));
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<number | null>} how many tag definitions no character or group uses
 */
export async function countUnusedTags(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = (/** @type {{ n: number }} */ (entry.db.get(
        `SELECT COUNT(*) AS n FROM tags t WHERE ${UNUSED_TAGS_WHERE}`,
        { pending: pendingImportTagIdsJson(entry) },
    )));
    return Number(row.n);
}

/**
 * Deletes up to `limit` tag definitions that no character or group uses. The in-use check and the delete run in
 * one transaction, so a tag assigned concurrently is never deleted.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} limit
 * @returns {Promise<string[] | null>} the deleted tag ids
 */
export async function pruneUnusedTags(directories, limit) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    /** @type {string[]} */
    const deleted = [];
    entry.db.transaction(() => {
        const params = { pending: pendingImportTagIdsJson(entry), limit };
        for (const row of /** @type {Generator<{ id: string }>} */ (entry.db.iterate(`SELECT t.id FROM tags t WHERE ${UNUSED_TAGS_WHERE} ORDER BY t.id LIMIT @limit`, params))) {
            deleted.push(row.id);
        }
        if (!deleted.length) return;
        const ids = JSON.stringify(deleted);
        entry.db.run('DELETE FROM tags WHERE id IN (SELECT value FROM json_each(@ids))', { ids });
        entry.db.run('DELETE FROM tag_usage WHERE tag_id IN (SELECT value FROM json_each(@ids))', { ids });
        logTagChangesSync(entry, deleted);
    });
    return deleted;
}

/**
 * @typedef {object} TagDeleteResult
 * @property {{ id: string, reason: 'deleted' | 'missing' | 'same' | 'unreadable' }[]} refused - Why nothing was
 *   written, naming the tag the reason is about: `tagId` itself, or its merge target.
 * @property {string | null} mergedInto - The tag every entity carrying `tagId` now reads as carrying instead.
 * @property {object | null} target - `mergedInto`'s stored definition.
 */

/**
 * Marks a tag definition deleted, merging into `mergeInto` when given. Its tags row and tag rows stay until the
 * migration worker's batched pass removes them; every read treats it as deleted from now on.
 * Refused, with nothing written:
 * - `tagId` already marked ('deleted': it keeps its first merge target), or with no tags row ('missing').
 * - `mergeInto` is `tagId` ('same'), was deleted with no merge target ('deleted'), has no tags row ('missing'), or
 *   its stored definition can't be read ('unreadable'). A delete asked for with a merge never deletes unmerged.
 * `mergeInto` marked with a merge target of its own: that target is used, so no mark ever points at another mark.
 * Tags that merged into `tagId` move onto its merge target. Each marked tag whose resolved name changed is logged in
 * tag_name_changes, so the search index re-indexes the entities carrying it.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} tagId
 * @param {string | null} [mergeInto]
 * @returns {Promise<TagDeleteResult | null>}
 */
export async function deleteTagDefinition(directories, tagId, mergeInto = null) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    if (typeof tagId !== 'string' || !tagId) return null;

    /** @type {TagDeleteResult} */
    const result = { refused: [], mergedInto: null, target: null };
    /** @param {string} id @param {TagDeleteResult['refused'][number]['reason']} reason */
    const refuse = (id, reason) => { result.refused = [{ id, reason }]; };
    entry.db.transaction(() => {
        result.refused = [];
        result.mergedInto = null;
        result.target = null;
        if (entry.db.get('SELECT 1 FROM tag_deletions WHERE tag_id = @id', { id: tagId })) return refuse(tagId, 'deleted');
        if (!entry.db.get('SELECT 1 FROM tags WHERE id = @id', { id: tagId })) return refuse(tagId, 'missing');

        /** @type {string | null} */
        let target = null;
        if (typeof mergeInto === 'string' && mergeInto) {
            if (mergeInto === tagId) return refuse(mergeInto, 'same');
            const targetMark = /** @type {{ merge_into: string | null } | undefined} */ (entry.db.get('SELECT merge_into FROM tag_deletions WHERE tag_id = @id', { id: mergeInto }));
            if (targetMark && targetMark.merge_into === null) return refuse(mergeInto, 'deleted');
            target = targetMark ? targetMark.merge_into : mergeInto;
            const targetRow = /** @type {{ data: string } | undefined} */ (entry.db.get('SELECT data FROM tags WHERE id = @id', { id: target }));
            if (!targetRow) return refuse(mergeInto, 'missing');
            try {
                result.target = JSON.parse(targetRow.data);
            } catch {
                return refuse(mergeInto, 'unreadable');
            }
        }

        // The marks merging into tagId now merge into its target, so their names change too.
        entry.db.run('INSERT INTO tag_name_changes (tag_id) VALUES (@tagId)', { tagId });
        entry.db.run('INSERT INTO tag_name_changes (tag_id) SELECT tag_id FROM tag_deletions WHERE merge_into = @id ORDER BY tag_id', { id: tagId });
        entry.db.run('UPDATE tag_deletions SET merge_into = @target WHERE merge_into = @id', { id: tagId, target });
        entry.db.run('INSERT INTO tag_deletions (tag_id, merge_into) VALUES (@id, @target)', { id: tagId, target });
        logTagChangesSync(entry, [tagId]);
        result.mergedInto = target;
    });
    return result;
}

// The same bound streamRows() pages the other migration passes by.
const DELETED_TAG_BATCH_SIZE = 1000;

/**
 * @typedef {object} TagRowSide
 * @property {'character_tags' | 'group_tags'} tagTable
 * @property {'character_id' | 'group_id'} entityColumn
 * @property {'characters' | 'groups'} entityTable
 * @property {(db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle, id: string) => void} syncStoredCopy
 * @property {(db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle, id: string) => void} logTagRowsChanged
 *   Called once per entity whose tag rows a transaction changed, in that transaction.
 */

/** @type {TagRowSide[]} */
const TAG_ROW_SIDES = [
    { tagTable: 'character_tags', entityColumn: 'character_id', entityTable: 'characters', syncStoredCopy: syncShallowTagIdsFromTable, logTagRowsChanged: () => {} },
    { tagTable: 'group_tags', entityColumn: 'group_id', entityTable: 'groups', syncStoredCopy: syncGroupDigestTagIdsFromTable, logTagRowsChanged: insertGroupChange },
];

/**
 * @typedef {object} DeletedTagPassTotals
 * @property {number} batches
 * @property {number} rowsChanged
 * @property {boolean} wrote
 */

/**
 * Finishes the tags deleteTagDefinition() marked. For each, in batches: every entity carrying it gets its merge
 * target (unless it has it already) and loses the tag's row, with its stored copy of its tags kept in sync in the
 * same transaction. A row whose entity doesn't exist is removed with no merge and listed in a warning. Once no row
 * carries the tag, its tags row, tag_usage row and mark are dropped together.
 *
 * Resumable with no saved position: the rows still carrying a marked tag are what is left to do. Each batch reads
 * a bounded list of entity ids, closes the read, then writes in its own transaction.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>} `rowsChanged` counts the marked tags' rows removed.
 */
export async function finishDeletedTags(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    /** @type {DeletedTagPassTotals} */
    const totals = { batches: 0, rowsChanged: 0, wrote: false };
    // Read to the end rather than stopping at a short page, so a tag marked while this runs (a merge target
    // deleted mid-pass) is finished by the same run when its id sorts after the ones done.
    /** @type {string | null} */
    let after = null;
    for (;;) {
        /** @type {string[]} */
        const tagIds = [];
        const rows = after === null
            ? entry.db.iterate('SELECT tag_id FROM tag_deletions ORDER BY tag_id LIMIT @limit', { limit: DELETED_TAG_BATCH_SIZE })
            : entry.db.iterate('SELECT tag_id FROM tag_deletions WHERE tag_id > @after ORDER BY tag_id LIMIT @limit', { after, limit: DELETED_TAG_BATCH_SIZE });
        for (const row of /** @type {Iterable<{ tag_id: string }>} */ (rows)) tagIds.push(row.tag_id);
        if (tagIds.length === 0) break;
        for (const tagId of tagIds) await finishDeletedTag(entry, tagId, totals);
        after = tagIds[tagIds.length - 1];
    }
    if (totals.wrote && !isReadOnlyMode()) entry.db.checkpoint();
    return { batches: totals.batches, rowsChanged: totals.rowsChanged };
}

/**
 * @param {MetadataDbEntry} entry
 * @param {string} tagId
 * @param {DeletedTagPassTotals} totals
 */
async function finishDeletedTag(entry, tagId, totals) {
    const { db } = entry;
    const tagName = tagNameForWarning(db, tagId);
    for (;;) {
        for (const side of TAG_ROW_SIDES) {
            if (await moveDeletedTagRows(db, tagId, tagName, side, totals) === 'unmarked') return;
        }

        // A row added behind a walk's position sends it round again.
        if (db.get('SELECT 1 FROM character_tags WHERE tag_id = @tagId LIMIT 1', { tagId })
            || db.get('SELECT 1 FROM group_tags WHERE tag_id = @tagId LIMIT 1', { tagId })) {
            continue;
        }

        /** @type {{ outcome: 'unmarked' | 'rows' | 'finished' }} */
        const state = { outcome: 'unmarked' };
        db.transaction(() => {
            state.outcome = 'unmarked';
            if (!db.get('SELECT 1 FROM tag_deletions WHERE tag_id = @tagId', { tagId })) return;
            state.outcome = 'rows';
            if (db.get('SELECT 1 FROM character_tags WHERE tag_id = @tagId LIMIT 1', { tagId })
                || db.get('SELECT 1 FROM group_tags WHERE tag_id = @tagId LIMIT 1', { tagId })) return;
            db.run('DELETE FROM tags WHERE id = @tagId', { tagId });
            db.run('DELETE FROM tag_usage WHERE tag_id = @tagId', { tagId });
            db.run('DELETE FROM tag_deletions WHERE tag_id = @tagId', { tagId });
            state.outcome = 'finished';
        });
        if (state.outcome === 'rows') continue;
        if (state.outcome === 'finished') {
            totals.wrote = true;
        }
        return;
    }
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} tagId
 * @returns {string} The tag's name, or its id when its tags row or name is missing.
 */
function tagNameForWarning(db, tagId) {
    const row = /** @type {{ data: string } | undefined} */ (db.get('SELECT data FROM tags WHERE id = @tagId', { tagId }));
    try {
        const name = row ? JSON.parse(row.data)?.name : undefined;
        return typeof name === 'string' && name ? name : tagId;
    } catch {
        return tagId;
    }
}

/**
 * One walk over a marked tag's rows on one side, by entity id.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} tagId
 * @param {string} tagName
 * @param {TagRowSide} side
 * @param {DeletedTagPassTotals} totals
 * @returns {Promise<'walked' | 'unmarked'>} 'unmarked' when the mark was gone at a batch's start.
 */
async function moveDeletedTagRows(db, tagId, tagName, side, totals) {
    const { tagTable, entityColumn, entityTable, syncStoredCopy, logTagRowsChanged } = side;
    /** @type {string | null} */
    let after = null;
    for (;;) {
        /** @type {string[]} */
        const page = [];
        const rows = after === null
            ? db.iterate(`SELECT ${entityColumn} AS id FROM ${tagTable} WHERE tag_id = @tagId ORDER BY ${entityColumn} LIMIT @limit`, { tagId, limit: DELETED_TAG_BATCH_SIZE })
            : db.iterate(`SELECT ${entityColumn} AS id FROM ${tagTable} WHERE tag_id = @tagId AND ${entityColumn} > @after ORDER BY ${entityColumn} LIMIT @limit`, { tagId, after, limit: DELETED_TAG_BATCH_SIZE });
        for (const row of /** @type {Iterable<{ id: string }>} */ (rows)) page.push(row.id);
        if (page.length === 0) return 'walked';
        after = page[page.length - 1];
        /** @type {{ unmarked: boolean, removed: number, orphans: string[] }} */
        const state = { unmarked: false, removed: 0, orphans: [] };
        db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            state.unmarked = false;
            state.removed = 0;
            state.orphans = [];
            // Re-read every batch: deleting the merge target moves this mark onto the target's own.
            const mark = /** @type {{ merge_into: string | null } | undefined} */ (db.get('SELECT merge_into FROM tag_deletions WHERE tag_id = @tagId', { tagId }));
            if (!mark) {
                state.unmarked = true;
                return;
            }
            const target = mark.merge_into ?? null;
            for (const id of page) {
                if (db.run(`DELETE FROM ${tagTable} WHERE ${entityColumn} = @id AND tag_id = @tagId`, { id, tagId }).changes === 0) continue;
                state.removed++;
                logTagRowsChanged(db, id);
                if (!db.get(`SELECT 1 FROM ${entityTable} WHERE id = @id`, { id })) {
                    state.orphans.push(id);
                    continue;
                }
                if (target !== null) {
                    db.run(`INSERT OR IGNORE INTO ${tagTable} (${entityColumn}, tag_id) VALUES (@id, @target)`, { id, target });
                }
                syncStoredCopy(db, id);
            }
        });
        if (state.unmarked) return 'unmarked';
        if (state.removed > 0) {
            totals.batches++;
            totals.rowsChanged += state.removed;
            totals.wrote = true;
            if (totals.batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0 && !isReadOnlyMode()) db.get('PRAGMA wal_checkpoint(PASSIVE)');
        }
        if (state.orphans.length > 0) {
            console.warn(color.yellow(`[character-metadata] Deleted tag ${tagId}: removed it with no merge from ${state.orphans.length} ${tagTable} row(s) whose ${entityTable} row doesn't exist:\n${state.orphans.map(id => `  ${id}: ${tagName}`).join('\n')}`));
        }
        await delay(MIGRATION_BATCH_PAUSE_MS);
        if (page.length < DELETED_TAG_BATCH_SIZE) return 'walked';
    }
}

export const ORPHAN_TAG_ROWS_REMOVED_FLAG = 'orphan_tag_rows_removed_v1';
const ORPHAN_TAG_ROWS_PROGRESS_KEY = `${ORPHAN_TAG_ROWS_REMOVED_FLAG}_progress`;

/**
 * One-time pass removing every character_tags row with no characters row and every group_tags row with no groups
 * row, whatever its id looks like, and listing each in a warning (entity id: tag name). tag_usage follows through
 * its triggers.
 *
 * Walks each tag table by its primary key, a bounded page at a time, closing each page's read before writing. A
 * page's orphans are re-checked and removed in one transaction that also saves the position, so a page with none
 * writes nothing, and a restart re-reads from the last page that removed rows.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>} `batches` and `rowsChanged` count the pages that removed rows
 *   and the rows removed.
 */
export async function removeOrphanTagRowsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const { db } = entry;
    if (db.get('SELECT 1 FROM meta WHERE key = @key', { key: ORPHAN_TAG_ROWS_REMOVED_FLAG })) return { batches: 0, rowsChanged: 0 };

    const label = 'Orphan tag row removal';
    const saved = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: ORPHAN_TAG_ROWS_PROGRESS_KEY }));
    let progressSaved = !!saved;
    /** @type {{ table: string, id: string, tagId: string } | null} */
    const resumeAt = saved ? JSON.parse(saved.value) : null;

    let batches = 0;
    let rowsChanged = 0;
    const sides = resumeAt ? TAG_ROW_SIDES.slice(TAG_ROW_SIDES.findIndex(side => side.tagTable === resumeAt.table)) : TAG_ROW_SIDES;
    for (const { tagTable, entityColumn, entityTable, logTagRowsChanged } of sides) {
        /** @type {{ id: string, tagId: string } | null} */
        let after = resumeAt?.table === tagTable ? { id: resumeAt.id, tagId: resumeAt.tagId } : null;
        for (;;) {
            /** @type {{ id: string, tagId: string }[]} */
            const page = [];
            const rows = after === null
                ? db.iterate(`SELECT ${entityColumn} AS id, tag_id FROM ${tagTable} ORDER BY ${entityColumn}, tag_id LIMIT @limit`, { limit: DELETED_TAG_BATCH_SIZE })
                : db.iterate(`SELECT ${entityColumn} AS id, tag_id FROM ${tagTable} WHERE (${entityColumn}, tag_id) > (@id, @tagId) ORDER BY ${entityColumn}, tag_id LIMIT @limit`, { ...after, limit: DELETED_TAG_BATCH_SIZE });
            for (const row of /** @type {Iterable<{ id: string, tag_id: string }>} */ (rows)) page.push({ id: row.id, tagId: row.tag_id });
            if (page.length === 0) break;
            const last = page[page.length - 1];
            after = { id: last.id, tagId: last.tagId };

            const pageIds = [...new Set(page.map(row => row.id))];
            /** @type {Set<string>} */
            const known = new Set();
            for (let i = 0; i < pageIds.length; i += FAV_LOOKUP_BATCH_SIZE) {
                for (const id of knownEntityIdsOf(db, entityTable, pageIds.slice(i, i + FAV_LOOKUP_BATCH_SIZE))) known.add(id);
            }
            const candidates = page.filter(row => !known.has(row.id));

            if (candidates.length > 0) {
                /** @type {{ removed: string[] }} */
                const state = { removed: [] };
                db.transaction(() => {
                    // Reset here: a transaction that hits busy is rolled back and rerun.
                    state.removed = [];
                    /** @type {Map<string, string>} */
                    const names = new Map();
                    /** @type {Set<string>} */
                    const changedIds = new Set();
                    for (const row of candidates) {
                        if (db.get(`SELECT 1 FROM ${entityTable} WHERE id = @id`, { id: row.id })) continue;
                        if (db.run(`DELETE FROM ${tagTable} WHERE ${entityColumn} = @id AND tag_id = @tagId`, row).changes === 0) continue;
                        if (!names.has(row.tagId)) names.set(row.tagId, tagNameForWarning(db, row.tagId));
                        state.removed.push(`  ${row.id}: ${names.get(row.tagId)}`);
                        changedIds.add(row.id);
                    }
                    for (const id of changedIds) logTagRowsChanged(db, id);
                    if (state.removed.length === 0) return;
                    setMetaSync(db, ORPHAN_TAG_ROWS_PROGRESS_KEY, JSON.stringify({ table: tagTable, id: last.id, tagId: last.tagId }));
                });
                if (state.removed.length > 0) {
                    progressSaved = true;
                    batches++;
                    rowsChanged += state.removed.length;
                    if (batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0 && !isReadOnlyMode()) db.get('PRAGMA wal_checkpoint(PASSIVE)');
                    console.warn(color.yellow(`[character-metadata] ${label}: removed ${state.removed.length} ${tagTable} row(s) whose ${entityTable} row doesn't exist:\n${state.removed.join('\n')}`));
                }
            }
            await delay(MIGRATION_BATCH_PAUSE_MS);
            if (page.length < DELETED_TAG_BATCH_SIZE) break;
        }
    }

    db.transaction(() => {
        setMetaSync(db, ORPHAN_TAG_ROWS_REMOVED_FLAG, String(Date.now()));
        if (progressSaved) db.run('DELETE FROM meta WHERE key = @key', { key: ORPHAN_TAG_ROWS_PROGRESS_KEY });
    });
    if (!isReadOnlyMode()) db.checkpoint();
    return { batches, rowsChanged };
}

export const GROUP_DIGEST_TAG_IDS_REFRESHED_FLAG = 'group_digest_tag_ids_refreshed_v1';
const GROUP_DIGEST_TAG_IDS_PROGRESS_KEY = `${GROUP_DIGEST_TAG_IDS_REFRESHED_FLAG}_progress`;

/**
 * One-time pass setting every group's digest_tag_ids to what its group_tags rows give, where it is NULL or
 * differs, and listing each group it set in a warning.
 *
 * Walks groups by id, a bounded page at a time, closing each page's read before writing. A page's groups are
 * re-checked and set in one transaction that also saves the position, so a page with nothing to set writes
 * nothing, and a restart re-reads from the last page that set a digest.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>} `batches` and `rowsChanged` count the pages that set digests
 *   and the groups set.
 */
export async function refreshGroupDigestTagIdsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const { db } = entry;
    if (db.get('SELECT 1 FROM meta WHERE key = @key', { key: GROUP_DIGEST_TAG_IDS_REFRESHED_FLAG })) return { batches: 0, rowsChanged: 0 };

    const label = 'Group digest_tag_ids refresh';
    const saved = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: GROUP_DIGEST_TAG_IDS_PROGRESS_KEY }));
    let progressSaved = !!saved;
    /** @type {string | null} */
    let after = saved ? JSON.parse(saved.value).id : null;

    let batches = 0;
    let rowsChanged = 0;
    for (;;) {
        /** @type {{ id: string, digest_tag_ids: number | null }[]} */
        const page = [];
        const rows = after === null
            ? db.iterate('SELECT id, digest_tag_ids FROM groups ORDER BY id LIMIT @limit', { limit: DELETED_TAG_BATCH_SIZE })
            : db.iterate('SELECT id, digest_tag_ids FROM groups WHERE id > @after ORDER BY id LIMIT @limit', { after, limit: DELETED_TAG_BATCH_SIZE });
        for (const row of /** @type {Iterable<{ id: string, digest_tag_ids: number | null }>} */ (rows)) page.push(row);
        if (page.length === 0) break;
        const last = page[page.length - 1].id;
        after = last;

        const candidates = page.filter(row => !groupDigestTagIdsMatch(row.digest_tag_ids, groupDigestTagIdsFromTable(db, row.id))).map(row => row.id);

        if (candidates.length > 0) {
            /** @type {{ set: string[] }} */
            const state = { set: [] };
            db.transaction(() => {
                // Reset here: a transaction that hits busy is rolled back and rerun.
                state.set = [];
                for (const id of candidates) {
                    if (!syncGroupDigestTagIdsFromTable(db, id)) continue;
                    state.set.push(id);
                    insertGroupChange(db, id);
                }
                if (state.set.length === 0) return;
                setMetaSync(db, GROUP_DIGEST_TAG_IDS_PROGRESS_KEY, JSON.stringify({ id: last }));
            });
            if (state.set.length > 0) {
                progressSaved = true;
                batches++;
                rowsChanged += state.set.length;
                if (batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0 && !isReadOnlyMode()) db.get('PRAGMA wal_checkpoint(PASSIVE)');
                console.warn(color.yellow(`[character-metadata] ${label}: set digest_tag_ids from group_tags on ${state.set.length} group(s) whose stored one was NULL or stale:\n${state.set.map(id => `  ${id}`).join('\n')}`));
            }
        }
        await delay(MIGRATION_BATCH_PAUSE_MS);
        if (page.length < DELETED_TAG_BATCH_SIZE) break;
    }

    db.transaction(() => {
        setMetaSync(db, GROUP_DIGEST_TAG_IDS_REFRESHED_FLAG, String(Date.now()));
        if (progressSaved) db.run('DELETE FROM meta WHERE key = @key', { key: GROUP_DIGEST_TAG_IDS_PROGRESS_KEY });
    });
    if (!isReadOnlyMode()) db.checkpoint();
    return { batches, rowsChanged };
}

const ENTITY_COUNT_FILL_BATCH_SIZE = 1000;

const TREE_OWNER_KIND_BATCH_SIZE = 100;

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {'characters' | 'groups'} table
 * @param {string[]} ids
 * @returns {string[]} The ids that have a row in `table`.
 */
function existingRowIds(db, table, ids) {
    /** @type {string[]} */
    const found = [];
    for (let i = 0; i < ids.length; i += FAV_LOOKUP_BATCH_SIZE) {
        const batch = ids.slice(i, i + FAV_LOOKUP_BATCH_SIZE);
        const rows = db.iterate(`SELECT id FROM ${table} WHERE id IN (${batch.map(() => '?').join(',')})`, batch);
        for (const row of /** @type {Iterable<{ id: string }>} */ (rows)) found.push(row.id);
    }
    return found;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult>} `batches` is 1 when the index was dropped.
 */
export async function dropTreeOwnerCreatedAtIndex(directories) {
    return { batches: await dropOwnerCreatedAtIndex(directories) ? 1 : 0, rowsChanged: 0 };
}

/**
 * Records the kind of every message tree owner that has none yet: `character` when exactly one characters row's
 * chats live under the owner id, `group` when the groups row with that id is the only match. An owner with no match,
 * or more than one, stays unknown and is logged. Runs every boot, since owners the boot chat migration creates have
 * no kind until this pass.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>} `batches` counts the pages of owners examined, `rowsChanged`
 *   the kinds recorded.
 */
export async function fillTreeOwnerKinds(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    let batches = 0;
    let rowsChanged = 0;
    /** @type {string | null} */
    let after = null;
    for (;;) {
        const ownerIds = await listOwnersWithoutKind(directories, after, TREE_OWNER_KIND_BATCH_SIZE);
        if (ownerIds.length === 0) break;
        after = ownerIds[ownerIds.length - 1];

        /** @type {{ ownerId: string, owner: import('./message-tree-db.js').OwnerDescriptor }[]} */
        const found = [];
        for (const ownerId of ownerIds) {
            const owner = ownerKindFromRowsSync(entry.db, ownerId);
            if (owner) found.push({ ownerId, owner });
        }
        rowsChanged += await recordOwnerKinds(directories, found);
        batches++;
    }
    return { batches, rowsChanged };
}

/** Owners recounted per message stats fill batch. */
const MESSAGE_STATS_FILL_BATCH = 50;

/**
 * Counts every message tree owner's message stats from its rows once (message-stats.js), a batch of owners at a time
 * with a pause between; the triggers keep them current after. Resumes where it stopped.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>} `rowsChanged` counts the owners recounted.
 */
export async function fillMessageStatsIfNeeded(directories) {
    let batches = 0;
    let rowsChanged = 0;
    /** @type {ProgressLog | null} */
    let progress = null;
    for (;;) {
        const result = await fillMessageStats(directories, MESSAGE_STATS_FILL_BATCH);
        if (!result) return;
        if (result.owners > 0) {
            progress ??= new ProgressLog({ what: 'counting message stats from stored chats' });
            progress.add(result.owners);
            rowsChanged += result.owners;
            batches++;
        }
        if (result.done) break;
        await delay(MIGRATION_BATCH_PAUSE_MS);
    }
    progress?.finish('owners');
    return { batches, rowsChanged };
}

/**
 * The kind a message tree owner's messages belong to, by the rows that exist: the one characters row whose chats
 * live under the owner id, or the groups row with that id when it's the only match. No match, or more than one, is
 * logged and gives undefined.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} ownerId
 * @returns {import('./message-tree-db.js').OwnerDescriptor | undefined}
 */
function ownerKindFromRowsSync(db, ownerId) {
    /** @type {import('./message-tree-db.js').OwnerDescriptor[]} */
    const matches = [
        ...existingRowIds(db, 'characters', characterAvatarsForOwnerId(ownerId)).map(rowId => ({ kind: /** @type {const} */ ('character'), rowId })),
        ...existingRowIds(db, 'groups', [ownerId]).map(rowId => ({ kind: /** @type {const} */ ('group'), rowId })),
    ];
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
        console.warn(color.yellow(`[character-metadata] Message tree owner ${ownerId} matches no character or group, so its chat stats aren't kept.`));
    } else {
        console.warn(color.yellow(`[character-metadata] Message tree owner ${ownerId} matches more than one entity (${matches.map(m => `${m.kind} ${m.rowId}`).join(', ')}), so its chat stats aren't kept.`));
    }
    return undefined;
}

/**
 * Copies into the tag sort tables the tag rows that existed before their triggers did, a batch of entities at a
 * time in id order, pausing between batches; the triggers keep every row written since. INSERT OR IGNORE leaves a
 * row a trigger already wrote, which is current. /query reads the tables only once this has finished.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<{ batches: number, rowsChanged: number } | undefined>}
 */
export async function fillTagSortTablesIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const { db } = entry;
    if (db.get('SELECT 1 FROM meta WHERE key = @key', { key: TAG_SORT_FILLED_FLAG })) return { batches: 0, rowsChanged: 0 };

    let batches = 0;
    let rowsChanged = 0;
    for (const { name, table, tagTable, entityColumn, sortTable, columns, tagRowCounts } of TAG_SORT_KINDS) {
        const uptoKey = `${TAG_SORT_FILL_UPTO_KEY}${name}`;
        const saved = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: uptoKey }));
        if (saved?.value === '\u0000done') continue;
        /** @type {string | null} */
        let after = saved ? saved.value : null;
        for (;;) {
            /** @type {string[]} */
            const page = [];
            const rows = after === null
                ? db.iterate(`SELECT id FROM ${table} ORDER BY id LIMIT @limit`, { limit: TAG_SORT_FILL_BATCH_SIZE })
                : db.iterate(`SELECT id FROM ${table} WHERE id > @after ORDER BY id LIMIT @limit`, { after, limit: TAG_SORT_FILL_BATCH_SIZE });
            for (const row of /** @type {Iterable<{ id: string }>} */ (rows)) page.push(row.id);
            const last = page.length > 0 ? page[page.length - 1] : after;
            const done = page.length < TAG_SORT_FILL_BATCH_SIZE;
            const state = { inserted: 0 };
            db.transaction(() => {
                // Reset here: a transaction that hits busy is rolled back and rerun.
                state.inserted = 0;
                if (page.length > 0) {
                    const range = after === null ? 'e.id <= @last' : 'e.id > @after AND e.id <= @last';
                    const result = db.run(
                        `INSERT OR IGNORE INTO ${sortTable} (tag_id, entity_id, ${columns.map(c => c.key).join(', ')})
                            SELECT t.tag_id, e.id, ${columns.map(c => `e.${c.source}`).join(', ')}
                            FROM ${table} e JOIN ${tagTable} t ON t.${entityColumn} = e.id
                            WHERE ${range} AND ${tagRowCounts(`t.${entityColumn}`)}`,
                        after === null ? { last } : { after, last },
                    );
                    state.inserted = Number(result.changes);
                }
                setMetaSync(db, uptoKey, done ? '\u0000done' : /** @type {string} */ (last));
            });
            batches++;
            rowsChanged += state.inserted;
            if (batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0 && !isReadOnlyMode()) db.get('PRAGMA wal_checkpoint(PASSIVE)');
            if (done) break;
            after = last;
            await delay(MIGRATION_BATCH_PAUSE_MS);
        }
    }
    db.run('INSERT INTO meta (key, value) VALUES (@key, \'1\') ON CONFLICT(key) DO NOTHING', { key: TAG_SORT_FILLED_FLAG });
    entry.tagSortFilled = true;
    if (batches > 0 && !isReadOnlyMode()) db.checkpoint();
    return { batches, rowsChanged };
}

/**
 * Whether the tag sort tables are filled. Stays true once it is.
 * @param {MetadataDbEntry} entry
 * @returns {boolean}
 */
function tagSortTablesReady(entry) {
    if (entry.tagSortFilled === true) return true;
    if (!entry.db.get('SELECT 1 FROM meta WHERE key = @key', { key: TAG_SORT_FILLED_FLAG })) return false;
    entry.tagSortFilled = true;
    return true;
}

/**
 * Gives every entity that existed before the rank triggers its ranks (search plan step 7a), a batch of entities at a
 * time in id order, pausing between batches; the triggers keep every rank written since. A space an entity already
 * holds (a trigger put it there) is left alone. The random sort reads the ranks only once this has finished.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<{ batches: number, rowsChanged: number } | undefined>}
 */
export async function fillRandomRanksIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const { db } = entry;
    if (db.get('SELECT 1 FROM meta WHERE key = @key', { key: RANDOM_RANKS_FILLED_FLAG })) return { batches: 0, rowsChanged: 0 };

    let batches = 0;
    let rowsChanged = 0;
    for (const { code, table, tagTable, entityColumn, tagRowCounts } of RANDOM_RANK_KINDS) {
        const uptoKey = `${RANDOM_RANKS_FILL_UPTO_KEY}${code}`;
        const saved = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: uptoKey }));
        if (saved?.value === '\u0000done') continue;
        /** @type {string | null} */
        let after = saved ? saved.value : null;
        for (;;) {
            /** @type {string[]} */
            const page = [];
            const rows = after === null
                ? db.iterate(`SELECT id FROM ${table} ORDER BY id LIMIT @limit`, { limit: RANDOM_RANKS_FILL_BATCH_SIZE })
                : db.iterate(`SELECT id FROM ${table} WHERE id > @after ORDER BY id LIMIT @limit`, { after, limit: RANDOM_RANKS_FILL_BATCH_SIZE });
            for (const row of /** @type {Iterable<{ id: string }>} */ (rows)) page.push(row.id);
            const last = page.length > 0 ? page[page.length - 1] : after;
            const done = page.length < RANDOM_RANKS_FILL_BATCH_SIZE;
            const state = { inserted: 0 };
            db.transaction(() => {
                // Reset here: a transaction that hits busy is rolled back and rerun.
                state.inserted = 0;
                /** @type {Map<string, number>} each touched space's next free rank */
                const nextRank = new Map();
                for (const id of page) {
                    const entity = /** @type {{ fav: number } | undefined} */ (db.get(`SELECT fav FROM ${table} WHERE id = @id`, { id }));
                    if (!entity) continue;
                    const fav = Number(entity.fav) ? 1 : 0;
                    const wanted = [randomSpaceName('', null), randomSpaceName('', fav)];
                    for (const row of /** @type {Iterable<{ tag_id: string }>} */ (db.iterate(`SELECT tag_id FROM ${tagTable} WHERE ${entityColumn} = @id AND ${tagRowCounts(entityColumn)}`, { id }))) {
                        wanted.push(randomSpaceName(row.tag_id, null), randomSpaceName(row.tag_id, fav));
                    }
                    const held = new Set(Array.from(/** @type {Iterable<{ space: string }>} */ (db.iterate('SELECT space FROM random_ranks WHERE kind = @code AND entity_id = @id', { code, id })), r => r.space));
                    for (const space of wanted) {
                        if (held.has(space)) continue;
                        let rank = nextRank.get(space);
                        if (rank === undefined) {
                            rank = Number(/** @type {{ n: number }} */ (db.get('SELECT COALESCE(MAX(rank), -1) + 1 AS n FROM random_ranks WHERE space = @space', { space })).n);
                        }
                        db.run('INSERT INTO random_ranks (space, rank, kind, entity_id) VALUES (@space, @rank, @code, @id)', { space, rank, code, id });
                        nextRank.set(space, rank + 1);
                        held.add(space);
                        state.inserted++;
                    }
                }
                setMetaSync(db, uptoKey, done ? '\u0000done' : /** @type {string} */ (last));
            });
            batches++;
            rowsChanged += state.inserted;
            if (batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0 && !isReadOnlyMode()) db.get('PRAGMA wal_checkpoint(PASSIVE)');
            if (done) break;
            after = last;
            await delay(MIGRATION_BATCH_PAUSE_MS);
        }
    }
    db.run('INSERT INTO meta (key, value) VALUES (@key, \'1\') ON CONFLICT(key) DO NOTHING', { key: RANDOM_RANKS_FILLED_FLAG });
    entry.randomRanksFilled = true;
    if (batches > 0 && !isReadOnlyMode()) db.checkpoint();
    return { batches, rowsChanged };
}

/**
 * Whether the random order's ranks are filled. Stays true once it is.
 * @param {MetadataDbEntry} entry
 * @returns {boolean}
 */
function randomRanksReady(entry) {
    if (entry.randomRanksFilled === true) return true;
    if (!entry.db.get('SELECT 1 FROM meta WHERE key = @key', { key: RANDOM_RANKS_FILLED_FLAG })) return false;
    entry.randomRanksFilled = true;
    return true;
}

/**
 * @typedef {'asc' | 'desc'} NameOrderDirection
 * @typedef {{ kind: string, entity_id: string, name_fold: string, tie_key: string, pos: number | null }} NameOrderRow
 */

/** @param {NameOrderDirection} dir */
const namePosColumn = dir => dir === 'asc' ? 'pos_asc' : 'pos_desc';

/**
 * Up to `limit` name_order rows after (name_fold, tie_key) in `dir`'s order, nearest first. Each part reads an index
 * in its own order, so no row before the key is read.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {NameOrderDirection} dir
 * @param {string} nameFold
 * @param {string} tieKey
 * @param {number} limit
 * @returns {NameOrderRow[]}
 */
function nameOrderRowsAfter(db, dir, nameFold, tieKey, limit) {
    const pos = namePosColumn(dir);
    const cols = `kind, entity_id, name_fold, tie_key, ${pos} AS pos`;
    const sameName = /** @type {NameOrderRow[]} */ (Array.from(db.iterate(
        `SELECT ${cols} FROM name_order WHERE name_fold = @nameFold AND tie_key > @tieKey ORDER BY tie_key LIMIT @limit`, { nameFold, tieKey, limit })));
    if (sameName.length >= limit) return sameName;
    const rest = dir === 'asc'
        ? `SELECT ${cols} FROM name_order WHERE name_fold > @nameFold ORDER BY name_fold ASC, tie_key ASC LIMIT @limit`
        : `SELECT ${cols} FROM name_order WHERE name_fold < @nameFold ORDER BY name_fold DESC, tie_key ASC LIMIT @limit`;
    const restRows = /** @type {NameOrderRow[]} */ (Array.from(db.iterate(rest, { nameFold, limit: limit - sameName.length })));
    return [...sameName, ...restRows];
}

/**
 * Up to `limit` name_order rows before (name_fold, tie_key) in `dir`'s order, nearest first.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {NameOrderDirection} dir
 * @param {string} nameFold
 * @param {string} tieKey
 * @param {number} limit
 * @returns {NameOrderRow[]}
 */
function nameOrderRowsBefore(db, dir, nameFold, tieKey, limit) {
    const pos = namePosColumn(dir);
    const cols = `kind, entity_id, name_fold, tie_key, ${pos} AS pos`;
    const sameName = /** @type {NameOrderRow[]} */ (Array.from(db.iterate(
        `SELECT ${cols} FROM name_order WHERE name_fold = @nameFold AND tie_key < @tieKey ORDER BY tie_key DESC LIMIT @limit`, { nameFold, tieKey, limit })));
    if (sameName.length >= limit) return sameName;
    const rest = dir === 'asc'
        ? `SELECT ${cols} FROM name_order WHERE name_fold < @nameFold ORDER BY name_fold DESC, tie_key DESC LIMIT @limit`
        : `SELECT ${cols} FROM name_order WHERE name_fold > @nameFold ORDER BY name_fold ASC, tie_key DESC LIMIT @limit`;
    const restRows = /** @type {NameOrderRow[]} */ (Array.from(db.iterate(rest, { nameFold, limit: limit - sameName.length })));
    return [...sameName, ...restRows];
}

/**
 * The window of rows to renumber around a row: at least `size` rows on each side, extended past any unplaced rows,
 * and the placed positions bounding it (0 and NAME_ORDER_LIMIT at the ends).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {NameOrderDirection} dir
 * @param {NameOrderRow} row
 * @param {number} size
 */
function nameOrderWindow(db, dir, row, size) {
    /**
     * @param {(nameFold: string, tieKey: string, limit: number) => NameOrderRow[]} fetch
     * @returns {{ rows: NameOrderRow[], bound: number | null }}
     */
    const side = (fetch) => {
        /** @type {NameOrderRow[]} */
        const rows = [];
        let from = row;
        for (;;) {
            const page = fetch(from.name_fold, from.tie_key, size);
            for (const next of page) {
                if (rows.length >= size && next.pos !== null) return { rows, bound: next.pos };
                rows.push(next);
            }
            if (page.length < size) return { rows, bound: null };
            from = page[page.length - 1];
        }
    };
    const before = side((nf, tk, limit) => nameOrderRowsBefore(db, dir, nf, tk, limit));
    const after = side((nf, tk, limit) => nameOrderRowsAfter(db, dir, nf, tk, limit));
    return {
        rows: [...before.rows.reverse(), row, ...after.rows],
        lo: before.bound ?? 0,
        hi: after.bound ?? NAME_ORDER_LIMIT,
    };
}

/**
 * Places one unplaced row in one order: between its placed neighbours when there's room, otherwise by spreading a
 * window around it evenly, doubled until it has room.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {NameOrderDirection} dir
 * @param {NameOrderRow} row
 * @returns {NameOrderRow[]} The rows whose position was written.
 */
function placeNameOrderRow(db, dir, row) {
    const pos = namePosColumn(dir);
    const write = (/** @type {NameOrderRow} */ r, /** @type {number} */ value) => {
        writeRowIfChanged(db, 'name_order', { kind: r.kind, entity_id: r.entity_id }, { [pos]: value });
    };
    const before = nameOrderRowsBefore(db, dir, row.name_fold, row.tie_key, 1);
    const after = nameOrderRowsAfter(db, dir, row.name_fold, row.tie_key, 1);
    if (before.every(r => r.pos !== null) && after.every(r => r.pos !== null)) {
        const lo = before.length > 0 ? Number(before[0].pos) : 0;
        const hi = after.length > 0 ? Number(after[0].pos) : NAME_ORDER_LIMIT;
        const value = after.length === 0 ? lo + NAME_ORDER_SPACING
            : before.length === 0 ? hi - NAME_ORDER_SPACING
                : Math.floor((lo + hi) / 2);
        const placed = value > lo && value < hi ? value : Math.floor((lo + hi) / 2);
        if (placed > lo && placed < hi) {
            write(row, placed);
            return [row];
        }
    }
    for (let size = NAME_ORDER_RESPACE_WINDOW; ; size *= 2) {
        const { rows, lo, hi } = nameOrderWindow(db, dir, row, size);
        const step = Math.floor((hi - lo) / (rows.length + 1));
        if (step >= 1) {
            rows.forEach((r, i) => write(r, lo + step * (i + 1)));
            return rows;
        }
        if (lo === 0 && hi === NAME_ORDER_LIMIT) throw new Error('the name order has no room left for its rows');
    }
}

/**
 * Places up to `limit` unplaced name_order rows, each in a transaction of its own, and logs the characters whose
 * position moved in name_order_changes. Run while the name order is filled; a fill places everything itself.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} limit
 * @returns {Promise<{ placed: number, moved: number } | null>} null when the metadata store is unavailable.
 */
export async function placeNameOrderRows(directories, limit) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const { db } = entry;
    if (!nameOrderReady(entry)) return { placed: 0, moved: 0 };
    const unplaced = /** @type {{ kind: string, entity_id: string }[]} */ (Array.from(db.iterate(
        'SELECT kind, entity_id FROM name_order WHERE pos_asc IS NULL OR pos_desc IS NULL LIMIT @limit', { limit })));
    let moved = 0;
    for (const { kind, entity_id } of unplaced) {
        const state = { moved: 0 };
        db.transaction(() => {
            state.moved = 0;
            const current = /** @type {{ name_fold: string, tie_key: string, pos_asc: number | null, pos_desc: number | null } | undefined} */ (
                db.get('SELECT name_fold, tie_key, pos_asc, pos_desc FROM name_order WHERE kind = @kind AND entity_id = @entity_id', { kind, entity_id }));
            if (!current) return;
            /** @type {Set<string>} */
            const movedCharacters = new Set();
            for (const dir of /** @type {NameOrderDirection[]} */ (['asc', 'desc'])) {
                if (current[namePosColumn(dir)] !== null) continue;
                const rows = placeNameOrderRow(db, dir, { kind, entity_id, name_fold: current.name_fold, tie_key: current.tie_key, pos: null });
                for (const r of rows) if (r.kind === 'c') movedCharacters.add(r.entity_id);
            }
            for (const id of movedCharacters) db.run('INSERT INTO name_order_changes (entity_id) VALUES (@id)', { id });
            state.moved = movedCharacters.size;
        });
        moved += state.moved;
    }
    return { placed: unplaced.length, moved };
}

/**
 * Gives every character and group a name_order row, then numbers both orders once (search plan step 7f), a batch at
 * a time, pausing between batches. The triggers keep the rows' names since, and leave the positions of rows added or
 * renamed behind the numbering unplaced, for placeNameOrderRows(). Ends with one name_order_changes row for every
 * character, since every position moved.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<{ batches: number, rowsChanged: number } | undefined>}
 */
export async function fillNameOrderIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const { db } = entry;
    if (db.get('SELECT 1 FROM meta WHERE key = @key', { key: NAME_ORDER_FILLED_FLAG })) return { batches: 0, rowsChanged: 0 };
    let batches = 0;
    let rowsChanged = 0;
    /** @param {string} phase */
    const readUpto = phase => {
        const saved = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: `${NAME_ORDER_FILL_UPTO_KEY}${phase}` }));
        return saved ? JSON.parse(saved.value) : null;
    };
    /** @param {string} phase @param {unknown} value */
    const writeUpto = (phase, value) => setMetaSync(db, `${NAME_ORDER_FILL_UPTO_KEY}${phase}`, JSON.stringify(value));
    const pause = async () => {
        batches++;
        if (batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0 && !isReadOnlyMode()) db.get('PRAGMA wal_checkpoint(PASSIVE)');
        await delay(MIGRATION_BATCH_PAUSE_MS);
    };

    for (const [code, table] of /** @type {['c' | 'g', string][]} */ ([['c', 'characters'], ['g', 'groups']])) {
        const phase = `copy_${code}`;
        let upto = readUpto(phase);
        while (upto?.done !== true) {
            const after = upto?.after ?? null;
            const ids = /** @type {{ id: string }[]} */ (Array.from(after === null
                ? db.iterate(`SELECT id FROM ${table} ORDER BY id LIMIT @limit`, { limit: NAME_ORDER_FILL_BATCH_SIZE })
                : db.iterate(`SELECT id FROM ${table} WHERE id > @after ORDER BY id LIMIT @limit`, { after, limit: NAME_ORDER_FILL_BATCH_SIZE }))).map(r => r.id);
            const next = ids.length < NAME_ORDER_FILL_BATCH_SIZE ? { done: true } : { after: ids[ids.length - 1] };
            const state = { inserted: 0 };
            db.transaction(() => {
                state.inserted = 0;
                for (const id of ids) {
                    state.inserted += db.run(`INSERT INTO name_order (kind, entity_id, name_fold, tie_key)
                        SELECT '${code}', id, name_fold, ${nameOrderTieKeySql(code, 'id')} FROM ${table} WHERE id = @id
                        ON CONFLICT(kind, entity_id) DO NOTHING`, { id }).changes;
                }
                writeUpto(phase, next);
            });
            rowsChanged += state.inserted;
            upto = next;
            await pause();
        }
    }

    for (const dir of /** @type {NameOrderDirection[]} */ (['asc', 'desc'])) {
        const phase = `number_${dir}`;
        const pos = namePosColumn(dir);
        let upto = readUpto(phase) ?? { rank: 0, nameFold: null, tieKey: null };
        while (upto.done !== true) {
            const rows = upto.nameFold === null
                ? /** @type {NameOrderRow[]} */ (Array.from(db.iterate(dir === 'asc'
                    ? 'SELECT kind, entity_id, name_fold, tie_key FROM name_order ORDER BY name_fold ASC, tie_key ASC LIMIT @limit'
                    : 'SELECT kind, entity_id, name_fold, tie_key FROM name_order ORDER BY name_fold DESC, tie_key ASC LIMIT @limit', { limit: NAME_ORDER_FILL_BATCH_SIZE })))
                : nameOrderRowsAfter(db, dir, upto.nameFold, upto.tieKey, NAME_ORDER_FILL_BATCH_SIZE);
            const last = rows[rows.length - 1];
            const next = rows.length < NAME_ORDER_FILL_BATCH_SIZE
                ? { done: true }
                : { rank: upto.rank + rows.length, nameFold: last.name_fold, tieKey: last.tie_key };
            const from = upto.rank;
            db.transaction(() => {
                rows.forEach((r, i) => writeRowIfChanged(db, 'name_order', { kind: r.kind, entity_id: r.entity_id },
                    { [pos]: (from + i + 1) * NAME_ORDER_SPACING }));
                writeUpto(phase, next);
            });
            rowsChanged += rows.length;
            upto = next;
            await pause();
        }
    }

    db.transaction(() => {
        db.run('INSERT INTO name_order_changes (entity_id) VALUES (NULL)');
        db.run('INSERT INTO meta (key, value) VALUES (@key, \'1\') ON CONFLICT(key) DO NOTHING', { key: NAME_ORDER_FILLED_FLAG });
    });
    entry.nameOrderFilled = true;
    if (batches > 0 && !isReadOnlyMode()) db.checkpoint();
    return { batches, rowsChanged };
}

/**
 * Whether the name order has been filled. Stays true once it is.
 * @param {MetadataDbEntry} entry
 * @returns {boolean}
 */
function nameOrderReady(entry) {
    if (entry.nameOrderFilled === true) return true;
    if (!entry.db.get('SELECT 1 FROM meta WHERE key = @key', { key: NAME_ORDER_FILLED_FLAG })) return false;
    entry.nameOrderFilled = true;
    return true;
}

/**
 * Whether a search index can sort by the stored name order: it's filled and every row is placed. `seq` is the last
 * name_order_changes row, which an index's docs must cover too.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<{ usable: boolean, seq: number } | null>} null when the metadata store is unavailable.
 */
export async function getNameOrderState(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const { db } = entry;
    const seq = Number(/** @type {{ seq: number | null }} */ (db.get('SELECT MAX(seq) AS seq FROM name_order_changes')).seq ?? 0);
    if (!nameOrderReady(entry)) return { usable: false, seq };
    const unplaced = db.get('SELECT 1 FROM name_order WHERE pos_asc IS NULL OR pos_desc IS NULL LIMIT 1');
    return { usable: !unplaced, seq };
}

/**
 * The name_order_changes rows past sinceSeq, at most `limit`: the characters whose position moved, or `all` when a
 * row says every one did.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} sinceSeq
 * @param {number} limit
 * @returns {Promise<{ seq: number, ids: string[], all: boolean, hasMore: boolean } | null>}
 */
export async function getNameOrderChangesSince(directories, sinceSeq, limit) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const rows = /** @type {{ seq: number, entity_id: string | null }[]} */ (Array.from(entry.db.iterate(
        'SELECT seq, entity_id FROM name_order_changes WHERE seq > @sinceSeq ORDER BY seq LIMIT @limit', { sinceSeq, limit })));
    return {
        seq: rows.length > 0 ? rows[rows.length - 1].seq : sinceSeq,
        ids: [...new Set(rows.filter(r => r.entity_id !== null).map(r => /** @type {string} */ (r.entity_id)))],
        all: rows.some(r => r.entity_id === null),
        hasMore: rows.length === limit,
    };
}

/**
 * Each listed entity's name order positions; an entity with no row, or not yet placed, is left out.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {'c' | 'g'} kind
 * @param {string[]} ids
 * @returns {Promise<Map<string, { asc: number, desc: number }>>}
 */
export async function getNameOrderPositions(directories, kind, ids) {
    const entry = await getEntry(directories);
    /** @type {Map<string, { asc: number, desc: number }>} */
    const out = new Map();
    if (!entry || ids.length === 0) return out;
    for (const row of /** @type {Iterable<{ entity_id: string, pos_asc: number, pos_desc: number }>} */ (entry.db.iterate(
        'SELECT entity_id, pos_asc, pos_desc FROM name_order WHERE kind = @kind AND entity_id IN (SELECT value FROM json_each(@ids)) AND pos_asc IS NOT NULL AND pos_desc IS NOT NULL',
        { kind, ids: JSON.stringify(ids) }))) {
        out.set(row.entity_id, { asc: Number(row.pos_asc), desc: Number(row.pos_desc) });
    }
    return out;
}

/**
 * Fills entity_counts and entity_tag_counts (see SCHEMA_SQL) for every entity past each kind's frontier in
 * entity_count_fill, and marks the kind done once none is left.
 *
 * Walks each kind's entities by id, a bounded page at a time, closing each page's read before writing. One
 * transaction per page counts the entities in (upto, last id of the page], and their tag rows, as they are inside
 * that transaction, adds those counts and moves upto to the page's last id, so a write landing between the read and
 * the transaction is counted once, by the fill or by the triggers. The same transaction sets done = 1 when no entity
 * is left past the new upto. A restart resumes from upto.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>} `batches` and `rowsChanged` count the transactions that
 *   filled a range or marked a kind done, and the entities counted.
 */
export async function fillEntityCountsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const { db } = entry;

    let batches = 0;
    let rowsChanged = 0;
    for (const { name, table, tagTable, entityColumn, tagRowCounts } of ENTITY_COUNT_KINDS) {
        const fill = /** @type {{ upto: string | null, done: number }} */ (db.get('SELECT upto, done FROM entity_count_fill WHERE kind = @name', { name }));
        if (fill.done === 1) continue;
        /** @type {string | null} */
        let after = fill.upto;

        const rangeSql = (/** @type {string} */ column, /** @type {string | null} */ lower) => `${lower === null ? '' : `${column} > @after AND `}${column} <= @last`;
        for (;;) {
            /** @type {string[]} */
            const page = [];
            const rows = after === null
                ? db.iterate(`SELECT id FROM ${table} ORDER BY id LIMIT @limit`, { limit: ENTITY_COUNT_FILL_BATCH_SIZE })
                : db.iterate(`SELECT id FROM ${table} WHERE id > @after ORDER BY id LIMIT @limit`, { after, limit: ENTITY_COUNT_FILL_BATCH_SIZE });
            for (const row of /** @type {Iterable<{ id: string }>} */ (rows)) page.push(row.id);
            const last = page.length > 0 ? page[page.length - 1] : after;

            /** @type {{ entities: number, done: boolean }} */
            const state = { entities: 0, done: false };
            db.transaction(() => {
                // Reset here: a transaction that hits busy is rolled back and rerun.
                state.entities = 0;
                state.done = false;
                if (page.length > 0) {
                    const params = after === null ? { last } : { after, last };
                    const entityCounts = /** @type {{ fav: number, n: number }[]} */ ([...db.iterate(
                        `SELECT fav, COUNT(*) AS n FROM ${table} WHERE ${rangeSql('id', after)} GROUP BY fav`, params)]);
                    const tagCounts = /** @type {{ tag_id: string, fav: number, n: number }[]} */ ([...db.iterate(
                        `SELECT t.tag_id, e.fav, COUNT(*) AS n FROM ${table} e JOIN ${tagTable} t ON t.${entityColumn} = e.id
                            WHERE ${rangeSql('e.id', after)} AND ${tagRowCounts(`t.${entityColumn}`)} GROUP BY t.tag_id, e.fav`, params)]);
                    for (const { fav, n } of entityCounts) {
                        db.run(`INSERT INTO entity_counts (kind, fav, count) VALUES (@name, @fav, @n)
                            ON CONFLICT (kind, fav) DO UPDATE SET count = count + excluded.count`, { name, fav, n });
                        state.entities += n;
                    }
                    for (const { tag_id: tagId, fav, n } of tagCounts) {
                        db.run(`INSERT INTO entity_tag_counts (tag_id, kind, fav, count) VALUES (@tagId, @name, @fav, @n)
                            ON CONFLICT (tag_id, kind, fav) DO UPDATE SET count = count + excluded.count`, { tagId, name, fav, n });
                    }
                    writeRowIfChanged(db, 'entity_count_fill', { kind: name }, { upto: last });
                }
                const more = last === null
                    ? db.get(`SELECT 1 FROM ${table} LIMIT 1`)
                    : db.get(`SELECT 1 FROM ${table} WHERE id > @last LIMIT 1`, { last });
                if (!more) {
                    writeRowIfChanged(db, 'entity_count_fill', { kind: name }, { done: 1 });
                    state.done = true;
                }
            });
            if (page.length > 0 || state.done) {
                batches++;
                rowsChanged += state.entities;
                if (batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0 && !isReadOnlyMode()) db.get('PRAGMA wal_checkpoint(PASSIVE)');
            }
            if (state.done) break;
            after = last;
            await delay(MIGRATION_BATCH_PAUSE_MS);
        }
    }

    if (batches > 0 && !isReadOnlyMode()) db.checkpoint();
    return { batches, rowsChanged };
}

// One-time migration off tags.json (removed entirely, not just drained). Must run after bootstrapIfNeeded()
// AND bootstrapGroupsIfNeeded() since it classifies tag_map keys against those tables; an unmatched key is
// dropped with a warning. On success tags.json is renamed to `tags.json.migrated`, not deleted. Gated by a meta
// flag, set only if nothing failed; otherwise tags.json stays in place and the whole migration, which is
// idempotent, reruns from the start next boot.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>}
 */
export async function migrateTagsJsonIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = (/** @type {{ value: string } | undefined} */ (entry.db.get('SELECT value FROM meta WHERE key = \'tags_json_migrated\'')));
    if (already) return { batches: 0, rowsChanged: 0 };

    const tagsJsonPath = path.join(directories.root, TAGS_FILE);
    if (!fs.existsSync(tagsJsonPath)) {
        setMetaSync(entry.db, 'tags_json_migrated', String(Date.now()));
        return { batches: 0, rowsChanged: 0 };
    }
    // An install that had a tags.json, readable or not, isn't fresh, so it never gets the default tags.
    entry.db.run('DELETE FROM meta WHERE key = @key', { key: TAGS_SEED_PENDING_KEY });

    /** @type {{ tags?: TagDefinitionInput[], tag_map?: Record<string, string[]> }} */
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(tagsJsonPath, 'utf8'));
    } catch (err) {
        console.error('[character-metadata] Failed to parse tags.json during migration - leaving it in place and retrying next boot:', /** @type {any} */ (err).message);
        return { batches: 0, rowsChanged: 0 };
    }

    const tagsArray = Array.isArray(parsed.tags) ? parsed.tags : [];
    const tagMap = parsed.tag_map && typeof parsed.tag_map === 'object' ? parsed.tag_map : {};

    // Only ids not already in `tags`: a definition saved after the server started listening is newer than
    // tags.json's and wins. Nothing is deleted, so a rerun from the start is safe.
    let insertedDefinitions = 0;
    entry.db.transaction(() => {
        // Reset here: a transaction that hits busy is rolled back and rerun.
        insertedDefinitions = 0;
        for (const raw of tagsArray) {
            const tag = /** @type {TagDefinitionInput | null | undefined} */ (raw);
            if (!tag || typeof tag.id !== 'string' || !tag.id) continue;
            insertedDefinitions += entry.db.run(`INSERT OR IGNORE INTO tags ${TAG_ROW_VALUES_SQL}`, tagRowParams(tag)).changes;
        }
        if (insertedDefinitions > 0) {
            logTagChangesSync(entry, null);
        }
    });
    const imported = await importTagMap(entry, tagMap);
    const { droppedKeys } = imported;
    const batches = 1 + imported.batches;
    const rowsChanged = insertedDefinitions + imported.rowsChanged;
    if (imported.failedKeys === 0) {
        setMetaSync(entry.db, 'tags_json_migrated', String(Date.now()));
    }
    if (!isReadOnlyMode()) entry.db.checkpoint();

    if (droppedKeys.length > 0) {
        console.warn(`[character-metadata] tags.json migration: ${droppedKeys.length} tag_map key(s) matched neither a known character nor a known group, dropped: ${droppedKeys.slice(0, 20).join(', ')}${droppedKeys.length > 20 ? ', ...' : ''}`);
    }

    if (imported.failedKeys > 0) {
        console.warn(color.yellow(`[character-metadata] tags.json migration: ${imported.failedKeys} tag_map key(s) failed (listed above); not marked done and tags.json left in place, so it runs again from the start next boot.`));
        return { batches, rowsChanged };
    }

    try {
        fs.renameSync(tagsJsonPath, `${tagsJsonPath}.migrated`);
    } catch (err) {
        console.error('[character-metadata] Migrated tags.json successfully but could not rename it out of the way (safe to ignore - it is never read again):', /** @type {any} */ (err).message);
    }
    return { batches, rowsChanged };
}

const SETTINGS_TAGS_MIGRATED_FLAG = 'settings_tags_migrated';
const SETTINGS_TAGS_IMPORT_BATCH_SIZE = 500;

// Written when getEntry() creates the database file, so only a store's first settings tags import decides the seed.
const TAGS_SEED_PENDING_KEY = 'tags_seed_pending';
// Upstream's DEFAULT_TAGS (public/scripts/tags.js), which upstream shows when settings have no `tags` key.
const DEFAULT_TAG_NAMES = ['Plain Text', 'OpenAI', 'W++', 'Boostyle', 'PList', 'AliChat'];

/**
 * On a store with TAGS_SEED_PENDING_KEY, decides whether it gets upstream's default tags, and clears the key in the
 * same transaction. It gets them when every settings source was read and none has a `tags` key. They have no
 * sort_order of their own, so they get max+1 upward in the order upstream shows them, alphabetically.
 * @param {MetadataDbEntry} entry
 * @param {{ tagsKey: boolean, unreadable: string[] }} settings
 */
function seedDefaultTagsIfPendingSync(entry, settings) {
    const outcome = { decided: false, seeded: false };
    entry.db.transaction(() => {
        // Reset here: a transaction that hits busy is rolled back and rerun.
        outcome.decided = false;
        outcome.seeded = false;
        if (!entry.db.get('SELECT 1 FROM meta WHERE key = @key', { key: TAGS_SEED_PENDING_KEY })) return;
        outcome.decided = true;
        entry.db.run('DELETE FROM meta WHERE key = @key', { key: TAGS_SEED_PENDING_KEY });
        if (settings.tagsKey || settings.unreadable.length > 0) return;
        const tags = DEFAULT_TAG_NAMES
            .map(name => ({ id: crypto.randomUUID(), name, create_date: Date.now() }))
            .sort((a, b) => compareNameKeys(tagDefinitionNameKey(a), tagDefinitionNameKey(b)));
        let next = nextTagSortOrderSync(entry);
        for (const tag of tags) {
            entry.db.run(`INSERT INTO tags ${TAG_ROW_VALUES_SQL}`, tagRowParams(next === null ? tag : { ...tag, sort_order: next++ }));
        }
        logTagChangesSync(entry, null);
        outcome.seeded = true;
    });
    if (outcome.decided && settings.unreadable.length > 0) {
        console.warn(color.yellow(`[character-metadata] This store is new, but the default tags were not added, because these settings files could not be read, so whether they have tags is unknown: ${settings.unreadable.join(', ')}`));
    }
}

/**
 * @param {string} filePath
 * @returns {{ missing: true } | { error: string } | { text: string, value: unknown }}
 */
function readSettingsTagsSource(filePath) {
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        if (/** @type {any} */ (err)?.code === 'ENOENT') return { missing: true };
        return { error: String(/** @type {any} */ (err)?.message ?? err) };
    }
    try {
        return { text, value: JSON.parse(text) };
    } catch (err) {
        return { error: String(/** @type {any} */ (err)?.message ?? err) };
    }
}

/**
 * Creates each tag of `tags` whose id has no `tags` row and no tag_deletions mark, as createTagDefinition() does:
 * an own sort_order is kept (and queued while moves queue); tags without one get max+1 upward, alphabetically,
 * after every tag in the list that has one. Everything not created is listed in a warning.
 * @param {MetadataDbEntry} entry
 * @param {string} label
 * @param {unknown[]} tags
 * @returns {Promise<{ batches: number, rowsChanged: number }>}
 */
async function importSettingsTagDefinitions(entry, label, tags) {
    /** @type {string[]} */
    const skipped = [];
    /** @type {TagDefinitionInput[]} */
    const ordered = [];
    /** @type {TagDefinitionInput[]} */
    const orderless = [];
    for (const raw of tags) {
        const tag = /** @type {TagDefinitionInput | null} */ (raw);
        if (!tag || typeof tag !== 'object' || Array.isArray(tag) || typeof tag.id !== 'string' || !tag.id) {
            skipped.push(`  ${JSON.stringify(raw)}: not a tag with a non-empty string id`);
            continue;
        }
        (Object.hasOwn(tag, 'sort_order') ? ordered : orderless).push(tag);
    }
    // Stable, so tags with the same name key keep the list's order, as rowid does in fillTagSortOrdersIfNeeded().
    orderless.sort((a, b) => compareNameKeys(tagDefinitionNameKey(a), tagDefinitionNameKey(b)));
    const sequence = [...ordered, ...orderless];

    let batches = 0;
    let rowsChanged = 0;
    for (let i = 0; i < sequence.length; i += SETTINGS_TAGS_IMPORT_BATCH_SIZE) {
        if (i > 0) await delay(TAG_MAP_IMPORT_BATCH_PAUSE_MS);
        const batch = sequence.slice(i, i + SETTINGS_TAGS_IMPORT_BATCH_SIZE);
        const ids = [...new Set(batch.map(tag => tag.id))];
        /** @type {string[]} */
        let batchSkipped = [];
        /** @type {string[]} */
        let batchInserted = [];
        entry.db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            batchSkipped = [];
            batchInserted = [];
            const placeholders = ids.map(() => '?').join(',');
            /** @type {Set<string>} */
            const existing = new Set();
            for (const row of /** @type {Generator<{ id: string }>} */ (entry.db.iterate(`SELECT id FROM tags WHERE id IN (${placeholders})`, ids))) existing.add(row.id);
            /** @type {Set<string>} */
            const marked = new Set();
            for (const row of /** @type {Generator<{ tag_id: string }>} */ (entry.db.iterate(`SELECT tag_id FROM tag_deletions WHERE tag_id IN (${placeholders})`, ids))) marked.add(row.tag_id);
            const settled = tagSortOrdersSettledSync(entry.db);
            let next = nextTagSortOrderSync(entry);

            for (const source of batch) {
                const id = source.id;
                if (marked.has(id)) {
                    batchSkipped.push(`  ${id}: deleted`);
                    continue;
                }
                if (existing.has(id) || batchInserted.includes(id)) {
                    batchSkipped.push(`  ${id}: already exists`);
                    continue;
                }
                const tag = { ...source };
                const assignOrder = !Object.hasOwn(tag, 'sort_order');
                if (assignOrder && next !== null) tag.sort_order = next;
                const params = tagRowParams(tag);
                entry.db.run(`INSERT INTO tags ${TAG_ROW_VALUES_SQL}`, params);
                if (next !== null && params.sortOrder !== null && params.sortOrder >= next) next = params.sortOrder + 1;
                if (!assignOrder && !settled) queueTagSortOrderValueSync(entry.db, id, tag.sort_order);
                batchInserted.push(id);
            }
            if (batchInserted.length > 0) {
                logTagChangesSync(entry, null);
            }
        });
        batches++;
        rowsChanged += batchInserted.length;
        skipped.push(...batchSkipped);
    }

    if (skipped.length > 0) {
        console.warn(color.yellow(`[character-metadata] ${label}: ${skipped.length} tag(s) not imported:\n${skipped.join('\n')}`));
    }
    return { batches, rowsChanged };
}

/**
 * Imports one settings source: its `tags` (when it has the key) and then its `tag_map`, leaving out assignments to
 * tags that have no definition. Everything left out is listed in a warning.
 * @param {MetadataDbEntry} entry
 * @param {string} label
 * @param {{ tags?: unknown, tag_map?: unknown }} source Only own keys are read.
 * @param {{ batches: number, rowsChanged: number }} totals Added to.
 * @returns {Promise<boolean>} Whether every tag_map key could be written.
 */
async function importSettingsTagsSource(entry, label, source, totals) {
    if (Object.hasOwn(source, 'tags')) {
        if (Array.isArray(source.tags)) {
            const result = await importSettingsTagDefinitions(entry, label, source.tags);
            totals.batches += result.batches;
            totals.rowsChanged += result.rowsChanged;
        } else {
            console.warn(color.yellow(`[character-metadata] ${label}: tags is not a list, no tag imported from it: ${JSON.stringify(source.tags)}`));
        }
    }
    if (!Object.hasOwn(source, 'tag_map')) return true;
    const tagMap = source.tag_map;
    if (!tagMap || typeof tagMap !== 'object' || Array.isArray(tagMap)) {
        console.warn(color.yellow(`[character-metadata] ${label}: tag_map is not an object, no assignment imported from it: ${JSON.stringify(tagMap)}`));
        return true;
    }
    const imported = await importTagMap(entry, /** @type {Record<string, unknown>} */ (tagMap), { label, requireDefinitions: true });
    totals.batches += imported.batches;
    totals.rowsChanged += imported.rowsChanged;
    if (imported.droppedKeys.length > 0) {
        console.warn(color.yellow(`[character-metadata] ${label}: ${imported.droppedKeys.length} tag_map key(s) matched neither a known character nor a known group, not imported: ${imported.droppedKeys.join(', ')}`));
    }
    if (imported.undefinedTagIds.length > 0) {
        console.warn(color.yellow(`[character-metadata] ${label}: tag ids with no tag definition, not assigned:\n${imported.undefinedTagIds.map(u => `  ${u.key}: ${u.tagIds.join(', ')}`).join('\n')}`));
    }
    return imported.failedKeys === 0;
}

/**
 * Moves an imported settings key file out of the settings store, to `<file>.migrated`, or to a timestamped name when
 * that is taken. Never overwrites a file, and leaves the file where it is if it no longer holds what was imported.
 * @param {string} filePath
 * @param {string} importedText
 * @returns {boolean} Whether the file is gone from its place.
 */
function moveImportedSettingsFile(filePath, importedText) {
    const current = readSettingsTagsSource(filePath);
    if ('missing' in current) return true;
    if (!('text' in current) || current.text !== importedText) {
        console.warn(color.yellow(`[character-metadata] ${filePath} changed after it was imported; left in place, imported again next boot.`));
        return false;
    }
    const stamp = generateTimestamp();
    for (let attempt = 0; ; attempt++) {
        const target = attempt === 0 ? `${filePath}.migrated` : `${filePath}.migrated-${stamp}${attempt > 1 ? `-${attempt}` : ''}`;
        try {
            fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
        } catch (err) {
            const code = /** @type {any} */ (err)?.code;
            if (code === 'EEXIST') continue;
            if (code === 'ENOENT') return true;
            console.error(`[character-metadata] Imported ${filePath} but could not copy it to ${target}; left in place:`, /** @type {any} */ (err)?.message);
            return false;
        }
        try {
            if (fs.readFileSync(target, 'utf8') !== importedText || fs.readFileSync(filePath, 'utf8') !== importedText) {
                fs.rmSync(target, { force: true });
                console.warn(color.yellow(`[character-metadata] ${filePath} changed after it was imported; left in place, imported again next boot.`));
                return false;
            }
            fs.rmSync(filePath);
        } catch (err) {
            console.error(`[character-metadata] Imported ${filePath} and copied it to ${target}, but could not remove it; left in place:`, /** @type {any} */ (err)?.message);
            return false;
        }
        return true;
    }
}

// Imports settings' `tags` and `tag_map` into the tag store: from a legacy settings.json not yet split, then from
// the key files settings/tags.json + settings/tag_map.json. It reads the files itself: going through the settings
// store would run ensureMigrated(), which the server may be running at the same time. The legacy file is read first
// because ensureMigrated() writes every key file before it deletes it, so a legacy file that is gone means the key
// files are complete. Needs bootstrapIfNeeded() and bootstrapGroupsIfNeeded() done, to classify tag_map keys.
//
// A source (the legacy file, or the two key files together) is imported whole or not at all: one unreadable file
// imports nothing from its source. What already exists is skipped, so a rerun from the start is safe. Imported key
// files leave the settings store (moveImportedSettingsFile()), which reads every key file on every request; the
// legacy file holds every setting and is never touched. The pass is marked done once no source is left; until
// then it runs every boot. restartSettingsTagsImport() clears the mark.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>}
 */
export async function migrateSettingsTagsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const totals = { batches: 0, rowsChanged: 0 };
    if (entry.db.get('SELECT 1 FROM meta WHERE key = @key', { key: SETTINGS_TAGS_MIGRATED_FLAG })) return totals;

    let sourceLeft = false;
    /** @type {{ tagsKey: boolean, unreadable: string[] }} */
    const seedCheck = { tagsKey: false, unreadable: [] };

    const legacyPath = legacySettingsPath(directories);
    const legacy = readSettingsTagsSource(legacyPath);
    if (!('missing' in legacy)) {
        sourceLeft = true;
        const label = `settings tags import (${legacyPath})`;
        if ('error' in legacy) {
            seedCheck.unreadable.push(legacyPath);
            console.error(color.red(`[character-metadata] ${label}: could not read ${legacyPath}, nothing imported from it; retrying next boot: ${legacy.error}`));
        } else if (!legacy.value || typeof legacy.value !== 'object' || Array.isArray(legacy.value)) {
            console.warn(color.yellow(`[character-metadata] ${label}: ${legacyPath} is not an object, nothing imported from it.`));
        } else {
            if (Object.hasOwn(legacy.value, 'tags')) seedCheck.tagsKey = true;
            await importSettingsTagsSource(entry, label, /** @type {object} */ (legacy.value), totals);
        }
    }

    const dir = settingsDirPath(directories);
    const keyFiles = [path.join(dir, 'tags.json'), path.join(dir, 'tag_map.json')].map(filePath => ({ filePath, read: readSettingsTagsSource(filePath) }));
    const present = keyFiles.filter(file => !('missing' in file.read));
    if (!('missing' in keyFiles[0].read)) seedCheck.tagsKey = true;
    if (present.length > 0) {
        const label = `settings tags import (${present.map(file => file.filePath).join(' + ')})`;
        const unreadable = present.filter(file => 'error' in file.read);
        if (unreadable.length > 0) {
            sourceLeft = true;
            seedCheck.unreadable.push(...unreadable.map(file => file.filePath));
            for (const file of unreadable) {
                console.error(color.red(`[character-metadata] ${label}: could not read ${file.filePath}, nothing imported from the key files; retrying next boot: ${/** @type {{ error: string }} */ (file.read).error}`));
            }
        } else {
            /** @type {{ tags?: unknown, tag_map?: unknown }} */
            const source = {};
            const [tagsFile, tagMapFile] = keyFiles;
            if ('value' in tagsFile.read) source.tags = tagsFile.read.value;
            if ('value' in tagMapFile.read) source.tag_map = tagMapFile.read.value;
            if (await importSettingsTagsSource(entry, label, source, totals)) {
                for (const file of present) {
                    if (!moveImportedSettingsFile(file.filePath, /** @type {{ text: string }} */ (file.read).text)) sourceLeft = true;
                }
            } else {
                sourceLeft = true;
                console.warn(color.yellow(`[character-metadata] ${label}: some tag_map keys failed (listed above); the key files are left in place and imported again next boot.`));
            }
        }
    }

    seedDefaultTagsIfPendingSync(entry, seedCheck);

    if (!sourceLeft) {
        setMetaSync(entry.db, SETTINGS_TAGS_MIGRATED_FLAG, String(Date.now()));
        // A restore may have written a source after it was looked for, and cleared the mark before it was set.
        if ([legacyPath, ...keyFiles.map(file => file.filePath)].some(filePath => fs.existsSync(filePath))) {
            entry.db.run('DELETE FROM meta WHERE key = @key', { key: SETTINGS_TAGS_MIGRATED_FLAG });
        }
    }
    if (totals.batches > 0 && !isReadOnlyMode()) entry.db.checkpoint();
    return totals;
}

/**
 * Makes migrateSettingsTagsIfNeeded() read the settings sources again on its next run.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<boolean>} Whether the store was there to mark.
 */
export async function restartSettingsTagsImport(directories) {
    if (isReadOnlyMode()) return false;
    const entry = await getEntry(directories);
    if (!entry) return false;
    entry.db.run('DELETE FROM meta WHERE key = @key', { key: SETTINGS_TAGS_MIGRATED_FLAG });
    return true;
}

const TAG_MAP_IMPORT_BATCH_SIZE = 500;
const TAG_MAP_IMPORT_BATCH_PAUSE_MS = 10;

// Imports a `{[id]: tagId[]}` map into character_tags/group_tags in batches of keys, one transaction each,
// pausing between them. Each key is looked for only in its own type's table (tagEntityTypeOf()); keys not found
// there are returned in `droppedKeys`. A key whose reads or parsing throw is left as it is and listed in a
// warning; a write that throws rolls back its whole batch and fails the import.
/**
 * @param {MetadataDbEntry} entry
 * @param {Record<string, unknown>} tagMap Externally-supplied - each value is runtime-checked as string[] below.
 * @param {object} [options]
 * @param {string} [options.label] Names the import in its warnings.
 * @param {boolean} [options.requireDefinitions] Leaves out, and returns in `undefinedTagIds`, the tag ids (after
 *   merge-target resolution) that have no `tags` row when their batch runs.
 * @param {boolean} [options.writeBuffered] Counts a character still in the batch-import buffer as known, writing its
 *   row to the table first, as assignEntityTag() does.
 * @returns {Promise<{ droppedKeys: string[], undefinedTagIds: { key: string, tagIds: string[] }[], notAssigned: { key: string, tagIds: string[] }[], failed: { key: string, message: string }[], failedKeys: number, batches: number, rowsChanged: number }>}
 *   rowsChanged counts the keys whose assignments or shallow_json changed. notAssigned lists, per known key, the tag
 *   ids deleted with no merge target.
 */
async function importTagMap(entry, tagMap, { label = 'tags.json migration', requireDefinitions = false, writeBuffered = false } = {}) {
    /** @type {string[]} */
    const droppedKeys = [];
    /** @type {{ key: string, tagIds: string[] }[]} */
    const undefinedTagIds = [];
    /** @type {{ key: string, tagIds: string[] }[]} */
    const notAssigned = [];
    /** @type {{ key: string, message: string }[]} */
    const failed = [];
    let failedKeys = 0;
    let batches = 0;
    let rowsChanged = 0;
    const entries = Object.entries(tagMap);

    /**
     * @param {string} key
     * @param {unknown[]} tagIds
     * @returns {() => boolean} The key's writes; true if they changed anything.
     */
    const prepareCharacterKey = (key, tagIds) => {
        const row = /** @type {{ shallow_json: string }} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: key }));
        const shallow = JSON.parse(row.shallow_json);
        return () => {
            let changed = false;
            for (const tagId of tagIds) {
                if (entry.db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@key, @tagId)', { key, tagId }).changes > 0) changed = true;
            }
            const currentTagIds = readCharacterTagIds(entry.db, key);
            // writeShallowJson() stores tag_ids normalized.
            if (Array.isArray(shallow.tag_ids) && JSON.stringify(shallow.tag_ids) === JSON.stringify(normalizeTagIds(currentTagIds))) return changed;
            shallow.tag_ids = currentTagIds;
            writeShallowJson(entry.db, key, shallow, ['tag_ids']);
            return true;
        };
    };

    /**
     * @param {string} key
     * @param {unknown[]} tagIds
     * @returns {() => boolean}
     */
    const prepareGroupKey = (key, tagIds) => () => {
        let changed = false;
        for (const tagId of tagIds) {
            if (entry.db.run('INSERT OR IGNORE INTO group_tags (group_id, tag_id) VALUES (@key, @tagId)', { key, tagId }).changes > 0) changed = true;
        }
        if (tagIds.length > 0 && syncGroupDigestTagIdsFromTable(entry.db, key)) changed = true;
        if (changed) insertGroupChange(entry.db, key);
        return changed;
    };

    for (let i = 0; i < entries.length; i += TAG_MAP_IMPORT_BATCH_SIZE) {
        if (i > 0) await delay(TAG_MAP_IMPORT_BATCH_PAUSE_MS);
        const batch = entries.slice(i, i + TAG_MAP_IMPORT_BATCH_SIZE);
        for (const [key, tagIds] of batch) {
            if (!Array.isArray(tagIds)) warnTagMapEntryNotArray(key, tagIds, 'nothing imported for it');
        }

        /** @type {string[]} */
        let batchDropped = [];
        /** @type {{ key: string, message: string }[]} */
        let batchFailed = [];
        let batchChanged = 0;
        /** @type {Map<string, string[]>} */
        let batchNotAssigned = new Map();
        /** @type {{ key: string, tagIds: string[] }[]} */
        let batchUndefined = [];
        /** @type {{ id: string, row: PendingRow }[]} */
        let batchFlushed = [];
        entry.db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            batchDropped = [];
            batchFailed = [];
            batchChanged = 0;
            batchNotAssigned = new Map();
            batchUndefined = [];
            batchFlushed = [];
            if (writeBuffered) {
                for (const [key, rawTagIds] of batch) {
                    if (!Array.isArray(rawTagIds) || tagEntityTypeOf(key) !== 'character') continue;
                    const row = writeBufferedRowSync(entry, key);
                    if (row) batchFlushed.push({ id: key, row });
                }
            }
            const deletions = readTagDeletionsSync(entry.db);
            /** @type {Set<string> | null} */
            const definedTagIds = requireDefinitions ? new Set() : null;
            if (definedTagIds) {
                /** @type {Set<string>} */
                const wanted = new Set();
                for (const [, rawTagIds] of batch) {
                    if (Array.isArray(rawTagIds)) for (const tagId of resolveTagIdsToAssign(rawTagIds, deletions).tagIds) wanted.add(tagId);
                }
                const ids = [...wanted];
                for (let j = 0; j < ids.length; j += TAG_MAP_IMPORT_BATCH_SIZE) {
                    const chunk = ids.slice(j, j + TAG_MAP_IMPORT_BATCH_SIZE);
                    for (const row of /** @type {Generator<{ id: string }>} */ (entry.db.iterate(`SELECT id FROM tags WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk))) {
                        definedTagIds.add(row.id);
                    }
                }
            }
            const characterKeys = batch.filter(([key]) => tagEntityTypeOf(key) === 'character').map(([key]) => key);
            const groupKeys = batch.filter(([key]) => tagEntityTypeOf(key) === 'group').map(([key]) => key);
            /** @type {Set<string>} */
            const knownCharacterIds = new Set();
            /** @type {Set<string>} */
            const knownGroupIds = new Set();
            if (characterKeys.length > 0) {
                for (const row of /** @type {Generator<{ id: string }>} */ (entry.db.iterate(`SELECT id FROM characters WHERE id IN (${characterKeys.map(() => '?').join(',')})`, characterKeys))) {
                    knownCharacterIds.add(row.id);
                }
            }
            if (groupKeys.length > 0) {
                for (const row of /** @type {Generator<{ id: string }>} */ (entry.db.iterate(`SELECT id FROM groups WHERE id IN (${groupKeys.map(() => '?').join(',')})`, groupKeys))) {
                    knownGroupIds.add(row.id);
                }
            }

            for (const [key, rawTagIds] of batch) {
                if (!Array.isArray(rawTagIds)) continue;
                const type = tagEntityTypeOf(key);
                const resolved = resolveTagIdsToAssign(rawTagIds, deletions);
                const { dropped } = resolved;
                let { tagIds } = resolved;
                const known = (type === 'character' && knownCharacterIds.has(key)) || (type === 'group' && knownGroupIds.has(key));
                if (dropped.length > 0 && known) batchNotAssigned.set(key, dropped);
                if (definedTagIds && known) {
                    const missing = tagIds.filter(tagId => !definedTagIds.has(tagId));
                    if (missing.length > 0) {
                        batchUndefined.push({ key, tagIds: missing });
                        tagIds = tagIds.filter(tagId => definedTagIds.has(tagId));
                    }
                }
                /** @type {(() => boolean) | null} */
                let write;
                if (type === 'character' && knownCharacterIds.has(key)) {
                    if (tagIds.length === 0) continue;
                    try {
                        write = prepareCharacterKey(key, tagIds);
                    } catch (err) {
                        batchFailed.push({ key, message: String(/** @type {any} */ (err)?.message ?? err) });
                        continue;
                    }
                } else if (type === 'group' && knownGroupIds.has(key)) {
                    write = prepareGroupKey(key, tagIds);
                } else {
                    batchDropped.push(key);
                    continue;
                }
                if (write()) batchChanged++;
            }
        });
        batches++;
        rowsChanged += batchChanged;
        droppedKeys.push(...batchDropped);
        undefinedTagIds.push(...batchUndefined);
        for (const { id, row } of batchFlushed) dropFromBuffer(entry, id, row);
        for (const [key, tagIds] of batchNotAssigned) {
            warnDeletedTagsNotAssigned(key, tagIds);
            notAssigned.push({ key, tagIds });
        }
        failed.push(...batchFailed);
        failedKeys += batchFailed.length;
        if (batchFailed.length > 0) {
            console.warn(color.yellow(`[character-metadata] ${label}: ${batchFailed.length} tag_map key(s) failed and were left as they are:\n${batchFailed.map(f => `  ${f.key}: ${f.message}`).join('\n')}`));
        }
        if (batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0) {
            if (!isReadOnlyMode()) entry.db.get('PRAGMA wal_checkpoint(PASSIVE)');
        }
    }

    return { droppedKeys, undefinedTagIds, notAssigned, failed, failedKeys, batches, rowsChanged };
}

/**
 * @typedef {object} TagRestoreDefinitions
 * @property {string[]} createdTagIds
 * @property {string[]} updatedTagIds Stored tags whose definition "Overwrite" changed.
 * @property {string[]} invalidTags As JSON, each entry of the backup's tags that isn't an object with a non-empty
 *   string id and name. Not restored.
 * @property {{ id: string, name: string, existingId: string }[]} keptTags Backup tags not applied under "Keep
 *   Existing": stored tag `existingId` is the same tag, by id or else by name.
 * @property {{ id: string, name: string }[]} namesTaken Overwritten except for the name, which another tag has.
 * @property {{ id: string, name: string }[]} unreadableTags Not overwritten: the stored data isn't a JSON object.
 */

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} nameKey
 * @param {string} exceptId '' for none.
 * @returns {string | null} The first tag by rowid with the name key and no deletion mark, as getTag() takes the
 *   first in its array.
 */
function liveTagIdByNameKeySync(db, nameKey, exceptId) {
    const row = /** @type {{ id: string } | undefined} */ (db.get(
        `SELECT t.id FROM tags t
         WHERE t.name_key = @nameKey AND t.id != @exceptId AND NOT EXISTS (SELECT 1 FROM tag_deletions d WHERE d.tag_id = t.id)
         ORDER BY t.rowid LIMIT 1`,
        { nameKey, exceptId },
    ));
    return row?.id ?? null;
}

/**
 * Brings a backup's tag definitions into `tags`, in batches. A backup tag is the stored tag with its id, else the
 * first live one with its name, and is created when there is neither. An id under a deletion mark can't be reused,
 * so its tag is created under a new id: what a restore gives must not depend on how far finishDeletedTags() has got.
 * `overwrite` writes the backup's fields onto the stored tag as editTagDefinition() does, leaving out a name another
 * live tag has. A created tag gets its order as in importSettingsTagDefinitions(). Needs tagNameKeysReady().
 * @param {MetadataDbEntry} entry
 * @param {unknown[]} tags
 * @param {boolean} overwrite
 * @returns {Promise<{ definitions: TagRestoreDefinitions, actualIds: Map<string, string> }>} actualIds: backup tag
 *   id -> the id its tag has in `tags`, where the two differ.
 */
async function restoreTagDefinitions(entry, tags, overwrite) {
    /** @type {TagRestoreDefinitions} */
    const definitions = { createdTagIds: [], updatedTagIds: [], invalidTags: [], keptTags: [], namesTaken: [], unreadableTags: [] };
    /** @type {Map<string, string>} */
    const actualIds = new Map();
    /** @type {(TagDefinitionInput & { name: string })[]} */
    const ordered = [];
    /** @type {(TagDefinitionInput & { name: string })[]} */
    const orderless = [];
    for (const raw of tags) {
        const tag = /** @type {(TagDefinitionInput & { name: string }) | null} */ (raw);
        if (!tag || typeof tag !== 'object' || Array.isArray(tag) || typeof tag.id !== 'string' || !tag.id || typeof tag.name !== 'string' || !tag.name) {
            definitions.invalidTags.push(String(JSON.stringify(raw)));
            continue;
        }
        (Object.hasOwn(tag, 'sort_order') ? ordered : orderless).push(tag);
    }
    orderless.sort((a, b) => compareNameKeys(tagDefinitionNameKey(a), tagDefinitionNameKey(b)));
    const sequence = [...ordered, ...orderless];

    const emptyBatch = () => ({
        created: /** @type {string[]} */ ([]),
        updated: /** @type {string[]} */ ([]),
        kept: /** @type {TagRestoreDefinitions['keptTags']} */ ([]),
        namesTaken: /** @type {TagRestoreDefinitions['namesTaken']} */ ([]),
        unreadable: /** @type {TagRestoreDefinitions['unreadableTags']} */ ([]),
        actualIds: /** @type {[string, string][]} */ ([]),
    });
    for (let i = 0; i < sequence.length; i += SETTINGS_TAGS_IMPORT_BATCH_SIZE) {
        if (i > 0) await delay(TAG_MAP_IMPORT_BATCH_PAUSE_MS);
        const batch = sequence.slice(i, i + SETTINGS_TAGS_IMPORT_BATCH_SIZE);
        const state = { done: emptyBatch() };
        entry.db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            const done = emptyBatch();
            state.done = done;
            const settled = tagSortOrdersSettledSync(entry.db);
            let next = nextTagSortOrderSync(entry);

            for (const source of batch) {
                const { id, name } = source;
                const nameKey = tagNameKey(name);
                const marked = entry.db.get('SELECT 1 FROM tag_deletions WHERE tag_id = @id', { id }) !== undefined;
                /** @type {string | null} */
                let existingId = null;
                if (!marked && entry.db.get('SELECT 1 FROM tags WHERE id = @id', { id })) existingId = id;
                else if (nameKey) existingId = liveTagIdByNameKeySync(entry.db, nameKey, '');

                if (existingId !== null) {
                    if (existingId !== id) done.actualIds.push([id, existingId]);
                    if (!overwrite) {
                        done.kept.push({ id, name, existingId });
                        continue;
                    }
                    /** @type {Record<string, unknown>} */
                    const patch = { ...source };
                    delete patch.id;
                    if (existingId === id && nameKey) {
                        const stored = /** @type {{ name_key: string }} */ (entry.db.get('SELECT name_key FROM tags WHERE id = @id', { id }));
                        if (stored.name_key !== nameKey && liveTagIdByNameKeySync(entry.db, nameKey, id) !== null) {
                            delete patch.name;
                            done.namesTaken.push({ id, name });
                        }
                    }
                    const outcome = editTagSync(entry, existingId, patch);
                    if (outcome.refused === 'unreadable') done.unreadable.push({ id: existingId, name });
                    else if (outcome.written) done.updated.push(existingId);
                    const patchedOrder = Object.hasOwn(patch, 'sort_order') ? tagDerivedColumns(patch).sortOrder : null;
                    if (next !== null && patchedOrder !== null && patchedOrder >= next) next = patchedOrder + 1;
                    continue;
                }

                const newId = marked ? crypto.randomUUID() : id;
                if (newId !== id) done.actualIds.push([id, newId]);
                const tag = { ...source, id: newId };
                const assignOrder = !Object.hasOwn(tag, 'sort_order');
                if (assignOrder && next !== null) tag.sort_order = next;
                const params = tagRowParams(tag);
                entry.db.run(`INSERT INTO tags ${TAG_ROW_VALUES_SQL}`, params);
                if (next !== null && params.sortOrder !== null && params.sortOrder >= next) next = params.sortOrder + 1;
                if (!assignOrder && !settled) queueTagSortOrderValueSync(entry.db, newId, tag.sort_order);
                done.created.push(newId);
            }
            if (done.created.length > 0) {
                logTagChangesSync(entry, done.created);
            }
        });
        const { done } = state;
        definitions.createdTagIds.push(...done.created);
        definitions.updatedTagIds.push(...done.updated);
        definitions.keptTags.push(...done.kept);
        definitions.namesTaken.push(...done.namesTaken);
        definitions.unreadableTags.push(...done.unreadable);
        for (const [backupId, actualId] of done.actualIds) actualIds.set(backupId, actualId);
    }
    return { definitions, actualIds };
}

/**
 * @typedef {object} TagRestoreAssignments
 * @property {{ key: string, value: string }[]} invalidKeys tag_map keys whose value isn't a list, with it as JSON.
 * @property {string[]} missingKeys Neither a character nor a group.
 * @property {{ key: string, tagIds: unknown[] }[]} undefinedTagIds Per known key, the listed ids no tag has.
 * @property {{ key: string, tagIds: string[] }[]} deletedTagIds Per known key, the listed ids of tags deleted with
 *   no merge target that the backup has no definition for.
 * @property {{ key: string, message: string }[]} failedKeys Keys whose stored data couldn't be read.
 */

/**
 * Restores a tag backup: its definitions first (restoreTagDefinitions()), then its assignments, so no assignment
 * names a tag that isn't there. Assignments are added to what each character or group already has; none is removed,
 * and a key that already has every tag listed for it isn't written. Everything not restored is in the result.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ tags: unknown[], tagMap: Record<string, unknown>, overwrite: boolean }} backup
 * @returns {Promise<(TagRestoreDefinitions & TagRestoreAssignments) | 'names-not-ready' | null>} 'names-not-ready',
 *   with nothing written, until fillTagNameKeysIfNeeded() has run: a backup tag can't be matched by name before.
 */
export async function restoreTagBackup(directories, { tags, tagMap, overwrite }) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    if (!tagNameKeysReady(entry)) return 'names-not-ready';

    const { definitions, actualIds } = await restoreTagDefinitions(entry, tags, overwrite);

    /** @type {TagRestoreAssignments['invalidKeys']} */
    const invalidKeys = [];
    /** @type {Record<string, string[]>} */
    const toAssign = {};
    /** @type {Map<string, unknown[]>} */
    const notTagIds = new Map();
    for (const [key, value] of Object.entries(tagMap)) {
        if (!Array.isArray(value)) {
            invalidKeys.push({ key, value: String(JSON.stringify(value)) });
            continue;
        }
        /** @type {string[]} */
        const tagIds = [];
        /** @type {unknown[]} */
        const others = [];
        for (const tagId of value) {
            if (typeof tagId === 'string' && tagId !== '') tagIds.push(actualIds.get(tagId) ?? tagId);
            else others.push(tagId);
        }
        if (others.length > 0) notTagIds.set(key, others);
        if (tagIds.length > 0 || others.length > 0) toAssign[key] = tagIds;
    }

    const imported = await importTagMap(entry, toAssign, { label: 'tag backup restore', requireDefinitions: true, writeBuffered: true });
    const missing = new Set(imported.droppedKeys);
    /** @type {Map<string, unknown[]>} */
    const undefinedByKey = new Map(imported.undefinedTagIds.map(u => [u.key, /** @type {unknown[]} */ (u.tagIds)]));
    for (const [key, others] of notTagIds) {
        if (!missing.has(key)) undefinedByKey.set(key, [...(undefinedByKey.get(key) ?? []), ...others]);
    }
    return {
        ...definitions,
        invalidKeys,
        missingKeys: imported.droppedKeys,
        undefinedTagIds: [...undefinedByKey].map(([key, tagIds]) => ({ key, tagIds })),
        deletedTagIds: imported.notAssigned,
        failedKeys: imported.failed,
    };
}

// A card's own `data.tags` array is user-authored free text, not a curated tag set - ROOT/TAVERN are structural
// markers some card sources embed that were never meant to become a visible tag, and 50 is a sanity cap against
// a malformed or abusive card claiming hundreds of "tags" and bloating the tags table on backfill.
const CARD_TAGS_EXCLUDED = new Set(['ROOT', 'TAVERN']);
const CARD_TAGS_MAX_PER_CARD = 50;

/**
 * @param {unknown} tag A tag definition as stored in tags.data.
 * @returns {string} tagNameKey() of its name; '' when it has none, which no card tag name has.
 */
function tagDefinitionNameKey(tag) {
    const name = /** @type {{ name?: unknown } | null | undefined} */ (tag)?.name;
    return typeof name === 'string' ? tagNameKey(name) : '';
}

/**
 * Whether every tags row has its name_key and its index exists, so a name_key lookup finds every tag that has the
 * name. Once true it stays true: every write to tags sets name_key.
 * @param {MetadataDbEntry} entry
 * @returns {boolean}
 */
function tagNameKeysReady(entry) {
    if (entry.tagNameKeysReady === true) return true;
    if (!entry.db.get('SELECT 1 FROM sqlite_master WHERE type = \'index\' AND name = \'tags_name_key\'')) return false;
    if (entry.db.get('SELECT 1 FROM tags WHERE name_key IS NULL LIMIT 1')) return false;
    entry.tagNameKeysReady = true;
    return true;
}

/**
 * @param {unknown[]} cardTags
 * @returns {string[]}
 */
function cardTagNames(cardTags) {
    return cardTags
        .filter(t => typeof t === 'string')
        .map(t => t.trim())
        .filter(t => t.length > 0 && !CARD_TAGS_EXCLUDED.has(t))
        .slice(0, CARD_TAGS_MAX_PER_CARD);
}

/**
 * @typedef {object} ResolvedCardTags
 * @property {string[]} tagIds
 * @property {string[]} toCreate Names no tag matches, for createCardTagsSync().
 * @property {string[]} held Names that can't be resolved while name keys are unfilled.
 * @property {{ key: string, id: string, data: string }[]} learned The definition of each tag read or created.
 */

/**
 * Resolves card tag names to tag ids inside the caller's write transaction, writing nothing. A name matches a tag
 * whose name_key is its tagNameKey(), the first by rowid when several do (upstream's getTag() takes the first in
 * its tags array, which is creation order). While name keys are unfilled every name is held; after, a name no tag
 * matches is to be created.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string[]} names From cardTagNames().
 * @param {object} options
 * @param {boolean} options.ready tagNameKeysReady(), read inside the same transaction.
 * @param {boolean} [options.onlyExisting] Never marks a name to be created.
 * @returns {ResolvedCardTags}
 */
function resolveCardTagNamesSync(db, names, { ready, onlyExisting = false }) {
    /** @type {ResolvedCardTags} */
    const resolved = { tagIds: [], toCreate: [], held: [], learned: [] };
    /** @type {Set<string>} */
    const seen = new Set();
    for (const name of names) {
        const key = tagNameKey(name);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!ready) {
            resolved.held.push(name);
            continue;
        }
        // A marked tag with a merge target stands for that target; one with none matches nothing.
        const row = /** @type {{ id: string, data: string, merge_into: string | null } | undefined} */ (db.get(
            `SELECT t.id, t.data, d.merge_into FROM tags t LEFT JOIN tag_deletions d ON d.tag_id = t.id
             WHERE t.name_key = @key AND (d.tag_id IS NULL OR d.merge_into IS NOT NULL) ORDER BY t.rowid LIMIT 1`,
            { key },
        ));
        const target = typeof row?.merge_into === 'string'
            ? /** @type {{ id: string, data: string } | undefined} */ (db.get('SELECT id, data FROM tags WHERE id = @id', { id: row.merge_into }))
            : row;
        if (row) {
            resolved.tagIds.push(row.merge_into ?? row.id);
            if (target) resolved.learned.push({ key, id: target.id, data: target.data });
        } else if (!onlyExisting) {
            resolved.toCreate.push(name);
        }
    }
    return resolved;
}

/**
 * Creates a tag for each of resolved.toCreate, adding it to resolved.tagIds and resolved.learned. Each gets the
 * sort_order upstream's importTags() -> createNewTag() gives it, one after another: max+1 (nextTagSortOrderSync()), or
 * none while that has no answer.
 * @param {MetadataDbEntry} entry
 * @param {ResolvedCardTags} resolved
 * @returns {string[]} The new tags' ids.
 */
function createCardTagsSync(entry, resolved) {
    const { db } = entry;
    // Each tag inserted is the new max, so the next one's max+1 is one more.
    let sortOrder = resolved.toCreate.length > 0 ? nextTagSortOrderSync(entry) : null;
    const created = resolved.toCreate.map((name) => {
        const id = crypto.randomUUID();
        const params = tagRowParams(sortOrder === null ? { id, name, create_date: Date.now() } : { id, name, create_date: Date.now(), sort_order: sortOrder++ });
        db.run(`INSERT INTO tags ${TAG_ROW_VALUES_SQL}`, params);
        resolved.learned.push({ key: params.nameKey, id, data: params.data });
        return id;
    });
    if (created.length > 0) {
        logTagChangesSync(entry, created);
    }
    resolved.tagIds.push(...created);
    resolved.toCreate = [];
    return created;
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} avatar
 * @param {string[]} names
 * @param {boolean} onlyExisting
 */
function holdCardTagNamesSync(db, avatar, names, onlyExisting) {
    for (const name of names) {
        db.run('INSERT OR IGNORE INTO tag_names_held (character_id, name, only_existing) VALUES (@characterId, @name, @onlyExisting)', { characterId: avatar, name, onlyExisting: onlyExisting ? 1 : 0 });
    }
}

/**
 * Creates resolved's new tags, assigns every resolved tag to a characters row and holds its unresolved names.
 * Leaves shallow_json.tag_ids to the caller (syncShallowTagIdsFromTable()).
 * @param {MetadataDbEntry} entry
 * @param {string} avatar
 * @param {ResolvedCardTags} resolved
 * @param {boolean} onlyExisting
 * @returns {number} How many tags it created.
 */
function writeResolvedCardTagsSync(entry, avatar, resolved, onlyExisting) {
    const { db } = entry;
    const created = createCardTagsSync(entry, resolved).length;
    for (const tagId of resolved.tagIds) {
        db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@characterId, @tagId)', { characterId: avatar, tagId });
    }
    holdCardTagNamesSync(db, avatar, resolved.held, onlyExisting);
    return created;
}

// Patches one character row's shallow_json.tag_ids to match character_tags. Re-reads
// character_tags rather than trusting a caller's resolved list, so other pre-existing assignments survive.
/**
 * @returns {boolean} Whether the row was found.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} avatar
 */
function syncShallowTagIdsFromTable(db, avatar) {
    const row = (/** @type {{ shallow_json: string } | undefined} */ (db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: avatar })));
    if (!row) return false;
    /** @type {string[]} */
    const currentTagIds = [];
    for (const r of /** @type {Generator<{ tag_id: string }>} */ (db.iterate('SELECT tag_id FROM character_tags WHERE character_id = @id', { id: avatar }))) {
        currentTagIds.push(r.tag_id);
    }
    const shallow = JSON.parse(row.shallow_json);
    // writeShallowJson() stores tag_ids normalized.
    if (Array.isArray(shallow.tag_ids) && JSON.stringify(shallow.tag_ids) === JSON.stringify(normalizeTagIds(currentTagIds))) return true;
    shallow.tag_ids = currentTagIds;
    writeShallowJson(db, avatar, shallow, ['tag_ids']);
    return true;
}

// Group counterpart to syncShallowTagIdsFromTable(): a group's stored copy of its tags is digest_tag_ids.
/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} groupId
 * @returns {boolean} Whether it wrote.
 */
function syncGroupDigestTagIdsFromTable(db, groupId) {
    const row = /** @type {{ digest_tag_ids: number | null } | undefined} */ (db.get('SELECT digest_tag_ids FROM groups WHERE id = @id', { id: groupId }));
    if (!row) return false;
    const digestTagIds = groupDigestTagIdsFromTable(db, groupId);
    if (groupDigestTagIdsMatch(row.digest_tag_ids, digestTagIds)) return false;
    db.run('UPDATE groups SET digest_tag_ids = @digestTagIds WHERE id = @id', { id: groupId, digestTagIds });
    return true;
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} groupId
 * @param {number} digestTagIds
 * @returns {boolean} Whether the group's row existed and held a different value.
 */
function setGroupDigestTagIdsSync(db, groupId, digestTagIds) {
    return writeRowIfChanged(db, 'groups', { id: groupId }, { digest_tag_ids: digestTagIds });
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} groupId
 * @returns {number} The digest_tag_ids the group's group_tags rows give.
 */
function groupDigestTagIdsFromTable(db, groupId) {
    /** @type {string[]} */
    const tagIds = [];
    for (const r of /** @type {Generator<{ tag_id: string }>} */ (db.iterate('SELECT tag_id FROM group_tags WHERE group_id = @id ORDER BY tag_id', { id: groupId }))) {
        tagIds.push(r.tag_id);
    }
    return groupDigestTagIdsHash({ tag_ids: tagIds });
}

/**
 * @param {number | bigint | null} stored
 * @param {number} digestTagIds
 */
function groupDigestTagIdsMatch(stored, digestTagIds) {
    return stored !== null && Number(stored) === digestTagIds;
}

// Accepts either shape a card may carry tags in: { data: { tags: [...] } } or a bare { tags: [...] }.
// Returns [] (never null/undefined) so callers can iterate unconditionally.
/**
 * @param {string} shallowJson
 * @returns {unknown[]}
 */
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
// needed). Gated by its own meta flag; resumes after the last batch it committed.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>}
 */
export async function backfillCardTagsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = (/** @type {{ value: string } | undefined} */ (entry.db.get('SELECT value FROM meta WHERE key = \'card_tags_backfill_completed\'')));
    if (already) return { batches: 0, rowsChanged: 0 };

    console.log(color.cyan('[character-metadata] Backfilling tag assignments from card-embedded tags...'));

    let ready = false;
    let batchNewDefinitions = 0;
    let batchNewAssignments = 0;
    let newDefinitions = 0;
    let newAssignments = 0;

    const result = await runResumableCharacterPass(entry.db, {
        doneKey: 'card_tags_backfill_completed',
        doneValue: '1',
        progressKey: 'card_tags_backfill_progress',
        label: 'Card-tags backfill',
        logProgress: true,
        onBatchStart: () => {
            ready = tagNameKeysReady(entry);
            batchNewDefinitions = 0;
            batchNewAssignments = 0;
        },
        onBatchCommitted: () => {
            newDefinitions += batchNewDefinitions;
            newAssignments += batchNewAssignments;
        },
        prepareRow: (id) => {
            const row = (/** @type {{ shallow_json: string } | undefined} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id })));
            if (!row) return null;
            const names = cardTagNames(extractCardTags(row.shallow_json));
            if (names.length === 0) return null;

            const resolved = resolveCardTagNamesSync(entry.db, names, { ready });
            const shallow = JSON.parse(row.shallow_json);
            const currentTagIds = readCharacterTagIds(entry.db, id);
            const current = new Set(currentTagIds);
            const missing = resolved.tagIds.filter(tagId => !current.has(tagId));
            // writeShallowJson() stores tag_ids normalized.
            const inSync = (/** @type {string[]} */ tagIds) => Array.isArray(shallow.tag_ids) && JSON.stringify(shallow.tag_ids) === JSON.stringify(normalizeTagIds(tagIds));
            if (missing.length === 0 && resolved.toCreate.length === 0 && resolved.held.length === 0 && inSync(currentTagIds)) return null;

            return () => {
                const created = createCardTagsSync(entry, resolved);
                batchNewDefinitions += created.length;
                for (const tagId of [...missing, ...created]) {
                    batchNewAssignments += entry.db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@characterId, @tagId)', { characterId: id, tagId }).changes;
                }
                holdCardTagNamesSync(entry.db, id, resolved.held, false);
                // Synced here rather than left to backfillTagIdsInShallowJson(), which only targets rows missing a
                // tag_ids key and would skip a row that already had one.
                const finalTagIds = [...currentTagIds, ...missing, ...created];
                if (!inSync(finalTagIds)) {
                    shallow.tag_ids = finalTagIds;
                    writeShallowJson(entry.db, id, shallow, ['tag_ids']);
                }
            };
        },
    });

    console.log(color.cyan(`[character-metadata] Card-tags backfill: ${newDefinitions} new tag definitions, ${newAssignments} new assignments.`));
    return result;
}

const TAG_NAME_KEY_FILL_BATCH_SIZE = 1000;
const HELD_TAG_NAMES_BATCH_SIZE = 500;

/**
 * One-time pass: builds name_key's index, fills name_key on every tags row that lacks it, then resolves and assigns
 * every held card tag name (tag_names_held). A name is held only while some row lacks its key, and the fill's last
 * batch commits before the first held name is read here, so no name is held after this pass has drained them.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>}
 */
export async function fillTagNameKeysIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    entry.db.run('CREATE INDEX IF NOT EXISTS tags_name_key ON tags(name_key)');

    let batches = 0;
    let rowsChanged = 0;
    for (;;) {
        let filled = 0;
        entry.db.transaction(() => {
            filled = 0;
            const rows = /** @type {{ id: string, data: string }[]} */ ([...entry.db.iterate('SELECT id, data FROM tags WHERE name_key IS NULL LIMIT @limit', { limit: TAG_NAME_KEY_FILL_BATCH_SIZE })]);
            for (const { id, data } of rows) {
                let tag = null;
                try {
                    tag = JSON.parse(data);
                } catch {
                    // Unparseable: it has no name to match, so it gets the key no card tag name has.
                }
                writeRowIfChanged(entry.db, 'tags', { id }, { name_key: tagDefinitionNameKey(tag) });
                filled++;
            }
        });
        if (filled === 0) break;
        batches++;
        rowsChanged += filled;
        await delay(MIGRATION_BATCH_PAUSE_MS);
    }

    for (;;) {
        /** @type {{ character_id: string, name: string }[]} */
        let dropped = [];
        let drained = 0;
        entry.db.transaction(() => {
            dropped = [];
            drained = 0;
            const held = /** @type {{ character_id: string, name: string, only_existing: number }[]} */ ([...entry.db.iterate('SELECT character_id, name, only_existing FROM tag_names_held ORDER BY character_id, name LIMIT @limit', { limit: HELD_TAG_NAMES_BATCH_SIZE })]);
            /** @type {Set<string>} */
            const assignedTo = new Set();
            for (const { character_id: characterId, name, only_existing: onlyExisting } of held) {
                entry.db.run('DELETE FROM tag_names_held WHERE character_id = @characterId AND name = @name', { characterId, name });
                drained++;
                if (!entry.db.get('SELECT 1 FROM characters WHERE id = @id', { id: characterId })) {
                    dropped.push({ character_id: characterId, name });
                    continue;
                }
                const resolved = resolveCardTagNamesSync(entry.db, [name], { ready: true, onlyExisting: !!onlyExisting });
                writeResolvedCardTagsSync(entry, characterId, resolved, !!onlyExisting);
                if (resolved.tagIds.length > 0) assignedTo.add(characterId);
            }
            for (const characterId of assignedTo) {
                syncShallowTagIdsFromTable(entry.db, characterId);
            }
        });
        if (dropped.length > 0) {
            console.warn(color.yellow(`[character-metadata] Held card tag names whose character no longer exists, not assigned:\n${dropped.map(d => `  ${d.character_id}: ${d.name}`).join('\n')}`));
        }
        if (drained === 0) break;
        batches++;
        rowsChanged += drained;
        await delay(MIGRATION_BATCH_PAUSE_MS);
    }

    return { batches, rowsChanged };
}

export const TAG_DERIVED_COLUMNS_FILLED_FLAG = 'tag_derived_columns_filled_v1';
// The rowid of the last tags row the fill has passed. Every row with rowid <= it has its derived columns: a row
// keeps its rowid, and every tags write sets the columns (TAG_ROW_VALUES_SQL), whatever rowid it lands on.
const TAG_DERIVED_COLUMNS_FILL_UPTO_KEY = `${TAG_DERIVED_COLUMNS_FILLED_FLAG}_upto`;
const TAG_DERIVED_COLUMNS_FILL_BATCH_SIZE = 1000;

// The indexes tag pages are read through by keyset, besides tags_name_key. tags is a rowid table, so each one ends
// in rowid without naming it (SQLite rejects naming it): ON tags(sort_order) is (sort_order, rowid).
const TAG_QUERY_INDEXES_SQL = `
    CREATE INDEX IF NOT EXISTS tags_sort_order ON tags(sort_order);
    CREATE INDEX IF NOT EXISTS tags_unordered_name_key ON tags(name_key) WHERE sort_order IS NULL;
    CREATE INDEX IF NOT EXISTS tags_usage_count ON tags(usage_count DESC, name_key);
    CREATE INDEX IF NOT EXISTS tags_folder_usage_count ON tags(is_folder, usage_count DESC, name_key);
    CREATE INDEX IF NOT EXISTS tags_folder_sort_order ON tags(is_folder, sort_order);
    CREATE INDEX IF NOT EXISTS tags_folder_unordered_name_key ON tags(is_folder, name_key) WHERE sort_order IS NULL;
    CREATE INDEX IF NOT EXISTS tags_folder_name_key ON tags(is_folder, name_key);
    CREATE INDEX IF NOT EXISTS tags_used_sort_order ON tags(sort_order) WHERE usage_count > 0;
    CREATE INDEX IF NOT EXISTS tags_used_unordered_name_key ON tags(name_key) WHERE sort_order IS NULL AND usage_count > 0;
    CREATE INDEX IF NOT EXISTS tags_used_name_key ON tags(name_key) WHERE usage_count > 0;
`;

/**
 * One-time pass: builds TAG_QUERY_INDEXES_SQL, then sets sort_order, folder_type and is_folder (tagDerivedColumns()
 * of data) and usage_count (the id's tag_usage.count, 0 without a row) on every tags row past the frontier, and
 * marks the fill done once no row is left past it.
 *
 * Each page is read to the end and written in one transaction, so a live write to a row can't be overwritten with
 * columns derived from its old data. A restart resumes from the frontier. Each tag whose sort_order is present but
 * has no order (a non-numeric string, NaN or an object) is logged once, with its raw value.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>} `batches` counts the transactions that moved the frontier or
 *   marked the fill done; `rowsChanged` the rows whose columns were written.
 */
export async function fillTagDerivedColumnsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const { db } = entry;
    // Every run, so a store filled before an index was added gets it here, in the worker.
    db.exec(TAG_QUERY_INDEXES_SQL);
    if (db.get('SELECT 1 FROM meta WHERE key = @key', { key: TAG_DERIVED_COLUMNS_FILLED_FLAG })) return { batches: 0, rowsChanged: 0 };

    const saved = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: TAG_DERIVED_COLUMNS_FILL_UPTO_KEY }));
    /** @type {number | null} */
    let after = saved ? Number(saved.value) : null;

    let batches = 0;
    let rowsChanged = 0;
    for (;;) {
        /** @type {{ changed: number, unordered: string[], last: number | null, done: boolean }} */
        const state = { changed: 0, unordered: [], last: after, done: false };
        db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            state.changed = 0;
            state.unordered = [];
            state.last = after;
            state.done = false;
            const page = /** @type {{ rowid: number, id: string, data: string }[]} */ ([...(after === null
                ? db.iterate('SELECT rowid, id, data FROM tags ORDER BY rowid LIMIT @limit', { limit: TAG_DERIVED_COLUMNS_FILL_BATCH_SIZE })
                : db.iterate('SELECT rowid, id, data FROM tags WHERE rowid > @after ORDER BY rowid LIMIT @limit', { after, limit: TAG_DERIVED_COLUMNS_FILL_BATCH_SIZE }))]);
            for (const { rowid, id, data } of page) {
                /** @type {unknown} */
                let tag = null;
                try {
                    tag = JSON.parse(data);
                } catch {
                    // Unparseable: derived as data with no fields, as name_key's fill does.
                }
                const { sortOrder, folderType, isFolder } = tagDerivedColumns(tag);
                const rawOrder = tag !== null && typeof tag === 'object' ? /** @type {Record<string, unknown>} */ (tag).sort_order : undefined;
                if (rawOrder !== undefined && sortOrder === null) {
                    const name = /** @type {Record<string, unknown>} */ (tag).name;
                    state.unordered.push(`  ${id} (${typeof name === 'string' ? name : JSON.stringify(name)}): ${JSON.stringify(rawOrder)}`);
                }
                const usage = /** @type {{ count: number } | undefined} */ (db.get('SELECT count FROM tag_usage WHERE tag_id = @id', { id }));
                if (writeRowIfChanged(db, 'tags', { rowid }, {
                    sort_order: sortOrder, folder_type: folderType, is_folder: isFolder, usage_count: usage?.count ?? 0,
                })) state.changed++;
            }
            if (page.length > 0) {
                state.last = page[page.length - 1].rowid;
                setMetaSync(db, TAG_DERIVED_COLUMNS_FILL_UPTO_KEY, String(state.last));
            }
            if (page.length < TAG_DERIVED_COLUMNS_FILL_BATCH_SIZE) {
                setMetaSync(db, TAG_DERIVED_COLUMNS_FILLED_FLAG, String(Date.now()));
                db.run('DELETE FROM meta WHERE key = @key', { key: TAG_DERIVED_COLUMNS_FILL_UPTO_KEY });
                state.done = true;
            }
        });
        batches++;
        rowsChanged += state.changed;
        if (state.unordered.length > 0) {
            console.warn(color.yellow(`[character-metadata] Tag derived columns fill: ${state.unordered.length} tag(s) whose sort_order is non-numeric, NaN or an object, so it has no sort_order and sorts alphabetically with the tags that have none:\n${state.unordered.join('\n')}`));
        }
        if (batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0 && !isReadOnlyMode()) db.get('PRAGMA wal_checkpoint(PASSIVE)');
        if (state.done) break;
        after = state.last;
        await delay(MIGRATION_BATCH_PAUSE_MS);
    }

    if (!isReadOnlyMode()) db.checkpoint();
    return { batches, rowsChanged };
}

/**
 * Whether every tags row has name_key and the derived columns, and their indexes exist, so tags can be paged
 * through them. Once true it stays true: every tags write sets all of those columns.
 * @param {MetadataDbEntry} entry
 * @returns {boolean}
 */
function tagQueryColumnsReady(entry) {
    if (entry.tagQueryColumnsReady === true) return true;
    if (!entry.db.get('SELECT 1 FROM meta WHERE key = @key', { key: TAG_DERIVED_COLUMNS_FILLED_FLAG })) return false;
    if (!tagNameKeysReady(entry)) return false;
    entry.tagQueryColumnsReady = true;
    return true;
}

/**
 * Whether the tags_folder_usage_count index exists. A store filled before it was added gets it from the next
 * fillTagDerivedColumnsIfNeeded() run; until then a most-used walk of folders checks is_folder per row.
 * @param {MetadataDbEntry} entry
 * @returns {boolean}
 */
function tagFolderUsageIndexReady(entry) {
    if (entry.tagFolderUsageIndex === true) return true;
    if (!entry.db.get('SELECT 1 FROM sqlite_master WHERE type = \'index\' AND name = \'tags_folder_usage_count\'')) return false;
    entry.tagFolderUsageIndex = true;
    return true;
}

/**
 * tagQueryColumnsReady() for the store.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<boolean>}
 */
export async function areTagQueryColumnsReady(directories) {
    const entry = await getEntry(directories);
    return !!entry && tagQueryColumnsReady(entry);
}

export const TAG_SORT_ORDERS_FILLED_FLAG = 'tag_sort_orders_filled_v1';
// JSON of the pass's place: { phase: 'unordered', k, r }, the (name_key, rowid) of the last tag without a
// sort_order it passed, or { phase: 'ties', s }, the sort_order up to which (s included) it has spread every tie.
const TAG_SORT_ORDERS_FILL_AT_KEY = `${TAG_SORT_ORDERS_FILLED_FLAG}_at`;
const TAG_SORT_ORDERS_FILL_BATCH_SIZE = 1000;

/**
 * @param {string} data A tags row's data.
 * @returns {Record<string, unknown> | null} The tag, or null when data isn't a JSON object, so a sort_order written
 *   into it would be lost or would lose it.
 */
function parseTagObject(data) {
    try {
        const tag = JSON.parse(data);
        return tag !== null && typeof tag === 'object' && !Array.isArray(tag) ? tag : null;
    } catch {
        return null;
    }
}

/**
 * Sets a tag's sort_order in data and in the column derived from it.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {number} rowid
 * @param {Record<string, unknown>} tag Parsed from the row's data.
 * @param {unknown} sortOrder A JSON value; the column gets it coerced (tagDerivedColumns()).
 */
function writeTagSortOrderSync(db, rowid, tag, sortOrder) {
    tag.sort_order = sortOrder;
    writeRowIfChanged(db, 'tags', { rowid }, { data: JSON.stringify(tag), sort_order: tagDerivedColumns(tag).sortOrder });
}

/**
 * `count` distinct finite values after `base`, rising in steps of 1, or of the smallest power of two that still
 * moves `base` once 1 doesn't.
 * @param {number} base
 * @param {number} count
 * @returns {number[]} Shorter than `count` where the values would stop being finite; empty for a non-finite `base`,
 *   which no step moves.
 */
function valuesAfter(base, count) {
    if (!Number.isFinite(base)) return [];
    let step = 1;
    while (base + step === base) step *= 2;
    /** @type {number[]} */
    const values = [];
    for (let i = 1; i <= count; i++) {
        const value = base + step * i;
        if (!Number.isFinite(value)) break;
        values.push(value);
    }
    return values;
}

/**
 * valuesAfter()'s mirror: `count` distinct finite values before `base`, ascending.
 * @param {number} base
 * @param {number} count
 * @returns {number[]} Shorter than `count` where the values would stop being finite, dropping the farthest from
 *   `base`; empty for a non-finite `base`.
 */
function valuesBefore(base, count) {
    if (!Number.isFinite(base)) return [];
    let step = 1;
    while (base - step === base) step *= 2;
    /** @type {number[]} */
    const values = [];
    for (let i = 1; i <= count; i++) {
        const value = base - step * i;
        if (!Number.isFinite(value)) break;
        values.push(value);
    }
    return values.reverse();
}

/**
 * Values for ranks 1..count-1 of `count` tags tied at `value`, spread evenly up to `next` (the next sort_order
 * above them; null when none is), rank 0 keeping `value`.
 * @param {number} value
 * @param {number | null} next
 * @param {number} count
 * @returns {number[] | null} null when there's no room for distinct values.
 */
function spreadTiedValues(value, next, count) {
    /** @type {number[]} */
    let values;
    if (next === null) {
        values = valuesAfter(value, count - 1);
        if (values.length < count - 1) return null;
    } else {
        values = [];
        for (let i = 1; i < count; i++) values.push(value + (next - value) * (i / count));
    }
    let previous = value;
    for (const v of values) {
        if (!Number.isFinite(v) || v <= previous) return null;
        previous = v;
    }
    return next !== null && previous >= next ? null : values;
}

/**
 * @param {string} id
 * @param {Record<string, unknown> | null} tag
 */
function tagWarningLabel(id, tag) {
    const name = tag?.name;
    return `${id} (${typeof name === 'string' ? name : JSON.stringify(name)})`;
}

/**
 * Logs every tag tied at `value`, which the pass leaves tied.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {number} value
 */
async function warnTagsLeftTied(db, value) {
    /** @type {number | null} */
    let after = null;
    for (;;) {
        const page = /** @type {{ rowid: number, id: string, data: string }[]} */ ([...(after === null
            ? db.iterate('SELECT rowid, id, data FROM tags WHERE sort_order = @value ORDER BY rowid LIMIT @limit', { value, limit: TAG_SORT_ORDERS_FILL_BATCH_SIZE })
            : db.iterate('SELECT rowid, id, data FROM tags WHERE sort_order = @value AND rowid > @after ORDER BY rowid LIMIT @limit', { value, after, limit: TAG_SORT_ORDERS_FILL_BATCH_SIZE }))]);
        if (page.length === 0) return;
        console.warn(color.yellow(`[character-metadata] Tag sort_order fill: ${page.length} tag(s) left tied at sort_order ${value}: there is no room for distinct values between it and the next one. They keep their order (insertion order):\n${page.map(row => `  ${tagWarningLabel(row.id, parseTagObject(row.data))}`).join('\n')}`));
        after = page[page.length - 1].rowid;
        if (page.length < TAG_SORT_ORDERS_FILL_BATCH_SIZE) return;
        await delay(MIGRATION_BATCH_PAUSE_MS);
    }
}

/**
 * Spreads the tags tied at `value` when there are more than a batch of them: counts them in bounded reads, then
 * writes them from the highest rowid down, so at every commit the tags still tied sit below the ones already
 * spread, in the same order. Each batch reads the next value above `value` live and spreads the rest below it,
 * so a tag written there meanwhile keeps its place. Tags a stale count leaves tied are found again by the walk.
 * @param {MetadataDbEntry} entry
 * @param {number} value
 * @param {{ batches: number, rowsChanged: number }} totals Added to.
 * @returns {Promise<'spread' | 'no-room'>}
 */
async function spreadLargeTie(entry, value, totals) {
    const { db } = entry;
    let remaining = 0;
    /** @type {number | null} */
    let after = null;
    for (;;) {
        const page = /** @type {number[]} */ ([...(after === null
            ? db.iterate('SELECT rowid FROM tags WHERE sort_order = @value ORDER BY rowid LIMIT @limit', { value, limit: TAG_SORT_ORDERS_FILL_BATCH_SIZE })
            : db.iterate('SELECT rowid FROM tags WHERE sort_order = @value AND rowid > @after ORDER BY rowid LIMIT @limit', { value, after, limit: TAG_SORT_ORDERS_FILL_BATCH_SIZE }))]
            .map(row => /** @type {{ rowid: number }} */ (row).rowid));
        remaining += page.length;
        if (page.length < TAG_SORT_ORDERS_FILL_BATCH_SIZE) break;
        after = page[page.length - 1];
        await delay(MIGRATION_BATCH_PAUSE_MS);
    }

    /** @type {number | null} */
    let below = null;
    for (;;) {
        /** @type {{ written: number, last: number | null, finished: boolean, noRoom: boolean }} */
        const state = { written: 0, last: below, finished: false, noRoom: false };
        db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            state.written = 0;
            state.last = below;
            state.finished = false;
            state.noRoom = false;
            const nextRow = /** @type {{ next: number | null }} */ (db.get('SELECT MIN(sort_order) AS next FROM tags WHERE sort_order > @value', { value }));
            const page = /** @type {{ rowid: number, id: string, data: string }[]} */ ([...(below === null
                ? db.iterate('SELECT rowid, id, data FROM tags WHERE sort_order = @value ORDER BY rowid DESC LIMIT @limit', { value, limit: TAG_SORT_ORDERS_FILL_BATCH_SIZE })
                : db.iterate('SELECT rowid, id, data FROM tags WHERE sort_order = @value AND rowid < @below ORDER BY rowid DESC LIMIT @limit', { value, below, limit: TAG_SORT_ORDERS_FILL_BATCH_SIZE }))]);
            const values = spreadTiedValues(value, nextRow.next, remaining);
            if (!values) {
                state.noRoom = true;
                return;
            }
            for (const row of page) {
                const rank = remaining - 1 - state.written;
                if (rank < 1) break;
                // Stored data under a sort_order is always an object: tagDerivedColumns() gives any other NULL.
                writeTagSortOrderSync(db, row.rowid, /** @type {Record<string, unknown>} */ (parseTagObject(row.data)), values[rank - 1]);
                state.written++;
                state.last = row.rowid;
            }
            if (state.written > 0) {
                logTagChangesSync(entry, null);
            }
            state.finished = page.length < TAG_SORT_ORDERS_FILL_BATCH_SIZE || state.written < page.length;
        });
        if (state.noRoom) {
            await warnTagsLeftTied(db, value);
            return 'no-room';
        }
        totals.batches++;
        totals.rowsChanged += state.written;
        remaining -= state.written;
        below = state.last;
        if (state.finished) return 'spread';
        await delay(MIGRATION_BATCH_PAUSE_MS);
    }
}

/**
 * One-time pass giving every tag a sort_order of its own, so a move can place a tag between two neighbours. Waits
 * until the derived columns are filled and tags.json is migrated: before that, sort_order's column isn't complete
 * and tags.json may still bring tags without one.
 *
 * 1. Tags without a sort_order get one, continuing after the current max in the order they display: by
 *    (name_key, rowid) after every ordered tag. A tag whose sort_order is present but has no order loses that raw
 *    value, which is logged; one whose data isn't a JSON object is left without one and logged.
 * 2. Tags sharing a sort_order are spread into distinct values in rowid order (upstream's insertion order), up to
 *    the next value above them, the first keeping its value. A tie with no room between it and the next value is
 *    left tied and logged.
 *
 * Every write changes a row's order value without changing the order, so each commit shows the order the user
 * sees. Each page is read to the end and written in one transaction. A restart resumes from the place kept in meta.
 *
 * 3. Once the flag is set, the moves queued in tag_pending_moves while the pass ran (moveTagDefinition()) are applied
 *    in arrival order (drainTagPendingMoves()). A run that finds the flag already set applies what is left of them.
 *    While a reorder pass is recorded, neither applies anything: that pass applies them when it ends.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>} `batches` counts the transactions that wrote or moved the
 *   place; `rowsChanged` the tags written.
 */
export async function fillTagSortOrdersIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const { db } = entry;
    if (db.get('SELECT 1 FROM meta WHERE key = @key', { key: TAG_SORT_ORDERS_FILLED_FLAG })) {
        const totals = { batches: 0, rowsChanged: 0 };
        await drainTagPendingMoves(entry, directories, totals);
        return totals;
    }
    if (!tagQueryColumnsReady(entry) || !db.get('SELECT 1 FROM meta WHERE key = \'tags_json_migrated\'')) {
        console.log(color.cyan('[character-metadata] Tag sort_order fill: waiting for the tag query columns fill and the tags.json migration to finish.'));
        return { batches: 0, rowsChanged: 0 };
    }

    const saved = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: TAG_SORT_ORDERS_FILL_AT_KEY }));
    /** @type {{ phase: 'unordered', k: string, r: number } | { phase: 'unordered' } | { phase: 'ties', s: number | null }} */
    let at = saved ? JSON.parse(saved.value) : { phase: 'unordered' };

    const totals = { batches: 0, rowsChanged: 0 };
    const pause = async () => {
        if (totals.batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0 && !isReadOnlyMode()) db.get('PRAGMA wal_checkpoint(PASSIVE)');
        await delay(MIGRATION_BATCH_PAUSE_MS);
    };
    /** @param {typeof at} next */
    const saveAt = next => setMetaSync(db, TAG_SORT_ORDERS_FILL_AT_KEY, JSON.stringify(next));

    while (at.phase === 'unordered') {
        const from = at;
        /** @type {{ written: number, next: typeof at, replaced: string[], unwritable: string[], unplaced: string[] }} */
        const state = { written: 0, next: from, replaced: [], unwritable: [], unplaced: [] };
        db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            Object.assign(state, { written: 0, next: from, replaced: [], unwritable: [], unplaced: [] });
            /** @type {{ rowid: number, id: string, data: string, name_key: string }[]} */
            const page = [];
            const read = (/** @type {string} */ where, /** @type {Record<string, unknown>} */ params) => {
                const limit = TAG_SORT_ORDERS_FILL_BATCH_SIZE - page.length;
                if (limit > 0) page.push(...db.iterate(`SELECT rowid, id, data, name_key FROM tags INDEXED BY tags_unordered_name_key
                    WHERE sort_order IS NULL${where} ORDER BY name_key, rowid LIMIT @limit`, { ...params, limit }));
            };
            if ('k' in from) {
                read(' AND name_key = @k AND rowid > @r', { k: from.k, r: from.r });
                read(' AND name_key > @k', { k: from.k });
            } else {
                read('', {});
            }
            const max = /** @type {{ max: number | null }} */ (db.get('SELECT MAX(sort_order) AS max FROM tags')).max;
            // Upstream newTag()'s Math.max(0, ...orders) + 1.
            const values = valuesAfter(Math.max(0, max ?? 0), page.length);
            for (const row of page) {
                const tag = parseTagObject(row.data);
                if (!tag) {
                    state.unwritable.push(`  ${row.id}`);
                    continue;
                }
                if (state.written >= values.length) {
                    state.unplaced.push(`  ${tagWarningLabel(row.id, tag)}`);
                    continue;
                }
                if (tag.sort_order !== undefined) state.replaced.push(`  ${tagWarningLabel(row.id, tag)}: ${JSON.stringify(tag.sort_order)}`);
                writeTagSortOrderSync(db, row.rowid, tag, values[state.written]);
                state.written++;
            }
            if (state.written > 0) {
                logTagChangesSync(entry, null);
            }
            const last = page[page.length - 1];
            state.next = page.length < TAG_SORT_ORDERS_FILL_BATCH_SIZE ? { phase: 'ties', s: null } : { phase: 'unordered', k: last.name_key, r: last.rowid };
            saveAt(state.next);
        });
        totals.batches++;
        totals.rowsChanged += state.written;
        if (state.replaced.length > 0) {
            console.warn(color.yellow(`[character-metadata] Tag sort_order fill: ${state.replaced.length} tag(s) whose sort_order had no order (non-numeric, NaN or an object) were given one; their old values:\n${state.replaced.join('\n')}`));
        }
        if (state.unwritable.length > 0) {
            console.warn(color.yellow(`[character-metadata] Tag sort_order fill: ${state.unwritable.length} tag(s) whose stored data isn't a JSON object were left without a sort_order:\n${state.unwritable.join('\n')}`));
        }
        if (state.unplaced.length > 0) {
            console.warn(color.yellow(`[character-metadata] Tag sort_order fill: ${state.unplaced.length} tag(s) were left without a sort_order: no finite value is left after the current max:\n${state.unplaced.join('\n')}`));
        }
        at = state.next;
        await pause();
    }

    for (;;) {
        const { s } = /** @type {{ phase: 'ties', s: number | null }} */ (at);
        /** @type {{ written: number, s: number | null, large: number | null, noRoom: number[], done: boolean }} */
        const state = { written: 0, s, large: null, noRoom: [], done: false };
        db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            Object.assign(state, { written: 0, s, large: null, noRoom: [], done: false });
            // One row past the batch shows whether the page's last run goes on.
            const page = /** @type {{ rowid: number, data: string, sort_order: number }[]} */ ([...(s === null
                ? db.iterate('SELECT rowid, data, sort_order FROM tags INDEXED BY tags_sort_order WHERE sort_order IS NOT NULL ORDER BY sort_order, rowid LIMIT @limit', { limit: TAG_SORT_ORDERS_FILL_BATCH_SIZE + 1 })
                : db.iterate('SELECT rowid, data, sort_order FROM tags INDEXED BY tags_sort_order WHERE sort_order > @s ORDER BY sort_order, rowid LIMIT @limit', { s, limit: TAG_SORT_ORDERS_FILL_BATCH_SIZE + 1 }))]);
            const atEnd = page.length <= TAG_SORT_ORDERS_FILL_BATCH_SIZE;
            /** @type {{ value: number, rows: typeof page }[]} */
            const runs = [];
            for (const row of page) {
                if (runs.length > 0 && runs[runs.length - 1].value === row.sort_order) runs[runs.length - 1].rows.push(row);
                else runs.push({ value: row.sort_order, rows: [row] });
            }
            const complete = atEnd ? runs.length : runs.length - 1;
            if (!atEnd && complete === 0) {
                state.large = runs[0].value;
                return;
            }
            for (let i = 0; i < complete; i++) {
                const { value, rows } = runs[i];
                const values = rows.length > 1 ? spreadTiedValues(value, i + 1 < runs.length ? runs[i + 1].value : null, rows.length) : [];
                if (!values) {
                    state.noRoom.push(value);
                    state.s = value;
                    continue;
                }
                for (let rank = 1; rank < rows.length; rank++) {
                    writeTagSortOrderSync(db, rows[rank].rowid, /** @type {Record<string, unknown>} */ (parseTagObject(rows[rank].data)), values[rank - 1]);
                    state.written++;
                }
                state.s = rows.length > 1 ? values[values.length - 1] : value;
            }
            if (state.written > 0) {
                logTagChangesSync(entry, null);
            }
            state.done = atEnd;
            if (state.done) {
                setMetaSync(db, TAG_SORT_ORDERS_FILLED_FLAG, String(Date.now()));
                db.run('DELETE FROM meta WHERE key = @key', { key: TAG_SORT_ORDERS_FILL_AT_KEY });
            } else {
                saveAt({ phase: 'ties', s: state.s });
            }
        });
        if (state.done) await drainTagPendingMoves(entry, directories, totals);
        for (const value of state.noRoom) await warnTagsLeftTied(db, value);
        if (state.large !== null) {
            const outcome = await spreadLargeTie(entry, state.large, totals);
            if (outcome === 'no-room') {
                db.transaction(() => saveAt({ phase: 'ties', s: state.large }));
                at = { phase: 'ties', s: state.large };
            }
            await pause();
            continue;
        }
        totals.batches++;
        totals.rowsChanged += state.written;
        if (state.done) break;
        at = { phase: 'ties', s: state.s };
        await pause();
    }

    if (!isReadOnlyMode()) db.checkpoint();
    return totals;
}

/** The rows a move's first renumbering window covers (tag-actions D11); it doubles while there's no room. */
const TAG_MOVE_WINDOW_ROWS = 16;

/** @typedef {{ rowid: number, id: string, data: string, sort_order: number | null, name_key: string }} TagMoveRow */

const TAG_MOVE_ROW_COLUMNS = 'rowid, id, data, sort_order, name_key';

/** Thrown inside moveTagDefinition()'s transaction to roll back the tail it numbered when the move is refused after. */
class TagMoveRollback extends Error {}

/**
 * Rows of the manual order (sort_order, rowid) next to the place (s, r), nearest first, through tags_sort_order.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {number} s
 * @param {number} r
 * @param {'down' | 'up'} direction 'down' reads the rows before the place, 'up' those after it.
 * @param {boolean} inclusive Whether the row at (s, r) itself is read.
 * @param {number | null} skip A rowid never read; null skips none.
 * @param {number} limit
 * @returns {TagMoveRow[]}
 */
function tagOrderRowsSync(db, s, r, direction, inclusive, skip, limit) {
    const down = direction === 'down';
    const rowidOp = `${down ? '<' : '>'}${inclusive ? '=' : ''}`;
    const order = down ? 'sort_order DESC, rowid DESC' : 'sort_order, rowid';
    const rows = /** @type {TagMoveRow[]} */ ([...db.iterate(`SELECT ${TAG_MOVE_ROW_COLUMNS} FROM tags INDEXED BY tags_sort_order
        WHERE sort_order = @s AND rowid ${rowidOp} @r AND rowid IS NOT @skip ORDER BY ${order} LIMIT @limit`, { s, r, skip, limit })]);
    if (rows.length < limit) {
        rows.push(...db.iterate(`SELECT ${TAG_MOVE_ROW_COLUMNS} FROM tags INDEXED BY tags_sort_order
            WHERE sort_order ${down ? '<' : '>'} @s AND rowid IS NOT @skip ORDER BY ${order} LIMIT @limit`, { s, skip, limit: limit - rows.length }));
    }
    return rows;
}

/**
 * Gives the moved tag a sort_order right before or after the anchor: the midpoint with the anchor's neighbour on
 * that side, or past the anchor at an end of the order; failing that, spreads a window of rows around the anchor,
 * doubling it until there is room.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {TagMoveRow} moved
 * @param {Record<string, unknown>} tag moved's data.
 * @param {TagMoveRow & { sort_order: number }} anchor
 * @param {'before' | 'after'} side
 * @param {TagSortOrderWrite[]} written Gets an entry per row written.
 * @returns {number | 'no-room'} The rows written; 0 when the tag is already in that place.
 */
function placeTagNextToSync(db, moved, tag, anchor, side, written) {
    const a = anchor.sort_order;
    const neighbour = tagOrderRowsSync(db, a, anchor.rowid, side === 'before' ? 'down' : 'up', false, null, 1).at(0);
    if (neighbour?.rowid === moved.rowid) return 0;
    /** @type {number | undefined} */
    let value;
    if (neighbour !== undefined) {
        const b = /** @type {number} */ (neighbour.sort_order);
        const m = (a + b) / 2;
        if (Number.isFinite(m) && Math.min(a, b) < m && m < Math.max(a, b)) value = m;
    } else {
        const v = (side === 'after' ? valuesAfter(a, 1) : valuesBefore(a, 1)).at(0);
        if (v !== undefined && Number.isFinite(v) && (side === 'after' ? v > a : v < a)) value = v;
    }
    if (value !== undefined) {
        writeTagSortOrderSync(db, moved.rowid, tag, value);
        written.push({ id: moved.id, sort_order: value });
        return 1;
    }

    for (let size = TAG_MOVE_WINDOW_ROWS; ; size *= 2) {
        const half = size / 2;
        // The gap is between the two sides: "before" puts the anchor first on the right, "after" first on the left.
        const left = tagOrderRowsSync(db, a, anchor.rowid, 'down', side === 'after', moved.rowid, half + 1);
        const right = tagOrderRowsSync(db, a, anchor.rowid, 'up', side === 'before', moved.rowid, half + 1);
        // A side with more than `half` rows hasn't reached its end of the order; its extra row is the bound.
        const leftBound = left.length > half ? left.pop() : undefined;
        const rightBound = right.length > half ? right.pop() : undefined;
        const sequence = [...left.reverse(), moved, ...right];
        const n = sequence.length;
        const lo = leftBound && leftBound.sort_order !== -Infinity ? /** @type {number} */ (leftBound.sort_order) : null;
        const hi = rightBound && rightBound.sort_order !== Infinity ? /** @type {number} */ (rightBound.sort_order) : null;
        const values = lo !== null && hi !== null
            ? sequence.map((_, i) => lo + (hi - lo) * (i + 1) / (n + 1))
            : lo !== null ? valuesAfter(lo, n) : hi !== null ? valuesBefore(hi, n) : valuesAfter(0, n);
        const valid = values.length === n && values.every((v, i) => Number.isFinite(v)
            && (i === 0 ? lo === null || v > lo : v > values[i - 1])
            && (i < n - 1 || hi === null || v < hi));
        if (valid) {
            let rows = 0;
            sequence.forEach((row, i) => {
                if (values[i] === row.sort_order) return;
                // Stored data under a sort_order is always an object: tagDerivedColumns() gives any other NULL.
                const rowTag = row === moved ? tag : /** @type {Record<string, unknown>} */ (parseTagObject(row.data));
                writeTagSortOrderSync(db, row.rowid, rowTag, values[i]);
                written.push({ id: row.id, sort_order: values[i] });
                rows++;
            });
            return rows;
        }
        if (!leftBound && !rightBound) return 'no-room';
    }
}

/**
 * Numbers the tail (tags without a sort_order, by (name_key, rowid)) from its start through the anchor, after the
 * current max as fillTagSortOrdersIfNeeded() does, reading at most TAG_QUERY_WORK_CAP rows. The moved tag and rows
 * whose data isn't a JSON object stay in the tail.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {TagMoveRow} anchor
 * @param {number} movedRowid
 * @param {{ unwritable: string[], replaced: string[] }} logs Get, once numbered, a line per row left in the tail
 *   because its data isn't a JSON object, and one per row whose present sort_order (which had no order) was replaced.
 * @param {TagSortOrderWrite[]} written Gets an entry per row written.
 * @returns {'unordered' | 'no-room' | number} The rows written, once numbered.
 */
function numberTagTailThroughSync(db, anchor, movedRowid, logs, written) {
    const rows = /** @type {TagMoveRow[]} */ ([...db.iterate(`SELECT ${TAG_MOVE_ROW_COLUMNS} FROM tags INDEXED BY tags_unordered_name_key
        WHERE sort_order IS NULL AND name_key < @k ORDER BY name_key, rowid LIMIT @limit`, { k: anchor.name_key, limit: TAG_QUERY_WORK_CAP })]);
    if (rows.length < TAG_QUERY_WORK_CAP) {
        rows.push(...db.iterate(`SELECT ${TAG_MOVE_ROW_COLUMNS} FROM tags INDEXED BY tags_unordered_name_key
            WHERE sort_order IS NULL AND name_key = @k AND rowid <= @r ORDER BY name_key, rowid LIMIT @limit`,
        { k: anchor.name_key, r: anchor.rowid, limit: TAG_QUERY_WORK_CAP - rows.length }));
    }
    if (rows.length === 0 || rows[rows.length - 1].rowid !== anchor.rowid) return 'unordered';

    /** @type {{ rowid: number, id: string, tag: Record<string, unknown> }[]} */
    const targets = [];
    /** @type {string[]} */
    const skipped = [];
    for (const row of rows) {
        if (row.rowid === movedRowid) continue;
        const tag = parseTagObject(row.data);
        if (tag) targets.push({ rowid: row.rowid, id: row.id, tag });
        else skipped.push(`  ${row.id}`);
    }
    const max = /** @type {{ max: number | null }} */ (db.get('SELECT MAX(sort_order) AS max FROM tags')).max;
    // Upstream newTag()'s Math.max(0, ...orders) + 1.
    const values = valuesAfter(Math.max(0, max ?? 0), targets.length);
    if (values.length < targets.length) return 'no-room';
    targets.forEach(({ rowid, id, tag }, i) => {
        if (tag.sort_order !== undefined) logs.replaced.push(`  ${tagWarningLabel(id, tag)}: ${JSON.stringify(tag.sort_order)}`);
        writeTagSortOrderSync(db, rowid, tag, values[i]);
        written.push({ id, sort_order: values[i] });
    });
    logs.unwritable.push(...skipped);
    return targets.length;
}

/** @typedef {{ unwritable: string[], replaced: string[] }} TagTailLogs */

/** @typedef {{ id: string, sort_order: number }} TagSortOrderWrite A row a move wrote, with the sort_order now stored. */

/**
 * @typedef {object} TagMoveOutcome
 * @property {{ id: string, reason: TagWriteRefusalReason }[]} refused
 * @property {number} rows The tags rows written.
 * @property {TagSortOrderWrite[]} written One entry per row written; a row written twice has two, the last one current.
 * @property {TagTailLogs | null} logs Set once the tail was numbered.
 * @property {string | null} noRoom The log line for a 'no-room' refusal.
 * @property {boolean} rollback Whether the rows written must be rolled back: the tail was numbered, then the move
 *   was refused.
 */

/** The orders a reorder switches from (tag-actions D3): the client's non-manual tag_sort_mode values. */
export const TAG_REORDER_MODES = /** @type {const} */ (['alphabetical', 'by_entries']);
/** @typedef {typeof TAG_REORDER_MODES[number]} TagReorderMode */

// meta: the recorded reorder pass as JSON, a TagReorderPass; absent when none is.
const TAG_REORDER_PASS_KEY = 'tag_reorder_pass';
// meta: the last pass id given out. Kept apart from the record, which goes away, so ids only grow.
const TAG_REORDER_PASS_LAST_ID_KEY = 'tag_reorder_pass_last_id';

/**
 * Where a reorder pass (runTagReorderPassIfNeeded()) is: walking `mode`'s order, with `n` the value the next tag
 * gets and (c, k, r) the (usage_count, name_key, rowid) of the last tag walked (absent before the first); clearing
 * older passes' stamps; sweeping the unstamped tags; or applying tag_pending_moves.
 * @typedef {{ phase: 'walk', n: number, c?: number, k?: string, r?: number } | { phase: 'clear' } | { phase: 'sweep' } | { phase: 'drain' }} TagReorderPassPlace
 */

/**
 * A reorder pass: writing sort_order for every tag in `mode`'s order, then applying tag_pending_moves.
 * @typedef {object} TagReorderPass
 * @property {number} id Greater than every id given before.
 * @property {TagReorderMode} mode
 * @property {TagReorderPassPlace | null} at The pass's place; null before the walk starts.
 */

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @returns {TagReorderPass | null}
 */
function tagReorderPassSync(db) {
    const row = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: TAG_REORDER_PASS_KEY }));
    return row ? JSON.parse(row.value) : null;
}

/**
 * Whether a move can be applied now: fillTagSortOrdersIfNeeded() has finished (its flag is set), no reorder pass is
 * recorded, and no move is left queued.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function tagSortOrdersSettledSync(db) {
    return !!db.get('SELECT 1 FROM meta WHERE key = @key', { key: TAG_SORT_ORDERS_FILLED_FLAG })
        && tagReorderPassSync(db) === null
        && !db.get('SELECT 1 FROM tag_pending_moves LIMIT 1');
}

/**
 * Queues `value` as tag `id`'s sort_order.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @param {unknown} value A JSON value.
 */
function queueTagSortOrderValueSync(db, id, value) {
    db.run('INSERT INTO tag_pending_moves (tag_id, value) VALUES (@id, @value)', { id, value: JSON.stringify(value) });
    foldTagPendingSync(db);
}

/**
 * Queues a move of tag `id` right before or after `anchorId`, inside the caller's transaction.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @param {'before' | 'after'} side
 * @param {string} anchorId
 */
function queueTagMoveSync(db, id, side, anchorId) {
    db.run('INSERT INTO tag_pending_moves (tag_id, side, anchor_id) VALUES (@id, @side, @anchorId)', { id, side, anchorId });
    foldTagPendingSync(db);
}

// The seq of the last tag_pending_moves entry foldTagPendingSync() has applied to tag_pending_places.
const TAG_PENDING_FOLDED_SEQ_KEY = 'tag_pending_folded_seq';

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function tagPendingFoldedSeqSync(db) {
    const row = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: TAG_PENDING_FOLDED_SEQ_KEY }));
    return row ? Number(row.value) : 0;
}

/**
 * Applies to tag_pending_places, in arrival order, every tag_pending_moves entry not yet applied, inside the caller's
 * transaction. seq only grows, so an entry is applied once.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function foldTagPendingSync(db) {
    const start = tagPendingFoldedSeqSync(db);
    let folded = start;
    for (;;) {
        const pending = /** @type {{ seq: number, tag_id: string, side: 'before' | 'after' | null, anchor_id: string | null, value: string | null } | undefined} */ (
            db.get('SELECT seq, tag_id, side, anchor_id, value FROM tag_pending_moves WHERE seq > @folded ORDER BY seq LIMIT 1', { folded }));
        if (!pending) break;
        foldTagPendingEntrySync(db, pending);
        folded = pending.seq;
    }
    if (folded !== start) setMetaSync(db, TAG_PENDING_FOLDED_SEQ_KEY, String(folded));
}

/**
 * Applies entries queued without foldTagPendingSync() (by a version before tag_pending_places existed), so the
 * manual order a read walks includes them.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function foldTagPendingIfBehindSync(db) {
    if (isReadOnlyMode()) return;
    if (!db.get('SELECT 1 FROM tag_pending_moves WHERE seq > @folded LIMIT 1', { folded: tagPendingFoldedSeqSync(db) })) return;
    db.transaction(() => foldTagPendingSync(db));
}

const TAG_PLACE_COLUMNS = 'tag_id, anchor_id, g, i, valued, frozen, vphase, vs, vk, vc, vr';

/**
 * A tag_pending_places row.
 * @typedef {object} TagPlaceRow
 * @property {string} tag_id
 * @property {string | null} anchor_id
 * @property {-1 | 0 | 1} g
 * @property {number} i
 * @property {0 | 1} valued
 * @property {0 | 1} frozen
 * @property {1 | 2 | null} vphase
 * @property {number | null} vs
 * @property {string | null} vk
 * @property {number | null} vc
 * @property {number | null} vr
 */

/**
 * Applies one tag_pending_moves entry to tag_pending_places as drainTagPendingMoves() will apply it (tag-actions
 * D16): an entry whose tag or anchor is deleted, gone or unreadable now, or whose tag is its own anchor, does
 * nothing. A tag moved next to an anchor goes in the anchor's gap on that side, nearest the anchor; one moved next to
 * a tag in a gap joins that gap right beside it. A gap is at the anchor's row, or at the anchor's queued value when
 * it has one. A value entry puts the tag at the place its value coerces to. A tag's later entry replaces its place.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {{ tag_id: string, side: 'before' | 'after' | null, anchor_id: string | null, value: string | null }} pending
 */
function foldTagPendingEntrySync(db, { tag_id: id, side, anchor_id: anchorId, value }) {
    const readRow = (/** @type {string} */ tagId) => /** @type {{ r: number, data: string, name_key: string, sort_order: number | null, marked: number } | undefined} */ (
        db.get(`SELECT rowid AS r, data, name_key, sort_order, EXISTS (SELECT 1 FROM tag_deletions WHERE tag_id = tags.id) AS marked
            FROM tags WHERE id = @id`, { id: tagId }));
    const row = readRow(id);
    if (!row || row.marked || !parseTagObject(row.data)) return;
    const insert = (/** @type {Omit<TagPlaceRow, 'tag_id'>} */ place) => db.run(`INSERT INTO tag_pending_places (${TAG_PLACE_COLUMNS})
        VALUES (@tag_id, @anchor_id, @g, @i, @valued, @frozen, @vphase, @vs, @vk, @vc, @vr)`, { ...place, tag_id: id });
    if (side === null || anchorId === null) {
        const vs = tagDerivedColumns({ sort_order: JSON.parse(/** @type {string} */ (value)) }).sortOrder;
        db.run('DELETE FROM tag_pending_places WHERE tag_id = @id', { id });
        insert({ anchor_id: null, g: 0, i: 0, valued: 1, frozen: 0, vphase: vs === null ? 2 : 1, vs, vk: row.name_key, vc: null, vr: row.r });
        return;
    }
    if (id === anchorId) return;
    const anchor = readRow(anchorId);
    if (!anchor || anchor.marked) return;
    if (anchor.sort_order === null && !parseTagObject(anchor.data)) return;
    db.run('DELETE FROM tag_pending_places WHERE tag_id = @id', { id });
    const g = side === 'before' ? -1 : 1;
    const anchorPlace = /** @type {TagPlaceRow | undefined} */ (db.get(`SELECT ${TAG_PLACE_COLUMNS} FROM tag_pending_places WHERE tag_id = @anchorId`, { anchorId }));
    if (anchorPlace && anchorPlace.anchor_id !== null) {
        const { anchor_id, g: gapSide, valued, frozen, vphase, vs, vk, vc, vr } = anchorPlace;
        insert({ anchor_id, g: gapSide, i: tagGapKeyBesideSync(db, anchorPlace, g), valued, frozen, vphase, vs, vk, vc, vr });
        return;
    }
    // Before the anchor, the newest tag is the last of its gap; after it, the first.
    const edge = /** @type {{ i: number } | undefined} */ (db.get(`SELECT i FROM tag_pending_places INDEXED BY tag_pending_places_gap
        WHERE anchor_id = @anchorId AND g = @g AND frozen = 0 ORDER BY i ${g === -1 ? 'DESC' : 'ASC'} LIMIT 1`, { anchorId, g }));
    const i = edge ? edge.i + (g === -1 ? 1 : -1) : 0;
    if (anchorPlace) {
        insert({ anchor_id: anchorId, g, i, valued: 1, frozen: 0, vphase: anchorPlace.vphase, vs: anchorPlace.vs, vk: anchor.name_key, vc: null, vr: anchor.r });
    } else {
        insert({ anchor_id: anchorId, g, i, valued: 0, frozen: 0, vphase: null, vs: null, vk: null, vc: null, vr: null });
    }
}

/**
 * Folds the entries left in tag_pending_moves into an emptied tag_pending_places, inside the caller's transaction.
 * drainTagPendingMoves() calls it after each entry it applies: that entry's tag now sits at its own row, and what the
 * entries left place is worked out over the rows as they now are. Its cost grows with the entries left, not the tags.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function refoldTagPendingSync(db) {
    // An emptied queue has emptied the places with it (trg_tag_pending_moves_emptied).
    if (!db.get('SELECT 1 FROM tag_pending_moves LIMIT 1')) return;
    db.run('DELETE FROM tag_pending_places');
    setMetaSync(db, TAG_PENDING_FOLDED_SEQ_KEY, '0');
    foldTagPendingSync(db);
}

/**
 * An i for a tag placed right beside `place` in its gap: before it (g -1) or after it (g 1). When halving can't
 * separate the two neighbours any more, the gap is numbered 0, 1, 2… first.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {TagPlaceRow} place
 * @param {-1 | 1} g
 * @returns {number}
 */
function tagGapKeyBesideSync(db, place, g) {
    const space = { anchorId: place.anchor_id, g: place.g, frozen: place.frozen };
    const where = 'anchor_id = @anchorId AND g = @g AND frozen = @frozen';
    const read = () => {
        const at = /** @type {{ i: number }} */ (db.get('SELECT i FROM tag_pending_places WHERE tag_id = @id', { id: place.tag_id })).i;
        const next = /** @type {{ i: number } | undefined} */ (db.get(`SELECT i FROM tag_pending_places INDEXED BY tag_pending_places_gap WHERE ${where}
            AND i ${g === 1 ? '>' : '<'} @at ORDER BY i ${g === 1 ? 'ASC' : 'DESC'} LIMIT 1`, { ...space, at }));
        return { at, next: next?.i ?? null };
    };
    let { at, next } = read();
    if (next === null) return at + g;
    let key = (at + next) / 2;
    if (key === at || key === next) {
        // Only the rows whose number moves are written.
        db.run(`UPDATE tag_pending_places SET i = numbered.n FROM (SELECT tag_id, ROW_NUMBER() OVER (ORDER BY i) AS n
            FROM tag_pending_places WHERE ${where}) AS numbered
            WHERE tag_pending_places.tag_id = numbered.tag_id AND tag_pending_places.i IS NOT numbered.n`, space);
        ({ at, next } = read());
        key = next === null ? at + g : (at + next) / 2;
    }
    return key;
}

/**
 * Reads a move's two tags, refusing what holds whatever the order: the tag as its own anchor ('same', and nothing
 * else is read), then per id a deletion mark or no row, and the moved tag's data not being a JSON object.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @param {string} anchorId
 * @returns {{ refused: TagMoveOutcome['refused'], moved: TagMoveRow | null, tag: Record<string, unknown> | null,
 *   anchor: TagMoveRow | null }} moved and anchor are null when refused as deleted or missing.
 */
function readTagMoveSync(db, id, anchorId) {
    if (id === anchorId) return { refused: [{ id, reason: 'same' }], moved: null, tag: null, anchor: null };
    /** @param {string} tagId */
    const read = tagId => ({
        marked: !!db.get('SELECT 1 FROM tag_deletions WHERE tag_id = @id', { id: tagId }),
        row: /** @type {TagMoveRow | undefined} */ (db.get(`SELECT ${TAG_MOVE_ROW_COLUMNS} FROM tags WHERE id = @id`, { id: tagId })),
    });
    const moved = read(id);
    const anchor = read(anchorId);
    const tag = moved.row ? parseTagObject(moved.row.data) : null;
    /** @type {TagMoveOutcome['refused']} */
    const refused = [];
    if (moved.marked) refused.push({ id, reason: 'deleted' });
    else if (!moved.row) refused.push({ id, reason: 'missing' });
    else if (!tag) refused.push({ id, reason: 'unreadable' });
    if (anchor.marked) refused.push({ id: anchorId, reason: 'deleted' });
    else if (!anchor.row) refused.push({ id: anchorId, reason: 'missing' });
    return {
        refused,
        moved: moved.marked || !moved.row ? null : moved.row,
        tag,
        anchor: anchor.marked || !anchor.row ? null : anchor.row,
    };
}

/**
 * Moves tag `id` right before or after `anchorId` in the manual order, inside the caller's transaction. A refusal
 * writes nothing, except that a move refused after numbering the tail comes
 * back with `rollback` set, and the caller must roll its transaction back.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @param {string} anchorId
 * @param {'before' | 'after'} side
 * @returns {TagMoveOutcome}
 */
function moveTagSync(db, id, anchorId, side) {
    const read = readTagMoveSync(db, id, anchorId);
    /** @type {TagMoveOutcome} */
    const result = { refused: read.refused, rows: 0, written: [], logs: null, noRoom: null, rollback: false };
    const anchorTag = read.anchor ? parseTagObject(read.anchor.data) : null;
    if (read.anchor && read.anchor.sort_order === null && !anchorTag) result.refused.push({ id: anchorId, reason: 'unreadable' });
    if (result.refused.length > 0) return result;
    const movedRow = /** @type {TagMoveRow} */ (read.moved);
    const tag = /** @type {Record<string, unknown>} */ (read.tag);
    let anchorRow = /** @type {TagMoveRow} */ (read.anchor);
    const noRoom = () => {
        result.refused.push({ id, reason: 'no-room' });
        result.noRoom = `[character-metadata] Couldn't move tag ${tagWarningLabel(id, tag)} ${side} ${tagWarningLabel(anchorId, anchorTag)}: there is no room for a sort_order there.`;
    };

    if (anchorRow.sort_order === null) {
        if (side === 'before' && movedRow.sort_order === null) {
            const k = anchorRow.name_key;
            const previous = /** @type {{ rowid: number }[]} */ ([
                ...db.iterate(`SELECT rowid FROM tags INDEXED BY tags_unordered_name_key
                    WHERE sort_order IS NULL AND name_key = @k AND rowid < @r ORDER BY name_key DESC, rowid DESC LIMIT 1`, { k, r: anchorRow.rowid }),
                ...db.iterate(`SELECT rowid FROM tags INDEXED BY tags_unordered_name_key
                    WHERE sort_order IS NULL AND name_key < @k ORDER BY name_key DESC, rowid DESC LIMIT 1`, { k }),
            ]).at(0);
            if (previous?.rowid === movedRow.rowid) return result;
        }
        /** @type {TagTailLogs} */
        const logs = { unwritable: [], replaced: [] };
        const outcome = numberTagTailThroughSync(db, anchorRow, movedRow.rowid, logs, result.written);
        if (outcome === 'unordered') {
            result.refused.push({ id: anchorId, reason: 'unordered' });
            return result;
        }
        if (outcome === 'no-room') {
            noRoom();
            return result;
        }
        result.rows = outcome;
        result.logs = logs;
        anchorRow = /** @type {TagMoveRow} */ (db.get(`SELECT ${TAG_MOVE_ROW_COLUMNS} FROM tags WHERE rowid = @r`, { r: anchorRow.rowid }));
    }

    const outcome = placeTagNextToSync(db, movedRow, tag, /** @type {TagMoveRow & { sort_order: number }} */ (anchorRow), side, result.written);
    if (outcome === 'no-room') {
        noRoom();
        result.written = [];
        if (result.rows > 0) {
            result.rows = 0;
            result.logs = null;
            result.rollback = true;
        }
        return result;
    }
    result.rows += outcome;
    return result;
}

/**
 * Logs what numbering the tail changed or skipped.
 * @param {TagTailLogs | null} logs
 */
function warnTagTailNumbering(logs) {
    const { replaced = [], unwritable = [] } = logs ?? {};
    if (replaced.length > 0) {
        console.warn(color.yellow(`[character-metadata] Tag move: ${replaced.length} tag(s) whose sort_order had no order (non-numeric, NaN or an object) were given one; their old values:\n${replaced.join('\n')}`));
    }
    if (unwritable.length > 0) {
        console.warn(color.yellow(`[character-metadata] Tag move: ${unwritable.length} tag(s) whose stored data isn't a JSON object were left without a sort_order:\n${unwritable.join('\n')}`));
    }
}

/**
 * Moves a tag to right before or right after an anchor tag in the manual order, both by id (tag-actions step 5).
 * Only the moved tag's sort_order changes, unless there's no room next to the anchor: then a window of rows around
 * it is spread too. An anchor without a sort_order first gets one, along with the tail before it.
 *
 * Until fillTagSortOrdersIfNeeded() has finished, while a reorder pass is recorded, or while anything is queued
 * (tagSortOrdersSettledSync()), the move is only checked for what the order can't change ('same', a deleted or
 * missing id, an unreadable moved tag) and queued in tag_pending_moves, writing nothing else; the pass that ends
 * applies it.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {unknown} id
 * @param {unknown} placement `{ before: anchorId }` or `{ after: anchorId }`.
 * @returns {Promise<(TagWriteResult & { written: TagSortOrderWrite[], queued?: true }) | null>} written: every row
 *   the move wrote, with the sort_order now stored; empty when refused, queued or already in place. queued is set
 *   when the move was queued.
 */
export async function moveTagDefinition(directories, id, placement) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    if (typeof id !== 'string' || !id) return null;
    const parsed = parseTagPlacement(placement);
    if (!parsed) return null;
    const { side, anchorId } = parsed;
    const { db } = entry;

    /** @type {TagMoveOutcome} */
    let result = { refused: [], rows: 0, written: [], logs: null, noRoom: null, rollback: false };
    const state = { queued: false };
    try {
        db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            state.queued = false;
            if (!tagSortOrdersSettledSync(db)) {
                result = { refused: readTagMoveSync(db, id, anchorId).refused, rows: 0, written: [], logs: null, noRoom: null, rollback: false };
                if (result.refused.length > 0) return;
                queueTagMoveSync(db, id, side, anchorId);
                state.queued = true;
                return;
            }
            result = moveTagSync(db, id, anchorId, side);
            if (result.rollback) throw new TagMoveRollback();
            logTagChangesSync(entry, result.written.map(w => w.id));
        });
    } catch (err) {
        if (!(err instanceof TagMoveRollback)) throw err;
    }
    warnStaleDeletedTagSave(result.refused.filter(r => r.reason === 'deleted').map(r => r.id));
    if (result.noRoom !== null) console.warn(color.yellow(result.noRoom));
    warnTagTailNumbering(result.logs);
    if (state.queued) return { refused: result.refused, written: [], queued: true };
    // A row the tail numbered and the window then respread has two entries; the later one is what is stored.
    return { refused: result.refused, written: [...new Map(result.written.map(w => [w.id, w])).values()] };
}

/**
 * @param {unknown} placement
 * @returns {{ side: 'before' | 'after', anchorId: string } | null} null unless it is `{ before: anchorId }` or
 *   `{ after: anchorId }` with a non-empty string id.
 */
function parseTagPlacement(placement) {
    if (placement === null || typeof placement !== 'object') return null;
    const { before, after } = /** @type {{ before?: unknown, after?: unknown }} */ (placement);
    if ((before === undefined) === (after === undefined)) return null;
    const side = before !== undefined ? 'before' : 'after';
    const anchorId = side === 'before' ? before : after;
    if (typeof anchorId !== 'string' || !anchorId) return null;
    return { side, anchorId };
}

/**
 * A reorder made while viewing a non-manual order (tag-actions step 6, D3, D16): records a reorder pass that will
 * write sort_order for every tag in `mode`'s order, and queues the move in tag_pending_moves after what is already
 * there, to apply once the pass has written. A recorded pass is replaced: the new one gets a new id and starts its
 * walk over, and what is queued stays queued.
 *
 * A move refused as moveTagDefinition() refuses a queued one ('same', a deleted or missing id, an unreadable moved
 * tag) records nothing and queues nothing (D25.2).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {unknown} id
 * @param {unknown} placement `{ before: anchorId }` or `{ after: anchorId }`.
 * @param {unknown} mode One of TAG_REORDER_MODES.
 * @returns {Promise<(TagWriteResult & { queued: boolean }) | null>} queued: the pass was recorded and the move queued.
 */
export async function reorderTagDefinitions(directories, id, placement, mode) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    if (typeof id !== 'string' || !id) return null;
    const parsed = parseTagPlacement(placement);
    if (!parsed) return null;
    if (!TAG_REORDER_MODES.includes(/** @type {TagReorderMode} */ (mode))) return null;
    const { side, anchorId } = parsed;
    const { db } = entry;

    /** @type {TagWriteResult['refused']} */
    let refused = [];
    db.transaction(() => {
        // Reset here: a transaction that hits busy is rolled back and rerun.
        refused = readTagMoveSync(db, id, anchorId).refused;
        if (refused.length > 0) return;
        const last = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: TAG_REORDER_PASS_LAST_ID_KEY }));
        const passId = (last ? Number(last.value) : 0) + 1;
        /** @type {TagReorderPass} */
        const pass = { id: passId, mode: /** @type {TagReorderMode} */ (mode), at: null };
        setMetaSync(db, TAG_REORDER_PASS_LAST_ID_KEY, String(passId));
        setMetaSync(db, TAG_REORDER_PASS_KEY, JSON.stringify(pass));
        queueTagMoveSync(db, id, side, anchorId);
    });
    warnStaleDeletedTagSave(refused.filter(r => r.reason === 'deleted').map(r => r.id));
    return { refused, queued: refused.length === 0 };
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @returns {string | null} The tag's name when its data is a JSON object with a string name.
 */
function tagNameSync(db, id) {
    const row = /** @type {{ data: string } | undefined} */ (db.get('SELECT data FROM tags WHERE id = @id', { id }));
    const name = row ? parseTagObject(row.data)?.name : undefined;
    return typeof name === 'string' ? name : null;
}

/**
 * Applies tag_pending_moves in arrival order, one entry per transaction, deleting each (tag-actions D16, D18, D19).
 * An anchored entry is moved as moveTagDefinition() moves; a value entry's raw value is written as the tag's
 * sort_order in data, and coerced in the column.
 * An entry whose tag was deleted or is gone is dropped, and one whose tag is its own anchor does nothing, both
 * without a warning. After each entry, tag_pending_places is folded again from the entries left (refoldTagPendingSync()). Any other refusal leaves the tags as they are and is reported by reportTagMoveFailed(), once
 * per refusal.
 *
 * With no `passId`, it stops while a reorder pass is recorded. With one, it applies them for that pass
 * (runTagReorderPassIfNeeded()): it stops once another pass (or none) is recorded, and the transaction that finds the
 * table empty clears the pass record, so no entry is left queued with no pass to apply it (tag-actions D25.7).
 * @param {MetadataDbEntry} entry
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ batches: number, rowsChanged: number }} totals Gets a batch per entry and the rows it wrote.
 * @param {number | null} [passId]
 * @returns {Promise<'done' | 'held'>} done: the table was found empty (and, with `passId`, the pass cleared), and
 *   reportTagOrderSettled() was called if this call applied an entry or ran for a pass; held: stopped by the pass
 *   record.
 */
async function drainTagPendingMoves(entry, directories, totals, passId = null) {
    const { db } = entry;
    // So a store with nothing queued runs no transaction; each transaction below still reads its own entry.
    if (passId === null && !db.get('SELECT 1 FROM tag_pending_moves LIMIT 1')) return 'done';
    let entries = 0;
    for (;;) {
        /** @type {'done' | 'held'} */
        let stop = 'done';
        /** @type {{ seq: number, tag_id: string, side: 'before' | 'after' | null, anchor_id: string | null, value: string | null } | undefined} */
        let pending;
        /** @type {TagMoveOutcome | null} */
        let moved = null;
        let rows = 0;
        /** @type {TagMoveFailedPayload[]} */
        let failures = [];
        try {
            db.transaction(() => {
                // Reset here: a transaction that hits busy is rolled back and rerun.
                moved = null;
                rows = 0;
                failures = [];
                const pass = tagReorderPassSync(db);
                if (passId === null ? pass !== null : pass?.id !== passId) {
                    pending = undefined;
                    stop = 'held';
                    return;
                }
                pending = /** @type {typeof pending} */ (db.get('SELECT seq, tag_id, side, anchor_id, value FROM tag_pending_moves ORDER BY seq LIMIT 1'));
                if (!pending) {
                    stop = 'done';
                    if (passId !== null) db.run('DELETE FROM meta WHERE key = @key', { key: TAG_REORDER_PASS_KEY });
                    // One batch row for the whole pass: its batches log none of their own.
                    if (passId !== null) logTagChangesSync(entry, null);
                    return;
                }
                const { tag_id: tagId, side, anchor_id: anchorId } = pending;
                if (side !== null && anchorId !== null) {
                    moved = moveTagSync(db, tagId, anchorId, side);
                    const { refused } = moved;
                    if (refused.length > 0) {
                        const dropped = refused.some(r => r.id === tagId && (r.reason === 'deleted' || r.reason === 'missing'))
                            || refused.some(r => r.reason === 'same');
                        if (!dropped) {
                            const tagName = tagNameSync(db, tagId);
                            const anchorName = tagNameSync(db, anchorId);
                            failures = refused.map(r => ({
                                tagId, tagName, anchorId, anchorName, refusedId: r.id,
                                reason: /** @type {TagMoveFailedReason} */ (r.reason === 'missing' ? 'deleted' : r.reason),
                            }));
                        }
                        // Rolls back what the move wrote; the entry is deleted in a transaction of its own below.
                        throw new TagMoveRollback();
                    }
                    rows = moved.rows;
                } else {
                    const value = JSON.parse(/** @type {string} */ (pending.value));
                    const marked = !!db.get('SELECT 1 FROM tag_deletions WHERE tag_id = @id', { id: tagId });
                    const row = /** @type {{ rowid: number, data: string } | undefined} */ (marked ? undefined
                        : db.get('SELECT rowid, data FROM tags WHERE id = @id', { id: tagId }));
                    const tag = row ? parseTagObject(row.data) : null;
                    if (row && !tag) {
                        failures = [{ tagId, tagName: null, anchorId: null, anchorName: null, refusedId: tagId, reason: 'unreadable' }];
                    } else if (row && tag && !(Object.hasOwn(tag, 'sort_order') && JSON.stringify(tag.sort_order) === JSON.stringify(value))) {
                        writeTagSortOrderSync(db, row.rowid, tag, value);
                        rows = 1;
                    }
                }
                db.run('DELETE FROM tag_pending_moves WHERE seq = @seq', { seq: pending.seq });
                refoldTagPendingSync(db);
                if (rows > 0) {
                    logTagChangesSync(entry, moved ? /** @type {TagMoveOutcome} */ (moved).written.map(w => w.id) : [tagId]);
                }
            });
        } catch (err) {
            if (!(err instanceof TagMoveRollback)) throw err;
            const { seq } = /** @type {NonNullable<typeof pending>} */ (pending);
            db.transaction(() => {
                db.run('DELETE FROM tag_pending_moves WHERE seq = @seq', { seq });
                refoldTagPendingSync(db);
            });
        }
        if (!pending) {
            // A pass rewrote every tag's sort_order even when its entries were all dropped.
            const outcome = /** @type {'done' | 'held'} */ (stop);
            if (outcome === 'done' && (passId !== null || entries > 0)) reportTagOrderSettled(directories.root);
            return outcome;
        }
        entries++;
        if (rows > 0) warnTagTailNumbering(/** @type {TagMoveOutcome | null} */ (moved)?.logs ?? null);
        for (const payload of failures) reportTagMoveFailed(directories.root, payload);
        totals.batches++;
        totals.rowsChanged += rows;
        await delay(MIGRATION_BATCH_PAUSE_MS);
    }
}

// The reorder pass's stamp indexes: clearing reads older stamps, and the sweep reads the unstamped tags in each
// mode's order. tags is a rowid table, so each ends in rowid.
const TAG_REORDER_PASS_INDEXES_SQL = `
    CREATE INDEX IF NOT EXISTS tags_reorder_pass_name_key ON tags(reorder_pass, name_key);
    CREATE INDEX IF NOT EXISTS tags_reorder_pass_usage_count ON tags(reorder_pass, usage_count DESC, name_key);
`;
const TAG_REORDER_PASS_BATCH_SIZE = 1000;

/**
 * @typedef {object} TagReorderBatchLogs
 * @property {string[]} replaced A line per tag whose present sort_order, which had no order, was replaced.
 * @property {string[]} unwritable A line per tag stamped without a sort_order because its data isn't a JSON object.
 * @property {string[]} unplaced A line per tag stamped without a new sort_order: no finite value is left after the max.
 */

/**
 * Stamps a tag with the pass and, when its data is a JSON object, writes `value` as its sort_order unless it already
 * holds exactly that.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {{ r: number, id: string, data: string }} row
 * @param {number} passId
 * @param {number | null} value null: stamp only.
 * @param {TagReorderBatchLogs} logs
 * @returns {{ changed: boolean, written: boolean }} changed: the row changed at all; written: its data did.
 */
function writeTagReorderRowSync(db, row, passId, value, logs) {
    const tag = parseTagObject(row.data);
    let written = false;
    if (!tag) {
        logs.unwritable.push(`  ${row.id}`);
    } else if (value === null) {
        logs.unplaced.push(`  ${tagWarningLabel(row.id, tag)}`);
    } else if (!(Object.hasOwn(tag, 'sort_order') && tag.sort_order === value)) {
        if (tag.sort_order !== undefined && tagDerivedColumns(tag).sortOrder === null) logs.replaced.push(`  ${tagWarningLabel(row.id, tag)}: ${JSON.stringify(tag.sort_order)}`);
        writeTagSortOrderSync(db, row.r, tag, value);
        written = true;
    }
    const stamped = db.run('UPDATE tags SET reorder_pass = @passId WHERE rowid = @r AND reorder_pass IS NOT @passId', { passId, r: row.r }).changes > 0;
    return { changed: written || stamped, written };
}

/**
 * @param {number} passId
 * @param {TagReorderBatchLogs} logs
 */
function warnTagReorderBatch(passId, { replaced, unwritable, unplaced }) {
    const label = `[character-metadata] Tag reorder pass ${passId}:`;
    if (replaced.length > 0) {
        console.warn(color.yellow(`${label} ${replaced.length} tag(s) whose sort_order had no order (non-numeric, NaN or an object) were given one; their old values:\n${replaced.join('\n')}`));
    }
    if (unwritable.length > 0) {
        console.warn(color.yellow(`${label} ${unwritable.length} tag(s) whose stored data isn't a JSON object were left without a sort_order:\n${unwritable.join('\n')}`));
    }
    if (unplaced.length > 0) {
        console.warn(color.yellow(`${label} ${unplaced.length} tag(s) were left where they are: no finite value is left after the current max sort_order:\n${unplaced.join('\n')}`));
    }
}

/**
 * The recorded reorder pass (tag-actions step 6, D3, D15, D16, D18, D19, D25), run in the migration worker after
 * reorderTagDefinitions() records it, and resumed from its place on a restart. Waits for fillTagSortOrdersIfNeeded()
 * to finish. Each batch re-reads the record, so a pass recorded meanwhile restarts the walk under its id, whatever
 * phase this one was in. Each batch reads its rows to the end, then writes them and the pass's place in one
 * transaction.
 *
 * 1. Walk: every tag, in `mode`'s live order (alphabetical: name_key, rowid; by_entries: usage_count DESC, name_key,
 *    rowid), gets sort_order 0, 1, 2, ... and the pass's stamp. A tag written twice (its count moved it past the walk)
 *    keeps its later value.
 * 2. Clear: stamps older than the pass are cleared, so every tag the walk missed is unstamped.
 * 3. Sweep: the first unstamped tags in `mode`'s live order, again and again, get values after the max
 *    (upstream newTag()'s Math.max(0, max) + 1 upward) and the stamp: tags whose count moved behind the walk and
 *    tags created meanwhile.
 * 4. Drain: tag_pending_moves applies in arrival order (drainTagPendingMoves()), and the pass record is cleared with
 *    the transaction that finds it empty.
 *
 * A tag whose data isn't a JSON object is stamped without a sort_order and logged; in the walk it still takes its
 * number, so a value is a tag's rank in the order. A replaced sort_order that had no order is logged with its old
 * value, and so is a tag the sweep finds no finite value for, which is left as it is.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<CharacterPassResult | undefined>} `batches` counts the transactions that wrote or moved the
 *   place, and the drain's entries; `rowsChanged` the tags rows written.
 */
export async function runTagReorderPassIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    const { db } = entry;
    const totals = { batches: 0, rowsChanged: 0 };
    const recorded = tagReorderPassSync(db);
    if (recorded === null) return totals;
    if (!db.get('SELECT 1 FROM meta WHERE key = @key', { key: TAG_SORT_ORDERS_FILLED_FLAG })) {
        return totals;
    }
    db.exec(TAG_REORDER_PASS_INDEXES_SQL);

    const pause = async () => {
        if (totals.batches % MIGRATION_PASSIVE_CHECKPOINT_EVERY_BATCHES === 0 && !isReadOnlyMode()) db.get('PRAGMA wal_checkpoint(PASSIVE)');
        await delay(MIGRATION_BATCH_PAUSE_MS);
    };

    for (;;) {
        /** @type {{ pass: TagReorderPass | null, phase: TagReorderPassPlace['phase'] | null, changed: number, written: number, logs: TagReorderBatchLogs }} */
        const state = { pass: null, phase: null, changed: 0, written: 0, logs: { replaced: [], unwritable: [], unplaced: [] } };
        db.transaction(() => {
            // Reset here: a transaction that hits busy is rolled back and rerun.
            Object.assign(state, { pass: null, phase: null, changed: 0, written: 0, logs: { replaced: [], unwritable: [], unplaced: [] } });
            const pass = tagReorderPassSync(db);
            state.pass = pass;
            if (!pass) return;
            /** @type {TagReorderPassPlace} */
            const at = pass.at ?? { phase: 'walk', n: 0 };
            state.phase = at.phase;
            /** @param {{ changed: boolean, written: boolean }} outcome */
            const count = ({ changed, written }) => {
                if (changed) state.changed++;
                if (written) state.written++;
            };
            /** @type {TagReorderPassPlace | null} */
            let next = null;

            if (at.phase === 'walk') {
                const phase = tagWalkPhases(pass.mode, { used: false, folders: false })[0];
                /** @type {TagQueryPosition | null} */
                const after = at.r === undefined ? null : { phase: 1, s: null, k: /** @type {string} */ (at.k), c: /** @type {number} */ (at.c), r: at.r };
                /** @type {TagQueryRow[]} */
                const page = [];
                for (const { sql, params } of tagWalkQueries(phase, after, null)) {
                    const limit = TAG_REORDER_PASS_BATCH_SIZE - page.length;
                    if (limit <= 0) break;
                    page.push(...db.iterate(sql, { ...params, limit }));
                }
                let n = at.n;
                for (const row of page) count(writeTagReorderRowSync(db, row, pass.id, n++, state.logs));
                const last = page.at(-1);
                next = page.length < TAG_REORDER_PASS_BATCH_SIZE || !last
                    ? { phase: 'clear' }
                    : { phase: 'walk', n, c: last.usage_count, k: last.name_key, r: last.r };
            } else if (at.phase === 'clear') {
                const rowids = /** @type {number[]} */ ([...db.iterate(`SELECT rowid FROM tags INDEXED BY tags_reorder_pass_name_key
                    WHERE reorder_pass < @passId LIMIT @limit`, { passId: pass.id, limit: TAG_REORDER_PASS_BATCH_SIZE })]
                    .map(row => /** @type {{ rowid: number }} */ (row).rowid));
                for (const rowid of rowids) state.changed += db.run('UPDATE tags SET reorder_pass = NULL WHERE rowid = @rowid', { rowid }).changes;
                if (rowids.length < TAG_REORDER_PASS_BATCH_SIZE) next = { phase: 'sweep' };
            } else if (at.phase === 'sweep') {
                const order = pass.mode === 'by_entries'
                    ? 'tags_reorder_pass_usage_count WHERE reorder_pass IS NULL ORDER BY usage_count DESC, name_key, rowid'
                    : 'tags_reorder_pass_name_key WHERE reorder_pass IS NULL ORDER BY name_key, rowid';
                const page = /** @type {{ r: number, id: string, data: string }[]} */ ([...db.iterate(`SELECT rowid AS r, id, data FROM tags INDEXED BY ${order} LIMIT @limit`, { limit: TAG_REORDER_PASS_BATCH_SIZE })]);
                const max = /** @type {{ max: number | null }} */ (db.get('SELECT MAX(sort_order) AS max FROM tags')).max;
                // Upstream newTag()'s Math.max(0, ...orders) + 1.
                const values = valuesAfter(Math.max(0, max ?? 0), page.filter(row => parseTagObject(row.data)).length);
                let i = 0;
                for (const row of page) {
                    const value = parseTagObject(row.data) ? values[i++] ?? null : null;
                    count(writeTagReorderRowSync(db, row, pass.id, value, state.logs));
                }
                if (page.length < TAG_REORDER_PASS_BATCH_SIZE) {
                    next = { phase: 'drain' };
                }
            }

            if (next !== null) setMetaSync(db, TAG_REORDER_PASS_KEY, JSON.stringify({ ...pass, at: next }));
        });
        const { pass } = state;
        if (!pass) break;
        warnTagReorderBatch(pass.id, state.logs);
        if (state.phase === 'drain') {
            if (await drainTagPendingMoves(entry, directories, totals, pass.id) === 'done') {
                console.log(color.cyan(`[character-metadata] Tag reorder pass ${pass.id}: done.`));
                break;
            }
            continue;
        }
        totals.batches++;
        totals.rowsChanged += state.changed;
        await pause();
    }

    if (!isReadOnlyMode()) db.checkpoint();
    return totals;
}

/** The sorts queryTags() takes: the client's tag_sort_mode values (public/scripts/tags.js). */
export const TAG_QUERY_SORTS = /** @type {const} */ (['manual', 'alphabetical', 'by_entries']);
/** @typedef {typeof TAG_QUERY_SORTS[number]} TagQuerySort */

/**
 * The most tags rows one queryTags() request examines on the indexed path, counting every row a walk reads,
 * whether it lands on the page or not; past it the page comes back with `more` and a cursor at the last row
 * examined (the search plan's work cap, T2/O1).
 */
export const TAG_QUERY_WORK_CAP = 20000;

/** ids chunk for the primary key reads of queryTags(). */
const TAG_QUERY_ID_CHUNK = 500;

/**
 * A place in a sort's order, the keyset cursor (D1). Manual is two phases: tags with a sort_order by
 * (sort_order, rowid), then those without by (name_key, rowid). Alphabetical is (name_key, rowid); by_entries is
 * (usage_count DESC, name_key, rowid). Ties go by rowid, upstream's insertion order.
 *
 * Manual only, while moves wait in tag_pending_moves (tag_pending_places): a tag a pending move placed sits in a
 * gap right before (g -1) or after (g +1) the place (phase, s, k, c, r) of its anchor, at i in the gap's order. A
 * place without g is a row's own, or a value's (g 0, i 0).
 *
 * While a reorder pass is recorded and not yet draining (tagQueryPassSync()), manual reads walk that pass's mode
 * order instead (tag-actions step 6, D24, D26, D27), and their places are that mode's (phase 1, k, c, r, g, i).
 * @typedef {object} TagQueryPosition
 * @property {1 | 2} phase Manual only; 1 elsewhere.
 * @property {number | null} s sort_order.
 * @property {string} k name_key.
 * @property {number} c usage_count.
 * @property {number} r rowid.
 * @property {-1 | 0 | 1} [g] Manual only: the side of the gap a pending move placed the tag in; 0 when none.
 * @property {number} [i] Manual only: the tag's order in that gap (any finite number); 0 when none.
 * @property {TagQueryPass | null} [pass] A decoded manual cursor only: the reorder pass whose mode order it was
 *   made in; null or absent for the stored order.
 */

/**
 * The order manual reads walk while a reorder pass is recorded: its id and mode.
 * @typedef {{ id: number, mode: TagReorderMode }} TagQueryPass
 */

/**
 * The reorder pass manual reads follow: the recorded one, unless it is draining, when every tag but the queued
 * ones has its final value and the stored order is the right one (tag-actions D26).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @returns {TagQueryPass | null}
 */
function tagQueryPassSync(db) {
    const pass = tagReorderPassSync(db);
    return pass !== null && pass.at?.phase !== 'drain' ? { id: pass.id, mode: pass.mode } : null;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} SQLite's BINARY order on the UTF-8 bytes.
 */
function compareNameKeys(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Compares two positions of one sort, without their rowids.
 * @param {TagQuerySort} sort
 * @param {TagQueryPosition} a
 * @param {TagQueryPosition} b
 */
function compareTagKeys(sort, a, b) {
    if (sort === 'manual') {
        if (a.phase !== b.phase) return a.phase - b.phase;
        if (a.phase === 1) return /** @type {number} */ (a.s) < /** @type {number} */ (b.s) ? -1 : /** @type {number} */ (a.s) > /** @type {number} */ (b.s) ? 1 : 0;
        return compareNameKeys(a.k, b.k);
    }
    if (sort === 'by_entries' && a.c !== b.c) return b.c - a.c;
    return compareNameKeys(a.k, b.k);
}

/**
 * The full order of positions of one sort; a missing g or i counts as 0.
 * @param {TagQuerySort} sort
 * @param {TagQueryPosition} a
 * @param {TagQueryPosition} b
 */
function compareTagPositions(sort, a, b) {
    return compareTagKeys(sort, a, b) || a.r - b.r || (a.g ?? 0) - (b.g ?? 0) || (a.i ?? 0) - (b.i ?? 0);
}

/**
 * A manual cursor made under a reorder pass is ['manual', 'pass', id, ...the mode's keys, r, g, i] (tag-actions
 * D27.4).
 * @param {TagQuerySort} sort
 * @param {TagQueryPosition} position
 * @param {TagQueryPass | null} [pass] The reorder pass a manual read followed.
 * @returns {string}
 */
function encodeTagQueryCursor(sort, position, pass = null) {
    const modeKeys = pass?.mode === 'by_entries' ? [position.c, position.k] : [position.k];
    let values;
    if (sort === 'manual' && pass !== null) values = [sort, 'pass', pass.id, ...modeKeys, position.r, position.g ?? 0, position.i ?? 0];
    else if (sort === 'manual') values = [sort, position.phase, position.phase === 1 ? String(position.s) : position.k, position.r, position.g ?? 0, position.i ?? 0];
    else values = sort === 'alphabetical' ? [sort, position.k, position.r] : [sort, position.c, position.k, position.r];
    return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

/**
 * Reads a cursor queryTags() returned for `sort` (encodeTagQueryCursor()). The sort_order is carried as a string,
 * so an infinite one survives JSON. A 4-element manual cursor [sort, phase, key, rowid] is still accepted, as
 * g 0, i 0. A manual cursor made under a reorder pass comes back with `pass`; queryTags() checks it against the
 * order it reads.
 * @param {unknown} cursor
 * @param {TagQuerySort} sort
 * @returns {TagQueryPosition | null} null when it isn't one, or was made for another sort.
 */
export function decodeTagQueryCursor(cursor, sort) {
    if (typeof cursor !== 'string') return null;
    /** @type {unknown} */
    let values;
    try {
        values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!Array.isArray(values) || values[0] !== sort) return null;
    const isRowid = (/** @type {unknown} */ r) => Number.isSafeInteger(r);
    if (sort === 'manual' && values[1] === 'pass') {
        const id = values[2];
        if (!Number.isSafeInteger(id) || id < 1) return null;
        const mode = values.length === 7 ? 'alphabetical' : values.length === 8 ? 'by_entries' : null;
        if (mode === null) return null;
        const [c, k, r, g, i] = mode === 'by_entries' ? values.slice(3) : [0, ...values.slice(3)];
        if (!Number.isSafeInteger(c) || typeof k !== 'string' || !isRowid(r)) return null;
        if ((g !== -1 && g !== 0 && g !== 1) || typeof i !== 'number' || !Number.isFinite(i)) return null;
        return { phase: 1, s: null, k, c, r, g, i, pass: { id, mode } };
    }
    if (sort === 'manual') {
        if ((values.length !== 4 && values.length !== 6) || !isRowid(values[3])) return null;
        const g = values.length === 6 ? values[4] : 0;
        const i = values.length === 6 ? values[5] : 0;
        if ((g !== -1 && g !== 0 && g !== 1) || typeof i !== 'number' || !Number.isFinite(i)) return null;
        if (values[1] === 1 && typeof values[2] === 'string') {
            const s = Number(values[2]);
            if (Number.isNaN(s) || values[2].trim() === '') return null;
            return { phase: 1, s, k: '', c: 0, r: values[3], g, i };
        }
        if (values[1] === 2 && typeof values[2] === 'string') return { phase: 2, s: null, k: values[2], c: 0, r: values[3], g, i };
        return null;
    }
    if (sort === 'alphabetical') {
        if (values.length !== 3 || typeof values[1] !== 'string' || !isRowid(values[2])) return null;
        return { phase: 1, s: null, k: values[1], c: 0, r: values[2] };
    }
    if (values.length !== 4 || !Number.isSafeInteger(values[1]) || typeof values[2] !== 'string' || !isRowid(values[3])) return null;
    return { phase: 1, s: null, k: values[2], c: values[1], r: values[3] };
}

/**
 * @typedef {object} TagQueryParams
 * @property {TagQuerySort} sort
 * @property {string} [search] A prefix of the folded name (tagNameKey()); empty is no search.
 * @property {string} [name] An exact name, matched as name_key = tagNameKey(name).
 * @property {string} [contains] Text the folded name holds anywhere; empty is no filter. No index covers it, so
 *   every row a walk reads is checked and counts toward TAG_QUERY_WORK_CAP.
 * @property {boolean} [counts] Also answer how many characters and groups carry each tag on the page.
 * @property {string[]} [ids] At most TAG_QUERY_ID_CHUNK distinct ids; the caller enforces it.
 * @property {boolean} [used] Only tags with usage_count > 0.
 * @property {boolean} [folders] Only folder tags (is_folder = 1).
 * @property {'OPEN'|'CLOSED'} [folderType] Only folder tags of this folder_type; implies `folders`.
 * @property {number} pageSize
 * @property {TagQueryPosition | null} [after] A decoded cursor.
 */

/**
 * @typedef {object} TagQueryResult
 * @property {object[]} rows Tag definitions (parsed data), in the sort's order.
 * @property {string | null} cursor Where the next page starts; null once the order is walked to its end.
 * @property {boolean} more The work cap stopped the walk: the page may be short and the cursor carries on.
 * @property {Record<string, number>} [counts] With `counts`: for each row's id, how many characters and groups
 *   carry the tag (tagCountsForIdsSync()).
 * @property {string[]} [approximate] With `counts`: the ids whose count may be too high.
 */

/**
 * Byte-level name_key tests for a search prefix, an exact name or text held anywhere, as SQLite compares them.
 * @param {TagQueryParams} params
 */
function tagNameMatchers(params) {
    const exact = typeof params.name === 'string' ? Buffer.from(tagNameKey(params.name), 'utf8') : null;
    const prefix = typeof params.search === 'string' && params.search !== '' ? Buffer.from(tagNameKey(params.search), 'utf8') : null;
    const containsKey = typeof params.contains === 'string' ? tagNameKey(params.contains) : '';
    const contains = containsKey !== '' ? Buffer.from(containsKey, 'utf8') : null;
    /** @param {string} key */
    const matches = (key) => {
        const bytes = Buffer.from(key, 'utf8');
        if (exact && !bytes.equals(exact)) return false;
        if (prefix && (bytes.length < prefix.length || !bytes.subarray(0, prefix.length).equals(prefix))) return false;
        if (contains && !bytes.includes(contains)) return false;
        return true;
    };
    return { exact, prefix, matches };
}

/**
 * One phase of a sort's walk: the index it reads through and the WHERE it needs for that index.
 * @typedef {object} TagWalkPhase
 * @property {1 | 2} phase
 * @property {string} index
 * @property {string[]} where Conditions every query of the phase carries (partial index, equality prefix).
 * @property {{ column: 'sort_order' | 'name_key' | 'usage_count', desc?: boolean }[]} keys The order before rowid.
 * @property {boolean} coversFolders is_folder is fixed by the index.
 * @property {boolean} coversUsed usage_count > 0 is fixed by the index.
 */

/**
 * The phases a sort walks for a filter set, each through the index tags-paging D11 lists for it. A filter the
 * index doesn't fix is checked per row.
 * @param {TagQuerySort} sort
 * @param {{ used: boolean, folders: boolean, folderUsageIndex?: boolean }} filter folderUsageIndex: the
 *   tags_folder_usage_count index exists, so a most-used walk of folders reads only folder tags.
 * @returns {TagWalkPhase[]}
 */
function tagWalkPhases(sort, { used, folders, folderUsageIndex = false }) {
    const folderWhere = folders ? ['is_folder = 1'] : [];
    if (sort === 'by_entries') {
        const byFolder = folders && folderUsageIndex;
        return [{
            phase: 1,
            index: byFolder ? 'tags_folder_usage_count' : 'tags_usage_count',
            where: [...(byFolder ? folderWhere : []), ...(used ? ['usage_count > 0'] : [])],
            keys: [{ column: 'usage_count', desc: true }, { column: 'name_key' }],
            coversFolders: byFolder,
            coversUsed: used,
        }];
    }
    const nameKeyIndex = folders ? 'tags_folder_name_key' : used ? 'tags_used_name_key' : 'tags_name_key';
    const nameKeyWhere = folders ? folderWhere : used ? ['usage_count > 0'] : [];
    if (sort === 'alphabetical') {
        return [{ phase: 1, index: nameKeyIndex, where: nameKeyWhere, keys: [{ column: 'name_key' }], coversFolders: folders, coversUsed: used && !folders }];
    }
    return [
        {
            phase: 1,
            index: folders ? 'tags_folder_sort_order' : used ? 'tags_used_sort_order' : 'tags_sort_order',
            where: [...(folders ? folderWhere : used ? ['usage_count > 0'] : []), 'sort_order IS NOT NULL'],
            keys: [{ column: 'sort_order' }],
            coversFolders: folders,
            coversUsed: used && !folders,
        },
        {
            phase: 2,
            index: folders ? 'tags_folder_unordered_name_key' : used ? 'tags_used_unordered_name_key' : 'tags_unordered_name_key',
            where: [...(folders ? folderWhere : used ? ['usage_count > 0'] : []), 'sort_order IS NULL'],
            keys: [{ column: 'name_key' }],
            coversFolders: folders,
            coversUsed: used && !folders,
        },
    ];
}

const TAG_QUERY_ROW_COLUMNS = `rowid AS r, id, data, name_key, sort_order, usage_count, is_folder, folder_type,
    EXISTS (SELECT 1 FROM tag_deletions WHERE tag_id = tags.id) AS marked`;
// placed: NULL when tag_pending_places has no place for the tag, 0 for a value's place, 1 for a gap's.
const TAG_QUERY_PLACED_ROW_COLUMNS = `${TAG_QUERY_ROW_COLUMNS},
    (SELECT anchor_id IS NOT NULL FROM tag_pending_places WHERE tag_id = tags.id) AS placed`;
// A tag_pending_places row joined to its tag's tags row (t).
const TAG_PLACE_ITEM_COLUMNS = `p.g, p.i, p.vphase, p.vs, p.vk, p.vc, p.vr, t.rowid AS r, t.id, t.data, t.name_key,
    t.sort_order, t.usage_count, t.is_folder, EXISTS (SELECT 1 FROM tag_deletions WHERE tag_id = t.id) AS marked`;

/**
 * @typedef {object} TagQueryRow
 * @property {number} r
 * @property {string} id
 * @property {string} data
 * @property {string} name_key
 * @property {number | null} sort_order
 * @property {number} usage_count
 * @property {number} is_folder
 * @property {number} marked
 */

/**
 * The queries that walk one phase from `after` on, in order, each seeking its start through the phase's index:
 * for keys (k1, k2, rowid) after (v1, v2, r) they are k1 = v1 AND k2 = v2 AND rowid > r, then k1 = v1 AND
 * k2 > v2, then k1 > v1. A name_key range (search prefix or exact name) bounds the name_key key when it leads.
 * @param {TagWalkPhase} phase
 * @param {TagQueryPosition | null} after In this phase, or null to walk it from its start.
 * @param {Buffer | null} nameLow The least name_key a match can have, when name_key leads the keys.
 * @param {string} [columns] What each row reads.
 * @returns {{ sql: string, params: Record<string, unknown> }[]}
 */
function tagWalkQueries(phase, after, nameLow, columns = TAG_QUERY_ROW_COLUMNS) {
    const value = (/** @type {string} */ column) => column === 'sort_order' ? after?.s : column === 'name_key' ? after?.k : after?.c;
    /** @type {{ sql: string, params: Record<string, unknown> }[]} */
    const queries = [];
    /**
     * @param {string[]} where
     * @param {typeof phase.keys} orderKeys
     * @param {Record<string, unknown>} params
     * @param {boolean} nameKeyFixed
     */
    const add = (where, orderKeys, params, nameKeyFixed) => {
        const all = [...phase.where, ...where];
        if (nameLow !== null && phase.keys[0].column === 'name_key' && !nameKeyFixed) {
            all.push('name_key >= @nameLow');
            params.nameLow = nameLow.toString('utf8');
        }
        const order = [...orderKeys.map(k => `${k.column}${k.desc === true ? ' DESC' : ''}`), 'rowid'].join(', ');
        queries.push({
            sql: `SELECT ${columns} FROM tags INDEXED BY ${phase.index}${all.length ? ` WHERE ${all.join(' AND ')}` : ''} ORDER BY ${order} LIMIT @limit`,
            params,
        });
    };
    if (after === null) {
        add([], phase.keys, {}, false);
        return queries;
    }
    for (let depth = phase.keys.length; depth >= 0; depth--) {
        const where = phase.keys.slice(0, depth).map((k, i) => `${k.column} = @eq${i}`);
        /** @type {Record<string, unknown>} */
        const params = Object.fromEntries(phase.keys.slice(0, depth).map((k, i) => [`eq${i}`, value(k.column)]));
        if (depth === phase.keys.length) {
            add([...where, 'rowid > @afterRowid'], [], { ...params, afterRowid: after.r }, true);
        } else {
            const key = phase.keys[depth];
            add([...where, `${key.column} ${key.desc === true ? '<' : '>'} @past`], phase.keys.slice(depth), { ...params, past: value(key.column) }, depth > 0 && phase.keys[0].column === 'name_key');
        }
    }
    return queries;
}

/**
 * The position of a row read from tags.
 * @param {TagQuerySort} sort
 * @param {TagQueryRow} row
 * @returns {TagQueryPosition}
 */
function tagRowPosition(sort, row) {
    const phase = sort === 'manual' && row.sort_order === null ? 2 : 1;
    return { phase, s: row.sort_order, k: row.name_key, c: row.usage_count, r: row.r };
}

/**
 * Parses a row's data, warning and returning undefined when it can't be.
 * @param {TagQueryRow} row
 */
function parseTagQueryRow(row) {
    try {
        return JSON.parse(row.data);
    } catch (err) {
        console.warn(`[character-metadata] Tag definition ${row.id} could not be parsed, skipped it: ${/** @type {Error} */ (err).message}`);
        return undefined;
    }
}

/**
 * Whether tag_pending_places holds anything: moves are queued, so manual reads show where they will put tags.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function hasTagPendingPlacesSync(db) {
    return !!db.get('SELECT 1 FROM tag_pending_places LIMIT 1');
}

/**
 * The place a tag_pending_places row gives its tag in `order`: in the stored manual order, a value place is
 * (vphase, vs, vk, vr); under a reorder pass a value counts for nothing (tag-actions D24), so a value's tag keeps its
 * own place and a gap is at its anchor's row, or at the anchor's last place in the mode when the row was removed.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {TagQuerySort} order
 * @param {TagQueryPass | null} pass
 * @param {TagPlaceRow} place
 * @returns {TagQueryPosition | null} null for a tag at its own row's place.
 */
function tagPlacePosition(db, order, pass, place) {
    const { g, i } = place;
    if (pass === null && place.valued === 1) {
        return { phase: /** @type {1 | 2} */ (place.vphase), s: place.vs, k: /** @type {string} */ (place.vk), c: 0, r: /** @type {number} */ (place.vr), g, i };
    }
    if (place.anchor_id === null) return null;
    if (place.frozen === 1) return { phase: 1, s: null, k: /** @type {string} */ (place.vk), c: /** @type {number} */ (place.vc), r: /** @type {number} */ (place.vr), g, i };
    const anchor = /** @type {TagQueryRow | undefined} */ (db.get(`SELECT ${TAG_QUERY_ROW_COLUMNS} FROM tags WHERE id = @id`, { id: place.anchor_id }));
    return anchor ? { ...tagRowPosition(order, anchor), g, i } : null;
}

/**
 * Whether a row passes a page's filters other than ids.
 * @param {TagQueryRow} row
 * @param {TagQueryParams} params
 * @param {ReturnType<typeof tagNameMatchers>} names
 */
function tagRowPassesFilters(row, params, names) {
    return !row.marked && names.matches(row.name_key)
        && (params.folders !== true || row.is_folder === 1)
        && (params.folderType === undefined || row.folder_type === params.folderType)
        && (params.used !== true || row.usage_count > 0);
}

/**
 * Something a walk reaches, in order: a tags row at its own place, or a tag at its tag_pending_places place.
 * @typedef {object} TagWalkEvent
 * @property {TagQueryPosition} position
 * @property {TagQueryRow} row
 * @property {boolean} show It goes on the page.
 */

/**
 * The tags in the gap of `anchorId` on side `g`, at `base` (the anchor's row place), after `after`, by index.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {TagQuerySort} order
 * @param {TagQueryPass | null} pass
 * @param {string} anchorId
 * @param {TagQueryPosition} base
 * @param {-1 | 1} g
 * @param {TagQueryPosition | null} after
 * @param {(row: TagQueryRow) => boolean} shows
 * @returns {Generator<TagWalkEvent>}
 */
function* tagGapEvents(db, order, pass, anchorId, base, g, after, shows) {
    /** @type {number | null} */
    let past = null;
    if (after !== null) {
        const cmp = compareTagKeys(order, base, after) || base.r - after.r;
        if (cmp < 0) return;
        if (cmp === 0) {
            const afterG = after.g ?? 0;
            if (afterG > g) return;
            if (afterG === g) past = after.i ?? 0;
        }
    }
    // Stored order: a gap at the anchor's value is walked with the value places. Under a pass every gap is at its row.
    const sql = `SELECT ${TAG_PLACE_ITEM_COLUMNS} FROM tag_pending_places p
        INDEXED BY ${pass === null ? 'tag_pending_places_row_gap' : 'tag_pending_places_gap'} JOIN tags t ON t.id = p.tag_id
        WHERE p.anchor_id = @anchorId AND p.g = @g ${pass === null ? 'AND p.valued = 0' : 'AND p.frozen = 0'}
        ${past !== null ? 'AND p.i > @past' : ''} ORDER BY p.i`;
    for (const item of /** @type {Generator<TagQueryRow & { i: number }>} */ (db.iterate(sql, { anchorId, g, past }))) {
        yield { position: { ...base, g, i: item.i }, row: item, show: shows(item) };
    }
}

/**
 * The walk of the tags rows in the sort's order, each with the gaps tag_pending_places has at it when `placed`.
 * Without places it starts after `after` (at its row for a cursor in the gap before it, cut before the row was
 * shown) and may skip rows by name; with places it starts at `after`'s row, since a gap item after the cursor can
 * still be due there, and walks every row, since a moved tag can sit next to any of them.
 * @param {MetadataDbEntry} entry
 * @param {TagQueryParams} params
 * @param {TagQuerySort} order
 * @param {TagQueryPass | null} pass
 * @param {boolean} placed
 * @param {ReturnType<typeof tagNameMatchers>} names
 * @returns {Generator<TagWalkEvent>}
 */
function* tagRowWalkEvents(entry, params, order, pass, placed, names) {
    const { db } = entry;
    const used = params.used === true;
    const folders = params.folders === true;
    const after = params.after ?? null;
    const nameLow = placed ? null : names.exact ?? names.prefix;
    const walkAfter = after !== null && (placed || after.g === -1) ? { ...after, r: after.r - 1, g: /** @type {0} */ (0), i: 0 } : after;
    const isPastAfter = (/** @type {TagQueryPosition} */ position) => after === null || compareTagPositions(order, position, after) > 0;
    const shows = (/** @type {TagQueryRow} */ row) => tagRowPassesFilters(row, params, names);
    const phases = tagWalkPhases(order, placed ? { used: false, folders: false } : { used, folders, folderUsageIndex: folders && tagFolderUsageIndexReady(entry) });
    for (const phase of phases) {
        if (walkAfter !== null && walkAfter.phase > phase.phase) continue;
        const leadsWithName = phase.keys[0].column === 'name_key';
        let phaseDone = false;
        const queries = tagWalkQueries(phase, walkAfter !== null && walkAfter.phase === phase.phase ? walkAfter : null, nameLow,
            placed ? TAG_QUERY_PLACED_ROW_COLUMNS : TAG_QUERY_ROW_COLUMNS);
        for (const { sql, params: queryParams } of queries) {
            if (phaseDone) break;
            for (const row of /** @type {Generator<TagQueryRow & { placed?: number | null }>} */ (db.iterate(sql, { ...queryParams, limit: TAG_QUERY_WORK_CAP }))) {
                const position = tagRowPosition(order, row);
                if (placed) yield* tagGapEvents(db, order, pass, row.id, position, -1, after, shows);
                if (isPastAfter(position)) {
                    const nameMatches = names.matches(row.name_key);
                    // A stored value counts for nothing under a pass, so only a gap's tag leaves its own row then.
                    const moved = placed && (pass === null ? row.placed !== null : row.placed === 1);
                    const show = nameMatches && !row.marked && !moved
                        && (phase.coversFolders || !folders || row.is_folder === 1)
                        && (params.folderType === undefined || row.folder_type === params.folderType)
                        && (phase.coversUsed || !used || row.usage_count > 0);
                    yield { position, row, show };
                    if (!nameMatches && leadsWithName && nameLow !== null && isPastNameRange(row.name_key, names, nameLow)) {
                        phaseDone = true;
                        break;
                    }
                }
                if (placed) yield* tagGapEvents(db, order, pass, row.id, position, 1, after, shows);
            }
        }
    }
}

/**
 * The tag_pending_places places that aren't at a live row, after `after`, in order: in the stored manual order the
 * value places (a value's tag, a gap at an anchor's value, a gap whose anchor row was removed); under a reorder pass
 * the gaps whose anchor row was removed, at its last place in the mode.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {TagQuerySort} order
 * @param {TagQueryPass | null} pass
 * @param {TagQueryPosition | null} after
 * @param {(row: TagQueryRow) => boolean} shows
 * @returns {Generator<TagWalkEvent>}
 */
function* tagPlaceStreamEvents(db, order, pass, after, shows) {
    /** @type {{ index: string, where: string, keys: string[], seek: unknown[] | null, position: (p: TagPlaceRow) => TagQueryPosition }[]} */
    const walks = [];
    const at = after === null ? null : [after.r, after.g ?? 0, after.i ?? 0];
    if (pass === null) {
        if (after === null || after.phase === 1) {
            walks.push({
                index: 'tag_pending_places_ordered', where: 'p.valued = 1 AND p.vphase = 1', keys: ['p.vs', 'p.vr', 'p.g', 'p.i'],
                seek: at === null ? null : [after?.s, ...at],
                position: p => ({ phase: 1, s: p.vs, k: /** @type {string} */ (p.vk), c: 0, r: /** @type {number} */ (p.vr), g: p.g, i: p.i }),
            });
        }
        walks.push({
            index: 'tag_pending_places_unordered', where: 'p.valued = 1 AND p.vphase = 2', keys: ['p.vk', 'p.vr', 'p.g', 'p.i'],
            seek: at === null || after?.phase === 1 ? null : [after?.k, ...at],
            position: p => ({ phase: 2, s: null, k: /** @type {string} */ (p.vk), c: 0, r: /** @type {number} */ (p.vr), g: p.g, i: p.i }),
        });
    } else {
        /** @param {TagPlaceRow} p */
        const position = p => ({ phase: /** @type {1} */ (1), s: null, k: /** @type {string} */ (p.vk), c: /** @type {number} */ (p.vc), r: /** @type {number} */ (p.vr), g: p.g, i: p.i });
        if (order === 'by_entries') {
            // Most used first: the rest of after's count by (k, r, g, i), then every lower count.
            if (at !== null) {
                walks.push({ index: 'tag_pending_places_frozen_usage', where: `p.frozen = 1 AND p.vc = ${Number(after?.c)}`, keys: ['p.vk', 'p.vr', 'p.g', 'p.i'], seek: [after?.k, ...at], position });
                walks.push({ index: 'tag_pending_places_frozen_usage', where: `p.frozen = 1 AND p.vc < ${Number(after?.c)}`, keys: ['p.vc DESC', 'p.vk', 'p.vr', 'p.g', 'p.i'], seek: null, position });
            } else {
                walks.push({ index: 'tag_pending_places_frozen_usage', where: 'p.frozen = 1', keys: ['p.vc DESC', 'p.vk', 'p.vr', 'p.g', 'p.i'], seek: null, position });
            }
        } else {
            walks.push({ index: 'tag_pending_places_frozen_name', where: 'p.frozen = 1', keys: ['p.vk', 'p.vr', 'p.g', 'p.i'], seek: at === null ? null : [after?.k, ...at], position });
        }
    }
    for (const walk of walks) {
        const seekKeys = walk.keys.filter(k => !k.endsWith(' DESC'));
        const seek = walk.seek === null ? '' : ` AND (${seekKeys.join(', ')}) > (${seekKeys.map(() => '?').join(', ')})`;
        const sql = `SELECT ${TAG_PLACE_ITEM_COLUMNS} FROM tag_pending_places p INDEXED BY ${walk.index} JOIN tags t ON t.id = p.tag_id
            WHERE ${walk.where}${seek} ORDER BY ${walk.keys.join(', ')}`;
        for (const item of /** @type {Generator<TagQueryRow & TagPlaceRow>} */ (db.iterate(sql, walk.seek ?? []))) {
            yield { position: walk.position(item), row: item, show: shows(item) };
        }
    }
}

/**
 * Two walks merged by place.
 * @param {TagQuerySort} order
 * @param {Generator<TagWalkEvent>} a
 * @param {Generator<TagWalkEvent>} b
 * @returns {Generator<TagWalkEvent>}
 */
function* mergeTagWalkEvents(order, a, b) {
    try {
        let x = a.next();
        let y = b.next();
        while (x.done !== true || y.done !== true) {
            if (y.done === true || (x.done !== true && compareTagPositions(order, x.value.position, y.value.position) <= 0)) {
                yield /** @type {TagWalkEvent} */ (x.value);
                x = a.next();
            } else {
                yield y.value;
                y = b.next();
            }
        }
    } finally {
        a.return(undefined);
        b.return(undefined);
    }
}

/**
 * Whether a name_key lies after every key the exact name or search prefix matches, so a walk in name_key order
 * has nothing left to find.
 * @param {string} nameKey
 * @param {ReturnType<typeof tagNameMatchers>} names
 * @param {Buffer} nameLow
 */
function isPastNameRange(nameKey, names, nameLow) {
    const key = Buffer.from(nameKey, 'utf8');
    if (Buffer.compare(key, nameLow) <= 0) return false;
    return names.exact !== null || !key.subarray(0, nameLow.length).equals(nameLow);
}

/**
 * The indexed path: walks the sort's phases through their indexes under TAG_QUERY_WORK_CAP. Manual, while moves are
 * queued, walks tag_pending_places along with them by index, so every tag shows at the place the queue will leave
 * it (tag-actions D16). Every row and place the walk reaches counts toward the cap.
 * @param {MetadataDbEntry} entry
 * @param {TagQueryParams} params
 * @param {TagQueryPass | null} pass Manual only: the reorder pass whose mode order to walk.
 * @returns {TagQueryResult}
 */
function queryTagsIndexed(entry, params, pass) {
    const { sort, pageSize } = params;
    const order = pass?.mode ?? sort;
    const names = tagNameMatchers(params);
    const placed = sort === 'manual' && hasTagPendingPlacesSync(entry.db);
    const shows = (/** @type {TagQueryRow} */ row) => tagRowPassesFilters(row, params, names);
    const walk = tagRowWalkEvents(entry, params, order, pass, placed, names);
    const events = placed ? mergeTagWalkEvents(order, walk, tagPlaceStreamEvents(entry.db, order, pass, params.after ?? null, shows)) : walk;
    /** @type {object[]} */
    const rows = [];
    let examined = 0;
    for (const { position, row, show } of events) {
        examined++;
        if (show) {
            const tag = parseTagQueryRow(row);
            if (tag !== undefined) {
                rows.push(tag);
                if (rows.length === pageSize) return { rows, cursor: encodeTagQueryCursor(sort, position, pass), more: false };
            }
        }
        if (examined === TAG_QUERY_WORK_CAP) return { rows, cursor: encodeTagQueryCursor(sort, position, pass), more: true };
    }
    return { rows, cursor: null, more: false };
}

/**
 * The ids path: reads the ids through the primary key, checks every other filter per row, and orders them by the
 * sort in memory (manual: a tag with a tag_pending_places place at that place); bounded by the ids' own cap.
 * @param {MetadataDbEntry} entry
 * @param {TagQueryParams} params
 * @param {TagQueryPass | null} pass Manual only: the reorder pass whose mode order to use.
 * @returns {TagQueryResult}
 */
function queryTagsByIds(entry, params, pass) {
    const { sort, pageSize } = params;
    const order = pass?.mode ?? sort;
    const names = tagNameMatchers(params);
    const placed = sort === 'manual' && hasTagPendingPlacesSync(entry.db);
    const wanted = [...new Set(params.ids)];
    /** @type {{ position: TagQueryPosition, row: TagQueryRow }[]} */
    const found = [];
    for (let i = 0; i < wanted.length; i += TAG_QUERY_ID_CHUNK) {
        const slice = wanted.slice(i, i + TAG_QUERY_ID_CHUNK);
        const sql = `SELECT ${TAG_QUERY_ROW_COLUMNS} FROM tags WHERE id IN (${slice.map(() => '?').join(',')}) LIMIT ${slice.length}`;
        for (const row of /** @type {Generator<TagQueryRow>} */ (entry.db.iterate(sql, slice))) {
            if (row.marked) continue;
            if (params.folders === true && row.is_folder !== 1) continue;
            if (params.folderType !== undefined && row.folder_type !== params.folderType) continue;
            if (params.used === true && !(row.usage_count > 0)) continue;
            if (!names.matches(row.name_key)) continue;
            const place = placed
                ? /** @type {TagPlaceRow | undefined} */ (entry.db.get(`SELECT ${TAG_PLACE_COLUMNS} FROM tag_pending_places WHERE tag_id = @id`, { id: row.id }))
                : undefined;
            const position = (place ? tagPlacePosition(entry.db, order, pass, place) : null) ?? tagRowPosition(order, row);
            if (params.after && compareTagPositions(order, position, params.after) <= 0) continue;
            found.push({ position, row });
        }
    }
    found.sort((a, b) => compareTagPositions(order, a.position, b.position));
    /** @type {object[]} */
    const rows = [];
    for (const { position, row } of found) {
        const tag = parseTagQueryRow(row);
        if (tag === undefined) continue;
        rows.push(tag);
        if (rows.length === pageSize) return { rows, cursor: encodeTagQueryCursor(sort, position, pass), more: false };
    }
    return { rows, cursor: null, more: false };
}

/**
 * One keyset page of tag definitions (tags-paging step 2, D1, D11-D14). Tags marked deleted are left out. Manual,
 * while tag_pending_moves holds entries, shows the order they will leave once applied (tag_pending_places, tag-actions
 * D16). Manual while a reorder pass is recorded and not draining walks the pass mode's live order
 * instead, with the pending moves on top in that order's places (tag-actions step 6, D24, D26); a manual cursor is
 * good only for the order it was made in (D25.8).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {TagQueryParams} params
 * @returns {Promise<TagQueryResult | 'invalid-cursor' | 'not-ready' | null>} null when no SQLite
 *   engine is usable; 'invalid-cursor' for a manual cursor made in another order than the one read now; 'not-ready'
 *   until the derived columns are filled (tagQueryColumnsReady()), the one-time pass after an update.
 */
export async function queryTags(directories, params) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    if (!tagQueryColumnsReady(entry)) return 'not-ready';
    const pass = params.sort === 'manual' ? tagQueryPassSync(entry.db) : null;
    if (params.sort === 'manual' && params.after) {
        const made = params.after.pass ?? null;
        if (made?.id !== pass?.id || made?.mode !== pass?.mode) return 'invalid-cursor';
    }
    if (params.sort === 'manual') foldTagPendingIfBehindSync(entry.db);
    const result = params.ids ? queryTagsByIds(entry, params, pass) : queryTagsIndexed(entry, params, pass);
    if (params.counts !== true) return result;
    const ids = result.rows.map(tag => /** @type {{ id?: unknown }} */ (tag).id).filter(id => typeof id === 'string');
    return { ...result, ...tagCountsForIdsSync(entry, ids) };
}

/**
 * How many characters and groups carry each of `ids`, counted as prune judges a tag in use (UNUSED_TAGS_WHERE): the
 * tag's own tag_usage count, plus that of each marked tag merging into it, plus the batch-import rows not yet
 * flushed that carry it. So a count of 0 is exactly a tag prune would delete.
 *
 * An entity carrying both a tag and a marked tag merging into it counts twice until the migration worker merges its
 * rows; finding the overlap would read every row of the marked tag. Such a tag is listed in `approximate`.
 * @param {MetadataDbEntry} entry
 * @param {string[]} ids Distinct ids of tags that aren't marked; at most a page of them.
 * @returns {{ counts: Record<string, number>, approximate: string[] }}
 */
function tagCountsForIdsSync(entry, ids) {
    /** @type {Record<string, number>} */
    const counts = Object.fromEntries(ids.map(id => [id, 0]));
    /** @type {string[]} */
    const approximate = [];
    for (let i = 0; i < ids.length; i += TAG_QUERY_ID_CHUNK) {
        const slice = ids.slice(i, i + TAG_QUERY_ID_CHUNK);
        const marks = slice.map(() => '?').join(',');
        for (const row of /** @type {Generator<{ tag_id: string, count: number }>} */ (entry.db.iterate(`SELECT tag_id, count FROM tag_usage WHERE tag_id IN (${marks}) LIMIT ${slice.length}`, slice))) {
            counts[row.tag_id] += Number(row.count);
        }
        const merging = `SELECT d.merge_into AS id, SUM(u.count) AS n FROM tag_deletions d JOIN tag_usage u ON u.tag_id = d.tag_id
            WHERE d.merge_into IN (${marks}) GROUP BY d.merge_into LIMIT ${slice.length}`;
        for (const row of /** @type {Generator<{ id: string, n: number }>} */ (entry.db.iterate(merging, slice))) {
            if (!(row.n > 0)) continue;
            counts[row.id] += Number(row.n);
            approximate.push(row.id);
        }
    }

    const pending = entry.batch?.pending;
    if (!pending || pending.size === 0 || ids.length === 0) return { counts, approximate };
    // The marks of the buffer's own tag ids, by primary key: a buffered row carrying a marked tag carries its target.
    const buffered = [...new Set([...pending.values()].flatMap(row => row.tagIds))];
    /** @type {Map<string, string | null>} */
    const targets = new Map();
    for (let i = 0; i < buffered.length; i += TAG_QUERY_ID_CHUNK) {
        const slice = buffered.slice(i, i + TAG_QUERY_ID_CHUNK);
        const sql = `SELECT tag_id, merge_into FROM tag_deletions WHERE tag_id IN (${slice.map(() => '?').join(',')}) LIMIT ${slice.length}`;
        for (const row of /** @type {Generator<{ tag_id: string, merge_into: string | null }>} */ (entry.db.iterate(sql, slice))) {
            targets.set(row.tag_id, row.merge_into ?? null);
        }
    }
    const wanted = new Set(ids);
    for (const [avatar, row] of pending) {
        const carried = new Set(row.tagIds.map(id => targets.has(id) ? targets.get(id) : id));
        for (const id of carried) {
            if (typeof id !== 'string' || !wanted.has(id)) continue;
            // A buffered row written over a stored character: tag_usage already counts the stored assignment.
            if (entry.db.get('SELECT 1 FROM character_tags WHERE character_id = @avatar AND tag_id = @id', { avatar, id })) continue;
            counts[id]++;
        }
    }
    return { counts, approximate };
}

// Must check entry.batch.pending: a character imported inside a multi-file drop can still be buffered there
// rather than committed to the characters table when this runs.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @param {object} [options]
 * @param {boolean} [options.onlyExisting] Resolves only tags matching an existing definition, never minting a new one.
 * @returns {Promise<{ tagIds: string[], tagDefinitions: object[], heldTagNames: string[] }>} tagDefinitions is
 * returned alongside tagIds because the client can't resolve an id to a tag it has never seen a definition for.
 * heldTagNames are names that can't be resolved until fillTagNameKeysIfNeeded() has run; it assigns them then.
 */
export async function seedCardTagsForSingleCharacter(directories, avatar, { onlyExisting = false } = {}) {
    const none = { tagIds: [], tagDefinitions: [], heldTagNames: [] };
    const entry = await getEntry(directories);
    if (!entry) return none;

    const pending = entry.batch?.pending.get(avatar);
    const shallowJson = pending ? pending.row.shallow_json : (/** @type {{ shallow_json: string } | undefined} */ (entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: avatar })))?.shallow_json;
    if (shallowJson === undefined) return none;

    const names = cardTagNames(extractCardTags(shallowJson));
    if (names.length === 0) return none;

    /** @type {ResolvedCardTags} */
    let resolved = { tagIds: [], toCreate: [], held: [], learned: [] };
    /** @type {PendingRow | undefined} */
    let flushed;
    entry.db.transaction(() => {
        flushed = undefined;
        resolved = resolveCardTagNamesSync(entry.db, names, { ready: tagNameKeysReady(entry), onlyExisting });
        flushed = writeBufferedRowOverExistingSync(entry, avatar);
        if (pending && !flushed && resolved.held.length === 0) {
            // Tag definitions go straight to the tags table; the row's assignments wait in the buffer (below).
            createCardTagsSync(entry, resolved);
            return;
        }
        // Held names are resolved against the characters table, so the row can't stay in the buffer.
        if (pending && !flushed) flushed = writeBufferedRowSync(entry, avatar);
        writeResolvedCardTagsSync(entry, avatar, resolved, onlyExisting);
        if (resolved.tagIds.length > 0) syncShallowTagIdsFromTable(entry.db, avatar);
    });
    dropFromBuffer(entry, avatar, flushed);

    if (pending && !flushed && resolved.tagIds.length > 0) {
        // Row doesn't exist in `characters` yet for a not-yet-flushed pending write, so patch the buffer instead.
        for (const tagId of resolved.tagIds) {
            if (!pending.tagIds.includes(tagId)) pending.tagIds.push(tagId);
        }
        patchPendingRowTagIds(pending);
    }

    const definitionsById = new Map(resolved.learned.map(({ id, data }) => [id, JSON.parse(data)]));
    const tagDefinitions = resolved.tagIds.map(id => definitionsById.get(id)).filter((t) => t !== undefined);
    return { tagIds: resolved.tagIds, tagDefinitions, heldTagNames: resolved.held };
}

// Columns queryCharacters() may sort by via a plain `ORDER BY <column>`. Deliberately excludes 'random'
// (sorts by RANDHASH(id, seed), not a column) and 'search' (relevance order supplied by the caller as idOrder).
/** @type {Record<string, string>} */
/**
 * When a tag filter can be read from the tag sort tables: no id list, 'and' mode, at least one included tag and no
 * marked tag touching the filter. For each kind, the driver is the included tag with the fewest entities of that kind
 * (by entity_tag_counts once filled, otherwise the first), and the others are checked per row.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {{ tags?: any, ids?: string[] }} filter
 * @param {import('./tag-deletions.js').TagDeletions} deletions
 * @returns {{ character: { driver: string, others: string[] }, group: { driver: string, others: string[] }, rest: { exclude: string[], mode: 'and' } } | null}
 */
function includedTagSortPlan(db, { tags, ids }, deletions) {
    if (Array.isArray(ids)) return null;
    if (!tags || tags.mode === 'or') return null;
    if (expandTagFilter(tags, deletions)) return null;
    const include = Array.isArray(tags.include) ? [...new Set(tags.include.filter(Boolean).map(String))] : [];
    if (include.length === 0) return null;
    const exclude = Array.isArray(tags.exclude) ? tags.exclude.filter(Boolean).map(String) : [];
    /** @param {'character' | 'group'} kind */
    const order = (kind) => {
        const filled = db.get('SELECT 1 FROM entity_count_fill WHERE kind = @kind AND done = 1', { kind });
        if (!filled || include.length === 1) return { driver: include[0], others: include.slice(1) };
        const sized = include.map(tagId => ({
            tagId,
            n: Number(/** @type {{ n: number }} */ (db.get('SELECT COALESCE(SUM(count), 0) AS n FROM entity_tag_counts WHERE tag_id = @tagId AND kind = @kind', { tagId, kind })).n),
        }));
        sized.sort((a, b) => a.n - b.n);
        return { driver: sized[0].tagId, others: sized.slice(1).map(x => x.tagId) };
    };
    return { character: order('character'), group: order('group'), rest: { exclude, mode: 'and' } };
}

/**
 * The conditions of a buildWhereClause()/buildGroupWhereClause() result, without its WHERE.
 * @param {{ where: string }} built
 * @returns {string[]}
 */
function whereClausesOf(built) {
    return built.where ? [built.where.replace(/^WHERE /, '')] : [];
}

/**
 * One ordered stream of a sorted /query page: one kind of entity, one fav value, read through a sort index.
 * @typedef {object} SortedStream
 * @property {string} name The stream's name in the page cursor.
 * @property {'character' | 'group'} type
 * @property {number} fav
 * @property {string} from
 * @property {string[]} where
 * @property {unknown[]} args The arguments of `from` and `where`, in order.
 * @property {string | null} key The sort key's SQL, or null when this kind has no such key and ties decide.
 * @property {string} tie The tie key's SQL: a character's id, a group's `id || '.json'`.
 * @property {string} id The entity id's SQL.
 * @property {'ASC' | 'DESC'} dir
 * @property {string} field The EntityRow field the merge comparator reads the key from.
 * @property {{ table: 'characters' | 'groups', where: string[], args: unknown[] } | null} check The filters an index
 *   doesn't fix, checked per row on the entity table by id, a window at a time; null when the index fixes them all.
 */

/**
 * A sorted page's key row: enough for the merge comparator, the cursor and the page's row read.
 * @typedef {{ stream: string, type: 'character' | 'group', id: string, fav: number, k: unknown, t: string } & Record<string, unknown>} SortedKeyRow
 */

/**
 * The streams a sorted /query page merges: per kind and fav value, through the tag sort tables when an included tag
 * can drive the walk (step 5), otherwise through the fav-first sort indexes (step 4).
 * @param {MetadataDbEntry} entry
 * @param {object} p
 * @returns {SortedStream[]}
 */
function sortedPageStreams(entry, { column, sortOrder, fav, world, ranges, excludeIds, ids, tags, groupsOnly, charactersOnly = false, charWhere, groupWhere, deletions }) {
    const keyColumn = column === 'fav' ? 'name_fold' : column;
    const dir = column !== 'fav' && sortOrder === 'desc' ? 'DESC' : 'ASC';
    const field = column === 'fav' ? 'name_fold' : column;
    const groupKey = keyColumn === 'create_date' ? 'date_added' : keyColumn === 'data_size' ? null : keyColumn;
    const favValues = typeof fav === 'boolean' ? [fav ? 1 : 0] : [1, 0];
    const hasIds = Array.isArray(ids);
    const plan = !hasIds && tagSortTablesReady(entry) ? includedTagSortPlan(entry.db, { tags, ids }, deletions) : null;
    /**
     * @param {'characters' | 'groups'} table
     * @param {string[]} where
     * @param {unknown[]} args
     */
    const checkOf = (table, where, args) => where.length > 0 ? { table, where, args } : null;
    /** @type {SortedStream[]} */
    const streams = [];
    for (const favValue of favValues) {
        if (plan) {
            const restChar = buildWhereClause({ tags: plan.rest, fav, world, ranges, excludeIds }, deletions);
            const restGroup = buildGroupWhereClause({ tags: plan.rest, fav, ranges, excludeIds }, deletions);
            if (!groupsOnly) {
                streams.push({
                    name: `c${favValue}`, type: 'character', fav: favValue, dir, field,
                    from: 'character_tag_sort s', where: ['s.tag_id = ?', 's.k_fav = ?'], args: [plan.character.driver, favValue],
                    key: `s.k_${keyColumn}`, tie: 's.entity_id', id: 's.entity_id',
                    check: checkOf('characters', [...whereClausesOf(restChar),
                        ...plan.character.others.map(() => 'EXISTS (SELECT 1 FROM character_tags WHERE character_id = characters.id AND tag_id = ?)')],
                    [...restChar.args, ...plan.character.others]),
                });
            }
            if (!charactersOnly) streams.push({
                name: `g${favValue}`, type: 'group', fav: favValue, dir, field,
                from: 'group_tag_sort s', where: ['s.tag_id = ?', 's.k_fav = ?'], args: [plan.group.driver, favValue],
                key: groupKey ? `s.k_${groupKey}` : null, tie: '(s.entity_id || \'.json\')', id: 's.entity_id',
                check: checkOf('groups', [...whereClausesOf(restGroup),
                    ...plan.group.others.map(() => 'EXISTS (SELECT 1 FROM group_tags WHERE group_id = groups.id AND tag_id = ?)')],
                [...restGroup.args, ...plan.group.others]),
            });
        } else if (hasIds) {
            // An id list drives the read and bounds it; every filter goes in the one statement.
            if (!groupsOnly) {
                streams.push({
                    name: `c${favValue}`, type: 'character', fav: favValue, dir, field,
                    from: charWhere.from, where: [...whereClausesOf(charWhere), 'fav = ?'], args: [...charWhere.args, favValue],
                    key: keyColumn, tie: 'id', id: 'id', check: null,
                });
            }
            if (!charactersOnly) streams.push({
                name: `g${favValue}`, type: 'group', fav: favValue, dir, field,
                from: groupWhere.from, where: [...whereClausesOf(groupWhere), 'fav = ?'], args: [...groupWhere.args, favValue],
                key: groupKey, tie: '(id || \'.json\')', id: 'id', check: null,
            });
        } else {
            if (!groupsOnly) {
                streams.push({
                    name: `c${favValue}`, type: 'character', fav: favValue, dir, field,
                    from: 'characters', where: ['fav = ?'], args: [favValue],
                    key: keyColumn, tie: 'id', id: 'id',
                    check: checkOf('characters', whereClausesOf(charWhere), charWhere.args),
                });
            }
            if (!charactersOnly) streams.push({
                name: `g${favValue}`, type: 'group', fav: favValue, dir, field,
                from: 'groups', where: ['fav = ?'], args: [favValue],
                key: groupKey, tie: '(id || \'.json\')', id: 'id',
                check: checkOf('groups', whereClausesOf(groupWhere), groupWhere.args),
            });
        }
    }
    return streams;
}

/**
 * A sorted page's streams walked under the work cap (search plan step 1b, T2): each stream reads its index a window
 * at a time and checks the window's rows against the filters its index doesn't fix, the streams taking turns, until
 * each has `need` rows, has ended, or SEARCH_WORK_CAP rows have been read in all. When the cap stops a stream early,
 * only the merged rows no later than that stream's last row read are certain, so only those are returned, with
 * `more`.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {SortedStream[]} streams
 * @param {Record<string, [unknown, string]> | null} startAt
 * @param {number} need
 * @param {(a: any, b: any) => number} comparator
 * @param {number} [cap]
 * @returns {{ rows: SortedKeyRow[], ends: Record<string, [unknown, string]>, more: boolean }} rows: the merged
 *   rows, at most `need`, in order. ends: where each stream it moved should carry on from.
 */
/** walkSortedStreams()'s cap and window; tests make them small. */
const sortedPageWalk = { cap: SEARCH_WORK_CAP, window: SEARCH_WALK_WINDOW };

/**
 * Sets walkSortedStreams()'s work cap and window, so a test can reach the cap with a few rows. Tests only.
 * @param {{ cap?: number, window?: number } | null} values null restores the defaults.
 */
export function _setSortedPageWalkForTests(values) {
    sortedPageWalk.cap = values?.cap ?? SEARCH_WORK_CAP;
    sortedPageWalk.window = values?.window ?? SEARCH_WALK_WINDOW;
}

function walkSortedStreams(db, streams, startAt, need, comparator, cap = sortedPageWalk.cap) {
    const states = streams.map(stream => ({
        stream,
        /** @type {[unknown, string] | null} */
        position: startAt?.[stream.name] ?? null,
        /** @type {SortedKeyRow[]} */
        kept: [],
        /** @type {SortedKeyRow | null} */
        lastRead: null,
        ended: false,
    }));
    let examined = 0;
    // Whole rounds: every stream still going reads a window per round, so each makes progress in every request.
    for (;;) {
        const active = states.filter(state => !state.ended && state.kept.length < need);
        if (active.length === 0 || examined >= cap) break;
        for (const state of active) {
            const { stream } = state;
            const want = stream.check ? sortedPageWalk.window : Math.min(sortedPageWalk.window, need - state.kept.length);
            const window = readSortedKeys(db, stream, state.position, want);
            examined += window.length;
            if (window.length < want) state.ended = true;
            if (window.length === 0) continue;
            const last = window[window.length - 1];
            state.lastRead = last;
            state.position = [last.k, last.t];
            if (!stream.check) {
                state.kept.push(...window);
                continue;
            }
            const { table, where, args } = stream.check;
            /** @type {Set<string>} */
            const passing = new Set();
            for (const row of db.iterate(
                `SELECT id FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) AND ${where.join(' AND ')}`,
                [JSON.stringify(window.map(keyRow => keyRow.id)), ...args],
            )) passing.add(/** @type {{ id: string }} */ (row).id);
            state.kept.push(...window.filter(keyRow => passing.has(keyRow.id)));
        }
    }

    /** @type {SortedKeyRow[]} */
    let merged = [];
    for (const state of states) merged = /** @type {SortedKeyRow[]} */ (/** @type {unknown} */ (mergeSortedRows(/** @type {any} */ (merged), /** @type {any} */ (state.kept), comparator)));
    // A stream the cap stopped early may still hold rows before any row past its last row read.
    const cut = states.filter(state => !state.ended && state.kept.length < need);
    if (cut.length > 0) {
        merged = merged.filter(row => cut.every(state => state.lastRead !== null && comparator(row, state.lastRead) <= 0));
    }
    const rows = merged.slice(0, need);

    /** @type {Record<string, [unknown, string]>} */
    const ends = {};
    for (const row of rows) ends[row.stream] = [row.k, row.t];
    if (cut.length > 0 && merged.length <= need) {
        // Every row this request read up to the earliest cut stream's last row read is now returned or failed its
        // check, so that stream carries on after it; otherwise a stream whose window held nothing that passed would
        // be read again from the same place.
        const earliest = cut.reduce((a, b) => (a.lastRead !== null && b.lastRead !== null && comparator(b.lastRead, a.lastRead) < 0) ? b : a);
        if (earliest.lastRead !== null) ends[earliest.stream.name] = [earliest.lastRead.k, earliest.lastRead.t];
    }
    return { rows, ends, more: cut.length > 0 };
}

/**
 * Up to `limit` of a stream's key rows in its order, after `after` (a cursor's last [key, tie] for this stream) when
 * given. Each part seeks its index: the rest of the run sharing the last key, then the keys past it, then (for a
 * descending key) the rows with no key, which SQLite puts last.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {SortedStream} stream
 * @param {[unknown, string] | null} after
 * @param {number} limit
 * @returns {SortedKeyRow[]}
 */
function readSortedKeys(db, stream, after, limit) {
    const { key, tie, dir } = stream;
    /** @type {[string | null, unknown[]][]} */
    let parts;
    if (!after) {
        parts = [[null, []]];
    } else if (key === null) {
        parts = [[`${tie} > ?`, [after[1]]]];
    } else {
        const [lastKey, lastTie] = after;
        parts = [[`${key} IS ? AND ${tie} > ?`, [lastKey, lastTie]]];
        if (dir === 'ASC') {
            parts.push(lastKey === null ? [`${key} IS NOT NULL`, []] : [`${key} > ?`, [lastKey]]);
        } else if (lastKey !== null) {
            parts.push([`${key} < ?`, [lastKey]], [`${key} IS NULL`, []]);
        }
    }
    const order = `ORDER BY ${key !== null ? `${key} ${dir}, ` : ''}${tie} ASC`;
    /** @type {SortedKeyRow[]} */
    const out = [];
    for (const [condition, conditionArgs] of parts) {
        if (out.length >= limit) break;
        const where = condition !== null ? [...stream.where, condition] : stream.where;
        const rows = db.iterate(
            `SELECT ${stream.id} AS id, ${key ?? 'NULL'} AS k, ${tie} AS t FROM ${stream.from}
            ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ${order} LIMIT ?`,
            [...stream.args, ...conditionArgs, limit - out.length],
        );
        for (const row of /** @type {Iterable<{ id: string, k: unknown, t: string }>} */ (rows)) {
            out.push({ stream: stream.name, type: stream.type, id: row.id, fav: stream.fav, k: row.k, t: row.t, [stream.field]: row.k });
        }
    }
    return out;
}

/**
 * What a sorted page cursor is for: a cursor made for another filter or sort is ignored.
 * @param {object} params
 * @returns {string}
 */
function sortedPageCursorKey({ tags, fav, world, ranges, excludeIds, ids, groupsOnly, charactersOnly = false, sortField, sortOrder }) {
    return String(getStringHash(JSON.stringify({ tags: tags ?? null, fav: fav ?? null, world: world ?? null, ...(hasRanges(ranges) ? { ranges } : {}), excludeIds: excludeIds ?? null, ids: ids ?? null, groupsOnly: !!groupsOnly, ...(charactersOnly ? { charactersOnly: true } : {}), sortField: sortField ?? null, sortOrder: sortOrder ?? null })));
}

/**
 * @param {string} key
 * @param {Record<string, [unknown, string]>} ends Each stream's last [key, tie] returned so far.
 * @param {number} skip How much of a jump's skip is still to come.
 * @returns {string}
 */
function encodeSortedPageCursor(key, ends, skip) {
    return Buffer.from(JSON.stringify({ v: 'sp1', k: key, s: ends, r: skip })).toString('base64url');
}

/**
 * @param {unknown} cursor
 * @param {string} key
 * @returns {{ ends: Record<string, [unknown, string]>, skip: number } | null} null when absent, malformed, or made
 *   for another query.
 */
function decodeSortedPageCursor(cursor, key) {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 8192) return null;
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (parsed?.v !== 'sp1' || parsed.k !== key || typeof parsed.s !== 'object' || parsed.s === null) return null;
        /** @type {Record<string, [unknown, string]>} */
        const ends = {};
        for (const [name, end] of Object.entries(parsed.s)) {
            if (!/^[cg][01]$/.test(name) || !Array.isArray(end) || end.length !== 2 || typeof end[1] !== 'string') return null;
            if (end[0] !== null && typeof end[0] !== 'string' && typeof end[0] !== 'number') return null;
            ends[name] = [end[0], end[1]];
        }
        const skip = parsed.r ?? 0;
        if (!Number.isSafeInteger(skip) || skip < 0) return null;
        return { ends, skip };
    } catch {
        return null;
    }
}

/**
 * The full rows of a page's entities, in the page's order. An entity whose row is gone is left out.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {{ type: 'character' | 'group', id: string }[]} entities
 * @returns {EntityRow[]}
 */
function readEntityRowsInOrder(db, entities) {
    if (entities.length === 0) return [];
    /** @type {Map<string, EntityRow>} */
    const byKey = new Map();
    const characterIds = entities.filter(e => e.type === 'character').map(e => e.id);
    const groupIds = entities.filter(e => e.type === 'group').map(e => e.id);
    if (characterIds.length > 0) {
        for (const row of db.iterate(`SELECT ${ENTITY_CHARACTER_COLUMNS} FROM characters WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(characterIds)])) {
            byKey.set(`character:${/** @type {EntityRow} */ (row).id}`, /** @type {EntityRow} */ (row));
        }
    }
    if (groupIds.length > 0) {
        for (const row of db.iterate(`SELECT ${ENTITY_GROUP_COLUMNS} FROM groups WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(groupIds)])) {
            byKey.set(`group:${/** @type {EntityRow} */ (row).id}`, /** @type {EntityRow} */ (row));
        }
    }
    return entities.map(e => byKey.get(`${e.type}:${e.id}`)).filter(row => row !== undefined);
}

/** The sort columns /query orders characters by, each with an index pair that starts with fav. */
const CHARACTER_SORT_INDEX_COLUMNS = ['name_fold', 'date_added', 'date_last_chat', 'create_date', 'data_size', 'chat_size'];
/** The same for groups. create_date sorts groups by date_added; data_size has no group column, so ties decide. */
const GROUP_SORT_INDEX_COLUMNS = ['name_fold', 'date_added', 'date_last_chat', 'chat_size'];

/**
 * The indexes that hand out one fav value's rows in a sort's order, ties included, so a page stops after the page
 * (search plan step 4). Each column has an ascending and a descending index, both ending in the tie key ascending,
 * because ties stay in ascending tie order in both directions; reading one index backwards would reverse the ties.
 * A group's tie key is `id || '.json'`, its file name, as upstream reads groups.
 * @type {{ name: string, sql: string }[]}
 */
const ENTITY_SORT_INDEXES = [
    ...CHARACTER_SORT_INDEX_COLUMNS.flatMap(column => ['asc', 'desc'].map(dir => ({
        name: `idx_characters_sort_fav_${column}_${dir}`,
        sql: `CREATE INDEX IF NOT EXISTS idx_characters_sort_fav_${column}_${dir} ON characters(fav, ${column} ${dir.toUpperCase()}, id ASC)`,
    }))),
    ...GROUP_SORT_INDEX_COLUMNS.flatMap(column => ['asc', 'desc'].map(dir => ({
        name: `idx_groups_sort_fav_${column}_${dir}`,
        sql: `CREATE INDEX IF NOT EXISTS idx_groups_sort_fav_${column}_${dir} ON groups(fav, ${column} ${dir.toUpperCase()}, (id || '.json') ASC)`,
    }))),
    {
        name: 'idx_groups_sort_fav_key',
        sql: 'CREATE INDEX IF NOT EXISTS idx_groups_sort_fav_key ON groups(fav, (id || \'.json\') ASC)',
    },
];

/**
 * Builds the sort indexes a store doesn't have yet, one statement at a time, in the migration worker after the
 * server is listening. Until every one exists, /query keeps its one-statement-per-table page read.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<{ batches: number, rowsChanged: number } | undefined>}
 */
export async function buildEntitySortIndexesIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    let built = 0;
    for (const index of ENTITY_SORT_INDEXES) {
        if (entry.db.get('SELECT 1 FROM sqlite_master WHERE type = \'index\' AND name = ?', [index.name])) continue;
        entry.db.exec(index.sql);
        built++;
        await new Promise(resolve => setImmediate(resolve));
    }
    return { batches: built, rowsChanged: 0 };
}

/**
 * Whether every sort index exists. Stays true once it is.
 * @param {MetadataDbEntry} entry
 * @returns {boolean}
 */
function entitySortIndexesReady(entry) {
    if (entry.entitySortIndexes === true) return true;
    const placeholders = ENTITY_SORT_INDEXES.map(() => '?').join(', ');
    const found = /** @type {{ n: number } | undefined} */ (entry.db.get(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders})`,
        ENTITY_SORT_INDEXES.map(index => index.name),
    ));
    if (Number(found?.n ?? 0) !== ENTITY_SORT_INDEXES.length) return false;
    entry.entitySortIndexes = true;
    return true;
}

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

/**
 * The FROM of a query narrowed to an id list: the list drives it, and each listed id is looked up by primary key.
 * SQLite always keeps the left side of a CROSS JOIN as the outer loop, so this holds whatever other filters the
 * query has and whatever the planner would guess about them. As a plain `id IN (...)` filter, the list lost to
 * `fav = ?` or `world = ?` (this db keeps no ANALYZE statistics), and SQLite walked every row of that index to
 * check each against the list. GROUP BY (not DISTINCT) keeps a repeated id to one row and hands the ids over
 * sorted, so the lookups walk the primary key in order; in search order, a long list (every match of a common
 * word) jumps around the table and reads several times more of it. Rows therefore come back in id order, and
 * callers that need search order restore it in JS. Takes one bind argument, the list as JSON, which goes before
 * the WHERE clause's own.
 * @param {'characters'|'groups'} table
 */
function idListDrivenFrom(table) {
    return `(SELECT value AS want_id FROM json_each(?) GROUP BY value) CROSS JOIN ${table} ON id = want_id`;
}

/**
 * Pushes the clauses for a tag filter that a marked tag touches (expandTagFilter()). A row matches an included tag
 * when its tag is that tag or a marked tag merging into it; the marks are matched in the query itself, so no list of
 * them is read. 'and' mode counts the distinct tags a row's tags resolve to, not distinct tag ids.
 * @param {string[]} clauses
 * @param {any[]} args
 * @param {import('./tag-deletions.js').ExpandedTagFilter} expanded
 * @param {object} table
 * @param {'character_tags' | 'group_tags'} table.tagTable
 * @param {'character_id' | 'group_id'} table.entityColumn
 * @param {'characters' | 'groups'} table.outer
 * @param {string} table.rowSql Extra condition on each tag row, '' for none.
 * @param {boolean} perRow Check each row's own tag rows (an id list drives the query) rather than read every row
 *   carrying the tag.
 */
function pushExpandedTagClauses(clauses, args, expanded, { tagTable, entityColumn, outer, rowSql }, perRow) {
    if (expanded.none) {
        clauses.push('0');
        return;
    }
    const rowCondition = rowSql ? ` AND ${rowSql}` : '';
    /** The tag row's tag is one of the json list's tags, or a marked tag merging into one. Binds the list twice. */
    const matchesSql = `(${tagTable}.tag_id IN (SELECT value FROM json_each(?)) OR ${tagTable}.tag_id IN (SELECT d.tag_id FROM tag_deletions d WHERE d.merge_into IN (SELECT value FROM json_each(?))))`;
    /** @param {string[]} targets */
    const matchArgs = (targets) => [JSON.stringify(targets), JSON.stringify(targets)];
    const resolvedSql = `COALESCE((SELECT d.merge_into FROM tag_deletions d WHERE d.tag_id = ${tagTable}.tag_id), ${tagTable}.tag_id)`;
    const { include, exclude, mode } = expanded;
    if (include.length > 0) {
        if (mode === 'and') {
            if (perRow) {
                clauses.push(`(SELECT COUNT(DISTINCT ${resolvedSql}) FROM ${tagTable} WHERE ${entityColumn} = ${outer}.id AND ${matchesSql}${rowCondition}) = ?`);
                args.push(...matchArgs(include), include.length);
            } else {
                clauses.push(`id IN (SELECT ${entityColumn} FROM ${tagTable} WHERE ${matchesSql}${rowCondition} GROUP BY ${entityColumn} HAVING COUNT(DISTINCT ${resolvedSql}) = ?)`);
                args.push(...matchArgs(include), include.length);
            }
        } else if (perRow) {
            clauses.push(`EXISTS (SELECT 1 FROM ${tagTable} WHERE ${entityColumn} = ${outer}.id AND ${matchesSql}${rowCondition})`);
            args.push(...matchArgs(include));
        } else {
            clauses.push(`id IN (SELECT ${entityColumn} FROM ${tagTable} WHERE ${matchesSql}${rowCondition})`);
            args.push(...matchArgs(include));
        }
    }
    if (exclude.length > 0) {
        // Per row whether or not the filter has an id list: see buildWhereClause()'s excluded tags.
        clauses.push(`NOT EXISTS (SELECT 1 FROM ${tagTable} WHERE ${entityColumn} = ${outer}.id AND ${matchesSql}${rowCondition})`);
        args.push(...matchArgs(exclude));
    }
}

/**
 * The fields a /query range filter can bound, with the column each kind keeps it in. A group has no card text, so a
 * bound on `data_size` leaves groups out; groups keep their creation date in date_added.
 * @type {Readonly<Record<string, { character: string, group: string | null }>>}
 */
export const QUERY_RANGE_COLUMNS = Object.freeze({
    create_date: { character: 'create_date', group: 'date_added' },
    date_last_chat: { character: 'date_last_chat', group: 'date_last_chat' },
    chat_size: { character: 'chat_size', group: 'chat_size' },
    data_size: { character: 'data_size', group: null },
    closed_folders: { character: closedFolderCountSql('character_tags', 'character_id', 'characters'), group: closedFolderCountSql('group_tags', 'group_id', 'groups') },
});

/**
 * How many closed folder tags a row carries, as a correlated subquery on its own tag rows. Tags marked deleted
 * don't count. A tag's folder_type is read from its data, so it holds before the derived columns are filled.
 * @param {string} tagTable
 * @param {string} entityColumn
 * @param {string} outer The row's table.
 * @returns {string}
 */
function closedFolderCountSql(tagTable, entityColumn, outer) {
    return `(SELECT COUNT(*) FROM ${tagTable} AS cf JOIN tags AS cft ON cft.id = cf.tag_id WHERE cf.${entityColumn} = ${outer}.id`
        + ' AND CASE WHEN json_valid(cft.data) THEN json_extract(cft.data, \'$.folder_type\') END = \'CLOSED\''
        + ' AND cf.tag_id NOT IN (SELECT tag_id FROM tag_deletions))';
}

/** A `filter.ranges` field bounding how many rows of one tag a row carries: `tag:<id>`, 0 or 1. */
const QUERY_RANGE_TAG_PREFIX = 'tag:';

/**
 * Whether `field` is a field `filter.ranges` can bound: a QUERY_RANGE_COLUMNS field or `tag:<id>`.
 * @param {string} field
 * @returns {boolean}
 */
export function isQueryRangeField(field) {
    return Object.hasOwn(QUERY_RANGE_COLUMNS, field) || (field.startsWith(QUERY_RANGE_TAG_PREFIX) && field.length > QUERY_RANGE_TAG_PREFIX.length);
}

/**
 * The SQL `field` reads for `kind`, with its placeholders' values; null when `kind` has no such value.
 * @param {string} field
 * @param {'character' | 'group'} kind
 * @returns {{ sql: string, args: any[] } | null}
 */
function queryRangeColumn(field, kind) {
    if (field.startsWith(QUERY_RANGE_TAG_PREFIX)) {
        const [tagTable, entityColumn, outer] = kind === 'character' ? ['character_tags', 'character_id', 'characters'] : ['group_tags', 'group_id', 'groups'];
        return { sql: `(SELECT COUNT(*) FROM ${tagTable} WHERE ${entityColumn} = ${outer}.id AND tag_id = ?)`, args: [field.slice(QUERY_RANGE_TAG_PREFIX.length)] };
    }
    const column = Object.hasOwn(QUERY_RANGE_COLUMNS, field) ? QUERY_RANGE_COLUMNS[field][kind] : null;
    return column === null ? null : { sql: column, args: [] };
}

/**
 * @typedef {Record<string, { min?: number, max?: number }>} QueryRanges Inclusive bounds per isQueryRangeField()
 *   field; a missing end is open.
 */

/**
 * Whether `ranges` bounds anything.
 * @param {QueryRanges | undefined} ranges
 * @returns {boolean}
 */
function hasRanges(ranges) {
    return !!ranges && Object.keys(ranges).length > 0;
}

/**
 * Pushes `ranges` as row conditions on `kind`'s own columns: each row is checked as a walk or count reaches it.
 * @param {string[]} clauses
 * @param {any[]} args
 * @param {QueryRanges | undefined} ranges
 * @param {'character' | 'group'} kind
 */
function pushRangeClauses(clauses, args, ranges, kind) {
    if (!hasRanges(ranges)) return;
    for (const [field, bound] of Object.entries(ranges)) {
        const column = queryRangeColumn(field, kind);
        if (column === null) {
            clauses.push('0');
            continue;
        }
        if (typeof bound.min === 'number') {
            clauses.push(`${column.sql} >= ?`);
            args.push(...column.args, bound.min);
        }
        if (typeof bound.max === 'number') {
            clauses.push(`${column.sql} <= ?`);
            args.push(...column.args, bound.max);
        }
    }
}

// `ids: []` is handled specially by the caller (queryCharacters()): "match zero ids" is different from "no id
// filter requested". This function only ever sees a non-empty `ids` array, or none.
/**
 * @param {object} [filter]
 * @param {{ include?: string[], exclude?: string[], mode?: 'and'|'or' }} [filter.tags]
 * @param {boolean} [filter.fav]
 * @param {string} [filter.world]
 * @param {QueryRanges} [filter.ranges]
 * @param {string[]} [filter.excludeIds]
 * @param {string[]} [filter.ids]
 * @param {import('./tag-deletions.js').TagDeletions} [deletions]
 * @returns {{ from: string, where: string, args: any[] }} `args` binds `from`'s placeholders, then `where`'s.
 */
function buildWhereClause({ tags, fav, world, ranges, excludeIds, ids } = {}, deletions = NO_TAG_DELETIONS) {
    const clauses = [];
    const args = [];
    let from = 'characters';
    const hasIds = Array.isArray(ids) && ids.length > 0;

    if (hasIds) {
        from = idListDrivenFrom('characters');
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
    pushRangeClauses(clauses, args, ranges, 'character');
    const expanded = expandTagFilter(tags, deletions);
    if (expanded) {
        pushExpandedTagClauses(clauses, args, expanded, { tagTable: 'character_tags', entityColumn: 'character_id', outer: 'characters', rowSql: '' }, hasIds);
    } else if (tags) {
        const include = Array.isArray(tags.include) ? tags.include.filter(Boolean) : [];
        const exclude = Array.isArray(tags.exclude) ? tags.exclude.filter(Boolean) : [];
        const mode = tags.mode === 'or' ? 'or' : 'and';
        if (include.length > 0 && hasIds) {
            // Checks each hit's own rows by primary key; the `id IN` form below reads every character carrying the tag.
            if (mode === 'and') {
                clauses.push(`(SELECT COUNT(DISTINCT tag_id) FROM character_tags WHERE character_id = characters.id AND tag_id IN (${include.map(() => '?').join(', ')})) = ?`);
                args.push(...include, include.length);
            } else {
                clauses.push(`EXISTS (SELECT 1 FROM character_tags WHERE character_id = characters.id AND tag_id IN (${include.map(() => '?').join(', ')}))`);
                args.push(...include);
            }
        } else if (include.length > 0) {
            if (mode === 'and') {
                clauses.push(`id IN (SELECT character_id FROM character_tags WHERE tag_id IN (${include.map(() => '?').join(', ')}) GROUP BY character_id HAVING COUNT(DISTINCT tag_id) = ?)`);
                args.push(...include, include.length);
            } else {
                clauses.push(`id IN (SELECT character_id FROM character_tags WHERE tag_id IN (${include.map(() => '?').join(', ')}))`);
                args.push(...include);
            }
        }
        if (exclude.length > 0) {
            // Each row's own tag rows are checked by primary key as the walk reaches it; `id NOT IN (SELECT ...)`
            // would read every row of the excluded tags first.
            clauses.push('NOT EXISTS (SELECT 1 FROM character_tags WHERE character_id = characters.id AND tag_id IN (SELECT value FROM json_each(?)))');
            args.push(JSON.stringify(exclude));
        }
    }

    return { from, where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

/**
 * Every world some character links as its primary world, with how many characters link it, in world order, in
 * batches. Reads idx_characters_world only; each batch's read is finished before it is yielded, so the caller may
 * write between batches.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<AsyncGenerator<{ world: string, linkers: number }[], void, undefined> | null>} `null` if the
 * metadata store is unavailable.
 */
export async function streamLinkedWorlds(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    // world has TEXT affinity, so `> ''` keeps exactly the rows that are neither NULL nor ''; a later page's `> @after` implies it.
    return /** @type {AsyncGenerator<{ world: string, linkers: number }[], void, undefined>} */ (streamRows(entry.db, {
        firstPageSql: 'SELECT world, COUNT(*) AS linkers FROM characters WHERE world > \'\' GROUP BY world ORDER BY world LIMIT @limit',
        firstPageParams: {},
        nextPageSql: 'SELECT world, COUNT(*) AS linkers FROM characters WHERE world > @after GROUP BY world ORDER BY world LIMIT @limit',
        nextPageParams: {},
        keyColumn: 'world',
    }));
}

/**
 * How many character rows there are, for a background pass's progress over them.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<number | null>} `null` if the metadata store is unavailable.
 */
export async function countCharacterRows(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = /** @type {{ n: number } | undefined} */ (entry.db.get('SELECT COUNT(*) AS n FROM characters', {}));
    return Number(row?.n ?? 0);
}

/**
 * How many characters link a World, for a background pass's progress over them.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<number | null>} `null` if the metadata store is unavailable.
 */
export async function countCharactersLinkedToAWorld(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = /** @type {{ n: number } | undefined} */ (entry.db.get('SELECT COUNT(*) AS n FROM characters WHERE world > \'\'', {}));
    return Number(row?.n ?? 0);
}

/** Rows per batch in the bulk selection reads below. */
const BULK_BATCH_SIZE = 500;

/** A bulk job older than this is left over from a page that went away, and the next job drops it. */
const BULK_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Ids of the characters matching a `/query` filter with no search term (tags, fav, world, excludeIds), in rowid
 * order, in batches. Each batch's read is finished before it is yielded, so the caller may write between batches.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ tags?: { include?: string[], exclude?: string[], mode?: 'and'|'or' }, fav?: boolean, world?: string, excludeIds?: string[] }} filter
 * @returns {Promise<AsyncGenerator<string[], void, undefined> | null>} `null` if the metadata store is unavailable.
 */
export async function streamCharacterIdsMatching(directories, filter) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    return (async function* () {
        let after = -1;
        for (;;) {
            const { from, where, args } = buildWhereClause({
                tags: filter.tags,
                fav: typeof filter.fav === 'boolean' ? filter.fav : undefined,
                world: filter.world,
                ranges: filter.ranges,
                excludeIds: filter.excludeIds,
            }, readTagDeletionsSync(entry.db));
            const sql = `SELECT characters.rowid AS rid, characters.id AS id FROM ${from} ${where ? `${where} AND` : 'WHERE'} characters.rowid > ? ORDER BY characters.rowid LIMIT ?`;
            const rows = /** @type {{ rid: number, id: string }[]} */ (entry.db.readBounded(sql, [...args, after, BULK_BATCH_SIZE], BULK_BATCH_SIZE));
            if (rows.length > 0) yield rows.map(row => row.id);
            if (rows.length < BULK_BATCH_SIZE) return;
            after = rows[rows.length - 1].rid;
        }
    })();
}

/**
 * Starts a bulk job's selection, empty, and drops the jobs left over from pages that went away.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<string | null>} The job's id, or `null` if the metadata store is unavailable.
 */
export async function beginBulkSelection(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const staleBefore = Date.now() - BULK_JOB_MAX_AGE_MS;
    const stale = /** @type {{ job: string }[]} */ (entry.db.readBounded(
        'SELECT job FROM bulk_jobs WHERE created_at < @staleBefore ORDER BY created_at LIMIT 10',
        { staleBefore }, 10));
    for (const { job } of stale) {
        await dropBulkSelection(directories, job);
    }

    const job = crypto.randomUUID();
    entry.db.run('INSERT INTO bulk_jobs (job, created_at) VALUES (@job, @createdAt)', { job, createdAt: Date.now() });
    return job;
}

/**
 * Whether a bulk job exists.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} job
 * @returns {Promise<boolean>}
 */
export async function bulkSelectionExists(directories, job) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return Boolean(entry.db.get('SELECT 1 FROM bulk_jobs WHERE job = @job', { job }));
}

/**
 * Adds characters to a bulk job's selection. An avatar no character has is left out; one already in it stays once.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} job
 * @param {string[]} avatars
 * @returns {Promise<void>}
 */
export async function addToBulkSelection(directories, job, avatars) {
    const entry = await getEntry(directories);
    if (!entry || avatars.length === 0) return;
    for (let start = 0; start < avatars.length; start += BULK_BATCH_SIZE) {
        const batch = avatars.slice(start, start + BULK_BATCH_SIZE);
        for (const avatar of batch) {
            if (typeof avatar === 'string' && avatar) flushBufferedRow(entry, avatar);
        }
        entry.db.run(
            'INSERT OR IGNORE INTO bulk_selections (job, avatar) SELECT ?, id FROM characters WHERE id IN (SELECT value FROM json_each(?))',
            [job, JSON.stringify(batch)]);
    }
}

/**
 * Takes characters out of a bulk job's selection.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} job
 * @param {string[]} avatars
 * @returns {Promise<void>}
 */
export async function removeFromBulkSelection(directories, job, avatars) {
    const entry = await getEntry(directories);
    if (!entry || avatars.length === 0) return;
    for (let start = 0; start < avatars.length; start += BULK_BATCH_SIZE) {
        const batch = avatars.slice(start, start + BULK_BATCH_SIZE);
        entry.db.run(
            'DELETE FROM bulk_selections WHERE job = ? AND avatar IN (SELECT value FROM json_each(?))',
            [job, JSON.stringify(batch)]);
    }
}

/**
 * How many characters a bulk job's selection holds, and whether `avatar` is one of them.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} job
 * @param {string} [avatar]
 * @returns {Promise<{ count: number, contains: boolean }>}
 */
export async function describeBulkSelection(directories, job, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return { count: 0, contains: false };
    const row = /** @type {{ count: number }} */ (entry.db.get('SELECT COUNT(*) AS count FROM bulk_selections WHERE job = @job', { job }));
    const contains = typeof avatar === 'string' && avatar
        ? Boolean(entry.db.get('SELECT 1 FROM bulk_selections WHERE job = @job AND avatar = @avatar', { job, avatar }))
        : false;
    return { count: Number(row.count), contains };
}

/**
 * One page of a bulk job's selection, in avatar order, after `after`.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} job
 * @param {{ after?: string, limit?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function readBulkSelectionPage(directories, job, { after = '', limit = BULK_BATCH_SIZE } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    const bounded = Math.max(1, Math.min(BULK_BATCH_SIZE, Math.trunc(limit) || BULK_BATCH_SIZE));
    const rows = /** @type {{ avatar: string }[]} */ (entry.db.readBounded(
        'SELECT avatar FROM bulk_selections WHERE job = @job AND avatar > @after ORDER BY avatar LIMIT @limit',
        { job, after: String(after), limit: bounded }, bounded));
    return rows.map(row => row.avatar);
}

/**
 * A bulk job's selection in avatar order, in batches. Each batch's read is finished before it is yielded, so the
 * caller may write between batches, including deleting the characters it was handed.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} job
 * @returns {AsyncGenerator<string[], void, undefined>}
 */
export async function* streamBulkSelection(directories, job) {
    let after = '';
    for (;;) {
        const batch = await readBulkSelectionPage(directories, job, { after });
        if (batch.length > 0) yield batch;
        if (batch.length < BULK_BATCH_SIZE) return;
        after = batch[batch.length - 1];
    }
}

/**
 * The tags every character in a bulk job's selection carries. Read a batch at a time; the answer can only shrink, so
 * it never holds more than the first character's tags.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} job
 * @returns {Promise<string[] | null>} `null` if the metadata store is unavailable.
 */
export async function mutualTagIdsOfBulkSelection(directories, job) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    /** @type {string[] | null} */
    let mutual = null;
    for await (const batch of streamBulkSelection(directories, job)) {
        const candidates = mutual;
        // Only a tag every character of the batch carries is kept, so the list is at most the first one's tags.
        /** @type {string[]} */
        const next = [];
        const rows = /** @type {Iterable<{ tag_id: string, carriers: number }>} */ (entry.db.iterate(
            candidates === null
                ? 'SELECT tag_id, COUNT(*) AS carriers FROM character_tags WHERE character_id IN (SELECT value FROM json_each(?)) GROUP BY tag_id'
                : 'SELECT tag_id, COUNT(*) AS carriers FROM character_tags WHERE character_id IN (SELECT value FROM json_each(?)) AND tag_id IN (SELECT value FROM json_each(?)) GROUP BY tag_id',
            candidates === null ? [JSON.stringify(batch)] : [JSON.stringify(batch), JSON.stringify(candidates)]));
        for (const row of rows) {
            if (Number(row.carriers) === batch.length) next.push(row.tag_id);
        }
        mutual = next;
        if (mutual.length === 0) return [];
    }
    return mutual ?? [];
}

/**
 * Drops a bulk job and its selection.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} job
 * @returns {Promise<void>}
 */
export async function dropBulkSelection(directories, job) {
    const entry = await getEntry(directories);
    if (!entry) return;
    // In batches, so dropping a big selection doesn't hold the database for one long statement.
    for (;;) {
        const removed = entry.db.run(
            'DELETE FROM bulk_selections WHERE rowid IN (SELECT rowid FROM bulk_selections WHERE job = @job LIMIT @limit)',
            { job, limit: BULK_BATCH_SIZE * 10 }).changes;
        if (removed < BULK_BATCH_SIZE * 10) break;
        await new Promise(resolve => setImmediate(resolve));
    }
    entry.db.run('DELETE FROM bulk_jobs WHERE job = @job', { job });
}

/**
 * Ids of the characters that link `world` as their primary world, in batches. Pages by rowid, the order
 * idx_characters_world keeps within one world, so a page seeks instead of sorting every linker; each batch's read is
 * finished before it is yielded.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} world
 * @returns {Promise<AsyncGenerator<string[], void, undefined> | null>} `null` if the metadata store is unavailable.
 */
export async function streamCharactersLinkedToWorld(directories, world) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    return (async function* () {
        for await (const rows of streamRows(entry.db, {
            firstPageSql: 'SELECT rowid AS rid, id FROM characters WHERE world = @world ORDER BY rowid LIMIT @limit',
            firstPageParams: { world },
            nextPageSql: 'SELECT rowid AS rid, id FROM characters WHERE world = @world AND rowid > @after ORDER BY rowid LIMIT @limit',
            nextPageParams: { world },
            keyColumn: 'rid',
        })) {
            yield (/** @type {{ rid: number, id: string }[]} */ (rows)).map(row => row.id);
        }
    })();
}

/**
 * Whether any character links `world` as its primary world - one indexed lookup.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} world
 * @returns {Promise<boolean | null>} `null` if the metadata store is unavailable.
 */
export async function isWorldLinkedByAnyCharacter(directories, world) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    return !!entry.db.get('SELECT 1 FROM characters WHERE world = @world LIMIT 1', { world });
}

// A boot-time migration reading this store must check this first - bootstrapIfNeeded() runs in the
// background and isn't awaited, so an early query could see a partially-backfilled table.
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<boolean>}
 */
export async function isBootstrapComplete(directories) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return !!(/** @type {Record<string, unknown> | undefined} */ (entry.db.get('SELECT value FROM meta WHERE key = @key', { key: 'bootstrap_completed' })));
}

/** Generic one-time-per-user completion marker, keyed by the caller's own namespaced `key`. */
/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function isMigrationMarkedComplete(directories, key) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return !!(/** @type {Record<string, unknown> | undefined} */ (entry.db.get('SELECT value FROM meta WHERE key = @key', { key })));
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} key
 */
export async function markMigrationComplete(directories, key) {
    const entry = await getEntry(directories);
    if (!entry) return;
    setMetaSync(entry.db, key, String(Date.now()));
}

/**
 * Records that `migration` still has to write `id`, unsettled (a row already there is reset to unsettled).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} migration
 * @param {string} id
 */
export async function addMigrationPending(directories, migration, id) {
    const entry = await getEntry(directories);
    if (!entry) return;
    writeRowIfChanged(entry.db, 'migration_pending', { migration, id }, { settled: 0 }, { insert: true });
}

/**
 * Marks one pending row settled (the running retry pass is done with it) or unsettled.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} migration
 * @param {string} id
 * @param {boolean} settled
 */
export async function setMigrationPendingSettled(directories, migration, id, settled) {
    const entry = await getEntry(directories);
    if (!entry) return;
    writeRowIfChanged(entry.db, 'migration_pending', { migration, id }, { settled: settled ? 1 : 0 });
}

/**
 * Deletes every pending row of `migration`.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} migration
 */
export async function clearMigrationPending(directories, migration) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run('DELETE FROM migration_pending WHERE migration = @migration', { migration });
}

/**
 * Whether `migration` has any pending row, settled or not - one indexed lookup.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} migration
 * @returns {Promise<boolean>} false when the metadata store is unavailable.
 */
export async function hasMigrationPending(directories, migration) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return !!entry.db.get('SELECT 1 FROM migration_pending WHERE migration = @migration LIMIT 1', { migration });
}

/**
 * The pending rows of `migration`, in id order, in batches; each batch's read is finished before it is yielded, so the
 * caller may write between batches.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} migration
 * @returns {Promise<AsyncGenerator<{ id: string, settled: number }[], void, undefined> | null>} `null` if the metadata
 * store is unavailable.
 */
export async function streamMigrationPending(directories, migration) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    return (async function* () {
        for await (const rows of streamRows(entry.db, {
            firstPageSql: 'SELECT id, settled FROM migration_pending WHERE migration = @migration ORDER BY id LIMIT @limit',
            firstPageParams: { migration },
            nextPageSql: 'SELECT id, settled FROM migration_pending WHERE migration = @migration AND id > @after ORDER BY id LIMIT @limit',
            nextPageParams: { migration },
            keyColumn: 'id',
        })) {
            yield (/** @type {{ id: string, settled: number }[]} */ (rows)).map(row => ({ id: String(row.id), settled: Number(row.settled) }));
        }
    })();
}

/**
 * In one transaction: deletes the settled pending rows of `migration`, and stores `metaValue` under `metaKey` (`null`
 * deletes the key, `undefined` leaves it as it is).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} migration
 * @param {string} metaKey
 * @param {unknown} metaValue
 */
export async function commitMigrationSettled(directories, migration, metaKey, metaValue) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.transaction(() => {
        entry.db.run('DELETE FROM migration_pending WHERE migration = @migration AND settled = 1', { migration });
        if (metaValue === null) {
            entry.db.run('DELETE FROM meta WHERE key = @key', { key: metaKey });
        } else if (metaValue !== undefined) {
            setMetaSync(entry.db, metaKey, String(metaValue));
        }
    });
}

const COUNT_SAMPLE_RUNS = 20;
const COUNT_SAMPLE_RUN_SIZE = 500;
/** Rows a count estimate reads at most, across every kind and tag it samples. */
const COUNT_SAMPLE_BUDGET = COUNT_SAMPLE_RUNS * COUNT_SAMPLE_RUN_SIZE;

/**
 * A /query filter's total read from entity_counts / entity_tag_counts, for the shapes one counter answers: no
 * filter, fav alone, one included tag, or one excluded tag, each with or without fav. Null for any other shape.
 *
 * The tag is read as expandTagFilter() reads it: a marked tag acts on its merge target, or on no tag when it has
 * none. A marked tag merging into the target keeps its rows, and its counters, under its own id until
 * finishDeletedTags() moves them, and an entity can carry both, so while one exists the total is an estimate with no
 * walk of the overlap: an included tag counts the sum of the counters, and an excluded tag, whose rows' union lies
 * between the largest counter and the sum, counts the midpoint of (total - sum) and (total - largest), rounded,
 * never below 0.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {EntityCountKind['name'][]} kinds
 * @param {object} filter
 * @param {string[]} filter.include
 * @param {string[]} filter.exclude
 * @param {unknown} filter.fav
 * @param {unknown} filter.world
 * @param {import('./tag-deletions.js').TagDeletions} deletions
 * @returns {{ total: number, approxTotal: boolean } | null}
 */
function countFromCounters(db, kinds, { include, exclude, fav, world, ranges }, deletions) {
    if (typeof world === 'string' && world) return null;
    if (hasRanges(ranges)) return null;
    // Two entries, even the same tag twice ('and' mode then matches nothing), have no single counter.
    if (include.length + exclude.length > 1) return null;
    const named = include.length > 0 ? include[0] : exclude.length > 0 ? exclude[0] : null;

    const favs = favScope(fav);
    const total = kinds.reduce((n, kind) => n + storedEntityCount(db, kind, favs), 0);
    if (named === null) return { total, approxTotal: false };

    const target = resolveTagId(named, deletions);
    if (target === null) return { total: include.length > 0 ? 0 : total, approxTotal: false };
    const approxTotal = deletions.hasMergingInto(target);
    if (!approxTotal) {
        const count = kinds.reduce((n, kind) => n + storedTagCount(db, target, kind, favs), 0);
        return { total: include.length > 0 ? count : total - count, approxTotal };
    }
    const { sum, largest } = storedMergedTagCounts(db, target, kinds, favs);
    if (include.length > 0) return { total: sum, approxTotal };
    return { total: Math.max(0, Math.round(((total - sum) + (total - largest)) / 2)), approxTotal };
}

/** @param {unknown} fav @returns {number[]} The fav values a filter's fav keeps. */
function favScope(fav) {
    return typeof fav === 'boolean' ? [fav ? 1 : 0] : [0, 1];
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {EntityCountKind['name']} kind
 * @param {number[]} favs
 */
function storedEntityCount(db, kind, favs) {
    const row = /** @type {{ n: number }} */ (db.get('SELECT COALESCE(SUM(count), 0) AS n FROM entity_counts WHERE kind = @kind AND fav IN (SELECT value FROM json_each(@favs))', { kind, favs: JSON.stringify(favs) }));
    return Number(row.n);
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} tagId
 * @param {EntityCountKind['name']} kind
 * @param {number[]} favs
 */
function storedTagCount(db, tagId, kind, favs) {
    const row = /** @type {{ n: number }} */ (db.get('SELECT COALESCE(SUM(count), 0) AS n FROM entity_tag_counts WHERE tag_id = @tagId AND kind = @kind AND fav IN (SELECT value FROM json_each(@favs))', { tagId, kind, favs: JSON.stringify(favs) }));
    return Number(row.n);
}

/**
 * The counters of the unmarked tag `target` and every marked tag merging into it, summed per tag in the query: their
 * sum, and the largest one tag's.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} target
 * @param {EntityCountKind['name'][]} kinds
 * @param {number[]} favs
 * @returns {{ sum: number, largest: number }}
 */
function storedMergedTagCounts(db, target, kinds, favs) {
    const row = /** @type {{ sum: number | null, largest: number | null }} */ (db.get(`SELECT SUM(n) AS sum, MAX(n) AS largest FROM (
        SELECT SUM(count) AS n FROM entity_tag_counts
        WHERE (tag_id = @target OR tag_id IN (SELECT tag_id FROM tag_deletions WHERE merge_into = @target))
            AND kind IN (SELECT value FROM json_each(@kinds)) AND fav IN (SELECT value FROM json_each(@favs))
        GROUP BY tag_id)`, { target, kinds: JSON.stringify(kinds), favs: JSON.stringify(favs) }));
    return { sum: Number(row.sum ?? 0), largest: Number(row.largest ?? 0) };
}

/**
 * A /query filter's total without reading every match, or null when the caller runs its COUNT(*) statement: for a
 * non-empty id list (that statement reads only the listed rows), a tag id that isn't a string, or while the counters
 * of one of `kindNames` aren't filled.
 * - A shape countFromCounters() answers takes its total from there, less the excludeIds that exist and match the rest
 *   of the filter, each looked up by primary key, so it is exact whenever the counters' answer is.
 * - Any other shape is estimated by sampleEstimate(). world narrows characters only, so the groups of a world filter
 *   can still be a countFromCounters() shape while the characters are sampled.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {EntityCountKind['name'][]} kindNames
 * @param {object} filter
 * @param {{ include?: unknown, exclude?: unknown, mode?: unknown }} [filter.tags]
 * @param {unknown} [filter.fav]
 * @param {unknown} [filter.world]
 * @param {unknown} [filter.excludeIds]
 * @param {unknown} [filter.ids]
 * @param {import('./tag-deletions.js').TagDeletions} deletions
 * @param {number} seq The store's change seq, which seeds the sample with the filter.
 * @returns {{ total: number, approxTotal: boolean } | null}
 */
function totalWithoutCount(db, kindNames, { tags, fav, world, ranges, excludeIds, ids }, deletions, seq) {
    if (Array.isArray(ids) && ids.length > 0) return null;
    const include = tags && Array.isArray(tags.include) ? tags.include.filter(Boolean) : [];
    const exclude = tags && Array.isArray(tags.exclude) ? tags.exclude.filter(Boolean) : [];
    if (![...include, ...exclude].every(tagId => typeof tagId === 'string')) return null;
    for (const kind of kindNames) {
        const fill = /** @type {{ done: number } | undefined} */ (db.get('SELECT done FROM entity_count_fill WHERE kind = @kind', { kind }));
        if (fill?.done !== 1) return null;
    }
    const mode = tags?.mode === 'or' ? 'or' : 'and';
    const listed = Array.isArray(excludeIds) && excludeIds.length > 0 ? excludeIds : null;
    const kinds = ENTITY_COUNT_KINDS.filter(kind => kindNames.includes(kind.name));
    const worldOf = (/** @type {EntityCountKind} */ kind) => kind.name === 'character' ? world : undefined;

    let total = 0;
    let approxTotal = false;
    /** @type {EntityCountKind[]} */
    const counted = [];
    /** @type {EntityCountKind[]} */
    const sampled = [];
    const whole = countFromCounters(db, kindNames, { include, exclude, fav, world, ranges }, deletions);
    if (whole) {
        ({ total, approxTotal } = whole);
        counted.push(...kinds);
    } else {
        for (const kind of kinds) {
            const part = countFromCounters(db, [kind.name], { include, exclude, fav, world: worldOf(kind), ranges }, deletions);
            if (!part) {
                sampled.push(kind);
                continue;
            }
            total += part.total;
            approxTotal ||= part.approxTotal;
            counted.push(kind);
        }
    }
    if (listed) {
        for (const kind of counted) {
            const { from, where, args } = kind.name === 'character'
                ? buildWhereClause({ tags, fav, world, ranges, ids: listed }, deletions)
                : buildGroupWhereClause({ tags, fav, ranges, ids: listed }, deletions);
            total -= Number((/** @type {{ n: number }} */ (db.get(`SELECT COUNT(*) AS n FROM ${from} ${where}`, args))).n);
        }
    }
    if (sampled.length > 0) {
        const seed = JSON.stringify([
            kindNames, typeof fav === 'boolean' ? fav : null, [...include].sort(), [...exclude].sort(), mode,
            typeof world === 'string' && world ? world : null, listed ? listed.map(String).sort() : null, seq,
            ...(hasRanges(ranges) ? [ranges] : []),
        ]);
        const estimate = sampleEstimate(db, sampled, { tags, include, exclude, mode, fav, world, ranges, excludeIds }, deletions, seededRandom(seed));
        total += estimate.total;
        approxTotal ||= estimate.approxTotal;
    }
    return { total: approxTotal ? Math.max(0, total) : total, approxTotal };
}

/**
 * A deterministic stream of numbers in [0, 1) from a string: an FNV-1a hash of it seeds mulberry32.
 * @param {string} text
 * @returns {() => number}
 */
function seededRandom(text) {
    let state = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        state = Math.imul(state ^ text.charCodeAt(i), 0x01000193);
    }
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The total of a filter no counter answers, for `kinds`, from at most COUNT_SAMPLE_BUDGET sampled rows. Each sampled
 * entity is checked against the filter by primary key.
 * - With an included tag ('and' mode, or a single included tag): sample the included tag with the smallest counter
 *   (summed over `kinds` and both fav values, since fav is checked per row), preferring one no marked tag merges
 *   into, and scale the share of sampled entities that match by its counter.
 * - 'or' mode with 2+ included tags, the union estimator: taking the tags in id order, sample each and scale by its
 *   counter the share of its sampled entities that match the rest of the filter and carry no tag earlier in the
 *   order. Then clamp each kind's sum between its largest counter and the sum of its counters, at the filter's fav;
 *   the lower bound only while nothing but fav narrows the set further.
 * - Otherwise: sample the whole entity table and scale by its count.
 * A tag with marked tags merging into it is sampled over its rows and theirs as one population, matched in the query
 * so no list of them is read, each entity once, and scaled by the sum of their counters.
 *
 * The budget is split between kinds, then between the terms of each kind, in proportion to their counters. A
 * share that covers its whole tag or table is read in full, and a term whose rows are all read counts its matches
 * exactly. Otherwise the share is read as runs of COUNT_SAMPLE_RUN_SIZE rows in id order, each starting at the entity
 * of the kind's table at a random rowid, so starts follow the ids' real distribution, and wrapping to the start of
 * the tag or table if it runs off the end. A tag whose rows cluster in id space is sampled slightly unevenly; only
 * sampling random ranks of a dense numbering of the tag's rows would be uniform.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {EntityCountKind[]} kinds
 * @param {object} filter
 * @param {{ include?: unknown, exclude?: unknown, mode?: unknown }} [filter.tags]
 * @param {string[]} filter.include
 * @param {string[]} filter.exclude
 * @param {'and' | 'or'} filter.mode
 * @param {unknown} filter.fav
 * @param {unknown} filter.world
 * @param {unknown} filter.excludeIds
 * @param {import('./tag-deletions.js').TagDeletions} deletions
 * @param {() => number} random
 * @returns {{ total: number, approxTotal: boolean }}
 */
function sampleEstimate(db, kinds, { tags, include, exclude, mode, fav, world, ranges, excludeIds }, deletions, random) {
    /** @typedef {{ target: string, merged: boolean }} SampledTag An included tag; merged when marked tags merge into it. */
    /** @type {SampledTag[]} */
    const included = [];
    for (const id of include) {
        const target = resolveTagId(id, deletions);
        if (target === null) {
            if (mode === 'and') return { total: 0, approxTotal: false };
            continue;
        }
        if (!included.some(tag => tag.target === target)) included.push({ target, merged: deletions.hasMergingInto(target) });
    }
    if (include.length > 0 && included.length === 0) return { total: 0, approxTotal: false };

    const bothFavs = [0, 1];
    /** A tag's counter for one kind; a merged tag's is its own and its marked tags' summed in the query. */
    const tagSize = (/** @type {SampledTag} */ tag, /** @type {EntityCountKind['name']} */ kindName, /** @type {number[]} */ favs) => (tag.merged
        ? storedMergedTagCounts(db, tag.target, [kindName], favs).sum
        : storedTagCount(db, tag.target, kindName, favs));
    const groupSize = (/** @type {SampledTag} */ tag) => kinds.reduce((n, kind) => n + tagSize(tag, kind.name, bothFavs), 0);
    /** @type {{ tag: SampledTag | null, earlier: string[] }[]} tag null samples the whole table. */
    let terms;
    if (included.length === 0) {
        terms = [{ tag: null, earlier: [] }];
    } else if (mode === 'and' || included.length === 1) {
        const unmerged = included.filter(tag => !tag.merged);
        const candidates = unmerged.length > 0 ? unmerged : included;
        let source = candidates[0];
        let sourceSize = groupSize(source);
        for (const tag of candidates.slice(1)) {
            const size = groupSize(tag);
            if (size < sourceSize) [source, sourceSize] = [tag, size];
        }
        terms = [{ tag: source, earlier: [] }];
    } else {
        const ordered = [...included].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
        terms = ordered.map((tag, i) => ({ tag, earlier: ordered.slice(0, i).map(earlier => earlier.target) }));
    }

    const populations = kinds.map(kind => terms.map(term => (term.tag === null
        ? [{ tagId: null, merged: false, size: storedEntityCount(db, kind.name, bothFavs) }]
        : [{ tagId: term.tag.target, merged: term.tag.merged, size: tagSize(term.tag, kind.name, bothFavs) }])));
    const kindSizes = populations.map(perTerm => perTerm.flat().reduce((n, population) => n + population.size, 0));
    const allSize = kindSizes.reduce((a, b) => a + b, 0);
    if (allSize === 0) return { total: 0, approxTotal: false };

    let total = 0;
    let approxTotal = false;
    for (const [k, kind] of kinds.entries()) {
        const kindBudget = Math.floor(COUNT_SAMPLE_BUDGET * kindSizes[k] / allSize);
        const kindWorld = kind.name === 'character' ? world : undefined;
        let kindTotal = 0;
        let kindApprox = false;
        for (const [t, term] of terms.entries()) {
            /** @type {Set<string>} */
            const ids = new Set();
            let full = true;
            let termSize = 0;
            for (const { tagId, merged, size } of populations[k][t]) {
                const share = kindSizes[k] > 0 ? Math.floor(kindBudget * size / kindSizes[k]) : 0;
                full = readCountSample(db, kind, tagId, merged, size, share, random, ids) && full;
                termSize += size;
            }
            if (ids.size === 0) continue;
            const idsJson = JSON.stringify([...ids]);
            const checked = term.tag !== null && terms.length > 1
                ? { tags: { exclude: [...exclude, ...term.earlier] }, fav, world: kindWorld, ranges, excludeIds, ids: [...ids] }
                : { tags, fav, world: kindWorld, ranges, excludeIds, ids: [...ids] };
            const { from, where, args } = kind.name === 'character' ? buildWhereClause(checked, deletions) : buildGroupWhereClause(checked, deletions);
            const hits = Number((/** @type {{ n: number }} */ (db.get(`SELECT COUNT(*) AS n FROM ${from} ${where}`, args))).n);
            if (full) {
                kindTotal += hits;
                continue;
            }
            const existing = Number((/** @type {{ n: number }} */ (db.get(`SELECT COUNT(*) AS n FROM ${idListDrivenFrom(kind.table)}`, [idsJson]))).n);
            kindTotal += existing > 0 ? termSize * hits / existing : 0;
            kindApprox = true;
        }
        if (kindApprox && terms.length > 1) {
            const favs = favScope(fav);
            const counts = terms.map(term => tagSize(/** @type {SampledTag} */ (term.tag), kind.name, favs));
            const onlyFav = exclude.length === 0 && !(typeof kindWorld === 'string' && kindWorld) && !(Array.isArray(excludeIds) && excludeIds.length > 0);
            const lower = onlyFav ? counts.reduce((a, b) => Math.max(a, b), 0) : 0;
            const upper = counts.reduce((a, b) => a + b, 0);
            kindTotal = Math.min(Math.max(kindTotal, lower), upper);
        }
        total += kindTotal;
        approxTotal ||= kindApprox;
    }
    return { total: Math.round(total), approxTotal };
}

/**
 * Reads `share` entity ids of one sampled population into `ids`: the rows of `tagId` for `kind`, or with tagId null
 * the kind's entity table. See sampleEstimate() for how.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {EntityCountKind} kind
 * @param {string | null} tagId
 * @param {boolean} merged The population is `tagId`'s rows and those of every marked tag merging into it.
 * @param {number} size The population's counter.
 * @param {number} share
 * @param {() => number} random
 * @param {Set<string>} ids
 * @returns {boolean} Whether every row of the population was read.
 */
function readCountSample(db, kind, tagId, merged, size, share, random, ids) {
    if (size === 0) return true;
    if (share <= 0) return false;
    const column = tagId === null ? 'id' : kind.entityColumn;
    const from = tagId === null ? kind.table : kind.tagTable;
    const tagRows = merged ? '(tag_id = @tagId OR tag_id IN (SELECT tag_id FROM tag_deletions WHERE merge_into = @tagId))' : 'tag_id = @tagId';
    const rowsOf = tagId === null ? '' : `${tagRows} AND ${kind.tagRowCounts(kind.entityColumn)} AND `;
    const base = tagId === null ? {} : { tagId };
    const read = (/** @type {string} */ condition, /** @type {object} */ params) => {
        let n = 0;
        for (const row of /** @type {Iterable<{ id: string }>} */ (db.iterate(`SELECT ${column} AS id FROM ${from} WHERE ${rowsOf}${condition} ORDER BY ${column} LIMIT @len`, { ...base, ...params }))) {
            ids.add(row.id);
            n++;
        }
        return n;
    };

    if (size <= share) {
        read('1', { len: share });
        return true;
    }
    const bounds = /** @type {{ lo: number | null }} */ (db.get(`SELECT MIN(rowid) AS lo FROM ${kind.table}`));
    const top = /** @type {{ hi: number | null }} */ (db.get(`SELECT MAX(rowid) AS hi FROM ${kind.table}`));
    if (bounds.lo === null || top.hi === null) return false;
    for (let offset = 0; offset < share; offset += COUNT_SAMPLE_RUN_SIZE) {
        const len = Math.min(COUNT_SAMPLE_RUN_SIZE, share - offset);
        const rowid = bounds.lo + Math.floor(random() * (top.hi - bounds.lo + 1));
        const startRow = /** @type {{ id: string } | undefined} */ (db.get(`SELECT id FROM ${kind.table} WHERE rowid >= @rowid ORDER BY rowid LIMIT 1`, { rowid }));
        if (!startRow) continue;
        const got = read(`${column} >= @start`, { start: startRow.id, len });
        if (got < len) read(`${column} < @start`, { start: startRow.id, len: len - got });
    }
    return false;
}

/**
 * Browse/sort/filter query backing `POST /api/characters/query`, entirely SQLite-backed.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} [params]
 * @param {{ include?: string[], exclude?: string[], mode?: 'and'|'or' }} [params.tags]
 * @param {boolean} [params.fav]
 * @param {string} [params.world]
 * @param {string[]} [params.excludeIds]
 * @param {string[]} [params.ids] Present-but-empty short-circuits to an empty result.
 * @param {string} [params.sortField] A QUERYABLE_SORT_COLUMNS key, or 'random' (needs `seed`), or 'search'
 * (needs `idOrder`).
 * @param {'asc'|'desc'} [params.sortOrder]
 * @param {number} [params.seed] Must stay stable across pages of the same query or pages return inconsistent
 * permutations.
 * @param {string[]} [params.idOrder] Relevance-ordered id list from the search engine when sortField === 'search'.
 * @param {number} [params.offset]
 * @param {number} [params.limit]
 * @param {boolean} [params.wantRows]
 * @param {boolean} [params.wantTotal]
 * @param {boolean} [params.wantHashes] Returns `hashRows` (per-row content hashes) instead of `rows`, computed
 * live from shallow_json rather than the stored digest_* columns, which can drift from a fresh recompute.
 * @returns {Promise<{ rows: object[] | undefined, hashRows: object[] | undefined, total: number | undefined, approxTotal: boolean, seq: number } | null>}
 * `null` means the metadata store is unavailable - callers must not fall back to a live filesystem scan.
 * `approxTotal` marks `total` as an estimate (totalWithoutCount()).
 */
export async function queryCharacters(directories, params = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const {
        tags, fav, world, ranges, excludeIds, ids,
        sortField, sortOrder, seed, idOrder,
        offset, limit,
        wantRows = true, wantTotal = true,
        wantHashes = false,
    } = params;

    if (readDependsOnActivity(sortField, ranges) && !isReadOnlyMode()) foldActivitySync(entry.db);
    const seqRow = (/** @type {{ seq: number } | undefined} */ (entry.db.get('SELECT COALESCE(MAX(seq), 0) as seq FROM changes')));
    const seq = Number(seqRow?.seq ?? 0);

    if (Array.isArray(ids) && ids.length === 0) {
        return { rows: wantRows ? [] : undefined, hashRows: wantHashes ? [] : undefined, total: wantTotal ? 0 : undefined, approxTotal: false, seq };
    }

    const deletions = readTagDeletionsSync(entry.db);
    const { from, where, args } = buildWhereClause({ tags, fav, world, ranges, excludeIds, ids }, deletions);

    let total;
    let approxTotal = false;
    if (wantTotal) {
        const counted = totalWithoutCount(entry.db, ['character'], { tags, fav, world, ranges, excludeIds, ids }, deletions, seq);
        if (counted) {
            ({ total, approxTotal } = counted);
        } else {
            const countRow = (/** @type {{ total: number } | undefined} */ (entry.db.get(`SELECT COUNT(*) as total FROM ${from} ${where}`, args)));
            total = Number(countRow?.total ?? 0);
        }
    }

    // digest_fav/digest_tag_ids/digest_content are plain column reads - writeShallowJson() is the only place
    // shallow_json is written outside buildRow()/writeRowSync()'s own row construction, and it always writes
    // these three columns in the same statement, so a stored value here can never be stale relative to shallow_json.
    // shallow_json only for characterTagIdsDigestForReader(), and only while some tag is marked deleted.
    const HASH_COLUMNS = `id, active_chat, date_added, create_date, date_last_chat, chat_size, data_size, digest_fav, digest_tag_ids, digest_content${deletions.any ? ', shallow_json' : ''}`;
    /** @param {HashSourceRow & { shallow_json?: string }} r */
    const toHashRow = (r) => ({
        id: r.id,
        chat: r.active_chat,
        date_added: r.date_added,
        create_date: r.create_date,
        date_last_chat: r.date_last_chat,
        chat_size: r.chat_size,
        data_size: r.data_size,
        favHash: r.digest_fav >>> 0,
        tagIdsHash: characterTagIdsDigestForReader(r.digest_tag_ids, r.shallow_json, deletions),
        contentHash: r.digest_content >>> 0,
    });

    let rows, hashRows;
    if ((wantRows || wantHashes) && sortField === 'search') {
        const orderedIds = Array.isArray(idOrder) ? idOrder : [];
        const numericOffset = typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
        const numericLimit = typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : DEFAULT_QUERY_LIMIT;
        // orderedIds is the search engine's full relevance-ranked id list, known before any DB query - slice to
        // the requested page first, then fetch only those ids, so cost is bounded by page size, never by the
        // total match count. `fav`, `tags`, `excludeIds` and an explicit `ids` allowlist are applied inside the
        // search engine itself (runIdSearch()), so orderedIds is already consistent with them; `where` below still
        // enforces them because the index can lag the db. `world` is NOT applied by the search engine (no world
        // field exists in the tantivy schema) - `where` enforces it here, but since orderedIds's ranking doesn't
        // know about it, a page that lands on an id it excludes comes back short of `limit` rather than backfilled
        // from further down the ranking. Known gap, not silently dropped.
        const pageIds = orderedIds.slice(numericOffset, numericOffset + numericLimit);
        if (pageIds.length === 0) {
            hashRows = wantHashes ? [] : undefined;
            rows = wantRows ? [] : undefined;
        } else {
            const pageWhere = where ? `${where} AND id IN (SELECT value FROM json_each(?))` : 'WHERE id IN (SELECT value FROM json_each(?))';
            const pageArgs = [...args, JSON.stringify(pageIds)];
            if (wantHashes) {
                const rawRows = Array.from(/** @type {Iterable<HashSourceRow>} */ (entry.db.iterate(`SELECT ${HASH_COLUMNS} FROM ${from} ${pageWhere}`, pageArgs)));
                const rowById = new Map(rawRows.map(r => [r.id, r]));
                hashRows = pageIds
                    .filter(id => rowById.has(id))
                    .map(id => toHashRow(/** @type {HashSourceRow} */ (rowById.get(id))));
            } else {
                const rawRows = Array.from(/** @type {Iterable<{ id: string, shallow_json: string }>} */ (entry.db.iterate(`SELECT id, shallow_json FROM ${from} ${pageWhere}`, pageArgs)));
                const shallowById = new Map(rawRows.map(r => [r.id, r.shallow_json]));
                rows = pageIds
                    .filter(id => shallowById.has(id))
                    .map(id => parseShallowResolvingTags(/** @type {string} */ (shallowById.get(id)), deletions));
            }
        }
    } else if (wantRows || wantHashes) {
        const orderParts = [];
        if (sortField === 'random') {
            const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
            orderParts.push(`RANDHASH(id, ?) ${direction}`);
        } else {
            const column = QUERYABLE_SORT_COLUMNS[sortField ?? ''];
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

        const numericOffset = typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
        const numericLimit = typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : DEFAULT_QUERY_LIMIT;

        // The RANDHASH(id, ?) placeholder above (when present) is the first `?` after the WHERE clause's own
        // args, so its bind value goes right after `args` and before the LIMIT/OFFSET pair - SQLite binds `?`
        // placeholders strictly in the order they appear in the SQL text.
        const orderArgs = sortField === 'random' ? [Number(seed) || 0] : [];
        const sortColumn = sortField === 'random' ? undefined : QUERYABLE_SORT_COLUMNS[sortField ?? ''];
        /** @type {{ ids: string[], cursor: string | undefined, more: boolean } | null} */
        let walkedPage = null;
        if (sortField === 'random' && randomRanksReady(entry)) {
            const page = randomOrderPage(entry, {
                kinds: { character: true, group: false }, tags, fav, world, ranges, excludeIds, ids, sortOrder,
                seed: Number(seed) || 0, offset: numericOffset, limit: numericLimit, cursor: params.cursor, deletions,
            });
            walkedPage = { ids: page.entities.map(e => e.id), cursor: page.cursor, more: page.more };
        } else if (sortColumn && entitySortIndexesReady(entry)) {
            // The same walk as queryEntities()'s sorted page, with characters only: keys through the fav-first sort
            // indexes or the tag sort tables, under the work cap, a cursor to seek from, full rows for the page alone.
            const charWhere = { from, where, args };
            const streams = sortedPageStreams(entry, {
                column: sortColumn, sortOrder, fav, world, ranges, excludeIds, ids, tags, groupsOnly: false, charactersOnly: true, charWhere, groupWhere: null, deletions,
            });
            const cursorKey = sortedPageCursorKey({ tags, fav, world, ranges, excludeIds, ids, groupsOnly: false, charactersOnly: true, sortField, sortOrder });
            const cursorAt = decodeSortedPageCursor(params.cursor, cursorKey);
            const skip = cursorAt ? cursorAt.skip : numericOffset;
            const walked = walkSortedStreams(entry.db, streams, cursorAt?.ends ?? null, skip + numericLimit, makeEntityMergeComparator(sortField, sortOrder, seed), Array.isArray(ids) ? Infinity : undefined);
            const pageIds = walked.rows.slice(skip).map(r => r.id);
            const more = walked.more && pageIds.length < numericLimit;
            const ends = { ...(cursorAt?.ends ?? {}), ...walked.ends };
            const cursor = more || pageIds.length === numericLimit ? encodeSortedPageCursor(cursorKey, ends, Math.max(0, skip - walked.rows.length)) : undefined;
            walkedPage = { ids: pageIds, cursor, more };
        }
        if (walkedPage) {
            const { ids: pageIds, cursor, more } = walkedPage;
            const pageJson = JSON.stringify(pageIds);
            if (wantHashes) {
                const byId = new Map(Array.from(/** @type {Iterable<HashSourceRow>} */ (entry.db.iterate(`SELECT ${HASH_COLUMNS} FROM characters WHERE id IN (SELECT value FROM json_each(?))`, [pageJson]))).map(r => [r.id, r]));
                hashRows = pageIds.filter(id => byId.has(id)).map(id => toHashRow(/** @type {HashSourceRow} */ (byId.get(id))));
            } else {
                const byId = new Map(Array.from(/** @type {Iterable<{ id: string, shallow_json: string }>} */ (entry.db.iterate('SELECT id, shallow_json FROM characters WHERE id IN (SELECT value FROM json_each(?))', [pageJson]))).map(r => [r.id, r.shallow_json]));
                rows = pageIds.filter(id => byId.has(id)).map(id => parseShallowResolvingTags(/** @type {string} */ (byId.get(id)), deletions));
            }
            overlayQueryRowsSync(entry.db, rows, hashRows);
            return { rows, hashRows, total, approxTotal, seq, ...(cursor !== undefined ? { cursor } : {}), ...(more ? { more: true } : {}) };
        }
        if (wantHashes) {
            const rawRows = (/** @type {HashSourceRow[]} */ (entry.db.readBounded(`SELECT ${HASH_COLUMNS} FROM ${from} ${where} ${orderBy} LIMIT ? OFFSET ?`, [...args, ...orderArgs, numericLimit, numericOffset], numericLimit)));
            hashRows = rawRows.map(toHashRow);
        } else {
            const rawRows = (/** @type {{ shallow_json: string }[]} */ (entry.db.readBounded(`SELECT shallow_json FROM ${from} ${where} ${orderBy} LIMIT ? OFFSET ?`, [...args, ...orderArgs, numericLimit, numericOffset], numericLimit)));
            rows = rawRows.map(r => parseShallowResolvingTags(r.shallow_json, deletions));
        }
    }

    overlayQueryRowsSync(entry.db, rows, hashRows);
    return { rows, hashRows, total, approxTotal, seq };
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
 * @param {import('./tag-deletions.js').TagDeletions} [deletions]
 * @returns {{ from: string, where: string, args: any[] }} `args` binds `from`'s placeholders, then `where`'s.
 */
function buildGroupWhereClause({ tags, fav, ranges, excludeIds, ids } = {}, deletions = NO_TAG_DELETIONS) {
    const clauses = [];
    const args = [];
    let from = 'groups';
    const hasIds = Array.isArray(ids) && ids.length > 0;

    if (hasIds) {
        from = idListDrivenFrom('groups');
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
    pushRangeClauses(clauses, args, ranges, 'group');
    const expanded = expandTagFilter(tags, deletions);
    if (expanded) {
        pushExpandedTagClauses(clauses, args, expanded, { tagTable: 'group_tags', entityColumn: 'group_id', outer: 'groups', rowSql: GROUP_TAG_ROW_IS_GROUP_SQL }, hasIds);
    } else if (tags) {
        const include = Array.isArray(tags.include) ? tags.include.filter(Boolean) : [];
        const exclude = Array.isArray(tags.exclude) ? tags.exclude.filter(Boolean) : [];
        const mode = tags.mode === 'or' ? 'or' : 'and';
        if (include.length > 0 && hasIds) {
            // Checks each hit's own rows by primary key; the `id IN` form below reads every group carrying the tag.
            if (mode === 'and') {
                clauses.push(`(SELECT COUNT(DISTINCT tag_id) FROM group_tags WHERE group_id = groups.id AND tag_id IN (${include.map(() => '?').join(', ')}) AND ${GROUP_TAG_ROW_IS_GROUP_SQL}) = ?`);
                args.push(...include, include.length);
            } else {
                clauses.push(`EXISTS (SELECT 1 FROM group_tags WHERE group_id = groups.id AND tag_id IN (${include.map(() => '?').join(', ')}) AND ${GROUP_TAG_ROW_IS_GROUP_SQL})`);
                args.push(...include);
            }
        } else if (include.length > 0) {
            if (mode === 'and') {
                clauses.push(`id IN (SELECT group_id FROM group_tags WHERE tag_id IN (${include.map(() => '?').join(', ')}) AND ${GROUP_TAG_ROW_IS_GROUP_SQL} GROUP BY group_id HAVING COUNT(DISTINCT tag_id) = ?)`);
                args.push(...include, include.length);
            } else {
                clauses.push(`id IN (SELECT group_id FROM group_tags WHERE tag_id IN (${include.map(() => '?').join(', ')}) AND ${GROUP_TAG_ROW_IS_GROUP_SQL})`);
                args.push(...include);
            }
        }
        if (exclude.length > 0) {
            clauses.push(`NOT EXISTS (SELECT 1 FROM group_tags WHERE group_id = groups.id AND tag_id IN (SELECT value FROM json_each(?)) AND ${GROUP_TAG_ROW_IS_GROUP_SQL})`);
            args.push(JSON.stringify(exclude));
        }
    }

    return { from, where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

// queryEntities() (below) is the `filter.includeGroups: true` half of `POST /api/characters/query` - it queries
// characters and groups as two separate per-table queries with a JS merge-sort (see mergeSortedRows()), not a
// UNION ALL, so each table keeps its own index-backed ORDER BY.

/**
 * Hash-sorted array of all entity IDs, cached per (handle, seed, seq, groupsVersion). With an unknown groups
 * version (null) it's neither served from nor stored in the cache.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} handle
 * @param {number} seed
 * @param {number} seq
 * @param {number | null} groupsVersion
 * @returns {string[]}
 */
function getRandomSortedEntityIds(db, handle, seed, seq, groupsVersion) {
    const key = `${handle}:${seed}`;
    const entry = groupsVersion === null ? undefined : randomSortCache.get(key);
    if (entry && entry.seq === seq && entry.groupsVersion === groupsVersion) {
        randomSortCache.delete(key);
        randomSortCache.set(key, entry);
        return entry.sortedIds;
    }

    const charIds = (/** @type {{ id: string }[]} */ (db.all('SELECT id FROM characters'))).map(r => r.id);
    const groupIds = (/** @type {{ id: string }[]} */ (db.all('SELECT id FROM groups'))).map(r => r.id);
    const allIds = [...charIds, ...groupIds];
    const hashed = allIds.map(id => ({ id, h: getStringHash(String(id), Number(seed)) }));
    hashed.sort((a, b) => a.h - b.h);
    const sortedIds = hashed.map(r => r.id);
    if (groupsVersion === null) return sortedIds;

    if (randomSortCache.size >= MAX_RANDOM_CACHE_ENTRIES && !randomSortCache.has(key)) {
        const oldest = randomSortCache.keys().next().value;
        if (oldest !== undefined) randomSortCache.delete(oldest);
    }

    randomSortCache.set(key, { seq, groupsVersion, sortedIds, db });
    return sortedIds;
}

/** Must match the ORDER BY each side's own SQL query used, so the merge stays a true sorted merge. */
/**
 * @param {string} [sortField]
 * @param {string} [sortOrder]
 * @param {number} [seed]
 * @returns {(a: EntityRow, b: EntityRow) => number}
 */
function makeEntityMergeComparator(sortField, sortOrder, seed) {
    const dir = sortOrder === 'desc' ? -1 : 1;
    /** @type {(a: EntityRow, b: EntityRow) => number} */
    const tiebreak = compareEntityTie;

    if (sortField === 'random') {
        return (a, b) => {
            const ha = getStringHash(a.id, Number(seed ?? 0));
            const hb = getStringHash(b.id, Number(seed ?? 0));
            return dir * (ha - hb) || tiebreak(a, b);
        };
    }

    const column = QUERYABLE_SORT_COLUMNS[sortField ?? ''];
    if (!column) return tiebreak;

    if (column === 'name_fold') {
        return (a, b) => dir * compareUtf8(a.name_fold, b.name_fold) || tiebreak(a, b);
    }
    if (column === 'fav') {
        // The direction picks which fav value comes first; names stay ascending inside each.
        return (a, b) => dir * ((a.fav ? 1 : 0) - (b.fav ? 1 : 0))
            || compareUtf8(a.name_fold, b.name_fold)
            || tiebreak(a, b);
    }
    // Remaining columns (date_added, date_last_chat, chat_size, create_date, data_size) are all plain numeric.
    // Dynamic-by-name lookup, hence the `any` casts - `column` is a runtime string, not a literal key.
    return (a, b) => dir * compareNullableNumbers(/** @type {any} */ (a)[column], /** @type {any} */ (b)[column]) || tiebreak(a, b);
}

/**
 * Compares two sort keys as SQLite orders them: NULL below every number.
 * @param {number | null | undefined} a
 * @param {number | null | undefined} b
 * @returns {number}
 */
function compareNullableNumbers(a, b) {
    const aNull = a === null || a === undefined;
    const bNull = b === null || b === undefined;
    if (aNull || bNull) return aNull === bNull ? 0 : aNull ? -1 : 1;
    return Number(a) - Number(b);
}

/**
 * Compares two strings by their UTF-8 bytes, as SQLite's BINARY collation does. JS `<` compares UTF-16 code units,
 * which differs from it for characters from U+E000 upward against characters outside the BMP.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareUtf8(a, b) {
    if (a === b) return 0;
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Upstream's order for entities with the same sort key, in both directions: it sorts every character, then every
 * group, with a stable sort, and reads each from its folder in file-name byte order. So characters come before
 * groups, a character by its id (its file name) and a group by `<id>.json`.
 * @param {EntityRow} a
 * @param {EntityRow} b
 * @returns {number}
 */
function compareEntityTie(a, b) {
    const ka = a.type === 'group' ? 1 : 0;
    const kb = b.type === 'group' ? 1 : 0;
    if (ka !== kb) return ka - kb;
    return ka === 1 ? compareUtf8(`${a.id}.json`, `${b.id}.json`) : compareUtf8(a.id, b.id);
}

// Avoids UNION ALL across characters/groups, which would defeat each table's own index-backed ORDER BY.
/**
 * @param {EntityRow[]} a
 * @param {EntityRow[]} b
 * @param {(a: EntityRow, b: EntityRow) => number} comparator
 * @returns {EntityRow[]}
 */
function mergeSortedRows(a, b, comparator) {
    /** @type {EntityRow[]} */
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

/**
 * @param {{ db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle }} entry
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./tag-deletions.js').TagDeletions} deletions
 */
function makeEntityHashRowMapper(entry, directories, deletions) {
    /**
     * A group's tag_ids digest as readers get it: the stored one, unless a marked tag is among its rows.
     * @param {string} id
     * @param {number} storedDigest
     */
    const groupTagIdsDigest = (id, storedDigest) => {
        if (!deletions.any) return storedDigest;
        /** @type {string[]} */
        const tagIds = [];
        for (const r of entry.db.iterate('SELECT tag_id FROM group_tags WHERE group_id = @id ORDER BY tag_id', { id })) {
            tagIds.push(/** @type {{ tag_id: string }} */ (r).tag_id);
        }
        const resolved = resolveTagIds(tagIds, deletions);
        return resolved === tagIds ? storedDigest : groupDigestTagIdsHash({ tag_ids: resolved });
    };
    // Character rows' digest_fav/digest_tag_ids/digest_content are plain column reads - writeShallowJson() is the
    // sole writer of shallow_json outside buildRow()/writeRowSync()'s own row construction, and always writes
    // these three columns in the same statement, so they can't be stale relative to shallow_json (see that
    // table's schema comment). Group rows trust their stored digest_* columns when non-NULL; a NULL digest falls
    // back to a live recompute.
    /** @type {Set<string>} */
    const groupIdsNeedingFileFallback = new Set();
    /**
     * @param {EntityRow} r
     * @returns {EntityHashRow}
     */
    const toHashRow = (r) => {
        let favHash, tagIdsHash, contentHash, chat = null;
        if (r.type === 'character') {
            favHash = r.digest_fav;
            tagIdsHash = characterTagIdsDigestForReader(r.digest_tag_ids, r.shallow_json, deletions);
            contentHash = r.digest_content;
            chat = JSON.parse(/** @type {string} */ (r.shallow_json)).chat ?? null;
        } else if (r.digest_fav != null && r.digest_tag_ids != null && r.digest_content != null) {
            favHash = r.digest_fav;
            // A .png group row's tags are never read as a group's (tagEntityTypeOf()), so it's served with none.
            tagIdsHash = tagEntityTypeOf(r.id) === 'group' ? groupTagIdsDigest(r.id, r.digest_tag_ids) : groupDigestTagIdsHash({ tag_ids: [] });
            contentHash = r.digest_content;
        } else {
            // Can't import groups.js's getGroupsByIds() here (import-direction rule), so re-read the file directly.
            groupIdsNeedingFileFallback.add(r.id);
            favHash = tagIdsHash = contentHash = 0; // corrected in the fallback pass below
        }
        return {
            id: r.id, isGroup: r.type === 'group', chat,
            date_added: Number(r.date_added), create_date: r.create_date === null ? null : Number(r.create_date),
            date_last_chat: Number(r.date_last_chat), chat_size: Number(r.chat_size),
            data_size: r.data_size === null ? 0 : Number(r.data_size),
            favHash: favHash >>> 0, tagIdsHash: tagIdsHash >>> 0, contentHash: contentHash >>> 0,
        };
    };
    /**
     * Resolves the placeholder hashes toHashRow() left for NULL-digest group rows, in place.
     * @param {EntityHashRow[]} hashRowList
     */
    const resolveFileFallbackHashes = (hashRowList) => {
        if (groupIdsNeedingFileFallback.size === 0) return;
        for (const hr of hashRowList) {
            if (!hr.isGroup || !groupIdsNeedingFileFallback.has(hr.id)) continue;
            try {
                const filePath = path.join(directories.groups, sanitize(`${hr.id}.json`));
                const group = normalizeGroupRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')));
                /** @type {string[]} */
                const tagIds = [];
                if (tagEntityTypeOf(hr.id) === 'group') {
                    for (const r of entry.db.iterate('SELECT tag_id FROM group_tags WHERE group_id = @id ORDER BY tag_id', { id: hr.id })) {
                        tagIds.push(/** @type {{ tag_id: string }} */ (r).tag_id);
                    }
                }
                const fingerprintSource = { ...group, tag_ids: resolveTagIds(tagIds, deletions) };
                hr.favHash = groupDigestFavHash(fingerprintSource) >>> 0;
                hr.tagIdsHash = groupDigestTagIdsHash(fingerprintSource) >>> 0;
                hr.contentHash = groupDigestContentHash(fingerprintSource) >>> 0;
            } catch (err) {
                console.error(`[character-metadata] queryEntities() hash-mode file fallback failed for group ${hr.id}, shipping a zero hash (forces the client to always treat this row as stale):`, /** @type {any} */ (err).message);
            }
        }
    };
    return { toHashRow, resolveFileFallbackHashes };
}

/**
 * @param {EntityRow} r
 * @param {import('./tag-deletions.js').TagDeletions} deletions
 */
function toEntityWireRow(r, deletions) {
    return {
        type: r.type,
        id: r.id,
        fav: !!r.fav,
        date_added: Number(r.date_added),
        date_last_chat: Number(r.date_last_chat),
        chat_size: Number(r.chat_size),
        item: r.type === 'character' ? parseShallowResolvingTags(/** @type {string} */ (r.shallow_json), deletions) : null,
    };
}

const ENTITY_CHARACTER_COLUMNS = 'id, \'character\' as type, name_fold, fav, date_added, date_last_chat, chat_size, create_date, data_size, shallow_json, digest_fav, digest_tag_ids, digest_content';
const ENTITY_GROUP_COLUMNS = 'id, \'group\' as type, name_fold, fav, date_added, date_last_chat, chat_size, date_added as create_date, NULL as data_size, NULL as shallow_json, digest_fav, digest_tag_ids, digest_content';

/**
 * queryEntities()'s row shapes for an already-ordered page of entities, in that order. An entity whose row no
 * longer exists is left out.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ type: 'character'|'group', id: string }[]} entities
 * @param {{ wantRows?: boolean, wantHashes?: boolean }} [options]
 * @returns {Promise<{ rows: ReturnType<typeof toEntityWireRow>[] | undefined, hashRows: EntityHashRow[] | undefined, seq: number, groupsVersion: number | null } | null>}
 * `groupsVersion`: readGroupsVersionSync()'s, read with `seq` before the rows.
 */
export async function getEntityRowsByIds(directories, entities, { wantRows = true, wantHashes = false } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const seqRow = (/** @type {{ seq: number } | undefined} */ (entry.db.get('SELECT COALESCE(MAX(seq), 0) as seq FROM changes')));
    const seq = Number(seqRow?.seq ?? 0);
    const groupsVersion = readGroupsVersionSync(entry.db);

    const characterIds = entities.filter(e => e.type === 'character').map(e => e.id);
    const groupIds = entities.filter(e => e.type === 'group').map(e => e.id);
    /** @type {Map<string, EntityRow>} */
    const characterRows = new Map();
    /** @type {Map<string, EntityRow>} */
    const groupRows = new Map();
    if (characterIds.length > 0) {
        for (const r of entry.db.iterate(`SELECT ${ENTITY_CHARACTER_COLUMNS} FROM characters WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(characterIds)])) {
            characterRows.set(/** @type {EntityRow} */ (r).id, /** @type {EntityRow} */ (r));
        }
    }
    if (groupIds.length > 0) {
        for (const r of entry.db.iterate(`SELECT ${ENTITY_GROUP_COLUMNS} FROM groups WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(groupIds)])) {
            groupRows.set(/** @type {EntityRow} */ (r).id, /** @type {EntityRow} */ (r));
        }
    }
    const rawRows = /** @type {EntityRow[]} */ (entities
        .map(e => (e.type === 'group' ? groupRows : characterRows).get(e.id))
        .filter(r => r !== undefined));

    const deletions = readTagDeletionsSync(entry.db);
    let rows, hashRows;
    if (wantHashes) {
        const { toHashRow, resolveFileFallbackHashes } = makeEntityHashRowMapper(entry, directories, deletions);
        overlayEntityRowsSync(entry.db, rawRows);
        hashRows = rawRows.map(toHashRow);
        resolveFileFallbackHashes(hashRows);
    } else if (wantRows) {
        overlayEntityRowsSync(entry.db, rawRows);
        rows = rawRows.map(r => toEntityWireRow(r, deletions));
    }
    return { rows, hashRows, seq, groupsVersion };
}

/**
 * `filter.includeGroups: true` half of `POST /api/characters/query` - see the doc comment above
 * buildGroupWhereClause() for why groups get their own where-clause builder.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} [params]
 * @param {{ include?: string[], exclude?: string[], mode?: 'and'|'or' }} [params.tags]
 * @param {boolean} [params.fav]
 * @param {string} [params.world] Applies to the characters arm only.
 * @param {string[]} [params.excludeIds]
 * @param {string[]} [params.ids] Present-but-empty means "resolve nothing" - same rule as queryCharacters().
 * @param {string} [params.sortField] One of QUERYABLE_SORT_COLUMNS' keys, or 'random'. Never 'search'.
 * @param {'asc'|'desc'} [params.sortOrder]
 * @param {number} [params.seed]
 * @param {number} [params.offset]
 * @param {number} [params.limit]
 * @param {string|null} [params.handle] Cache key for getRandomSortedEntityIds()'s per-(handle, seed, seq, groupsVersion) cache.
 * Required when a random-sorted page is read (sortField 'random' with wantRows or wantHashes); throws if missing or ''.
 * @param {boolean} [params.wantRows]
 * @param {boolean} [params.wantTotal]
 * @param {boolean} [params.wantHashes]
 * @param {boolean} [params.groupsOnly] Leaves characters out.
 * @returns {Promise<{ rows: {type: 'character'|'group', id: string, fav: boolean, date_added: number, date_last_chat: number, chat_size: number, item: object | null}[] | undefined, hashRows: object[] | undefined, total: number | undefined, approxTotal: boolean, seq: number, groupsVersion: number | null } | null>}
 * A group row's `item` is `null` here - the caller hydrates it; a character row's `item` is the full toShallow().
 * `approxTotal` marks `total` as an estimate (totalWithoutCount()). `groupsVersion`: readGroupsVersionSync()'s, read
 * with `seq` before the rows.
 */
export async function queryEntities(directories, params = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const {
        tags, fav, world, ranges, excludeIds, ids,
        sortField, sortOrder, seed,
        offset, limit, handle,
        wantRows = true, wantTotal = true,
        wantHashes = false,
        groupsOnly = false,
    } = params;

    if (readDependsOnActivity(sortField, ranges) && !isReadOnlyMode()) foldActivitySync(entry.db);
    const seqRow = (/** @type {{ seq: number } | undefined} */ (entry.db.get('SELECT COALESCE(MAX(seq), 0) as seq FROM changes')));
    const seq = Number(seqRow?.seq ?? 0);
    const groupsVersion = readGroupsVersionSync(entry.db);

    if (Array.isArray(ids) && ids.length === 0) {
        return { rows: wantRows ? [] : undefined, hashRows: wantHashes ? [] : undefined, total: wantTotal ? 0 : undefined, approxTotal: false, seq, groupsVersion };
    }

    const deletions = readTagDeletionsSync(entry.db);
    const charWhere = buildWhereClause({ tags, fav, world, ranges, excludeIds, ids }, deletions);
    const groupWhere = buildGroupWhereClause({ tags, fav, ranges, excludeIds, ids }, deletions);

    let total;
    let approxTotal = false;
    const counted = wantTotal ? totalWithoutCount(entry.db, groupsOnly ? ['group'] : ['character', 'group'], { tags, fav, world, ranges, excludeIds, ids }, deletions, seq) : null;
    if (counted) {
        ({ total, approxTotal } = counted);
    } else if (wantTotal && groupsOnly) {
        const countRow = /** @type {{ total: number } | undefined} */ (entry.db.get(`SELECT COUNT(*) as total FROM ${groupWhere.from} ${groupWhere.where}`, groupWhere.args));
        total = Number(countRow?.total ?? 0);
    } else if (wantTotal) {
        const countRow = /** @type {{ total: number } | undefined} */ (entry.db.get(
            `SELECT COUNT(*) as total FROM (
                SELECT id FROM ${charWhere.from} ${charWhere.where}
                UNION ALL
                SELECT id FROM ${groupWhere.from} ${groupWhere.where}
            )`,
            [...charWhere.args, ...groupWhere.args],
        ));
        total = Number(countRow?.total ?? 0);
    }

    const { toHashRow, resolveFileFallbackHashes } = makeEntityHashRowMapper(entry, directories, deletions);

    let rows, hashRows;
    /** @type {string | undefined} */
    let nextCursor;
    let moreRows = false;
    if (wantRows || wantHashes) {
        const orderParts = [];
        if (sortField === 'random') {
            const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
            orderParts.push(`RANDHASH(id, ?) ${direction}`);
        } else {
            const column = QUERYABLE_SORT_COLUMNS[sortField ?? ''];
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

        const numericOffset = typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
        const numericLimit = typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : DEFAULT_QUERY_LIMIT;
        const orderArgs = sortField === 'random' ? [Number(seed) || 0] : [];

        // Two separate per-table queries + a JS merge-sort instead of UNION ALL: a UNION ALL prevented SQLite
        // from using either table's index (full scan + temp B-tree sort).
        const fetchLimit = numericOffset + numericLimit;

        if (sortField === 'random' && randomRanksReady(entry)) {
            const page = randomOrderPage(entry, {
                kinds: { character: !groupsOnly, group: true }, tags, fav, world, ranges, excludeIds, ids, sortOrder,
                seed: Number(seed) || 0, offset: numericOffset, limit: numericLimit, cursor: params.cursor, deletions,
            });
            const rawRows = readEntityRowsInOrder(entry.db, page.entities);
            if (wantHashes) {
                overlayEntityRowsSync(entry.db, rawRows);
                hashRows = rawRows.map(toHashRow);
                resolveFileFallbackHashes(hashRows);
            } else {
                overlayEntityRowsSync(entry.db, rawRows);
                rows = rawRows.map(r => toEntityWireRow(r, deletions));
            }
            nextCursor = page.cursor;
            moreRows = page.more;
        } else if (sortField === 'random') {
            if (handle === undefined || handle === null || handle === '') {
                throw new Error('queryEntities(): a random sort needs params.handle (the random-sort id cache is keyed by it)');
            }
            const sortedAllIds = getRandomSortedEntityIds(entry.db, handle, Number(seed) || 0, seq, groupsVersion);

            const hasFilters = groupsOnly || charWhere.from !== 'characters' || charWhere.where !== '' || groupWhere.from !== 'groups' || groupWhere.where !== '';
            const filterSet = hasFilters ? new Set([
                ...(groupsOnly ? [] : (/** @type {{ id: string }[]} */ (entry.db.all(`SELECT id FROM ${charWhere.from} ${charWhere.where}`, charWhere.args))).map(r => r.id)),
                ...(/** @type {{ id: string }[]} */ (entry.db.all(`SELECT id FROM ${groupWhere.from} ${groupWhere.where}`, groupWhere.args))).map(r => r.id),
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
                /** @type {Map<string, EntityRow>} */
                const rowById = new Map();
                for (const r of entry.db.iterate(
                    `SELECT ${ENTITY_CHARACTER_COLUMNS}
                    FROM characters WHERE id IN (SELECT value FROM json_each(?))`,
                    [pageIdsJson],
                )) {
                    rowById.set(/** @type {EntityRow} */ (r).id, /** @type {EntityRow} */ (r));
                }
                for (const r of entry.db.iterate(
                    `SELECT ${ENTITY_GROUP_COLUMNS}
                    FROM groups WHERE id IN (SELECT value FROM json_each(?))`,
                    [pageIdsJson],
                )) {
                    rowById.set(/** @type {EntityRow} */ (r).id, /** @type {EntityRow} */ (r));
                }
                const rawRows = pageIds.map(id => rowById.get(id)).filter(r => r !== undefined);
                if (wantHashes) {
                    overlayEntityRowsSync(entry.db, rawRows);
                    hashRows = rawRows.map(toHashRow);
                    resolveFileFallbackHashes(hashRows);
                } else {
                    overlayEntityRowsSync(entry.db, rawRows);
                    rows = rawRows.map(r => toEntityWireRow(r, deletions));
                }
            }
        } else {
            const comparator = makeEntityMergeComparator(sortField, sortOrder, seed);
            const column = QUERYABLE_SORT_COLUMNS[sortField ?? ''];
            /** @type {EntityRow[]} */
            let rawRows;

            if (column && entitySortIndexesReady(entry)) {
                const streams = sortedPageStreams(entry, {
                    column, sortOrder, fav, world, ranges, excludeIds, ids, tags, groupsOnly, charWhere, groupWhere, deletions,
                });
                const cursorKey = sortedPageCursorKey({ tags, fav, world, ranges, excludeIds, ids, groupsOnly, sortField, sortOrder });
                const cursorAt = decodeSortedPageCursor(params.cursor, cursorKey);
                // A cursor knows how much of a jump's skip is left; without one, the skip is the offset.
                const skip = cursorAt ? cursorAt.skip : numericOffset;
                const need = skip + numericLimit;

                // Keys only, through the indexes and under the work cap; full rows are read for the page alone.
                // An id list bounds the read by itself, so it isn't capped: its callers ask for the whole list's page.
                const walked = walkSortedStreams(entry.db, streams, cursorAt?.ends ?? null, need, comparator, Array.isArray(ids) ? Infinity : undefined);
                const pageKeys = walked.rows.slice(skip);
                moreRows = walked.more && pageKeys.length < numericLimit;

                const ends = { ...(cursorAt?.ends ?? {}), ...walked.ends };
                const skipLeft = Math.max(0, skip - walked.rows.length);
                nextCursor = moreRows || pageKeys.length === numericLimit ? encodeSortedPageCursor(cursorKey, ends, skipLeft) : undefined;

                rawRows = readEntityRowsInOrder(entry.db, pageKeys);
            } else {
                // Until the sort indexes exist: one statement per table, merged in JS.
                // create_date: a group's own date_added stands in, projected as create_date, so it interleaves
                // correctly with characters instead of parking every group at one end of the sort (NULL would).
                // data_size: no equivalent for groups, stays NULL on the group side - every group sorts equal on
                // that key and falls through to the tiebreaker.
                const groupOrderBy = orderBy
                    .replace(/\bcreate_date\b/g, 'date_added')
                    .replace(/\bid ASC$/, '(id || \'.json\') ASC');
                /** @param {string} sql @param {unknown[]} args */
                const readStream = (sql, args) => {
                    /** @type {EntityRow[]} */
                    const out = [];
                    for (const row of entry.db.iterate(sql, args)) out.push(/** @type {EntityRow} */ (row));
                    return out;
                };
                /** @type {EntityRow[]} */
                let merged = [];
                if (!groupsOnly) {
                    merged = readStream(
                        `SELECT ${ENTITY_CHARACTER_COLUMNS}
                        FROM ${charWhere.from} ${charWhere.where}
                        ${orderBy}
                        LIMIT ?`,
                        [...charWhere.args, ...orderArgs, fetchLimit],
                    );
                }
                merged = mergeSortedRows(merged, readStream(
                    `SELECT ${ENTITY_GROUP_COLUMNS}
                    FROM ${groupWhere.from} ${groupWhere.where}
                    ${groupOrderBy}
                    LIMIT ?`,
                    [...groupWhere.args, ...orderArgs, fetchLimit],
                ), comparator);
                rawRows = merged.slice(numericOffset, numericOffset + numericLimit);
            }

            if (wantHashes) {
                overlayEntityRowsSync(entry.db, rawRows);
                hashRows = rawRows.map(toHashRow);
                resolveFileFallbackHashes(hashRows);
            } else {
                overlayEntityRowsSync(entry.db, rawRows);
                rows = rawRows.map(r => toEntityWireRow(r, deletions));
            }
        }
    }

    return { rows, hashRows, total, approxTotal, seq, groupsVersion, ...(nextCursor !== undefined ? { cursor: nextCursor } : {}), ...(moreRows ? { more: true } : {}) };
}

/** The random page walk's work cap and window; tests make them small. */
const randomPageWalk = { cap: SEARCH_WORK_CAP, window: SEARCH_WALK_WINDOW };

/**
 * Sets the random page walk's work cap and window, so a test can reach the cap with a few rows. Tests only.
 * @param {{ cap?: number, window?: number } | null} values null restores the defaults.
 */
export function _setRandomPageWalkForTests(values) {
    randomPageWalk.cap = values?.cap ?? SEARCH_WORK_CAP;
    randomPageWalk.window = values?.window ?? SEARCH_WALK_WINDOW;
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} space
 */
function randomSpaceSize(db, space) {
    return Number(/** @type {{ n: number }} */ (db.get('SELECT COALESCE(MAX(rank), -1) + 1 AS n FROM random_ranks WHERE space = @space', { space })).n);
}

/**
 * The entities at some ranks of one space.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} space
 * @param {number[]} ranks
 * @returns {Map<number, { type: 'character' | 'group', id: string }>}
 */
function randomEntitiesAtRanks(db, space, ranks) {
    /** @type {Map<number, { type: 'character' | 'group', id: string }>} */
    const byRank = new Map();
    if (ranks.length === 0) return byRank;
    for (const row of /** @type {Iterable<{ rank: number, kind: string, entity_id: string }>} */ (db.iterate(
        'SELECT rank, kind, entity_id FROM random_ranks WHERE space = ? AND rank IN (SELECT value FROM json_each(?))',
        [space, JSON.stringify(ranks)],
    ))) {
        byRank.set(Number(row.rank), { type: row.kind === 'g' ? 'group' : 'character', id: row.entity_id });
    }
    return byRank;
}

/**
 * The ids among `ids` of one kind that pass a filter's WHERE.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {{ from: string, where: string, args: unknown[] }} built
 * @param {string[]} ids
 * @returns {Set<string>}
 */
function idsPassing(db, built, ids) {
    /** @type {Set<string>} */
    const kept = new Set();
    if (ids.length === 0) return kept;
    const clause = built.where ? `${built.where} AND id IN (SELECT value FROM json_each(?))` : 'WHERE id IN (SELECT value FROM json_each(?))';
    for (const row of /** @type {Iterable<{ id: string }>} */ (db.iterate(`SELECT id FROM ${built.from} ${clause}`, [...built.args, JSON.stringify(ids)]))) {
        kept.add(row.id);
    }
    return kept;
}

/**
 * One page of the random order (search plan step 7c): position i of a space shows the entity at rank
 * permute(i). A filter that is one space (none, fav, one tag, one tag and fav, both kinds) reads the page's
 * positions directly. Any other filter walks the positions of the smallest space that holds every match and checks
 * each entity against the whole filter, under the work cap; an id list maps its own ids to their positions instead.
 * Descending reads the positions from the end.
 * @param {MetadataDbEntry} entry
 * @param {object} p
 * @param {{ character: boolean, group: boolean }} p.kinds
 * @param {any} p.tags
 * @param {boolean} [p.fav]
 * @param {string} [p.world]
 * @param {string[]} [p.excludeIds]
 * @param {string[]} [p.ids]
 * @param {'asc' | 'desc'} [p.sortOrder]
 * @param {number} p.seed
 * @param {number} p.offset
 * @param {number} p.limit
 * @param {unknown} p.cursor
 * @param {import('./tag-deletions.js').TagDeletions} p.deletions
 * @returns {{ entities: { type: 'character' | 'group', id: string }[], more: boolean, cursor: string | undefined }}
 */
function randomOrderPage(entry, { kinds, tags, fav, world, ranges, excludeIds, ids, sortOrder, seed, offset, limit, cursor, deletions }) {
    const { db } = entry;
    const favValue = typeof fav === 'boolean' ? (fav ? 1 : 0) : null;
    const include = tags && !Array.isArray(tags) && Array.isArray(tags.include) ? [...new Set(tags.include.filter(Boolean).map(String))] : [];
    const exclude = tags && Array.isArray(tags.exclude) ? tags.exclude.filter(Boolean) : [];
    const orMode = tags?.mode === 'or';
    const expanded = !!expandTagFilter(tags, deletions);
    const descending = sortOrder === 'desc';
    const key = String(getStringHash(JSON.stringify({ random: true, seed, tags: tags ?? null, fav: favValue, world: world ?? null, ...(hasRanges(ranges) ? { ranges } : {}), excludeIds: excludeIds ?? null, ids: ids ?? null, kinds, sortOrder: descending })));
    const at = decodeRandomPageCursor(cursor, key);
    const charWhere = buildWhereClause({ tags, fav, world, ranges, excludeIds, ids }, deletions);
    const groupWhere = buildGroupWhereClause({ tags, fav, ranges, excludeIds, ids }, deletions);
    /** @param {{ type: 'character' | 'group', id: string }[]} candidates */
    const passing = (candidates) => {
        const chars = kinds.character ? idsPassing(db, charWhere, candidates.filter(e => e.type === 'character').map(e => e.id)) : new Set();
        const groups = kinds.group ? idsPassing(db, groupWhere, candidates.filter(e => e.type === 'group').map(e => e.id)) : new Set();
        return candidates.filter(e => (e.type === 'character' ? chars : groups).has(e.id));
    };

    // The space whose positions give the order: the smallest included tag's when the filter needs every included tag,
    // otherwise the fav / whole-list space. An id list orders by the same space, so a search's matches listed by id
    // come in the order the walk over that space would give them.
    let space = randomSpaceName('', favValue);
    if (!orMode && !expanded && include.length > 0) {
        const sized = include.map(tagId => ({ space: randomSpaceName(tagId, favValue), n: randomSpaceSize(db, randomSpaceName(tagId, favValue)) }));
        sized.sort((a, b) => a.n - b.n);
        space = sized[0].space;
    }

    // An id list: its own ids, each at its position in that space, so the read is bounded by the list.
    if (Array.isArray(ids)) {
        const n = randomSpaceSize(db, space);
        const orderKeyOfSpace = orderKey(seed, space);
        /** @type {{ type: 'character' | 'group', id: string, position: number }[]} */
        const placed = [];
        for (const row of /** @type {Iterable<{ rank: number, kind: string, entity_id: string }>} */ (db.iterate(
            'SELECT rank, kind, entity_id FROM random_ranks WHERE space = ? AND entity_id IN (SELECT value FROM json_each(?))',
            [space, JSON.stringify(ids)],
        ))) {
            const position = unpermute(Number(row.rank), n, orderKeyOfSpace);
            placed.push({ type: row.kind === 'g' ? 'group' : 'character', id: row.entity_id, position: descending ? n - 1 - position : position });
        }
        placed.sort((a, b) => a.position - b.position);
        const kept = passing(placed);
        const start = at ? at.position : offset;
        const end = Math.min(kept.length, start + limit);
        return {
            entities: kept.slice(start, end).map(({ type, id }) => ({ type, id })),
            more: false,
            cursor: end - start === limit && end < kept.length ? encodeRandomPageCursor(key, end, 0) : undefined,
        };
    }

    const oneSpace = !orMode && !expanded && exclude.length === 0 && include.length <= 1 && (typeof world !== 'string' || world === '') && !hasRanges(ranges) && !(Array.isArray(excludeIds) && excludeIds.length > 0) && kinds.character && kinds.group;
    if (oneSpace) {
        const n = randomSpaceSize(db, space);
        const k = orderKey(seed, space);
        const start = at ? at.position : offset;
        const end = Math.min(n, start + limit);
        /** @type {number[]} */
        const ranks = [];
        for (let j = start; j < end; j++) ranks.push(permute(descending ? n - 1 - j : j, n, k));
        const byRank = randomEntitiesAtRanks(db, space, ranks);
        const entities = ranks.map(r => byRank.get(r)).filter(e => e !== undefined);
        return { entities, more: false, cursor: end - start === limit ? encodeRandomPageCursor(key, end, 0) : undefined };
    }

    // Walked: the space chosen above drives, and each entity is checked against the whole filter.
    const n = randomSpaceSize(db, space);
    const k = orderKey(seed, space);
    let skip = at ? at.skip : offset;
    let j = at ? at.position : 0;
    let examined = 0;
    /** @type {{ type: 'character' | 'group', id: string }[]} */
    const entities = [];
    while (entities.length < limit && j < n && examined < randomPageWalk.cap) {
        const windowEnd = Math.min(n, j + randomPageWalk.window, j + (randomPageWalk.cap - examined));
        /** @type {number[]} */
        const ranks = [];
        for (let q = j; q < windowEnd; q++) ranks.push(permute(descending ? n - 1 - q : q, n, k));
        const byRank = randomEntitiesAtRanks(db, space, ranks);
        const candidates = ranks.map(r => byRank.get(r)).filter(e => e !== undefined);
        const kept = passing(candidates);
        // Walk the kept entities in position order, stopping where the page fills, so the cursor lands right after.
        const keptKeys = new Set(kept.map(e => `${e.type}:${e.id}`));
        let q = j;
        for (const r of ranks) {
            const e = byRank.get(r);
            q++;
            if (!e || !keptKeys.has(`${e.type}:${e.id}`)) continue;
            if (skip > 0) { skip--; continue; }
            entities.push(e);
            if (entities.length === limit) break;
        }
        examined += q - j;
        j = q;
    }
    const more = entities.length < limit && j < n;
    const full = entities.length === limit && j < n;
    return { entities, more, cursor: more || full ? encodeRandomPageCursor(key, j, skip) : undefined };
}

/**
 * @param {string} key
 * @param {number} position The next position to read.
 * @param {number} skip How much of a jump's skip is left.
 */
function encodeRandomPageCursor(key, position, skip) {
    return Buffer.from(JSON.stringify({ r: key, p: position, s: skip })).toString('base64url');
}

/**
 * @param {unknown} cursor
 * @param {string} key
 * @returns {{ position: number, skip: number } | null} null when there's no cursor or it was made for another page.
 */
function decodeRandomPageCursor(cursor, key) {
    if (typeof cursor !== 'string' || cursor === '') return null;
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (parsed?.r !== key || !Number.isInteger(parsed.p) || parsed.p < 0 || !Number.isInteger(parsed.s) || parsed.s < 0) return null;
        return { position: parsed.p, skip: parsed.s };
    } catch {
        return null;
    }
}

/**
 * Every requested id is a key in the returned object - `true`/`false`, never absent - so callers never have to
 * distinguish "false" from "key missing".
 * @returns {Promise<Record<string, boolean> | null>} `null` if the metadata store is unavailable.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
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
        for (const row of /** @type {Generator<{ id: string }>} */ (entry.db.iterate(`SELECT id FROM characters WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk))) {
            result[row.id] = true;
        }
    }

    return result;
}

/** Rows findCharacterMatches() reads at most before it answers with what it found and `capped: true`. */
export const FIND_CHARACTER_WORK_CAP = 20000;

/**
 * The library-wide half of the client's findChar(): the characters findChar() would match if every character were
 * held, without the current-character preference, which the client applies from what it holds. Same rules: an
 * avatar key (with or without `.png`) wins; otherwise the name is compared as compareIgnoreCaseAndAccents() does
 * (`insensitive`) or exactly; with `tags`, a character must carry a tag of each name, compared exactly. No name
 * matches every character. Upstream returns the first match in its array, which is in avatar order; so is this.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ name?: string | null, allowAvatar?: boolean, insensitive?: boolean, tags?: string[] | null }} query
 * @returns {Promise<{ ids: string[], capped: boolean } | 'names-not-ready' | null>} at most two ids, the first being
 *   findChar()'s answer and a second meaning "more than one matched". `capped` when the work cap stopped the search
 *   before it could rule out a match. null when the store is unavailable.
 */
export async function findCharacterMatches(directories, { name = null, allowAvatar = true, insensitive = true, tags = null }) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const db = entry.db;
    const pending = entry.batch?.pending ?? new Map();
    const tagNames = Array.isArray(tags) && tags.length > 0 ? tags.map(String) : null;

    /** @type {Set<string>[]} for each wanted tag name, the ids of the live tags with exactly that name */
    let wantedTagIds = [];
    if (tagNames) {
        if (!tagNameKeysReady(entry)) return 'names-not-ready';
        wantedTagIds = tagNames.map(tagName => {
            const ids = new Set();
            for (const row of /** @type {Iterable<{ id: string, data: string }>} */ (db.iterate(`SELECT id, data FROM tags WHERE name_key = ? AND ${NOT_MARKED_DELETED_SQL}`, [tagNameKey(tagName)]))) {
                try {
                    if (JSON.parse(row.data)?.name == tagName) ids.add(row.id);
                } catch {
                    // An unparseable definition has no name to match.
                }
            }
            return ids;
        });
        if (wantedTagIds.some(ids => ids.size === 0)) return { ids: [], capped: false };
    }
    const deletions = tagNames ? readTagDeletionsSync(db) : NO_TAG_DELETIONS;

    /**
     * @param {string[]} ids
     * @returns {string[]} the ids among `ids` carrying every wanted tag, in the order given
     */
    const withWantedTags = (ids) => {
        if (!tagNames || ids.length === 0) return ids;
        /** @type {Map<string, string[]>} */
        const tagIdsOf = new Map(ids.map(id => [id, pending.get(id)?.tagIds ? [...pending.get(id).tagIds] : []]));
        const stored = ids.filter(id => !pending.has(id));
        for (let i = 0; i < stored.length; i += BATCH_FLUSH_SIZE) {
            const chunk = stored.slice(i, i + BATCH_FLUSH_SIZE);
            for (const row of /** @type {Iterable<{ character_id: string, tag_id: string }>} */ (db.iterate(`SELECT character_id, tag_id FROM character_tags WHERE character_id IN (${chunk.map(() => '?').join(', ')})`, chunk))) {
                tagIdsOf.get(row.character_id)?.push(row.tag_id);
            }
        }
        return ids.filter(id => {
            const carried = new Set(resolveTagIds(tagIdsOf.get(id) ?? [], deletions));
            return wantedTagIds.every(wanted => [...wanted].some(tagId => carried.has(tagId)));
        });
    };

    const hasName = typeof name === 'string' && name !== '';
    const nameKey = hasName ? tagNameKey(name) : null;
    // compareIgnoreCaseAndAccents() compares an empty string as it is.
    /** @param {string} candidate */
    const nameMatches = (candidate) => (insensitive && candidate !== '' ? tagNameKey(candidate) === nameKey : candidate === name);

    if (allowAvatar && hasName) {
        const avatars = name.endsWith('.png') ? [name] : [name, `${name}.png`];
        for (const avatar of avatars) {
            const exists = pending.has(avatar) || Boolean(db.get('SELECT 1 FROM characters WHERE id = @id', { id: avatar }));
            if (exists && withWantedTags([avatar]).length > 0) return { ids: [avatar], capped: false };
        }
    }

    /** @type {string[]} */
    const found = [];
    for (const [id, { row }] of pending) {
        if (!hasName || nameMatches(row.name)) found.push(id);
    }
    const fromPending = withWantedTags(found);
    found.length = 0;
    found.push(...fromPending);

    let read = 0;
    let capped = false;
    /** @type {string[]} */
    let batch = [];
    const flush = () => {
        for (const id of withWantedTags(batch)) {
            if (!pending.has(id)) found.push(id);
        }
        batch = [];
    };

    let sql;
    let params;
    if (hasName) {
        // name_fold folds a superset of what compareIgnoreCaseAndAccents() does, so every match is among these rows.
        sql = 'SELECT id, name FROM characters WHERE name_fold = ? ORDER BY id';
        params = [foldName(name)];
    } else if (tagNames) {
        // A row of a marked tag merging into one of the first tags counts as that tag; the marks are matched here.
        const firstIds = JSON.stringify([...wantedTagIds[0]]);
        sql = `SELECT DISTINCT character_id AS id FROM character_tags
            WHERE tag_id IN (SELECT value FROM json_each(?)) OR tag_id IN (SELECT tag_id FROM tag_deletions WHERE merge_into IN (SELECT value FROM json_each(?)))
            ORDER BY character_id`;
        params = [firstIds, firstIds];
    } else {
        sql = 'SELECT id, name FROM characters ORDER BY id';
        params = [];
    }

    for (const row of /** @type {Iterable<{ id: string, name: string | null }>} */ (db.iterate(sql, params))) {
        if (read >= FIND_CHARACTER_WORK_CAP) {
            capped = true;
            break;
        }
        read++;
        if (!hasName || nameMatches(String(row.name))) batch.push(row.id);
        if (batch.length >= BATCH_FLUSH_SIZE) flush();
        if (found.length >= 2) break;
    }
    flush();

    found.sort();
    return { ids: found.slice(0, 2), capped: capped && found.length < 2 };
}

/**
 * The groups whose name compares equal to `name` as compareIgnoreCaseAndAccents() does, in id order.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} name
 * @returns {Promise<string[] | null>} at most two ids; null when the store is unavailable.
 */
export async function findGroupMatches(directories, name) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const key = tagNameKey(String(name));
    /** @type {string[]} */
    const found = [];
    for (const row of /** @type {Iterable<{ id: string, name: string }>} */ (entry.db.iterate('SELECT id, name FROM groups WHERE name_fold = ? ORDER BY id', [foldName(name)]))) {
        if (tagNameKey(String(row.name)) === key) found.push(row.id);
        if (found.length >= 2) break;
    }
    return found;
}

/** @returns {Promise<number | null>} The change log's current high-water mark, or `null` if unavailable. */
/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export async function getCurrentSeq(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = (/** @type {{ seq: number } | undefined} */ (entry.db.get('SELECT COALESCE(MAX(seq), 0) as seq FROM changes')));
    return Number(row?.seq ?? 0);
}

/** getCurrentSeq()'s counterpart for the groups version log (group_changes): its latest version, 0 when empty.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<number | null>} `null` if the store is unavailable.
 */
export async function getGroupsVersion(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = (/** @type {{ version: number } | undefined} */ (entry.db.get('SELECT COALESCE(MAX(version), 0) as version FROM group_changes')));
    return Number(row?.version ?? 0);
}

/**
 * getCurrentSeq() and the groups version, read in the order queryEntities() and getEntityRowsByIds() read them.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<{ seq: number, groupsVersion: number | null } | null>} `null` if the store is unavailable;
 * `groupsVersion` null when it can't be read (readGroupsVersionSync()).
 */
export async function getCurrentSeqAndGroupsVersion(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = (/** @type {{ seq: number } | undefined} */ (entry.db.get('SELECT COALESCE(MAX(seq), 0) as seq FROM changes')));
    return { seq: Number(row?.seq ?? 0), groupsVersion: readGroupsVersionSync(entry.db) };
}

/** getCurrentSeq()'s counterpart for the tag-name change log.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<number | null>}
 */
export async function getCurrentTagNameChangeSeq(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = (/** @type {{ seq: number } | undefined} */ (entry.db.get('SELECT COALESCE(MAX(seq), 0) as seq FROM tag_name_changes')));
    return Number(row?.seq ?? 0);
}

/** Every character's id, card_json and chat stats, in id order, in batches - for a caller that must visit the whole
 * library without holding it.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {AsyncGenerator<CharacterIndexRow[], void, undefined>}
 */
export async function* streamCharacterCardJsonBatches(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;
    for await (const rows of /** @type {AsyncGenerator<CharacterIndexRow[], void, undefined>} */ (streamRows(entry.db, {
        firstPageSql: 'SELECT id, name, card_json, chat_size, date_last_chat FROM characters ORDER BY id LIMIT @limit',
        firstPageParams: {},
        nextPageSql: 'SELECT id, name, card_json, chat_size, date_last_chat FROM characters WHERE id > @after ORDER BY id LIMIT @limit',
        nextPageParams: {},
        keyColumn: 'id',
    }))) {
        overlayActivitySync(entry.db, 'character', rows);
        yield rows;
    }
}

/** Ids of the change log's delete rows with afterSeq < seq <= uptoSeq, in seq order, in batches - so the search
 * index can apply every pending delete ahead of an upsert backlog.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} afterSeq
 * @param {number} uptoSeq
 * @returns {AsyncGenerator<string[], void, undefined>}
 */
export async function* streamDeletedIdsBetween(directories, afterSeq, uptoSeq) {
    const entry = await getEntry(directories);
    if (!entry) return;
    for await (const rows of streamRows(entry.db, {
        firstPageSql: 'SELECT seq, id FROM changes WHERE op = \'delete\' AND seq > @lo AND seq <= @hi ORDER BY seq LIMIT @limit',
        firstPageParams: { lo: afterSeq, hi: uptoSeq },
        nextPageSql: 'SELECT seq, id FROM changes WHERE op = \'delete\' AND seq > @after AND seq <= @hi ORDER BY seq LIMIT @limit',
        nextPageParams: { hi: uptoSeq },
        keyColumn: 'seq',
    })) {
        yield rows.map(row => row.id);
    }
}

/**
 * @returns {Promise<{ seq: number, changes: { id: string, op: 'upsert'|'delete', fields?: string[]|null }[], truncated: boolean, hasMore: boolean } | null>}
 * `truncated: true` means `sinceSeq` predates the oldest change-log row still kept (the log is never pruned
 * today, so this can currently only trigger for a `sinceSeq` from a different store).
 * Reads at most `limit` log rows past sinceSeq and collapses only those: `seq` is the last row read (pass it
 * back as sinceSeq for the next page) and `hasMore` says whether rows remain. `limit` is required, so no
 * caller can reach an unbounded read.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} sinceSeq
 * @param {{ limit: number }} options
 */
export async function getChangesSince(directories, sinceSeq, { limit } = {}) {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new TypeError('getChangesSince() requires a positive integer limit');
    }
    const entry = await getEntry(directories);
    if (!entry) return null;

    const numericSince = Number.isFinite(sinceSeq) && sinceSeq >= 0 ? Math.trunc(sinceSeq) : 0;
    const bounds = (/** @type {{ minSeq: number | null, maxSeq: number | null } | undefined} */ (entry.db.get('SELECT (SELECT MIN(seq) FROM changes) AS minSeq, (SELECT MAX(seq) FROM changes) AS maxSeq')));
    const minSeq = bounds?.minSeq != null ? Number(bounds.minSeq) : undefined;
    const maxSeq = bounds?.maxSeq != null ? Number(bounds.maxSeq) : 0;

    const truncated = minSeq !== undefined && numericSince < minSeq - 1;
    if (truncated) {
        return { seq: maxSeq, changes: [], truncated: true, hasMore: false };
    }

    let lastSeq = null;
    let hasMore = false;
    let read = 0;
    const rawChanges = /** @type {Generator<ChangeRow>} */ (entry.db.iterate('SELECT seq, id, op, fields FROM changes WHERE seq > ? ORDER BY seq ASC LIMIT ?', [numericSince, limit + 1]));
    // Collapse to one entry per id: a delete anywhere in the window forces a full refetch even if the id
    // is later re-created, since the client's cached copy predates the delete.
    /** @type {Map<string, { op: 'upsert' | 'delete', hasDelete: boolean, hasNullFields: boolean, fieldSet: Set<string> }>} */
    const collapsedById = new Map();
    for (const row of rawChanges) {
        // The page's LIMIT is limit + 1: reaching the extra row means more remain, and it isn't part of this page.
        if (read === limit) {
            hasMore = true;
            break;
        }
        read++;
        lastSeq = Number(row.seq);
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

    return { seq: lastSeq ?? maxSeq, changes, truncated: false, hasMore };
}


// Emitted on characterChangeEmitter as (root) when a store's saved views changed.
export const SAVED_VIEWS_EVENT = 'saved-views';

/** Longest view name and view object a saved view keeps. */
export const SAVED_VIEW_NAME_MAX = 200;
export const SAVED_VIEW_JSON_MAX = 64 * 1024;
/** Most views one list read answers. */
export const SAVED_VIEWS_PAGE_MAX = 200;

/**
 * @typedef {{ id: string, name: string, view: object, position: number, updatedAt: number }} SavedView
 */

/** @param {{ id: string, name: string, view_json: string, position: number, updated_at: number }} row @returns {SavedView} */
function savedViewFromRow(row) {
    return { id: row.id, name: row.name, view: JSON.parse(row.view_json), position: row.position, updatedAt: row.updated_at };
}

/** @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db */
function readSavedViewsVersion(db) {
    const row = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = \'views_version\''));
    return Number(row?.value ?? 0);
}

/**
 * Marks a write to the saved views, in the caller's transaction.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function bumpSavedViewsVersion(db) {
    db.run('INSERT INTO meta (key, value) VALUES (\'views_version\', \'1\') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1');
}

/**
 * One page of the user's saved views in their order, those whose names hold `contains` when it is given.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ contains?: string, after?: { position: number, id: string } | null, limit?: number }} [options]
 * @returns {Promise<{ version: number, views: SavedView[], more: boolean } | null>} null if the store is unavailable.
 */
export async function listSavedViews(directories, { contains = '', after = null, limit = SAVED_VIEWS_PAGE_MAX } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const take = Math.max(1, Math.min(Math.trunc(limit) || SAVED_VIEWS_PAGE_MAX, SAVED_VIEWS_PAGE_MAX));
    const needle = foldName(String(contains).trim());
    const clauses = [];
    /** @type {Record<string, unknown>} */
    const params = { limit: take + 1 };
    if (after) {
        clauses.push('(position > @afterPosition OR (position = @afterPosition AND id > @afterId))');
        params.afterPosition = after.position;
        params.afterId = after.id;
    }
    if (needle) {
        clauses.push('instr(name_fold, @needle) > 0');
        params.needle = needle;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const version = readSavedViewsVersion(entry.db);
    const rows = /** @type {any[]} */ (entry.db.readBounded(
        `SELECT id, name, view_json, position, updated_at FROM saved_views ${where} ORDER BY position, id LIMIT @limit`, params, take + 1));
    return { version, views: rows.slice(0, take).map(savedViewFromRow), more: rows.length > take };
}

/**
 * One saved view, or null when no view has the id.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {Promise<SavedView | null | undefined>} undefined if the store is unavailable.
 */
export async function getSavedView(directories, id) {
    const entry = await getEntry(directories);
    if (!entry) return undefined;
    const row = /** @type {any} */ (entry.db.get('SELECT id, name, view_json, position, updated_at FROM saved_views WHERE id = @id', { id }));
    return row ? savedViewFromRow(row) : null;
}

/**
 * Saves a new view after the user's others.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ name: string, view: object }} params
 * @returns {Promise<SavedView | null>} null if the store is unavailable.
 */
export async function createSavedView(directories, { name, view }) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const id = crypto.randomUUID();
    const now = Date.now();
    let position = 0;
    entry.db.transaction(() => {
        const last = /** @type {{ position: number } | undefined} */ (entry.db.get('SELECT position FROM saved_views ORDER BY position DESC, id DESC LIMIT 1'));
        position = last ? Math.floor(last.position) + 1 : 1;
        entry.db.run('INSERT INTO saved_views (id, name, name_fold, view_json, position, updated_at) VALUES (@id, @name, @fold, @json, @position, @now)',
            { id, name, fold: foldName(name), json: JSON.stringify(view), position, now });
        bumpSavedViewsVersion(entry.db);
    });
    characterChangeEmitter.emit(SAVED_VIEWS_EVENT, directories.root);
    return { id, name, view, position, updatedAt: now };
}

/**
 * Changes one view's name or view object. Writes nothing when neither differs.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {{ name?: string, view?: object }} change
 * @returns {Promise<SavedView | null | undefined>} null when no view has the id; undefined if the store is unavailable.
 */
export async function changeSavedView(directories, id, { name, view }) {
    const entry = await getEntry(directories);
    if (!entry) return undefined;
    /** @type {{ result: SavedView | null, wrote: boolean }} */
    const done = { result: null, wrote: false };
    entry.db.transaction(() => {
        done.wrote = false;
        done.result = null;
        const row = /** @type {any} */ (entry.db.get('SELECT id, name, view_json, position, updated_at FROM saved_views WHERE id = @id', { id }));
        if (!row) return;
        const nextName = name ?? row.name;
        const nextJson = view !== undefined ? JSON.stringify(view) : row.view_json;
        if (nextName === row.name && nextJson === row.view_json) {
            done.result = savedViewFromRow(row);
            return;
        }
        const now = Date.now();
        writeRowIfChanged(entry.db, 'saved_views', { id }, { name: nextName, name_fold: foldName(nextName), view_json: nextJson, updated_at: now });
        bumpSavedViewsVersion(entry.db);
        done.result = { id, name: nextName, view: JSON.parse(nextJson), position: row.position, updatedAt: now };
        done.wrote = true;
    });
    if (done.wrote) characterChangeEmitter.emit(SAVED_VIEWS_EVENT, directories.root);
    return done.result;
}

/**
 * Deletes one view.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {Promise<boolean | null>} false when no view had the id; null if the store is unavailable.
 */
export async function deleteSavedView(directories, id) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const done = { deleted: false };
    entry.db.transaction(() => {
        done.deleted = entry.db.run('DELETE FROM saved_views WHERE id = @id', { id }).changes > 0;
        if (done.deleted) bumpSavedViewsVersion(entry.db);
    });
    if (done.deleted) characterChangeEmitter.emit(SAVED_VIEWS_EVENT, directories.root);
    return done.deleted;
}

/**
 * Moves one view to just before or just after another. Its position goes halfway between its new neighbours; when
 * they are too close for that, the views from the anchor on are numbered apart again.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {{ anchor: string, side: 'before' | 'after' }} where
 * @returns {Promise<'moved' | 'unchanged' | 'missing' | null>} 'missing' when either view doesn't exist; null if the
 *   store is unavailable.
 */
export async function moveSavedView(directories, id, { anchor, side }) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    /** @type {{ outcome: 'moved' | 'unchanged' | 'missing' }} */
    const done = { outcome: 'missing' };
    entry.db.transaction(() => {
        done.outcome = 'missing';
        if (id === anchor) {
            done.outcome = 'unchanged';
            return;
        }
        const moving = /** @type {{ position: number } | undefined} */ (entry.db.get('SELECT position FROM saved_views WHERE id = @id', { id }));
        const at = /** @type {{ position: number } | undefined} */ (entry.db.get('SELECT position FROM saved_views WHERE id = @anchor', { anchor }));
        if (!moving || !at) return;
        const beside = /** @type {{ id: string } | undefined} */ (side === 'before'
            ? entry.db.get('SELECT id FROM saved_views WHERE position < @p OR (position = @p AND id < @anchor) ORDER BY position DESC, id DESC LIMIT 1', { p: at.position, anchor })
            : entry.db.get('SELECT id FROM saved_views WHERE position > @p OR (position = @p AND id > @anchor) ORDER BY position, id LIMIT 1', { p: at.position, anchor }));
        if (beside?.id === id) {
            done.outcome = 'unchanged';
            return;
        }
        const neighbour = /** @type {{ id: string, position: number } | undefined} */ (side === 'before'
            ? entry.db.get('SELECT id, position FROM saved_views WHERE (position < @p OR (position = @p AND id < @anchor)) AND id <> @id ORDER BY position DESC, id DESC LIMIT 1', { p: at.position, anchor, id })
            : entry.db.get('SELECT id, position FROM saved_views WHERE (position > @p OR (position = @p AND id > @anchor)) AND id <> @id ORDER BY position, id LIMIT 1', { p: at.position, anchor, id }));
        const low = side === 'before' ? (neighbour ? neighbour.position : at.position - 2) : at.position;
        const high = side === 'before' ? at.position : (neighbour ? neighbour.position : at.position + 2);
        let position = (low + high) / 2;
        if (!(position > low && position < high)) {
            // Too close to split: space out every view from `low` on by whole numbers, then split the new gap.
            let next = Math.floor(low) + 2;
            for (const row of /** @type {{ id: string }[]} */ (entry.db.readBounded(
                'SELECT id FROM saved_views WHERE position >= @low AND id <> @id ORDER BY position, id LIMIT @cap', { low, id, cap: SAVED_VIEWS_RESPACE_MAX }, SAVED_VIEWS_RESPACE_MAX))) {
                writeRowIfChanged(entry.db, 'saved_views', { id: row.id }, { position: next });
                next += 2;
            }
            const anchorNow = /** @type {{ position: number }} */ (entry.db.get('SELECT position FROM saved_views WHERE id = @anchor', { anchor }));
            position = side === 'before' ? anchorNow.position - 1 : anchorNow.position + 1;
        }
        writeRowIfChanged(entry.db, 'saved_views', { id }, { position });
        bumpSavedViewsVersion(entry.db);
        done.outcome = 'moved';
    });
    if (done.outcome === 'moved') characterChangeEmitter.emit(SAVED_VIEWS_EVENT, directories.root);
    return done.outcome;
}

/** The most views a respace renumbers in one move; a user's own saved views stay well under it. */
const SAVED_VIEWS_RESPACE_MAX = 100000;
