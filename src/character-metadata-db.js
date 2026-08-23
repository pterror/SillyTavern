import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import _ from 'lodash';

import { color, getConfigValue, mapWithConcurrency } from './util.js';
import { parse as parseCharacterCard, parsePristine as parseCharacterCardPristine } from './character-card-parser.js';
import { getCharaCardV2, stripInstallLocalFields } from './character-card-normalize.js';
import { calculateChatSize, calculateDataSize, calculateGroupChatStats, toShallow } from './character-shallow.js';
import { readTagsData } from './endpoints/tags-data.js';
import { getSqliteEngine } from './endpoints/sqlite-engine.js';
import { TAGS_FILE } from './constants.js';
// cyrb53 - pure, dependency-free (no DOM/browser globals), already factored out of power-user.js specifically so
// it stays importable in a plain Node environment (see that module's own header) - reused here rather than
// duplicated so the server's seeded random-sort ordering (design doc §5.3, decision 8/13) can never drift from
// the client comparator (public/scripts/random-sort.js's compareByRandomSeed()) that decides the *same* ordering
// for whatever page hasn't round-tripped to the server yet.
import { getStringHash } from '../public/scripts/hash-utils.js';

/**
 * Phase 1 of the character-data-residency redesign (see docs/design/character-data-residency-redesign.md, §3):
 * a per-user SQLite database that becomes the server-side index of record for everything about a character that
 * ISN'T full text - sort keys, tag relations, a change log, and aggregates like tag-usage counts. Full-text
 * search stays exactly where it already was (characters-search-index.js's tantivy/FTS5 index) - this module
 * never touches it.
 *
 * WHY THIS MODULE IMPORTS NEITHER characters.js NOR tags.js: both of those need to call INTO this module (the
 * former to fire the write-path hooks below, the latter eventually in phase 3), so if this module imported
 * either of them back, that would be the same two-way import cycle this codebase has already been bitten by
 * once (see tags-data.js's header for the TDZ crash that motivated pulling readTagsData() out of tags.js).
 * The arrow only ever points one way: characters.js and (later) tags.js import this module, this module imports
 * only leaf modules (character-card-normalize.js, character-shallow.js, tags-data.js, sqlite-engine.js) that
 * import neither characters.js nor tags.js nor this module. Anything this module needs that would otherwise
 * mean importing characters.js (normalizing an arbitrary on-disk card to Spec V2, computing the shallow
 * projection, computing chat stats) was factored out to one of those leaf modules instead - see their headers.
 *
 * THREE FRESHNESS MECHANISMS, exactly matching the doc's §3.2, in order of latency:
 *   1. Write-path hooks (upsertCharacterFromWrite/deleteCharacterRow/renameCharacterRow below), called directly
 *      from characters.js's route handlers right after a write succeeds. This is the fast, precise path - no
 *      polling delay, no dependency on the filesystem to notice anything.
 *   2. A single non-recursive fs.watch() on the characters directory (startWatcher below), explicitly a latency
 *      optimization only, per the doc's own measurement: a burst of writes landing while the event loop is busy
 *      (a real bulk import, not a hypothetical) silently drops events past inotify's 16384-entry queue, with no
 *      `error` event and no way to tell from JS that it happened. So the watcher exists to catch mutations that
 *      *don't* go through this app's own write path (a file dropped in by hand, or a crash between a write-path
 *      hook and its completion) faster than the reconciler's interval would - it is never trusted as the sole
 *      source of truth for anything.
 *   3. A background reconciler (reconcile() below) as the mandatory backstop - not a "watch this later" item.
 *      It walks the characters directory and diffs it against the metadata table, so a dropped inotify event, a
 *      missed write-path hook, or an edit made while the server was down all get caught on the next pass.
 *
 * date_added IS RECORDED ONCE, AT FIRST INSERT, AND NEVER RECOMPUTED (doc §3.1, decision log #5) - it stops
 * being the PNG's ctimeMs, which moves on a chmod/chown/any metadata write and was never a real "added"
 * timestamp. This falls out of the UPSERT's own SQL rather than being application logic sprinkled through every
 * call site: every upsert statement's ON CONFLICT clause deliberately omits date_added from its SET list (see
 * upsertRowSync() below), so a row that already exists keeps whatever date_added it was first given, no matter
 * how many times it gets re-upserted afterward. What differs per call site is only the *candidate* value passed
 * for a genuinely new row: the one-time bootstrap backfill (bootstrapIfNeeded()) seeds it from the file's
 * ctimeMs, matching the doc's "best available approximation for cards that predate the column"; every other
 * discovery path (a write-path hook, the watcher, or the reconciler finding a file it's never seen) uses
 * Date.now() at the moment it's first seen, matching the doc's "a file dropped into the directory by hand gets
 * date_added = when the reconciler first saw it, not the file's mtime". Threading a caller-supplied date_added
 * through bulk import to preserve source-corpus ordering is flagged in the doc's decision log as still an open
 * question, not a settled one - so it is deliberately NOT implemented here; every new row's date_added comes
 * from one of the two rules above, never from caller input.
 */

// How many pending rows accumulate before a batch-import flush (beginBatchImport/endBatchImport below) or a
// bootstrap backfill pass writes them in one transaction. Mirrors characters-search-index.js's
// INDEX_BUILD_BATCH_SIZE reasoning: bounds peak memory (how many computed rows are held before being flushed)
// without needing a transaction per file, which is the whole point of batch mode - see this module's header and
// the doc's §3.3 item 7.
const BATCH_FLUSH_SIZE = 500;

// How many character files get read+parsed concurrently while bootstrapIfNeeded() backfills a library that
// predates this store. Deliberately the SAME config knob characters-search-index.js's index build already uses
// (performance.characterIndexBuildConcurrency), not a second one - both are the identical shape of work (stat +
// read a PNG file off disk + parse its tEXt chunk) against the same characters directory, and that build's own
// measurement (see that file's INDEX_BUILD_READ_CONCURRENCY comment) already established this install's disk,
// not Node's threadpool, is the limiting factor at any concurrency above ~4 - there is no reason bootstrap's
// version of the same work would plateau anywhere different, so there is nothing for a separate knob to tune.
const BOOTSTRAP_READ_CONCURRENCY = getConfigValue('performance.characterIndexBuildConcurrency', 64, 'number');

// How often bootstrapIfNeeded() emits a progress line while backfilling a large library, in wall-clock ms
// rather than a row/chunk count - a fixed row interval would either spam the log on a fast install or go quiet
// for too long on a slow one, so this ties log frequency to actual elapsed time instead.
const BOOTSTRAP_PROGRESS_LOG_INTERVAL_MS = 5000;

// How often the background reconciler re-walks a user's characters directory (see this module's header, freshness
// mechanism 3). This is a backstop, not the primary freshness path (that's the write-path hooks), so it doesn't
// need to be aggressive - it exists to catch what the other two mechanisms missed.
const RECONCILE_INTERVAL_MS = getConfigValue('performance.characterMetadataReconcileIntervalMs', 5 * 60 * 1000, 'number');

// Gates two consumers, both added alongside backfillContentIdentityHashes()/findCharacterIdByContentIdentityHash()
// below: this module's own one-time backfill pass (which pays the cost described below ONCE per poisoned row,
// not per comparison - see backfillContentIdentityHashes()'s own header) and local-import-scan.js's processFile()
// duplicate check (which, once a row is backfilled, is an O(1) indexed lookup, not the expensive path itself).
// The "expensive" part this flag is actually about is the backfill: reading every poisoned row's PNG off disk
// and computing a hash from its pristine 'chara' chunk (character-card-parser.js's readCharaChunkPristine()) - at
// 24k+ poisoned rows on an install that predates the import-mutation fix, that's real I/O + parse work this lets
// an install opt out of (poisoned characters then simply never participate in the identity-hash dedup fallback,
// same as before this flag had any consumer).
//
// Deliberately read fresh via getConfigValue() at each call site below (backfillContentIdentityHashes(),
// local-import-scan.js's processFile()) rather than through this cached module-load-time export - this export
// itself is left in place as the original groundwork/documentation anchor, but a cached boolean can't be toggled
// mid-process the way tests (and, in principle, a config reload) need to.
export const allowExpensiveDuplicateFallback = !!getConfigValue('performance.allowExpensiveDuplicateFallback', true, 'boolean');

// Debounce window for the fs.watch handler (see startWatcher() below) - editors and this app's own
// write-file-atomic writes can produce more than one raw fs event per logical change (e.g. a rename-over-target
// shows up as both a 'rename' for the temp name and a 'change'/'rename' for the target), so a short debounce per
// filename coalesces those into one stat-and-upsert instead of doing it twice.
const WATCH_DEBOUNCE_MS = 300;

/**
 * @typedef {object} MetadataDbEntry
 * @property {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @property {import('./users.js').UserDirectoryList} directories
 * @property {import('node:fs').FSWatcher | null} watcher
 * @property {Map<string, NodeJS.Timeout>} watchTimers Per-filename debounce timers for the watcher
 * @property {NodeJS.Timeout | null} reconcileInterval
 * @property {{ pending: Map<string, PendingRow> } | null} batch Non-null while batch-import mode is active
 * @property {Promise<void> | null} bootstrapPromise
 */

/**
 * @typedef {object} PendingRow
 * @property {object} row The fully-computed row (see buildRow()), minus rev (assigned at flush time)
 * @property {boolean} forceDateAdded True if `row.date_added` must be used verbatim even on conflict (rename)
 * @property {string[]} tagIds
 */

/** @type {Map<string, MetadataDbEntry>} Keyed by directories.root - one entry per user. */
const entries = new Map();

/** True once a "no usable SQLite backend" warning has been printed, so it only happens once per process. */
let warnedNoEngine = false;

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS characters (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        name_fold      TEXT NOT NULL,
        fav            INTEGER NOT NULL,
        date_added     INTEGER NOT NULL,
        create_date    TEXT,
        date_last_chat INTEGER NOT NULL,
        chat_size      INTEGER NOT NULL,
        data_size      INTEGER NOT NULL,
        file_mtime     INTEGER NOT NULL,
        world          TEXT,
        creator        TEXT,
        version        TEXT,
        creator_notes  TEXT,
        shallow_json   TEXT NOT NULL,
        rev            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_characters_name_fold ON characters(name_fold);
    CREATE INDEX IF NOT EXISTS idx_characters_date_added ON characters(date_added);
    CREATE INDEX IF NOT EXISTS idx_characters_date_last_chat ON characters(date_last_chat);
    CREATE INDEX IF NOT EXISTS idx_characters_chat_size ON characters(chat_size);
    CREATE INDEX IF NOT EXISTS idx_characters_fav_name_fold ON characters(fav, name_fold);
    CREATE INDEX IF NOT EXISTS idx_characters_world ON characters(world);
    -- Populated only via the import write path (bulk-dedup feature, see findCharacterIdByContentHash() below) -
    -- a sha256 hex digest of the raw bytes of the uploaded source file an import came from. NULL for every
    -- character that was never brought in through that path (created/edited in-app, or imported before this
    -- column existed) - deliberately not backfilled for a preexisting library (see this column's own migration
    -- note below), so a NULL/NULL pair never counts as a match: the lookup only ever compares real hash values.
    --
    -- content_identity_hash / import_poisoned (see migrateContentIdentityColumns() below): a DIFFERENT hash
    -- from content_hash above - content_hash fingerprints the raw bytes of whatever file an import was fed
    -- (only ever set on import, only ever matches a byte-identical re-upload); content_identity_hash
    -- fingerprints the character's own semantic content (install-local fields like fav/chat/create_date
    -- stripped first - see stripInstallLocalFields()), computed fresh on EVERY successful write (create, edit,
    -- import, rename - anything that reaches upsertCharacterFromWrite()), so two independently-imported copies
    -- of the same original card can be recognized as the same character even though their raw bytes differ.
    -- That equivalence only holds if the stored file actually went through the minimal-mutation write path
    -- (character-card-parser.js's write(), characters.js's writeCharacterData()) - a card written by the OLD,
    -- more-mutating import logic may have been reformatted/reencoded/spec-upgraded in ways that would make its
    -- hash disagree with a fresh import of the identical original card, even though they're the same character.
    -- import_poisoned=1 flags exactly that "can't trust the hash" state. Every row that predates this column
    -- starts poisoned (its bytes are whatever the old logic produced, unknown/untrustworthy) - see the column's
    -- own DEFAULT below. Any successful write clears it (poisoned=0) and records a hash computed from what was
    -- JUST written, because that write necessarily went through the current (fixed) write path regardless of
    -- how poisoned the row was before. Only upsertCharacterFromWrite() ever clears it - the reconciler/watcher/
    -- bootstrap paths (which discover files, they don't write them) leave both columns exactly as they found
    -- them, same as they already leave date_added alone (see this module's header).
    --
    -- backfillContentIdentityHashes() (below) is a THIRD way content_identity_hash gets populated, and it
    -- deliberately does NOT clear import_poisoned when it does. It recovers a poisoned row's pristine
    -- pre-mutation content straight from the PNG's 'chara' tEXt chunk (character-card-parser.js's
    -- readCharaChunkPristine()/parsePristine() - see write()'s own header for why that chunk is trustworthy even
    -- on a poisoned row) and hashes THAT, so the resulting hash is genuinely comparable to one computed via
    -- today's write path - but import_poisoned's broader meaning is "this row's FILE may still carry other
    -- old-write-path artifacts" (the forced ccv3 upgrade, the old unconditional Jimp re-encode of the avatar
    -- image, fav/chat written into the card instead of omitted), which stays true regardless of whether its hash
    -- is now trustworthy. Only an actual write through the current path (upsertCharacterFromWrite()) proves the
    -- file itself has been brought current, which is the only thing that legitimately clears the flag.

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
        rev INTEGER PRIMARY KEY AUTOINCREMENT,
        id  TEXT NOT NULL,
        op  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changes_id ON changes(id);

    CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
    );

    -- PHASE 3 EXTENSION (owner decision, see this module's header on tags.json's removal), FURTHER EXTENDED
    -- (owner decision) to give groups the same fav/date_added/date_last_chat/chat_size/name_fold columns
    -- characters already have, so a merged characters+groups browse/sort/paginate query (queryEntities() below)
    -- can ORDER BY one shared column shape across both tables via a single UNION ALL. Unlike characters, a
    -- group's id is stable for its whole lifetime (see groups.js's /create - it's minted once and never changes
    -- on rename), so there is no group equivalent of renameCharacterRow()/date_added carry-forward - date_added
    -- write-once still applies (see GROUP_UPSERT_SQL below), it just never needs a rename-time correction.
    -- Groups have no 'world' (no lorebook binding concept) and no full-text index (see queryEntities()'s header
    -- for why filter.search never reaches this table), so those two are simply absent here.
    CREATE TABLE IF NOT EXISTS groups (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        name_fold      TEXT NOT NULL DEFAULT '',
        fav            INTEGER NOT NULL DEFAULT 0,
        date_added     INTEGER NOT NULL DEFAULT 0,
        date_last_chat INTEGER NOT NULL DEFAULT 0,
        chat_size      INTEGER NOT NULL DEFAULT 0
    );
    -- Indexes for the groups table are deliberately NOT here (unlike every other CREATE INDEX in this schema) -
    -- see migrateGroupsColumns() below, which creates them AFTER guaranteeing the columns they reference exist.
    -- An unconditional CREATE INDEX here would run as part of this same db.exec() call, before
    -- migrateGroupsColumns() ever gets a chance to ALTER a pre-existing (old id/name-only shape) groups table -
    -- and SQLite has no lazy/deferred index creation, so CREATE INDEX ... ON groups(name_fold) against a table
    -- that doesn't have that column yet fails outright, taking the whole schema-init call down with it.

    CREATE TABLE IF NOT EXISTS group_tags (
        group_id TEXT NOT NULL,
        tag_id   TEXT NOT NULL,
        PRIMARY KEY (group_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_tags_tag ON group_tags(tag_id, group_id);

    -- Shared tag_usage table (same one character_tags' triggers feed) - a tag's usage count is meant to answer
    -- "how many things use this tag" regardless of whether those things are characters or groups, matching what
    -- the client's RelationStore.usageCounts already counted in one combined Map before this migration (tag_map
    -- always held both character avatars and group ids as keys).
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

    -- PHASE 4D (design doc §2.2/§9): durable bookkeeping for the one-time filename-migration script that moves
    -- every existing character off a name-derived filename onto a minted UUIDv7 id. Deliberately its own indexed
    -- SQL table rather than a single JSON blob in the meta table - a growing "map of every migrated id so far"
    -- stuffed into one meta row would mean re-parsing and re-serializing the WHOLE map on every single character
    -- (O(n) per row, O(n^2) over a 300k-character run), which is exactly the "rewrite the whole blob on every
    -- mutation" antipattern the rest of this redesign exists to retire (see tags.json in this module's own
    -- header). Each row is its own cheap indexed write instead.
    -- completed = 0 means "this old_id/new_id pair has been minted (so a resumed run must reuse the same
    -- new_id rather than minting a second one) but the per-character move (PNG rename, metadata row, chats
    -- directory) may not have finished" - the discriminator the migration script's resume logic queries on.
    -- completed = 1 is also the gate the script's cross-cutting sweep (groups/world_info/note.chara/
    -- active_character rewrites) uses: those rewrites only apply once the underlying identity move for a row is
    -- durably done, never while it's still in flight.
    CREATE TABLE IF NOT EXISTS id_migration (
        old_id    TEXT PRIMARY KEY,
        new_id    TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_id_migration_new ON id_migration(new_id);
    CREATE INDEX IF NOT EXISTS idx_id_migration_completed ON id_migration(completed);

    -- local-import-scan.js's durable "this source file has been positively determined to never be importable"
    -- record - source_path is the discovered file's full absolute path (not just its basename: multiple
    -- configured localImport.directories can share a filename, and this table is keyed per-DEFAULT_USER, not
    -- per-directory, so the full path is the only thing that's actually unique). Exists so a genuinely
    -- non-character file (invalid JSON entirely, e.g. a misnamed PNG; or valid JSON that isn't any recognized
    -- character-card shape, e.g. a lorebook/world-info export sharing a corpus directory with real cards) gets
    -- classified and logged ONCE, rather than re-attempting and re-logging a failed import every single scan
    -- pass forever, including across server restarts (unlike DirectoryScanState.lastSeenMtimeMs, which is
    -- in-memory-only and exists purely as a same-process efficiency cache - this table is the actual mechanism
    -- that stops the retry loop from resuming on every boot).
    -- mtime_ms records the file's mtimeMs AT THE TIME it was classified - a lookup only treats the skip as
    -- still valid when the file's CURRENT mtime still matches, so an owner editing/replacing a skipped file
    -- (e.g. turning a stray lorebook export into an actual character card) naturally invalidates the skip and
    -- gets a fresh classification attempt on the very next pass, no explicit cache-busting needed. This is also
    -- what tells a permanent non-importability apart from a transient one: this row is only ever written from a
    -- pure, non-destructive, in-memory content classification (JSON.parse + shape check) run BEFORE any staging
    -- or import machinery is touched - a real bug in the import code itself, or a file mid-write, never reaches
    -- this table at all and keeps the pre-existing "retry every pass" behavior untouched.
    CREATE TABLE IF NOT EXISTS local_import_skips (
        source_path TEXT PRIMARY KEY,
        mtime_ms    INTEGER NOT NULL,
        reason      TEXT NOT NULL,
        checked_at  INTEGER NOT NULL
    );

    -- local-import-scan.js's durable per-file "already processed at this mtime" record - the persisted
    -- counterpart to DirectoryScanState.lastSeenMtimeMs (in-memory-only, cold on every restart - see that
    -- field's own doc comment). Without this, a server restart forces a full read+hash+dedup-check of every
    -- file in every configured directory even when nothing changed since the last boot, because the in-memory
    -- skip cache always starts empty (measured ~23 minutes for a real ~301k-file corpus - 2026-08 local-import
    -- perf investigation). This table lets that skip survive a restart: on boot, local-import-scan.js bulk-loads
    -- every row for a configured directory into a fresh state's lastSeenMtimeMs before the first pass runs, so a
    -- file whose on-disk mtime still matches its recorded row is skipped in O(1) (a stat, no read/hash/import)
    -- exactly like an in-process rescan already does - this only extends that same existing, efficiency-only,
    -- never-relied-on-for-correctness semantics across a restart, it does not change what "unchanged" means.
    -- Same source_path-is-the-key shape as local_import_skips, for the same reason (multiple configured
    -- directories can share a filename; this table is keyed per-DEFAULT_USER, not per-directory).
    CREATE TABLE IF NOT EXISTS local_import_mtimes (
        source_path TEXT PRIMARY KEY,
        mtime_ms    INTEGER NOT NULL
    );
`;

const UPSERT_SQL = `
    INSERT INTO characters (
        id, name, name_fold, fav, date_added, create_date, date_last_chat, chat_size, data_size,
        file_mtime, world, creator, version, creator_notes, shallow_json, content_hash,
        content_identity_hash, import_poisoned, rev
    ) VALUES (
        @id, @name, @name_fold, @fav, @date_added, @create_date, @date_last_chat, @chat_size, @data_size,
        @file_mtime, @world, @creator, @version, @creator_notes, @shallow_json, @content_hash,
        @content_identity_hash, @import_poisoned, @rev
    )
    ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        name_fold = excluded.name_fold,
        fav = excluded.fav,
        create_date = excluded.create_date,
        date_last_chat = excluded.date_last_chat,
        chat_size = excluded.chat_size,
        data_size = excluded.data_size,
        file_mtime = excluded.file_mtime,
        world = excluded.world,
        creator = excluded.creator,
        version = excluded.version,
        creator_notes = excluded.creator_notes,
        shallow_json = excluded.shallow_json,
        -- COALESCE, not a plain overwrite: most writers of an already-existing row (ordinary edits, the
        -- reconciler re-parsing an unchanged file, the watcher) have no content hash to offer at all (their
        -- buildRow() call passes contentHash: undefined, see below), and a plain '= excluded.content_hash'
        -- would clobber a hash recorded at import time back to NULL on the very next unrelated edit. Only a
        -- write that actually carries a fresh hash (a re-import that reuses this same id, i.e. a preserved-name
        -- replace) overwrites it; every other writer's NULL candidate falls through to keep whatever was there.
        content_hash = COALESCE(excluded.content_hash, characters.content_hash),
        -- Same COALESCE shape as content_hash just above, for the same reason: buildRow() binds a real hash
        -- string only from upsertCharacterFromWrite() (a genuine write just happened), NULL from every other
        -- caller (reconcile/watch/bootstrap, which are re-observing a file, not writing one) - see this
        -- column's own SCHEMA_SQL comment.
        content_identity_hash = COALESCE(excluded.content_identity_hash, characters.content_identity_hash),
        -- Not a COALESCE (import_poisoned is NOT NULL, so there's no NULL sentinel available for "no signal" -
        -- buildRow() binds a real 0/1 always). Instead: a genuine write (excluded.import_poisoned = 0) always
        -- wins and clears poison, because that write just proved this row's bytes now come from the current
        -- write path regardless of whether it was poisoned before. Anything else (reconcile/watch/bootstrap,
        -- which bind import_poisoned = 1 as their "no signal" value - see buildRow()) leaves whatever was
        -- already there untouched, so a previously-cleared row never gets silently re-poisoned just because
        -- something re-observed its unchanged file.
        import_poisoned = CASE WHEN excluded.import_poisoned = 0 THEN 0 ELSE characters.import_poisoned END,
        rev = excluded.rev
    -- date_added is deliberately absent from this SET list - see this module's header ("date_added IS RECORDED
    -- ONCE"). On a genuine insert the VALUES clause's candidate is used; on conflict SQLite leaves the existing
    -- column untouched.
`;

/**
 * Case/accent-folded form of a character's name, for prefix lookup and A-Z sort (doc §3.1's name_fold column) -
 * NFKD-normalizing and stripping combining marks so "É" and "e" sort/prefix-match the same way "é" and "e" do.
 * @param {string} name
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

/**
 * Adds the `content_hash` column (bulk-import exact-duplicate dedup, see findCharacterIdByContentHash() below)
 * to an existing `characters` table that predates it. Not part of SCHEMA_SQL's `CREATE TABLE IF NOT EXISTS`
 * because that statement is a no-op against a table that already exists with an older column set - SQLite (like
 * most SQL engines) has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so this checks `PRAGMA table_info` itself
 * and only runs the ALTER once, on whichever call to getEntry() is the first to see the old shape. A brand-new
 * install's very first CREATE TABLE never has the column either (it isn't in SCHEMA_SQL's column list), so this
 * runs there too, unconditionally the first time - one code path handles both "always ran on a fresh table" and
 * "needs to catch up an existing one", instead of duplicating the column in two places that could drift.
 * Deliberately never backfills existing rows' hashes (they stay NULL) - see this module's header on why
 * `content_hash` is populate-going-forward only, matching the "don't re-hash the whole library" instruction it
 * exists to satisfy.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function migrateContentHashColumn(db) {
    const columns = db.all('PRAGMA table_info(characters)');
    const hasColumn = columns.some(c => c.name === 'content_hash');
    if (!hasColumn) {
        db.exec('ALTER TABLE characters ADD COLUMN content_hash TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_characters_content_hash ON characters(content_hash)');
}

/**
 * Adds `content_identity_hash`/`import_poisoned` (see this module's SCHEMA_SQL comment on both) to an existing
 * `characters` table that predates them. Same ALTER-if-missing shape as migrateContentHashColumn() just above,
 * for the identical reason (no `ADD COLUMN IF NOT EXISTS` in SQLite).
 *
 * `import_poisoned`'s ALTER deliberately gives it `DEFAULT 1` (not 0): every row that already exists the first
 * time this runs was written by whatever import logic was in place before this column existed - which, as of
 * this fix, is unconditionally the OLD, more-mutating logic - so treating every preexisting row as poisoned by
 * default is simply correct, not a conservative placeholder. A brand-new install's very first CREATE TABLE
 * never has this column either (matching migrateContentHashColumn()'s reasoning), so a genuinely-new row
 * inserted via this same connection before any real write happens would also land poisoned=1 by that DEFAULT -
 * which is also correct: SCHEMA_SQL's CREATE TABLE has no way to know this row is about to be immediately
 * overwritten by an INSERT that explicitly supplies its own import_poisoned value (buildRow() always supplies
 * one, so in practice the DEFAULT only matters for a row this module has never upserted through buildRow() at
 * all, e.g. hand-authored test fixtures).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
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

/**
 * Computes the content-identity fingerprint for a just-written character (see this module's SCHEMA_SQL comment
 * on content_identity_hash) - sha256 over a canonical (sorted-keys) JSON serialization of the character with
 * install-local fields (fav/chat/create_date) stripped, so two independently-imported copies of the same
 * original card hash identically regardless of which install produced them or what key order their JSON
 * happened to serialize in.
 * @param {object} character Spec V2 character object (already parsed from the JSON that was just written)
 * @returns {string} sha256 hex digest
 */
export function computeContentIdentityHash(character) {
    const stripped = stripInstallLocalFields(character);
    return crypto.createHash('sha256').update(canonicalStringify(stripped)).digest('hex');
}

/**
 * JSON.stringify with object keys sorted at every level, so two objects with the same key/value pairs in a
 * different insertion order (e.g. a value that round-tripped through JSON.parse -> mutate -> JSON.stringify
 * versus one that never did) always serialize identically. Only ever fed the plain-data output of
 * stripInstallLocalFields() (no cycles, no non-JSON-safe values), so this doesn't need JSON.stringify's full
 * generality (replacer functions, etc.) - just deterministic key order.
 * @param {*} value
 * @returns {string}
 */
function canonicalStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        // Skips undefined-VALUED own keys (not just absent ones) - matching JSON.stringify()'s own semantics
        // (which silently omits them from object output), rather than serializing the literal word `undefined`
        // for one. Without this, an object that still carries an own key set to undefined (e.g.
        // character-card-normalize.js's readFromV2() - see its fieldMappings loop's talkativeness fallback,
        // which sets a default and then unconditionally overwrites it back to `undefined` when the source has
        // no explicit value) would hash differently depending on whether it happened to have already been
        // round-tripped through JSON.stringify/JSON.parse before reaching here - a real footgun for exactly one
        // of this function's two callers (backfillContentIdentityHashes() below feeds it a freshly-normalized,
        // never-round-tripped object; upsertCharacterFromWrite() always feeds it `JSON.parse(cardJson)`, which
        // can never have an undefined-valued key in the first place) rather than a difference in the character's
        // actual semantic content.
        const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * Adds `fav`/`date_added`/`date_last_chat`/`chat_size`/`name_fold` to an existing `groups` table that predates
 * them (an install that only ever had the phase-3 minimal `id, name` shape) - same guarded-ALTER pattern as
 * migrateContentHashColumn() above, for the same reason (SQLite has no `ADD COLUMN IF NOT EXISTS`, and
 * SCHEMA_SQL's `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table with an older column set). A
 * brand-new install's first CREATE TABLE already has every column (they're in SCHEMA_SQL's groups definition
 * now), so every ALTER below is a no-op there - one code path handles both "always ran on a fresh table" and
 * "needs to catch up an existing one".
 *
 * UNLIKE migrateContentHashColumn(), this ALSO backfills real values into any row that already existed under the
 * old 2-column shape - and it has to be done here, as a plain UPDATE, rather than by re-running
 * bootstrapGroupsIfNeeded()'s normal upsert path. The reason is the write-once contract: GROUP_UPSERT_SQL's ON
 * CONFLICT clause deliberately never overwrites an existing row's `date_added` (see that SQL's own comment), so
 * a row that already exists (inserted back when the table only had `id`/`name`) would have its ALTER-added
 * `date_added` default of 0 frozen forever - bootstrapGroupsIfNeeded() is separately gated by
 * `groups_bootstrap_completed`, which is already set on such an install, so it would never even run again to
 * try. This function's own ALTER-presence check is therefore the only gate this backfill needs: it only touches
 * rows for a genuinely pre-existing table, and it only runs once (the next call finds every column already
 * present and does nothing).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {import('./users.js').UserDirectoryList} directories Needed to re-read each existing group's JSON file
 * for the values ALTER's column defaults can't supply (name, fav, chat ids for stat'ing).
 */
function migrateGroupsColumns(db, directories) {
    const columns = db.all('PRAGMA table_info(groups)');
    const columnNames = new Set(columns.map(c => c.name));
    const isPreExistingTable = columnNames.size > 0 && !columnNames.has('date_added');

    if (!columnNames.has('name_fold')) db.exec("ALTER TABLE groups ADD COLUMN name_fold TEXT NOT NULL DEFAULT ''");
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

/**
 * Resolves (creating on first use) the metadata DB entry for a user, including opening the SQLite file and
 * applying SCHEMA_SQL (idempotent - every statement is CREATE ... IF NOT EXISTS). Returns `null` if no SQLite
 * engine is usable on this install at all (see sqlite-engine.js) - callers must treat that as "the metadata
 * store is unavailable this run" and no-op rather than throwing, the same way this codebase already treats a
 * missing search backend as non-fatal (native-sqlite.js).
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<MetadataDbEntry | null>}
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
    migrateGroupsColumns(db, directories);
    // Design doc §5.3, decisions 8/13: random-sort order is a per-query `ORDER BY <hash>(id, seed)`, never a
    // materialized column (a materialized seeded column is O(users × rerolls) to maintain - see the decision's
    // rationale). Registering the client's own cyrb53 as a real SQL function is what makes that expressible at
    // the SQL layer at all, so it composes with LIMIT/OFFSET pagination instead of requiring a JS-side sort over
    // every candidate row first.
    db.defineFunction('RANDHASH', (id, seed) => getStringHash(String(id ?? ''), Number(seed ?? 0)));
    /** @type {MetadataDbEntry} */
    const entry = { db, directories, watcher: null, watchTimers: new Map(), reconcileInterval: null, batch: null, bootstrapPromise: null };
    entries.set(key, entry);
    return entry;
}

/**
 * Builds the full row (everything UPSERT_SQL needs except `rev`, which is only known once the change-log entry
 * is inserted - see writeRowSync()) from an already Spec-V2-normalized character object.
 * @param {string} id Avatar filename (today's primary key - see the design doc §2.2 on why this is pre-Option-A)
 * @param {object} character Spec V2 character object
 * @param {object} extra
 * @param {number} extra.dateAddedCandidate Used only if this is a genuine insert - see this module's header
 * @param {number} extra.fileMtime
 * @param {number} extra.chatSize
 * @param {number} extra.dateLastChat
 * @param {string|null} [extra.contentHash]
 * @param {string|null} [extra.contentIdentityHash] sha256 hex digest from computeContentIdentityHash(), or
 * undefined/null from every caller except upsertCharacterFromWrite() - see this column's SCHEMA_SQL comment.
 * @returns {object} Row fields (minus `rev`)
 */
function buildRow(id, character, { dateAddedCandidate, fileMtime, chatSize, dateLastChat, contentHash, contentIdentityHash }) {
    const includeCreatorNotes = !!getConfigValue('performance.shallowCharactersIncludeCreatorNotes', false, 'boolean');
    const dataSize = calculateDataSize(character?.data);
    const shallowSource = {
        ...character,
        avatar: id,
        date_added: dateAddedCandidate,
        date_last_chat: dateLastChat,
        chat_size: chatSize,
        data_size: dataSize,
    };
    return {
        id,
        name: character.name ?? '',
        name_fold: foldName(character.name),
        fav: character.fav ? 1 : 0,
        date_added: dateAddedCandidate,
        create_date: character.create_date ?? null,
        date_last_chat: dateLastChat,
        chat_size: chatSize,
        data_size: dataSize,
        file_mtime: fileMtime,
        world: _.get(character, 'data.extensions.world', '') || null,
        creator: _.get(character, 'data.creator', '') || null,
        version: _.get(character, 'data.character_version', '') || null,
        creator_notes: includeCreatorNotes ? (_.get(character, 'data.creator_notes', '') || null) : null,
        shallow_json: JSON.stringify(toShallow(shallowSource)),
        // Undefined/omitted from every call site except the import write path (see upsertCharacterFromWrite()'s
        // own contentHash param) - normalized to `null` here so UPSERT_SQL's bound parameter is always a real
        // SQL value, never `undefined` (which better-sqlite3 rejects as a bind parameter). See UPSERT_SQL's
        // ON CONFLICT clause for why a `null` candidate here never clobbers an existing hash on update.
        content_hash: contentHash ?? null,
        // See UPSERT_SQL's ON CONFLICT clause and this column's SCHEMA_SQL comment: a real hash string only
        // ever comes from upsertCharacterFromWrite() (a write just happened); every other caller's `undefined`
        // normalizes to `null` here, which the COALESCE in UPSERT_SQL then treats as "no signal, don't touch".
        content_identity_hash: contentIdentityHash ?? null,
        // Not COALESCE-able the way content_identity_hash is (this column is NOT NULL, so there's no spare
        // NULL to use as a "no signal" sentinel) - 0 only when a real write just proved this row unpoisoned
        // (contentIdentityHash was supplied), 1 (the "no signal, and also the correct default for a row nobody
        // has ever confirmed clean" value) otherwise. See UPSERT_SQL's own CASE-based ON CONFLICT clause for
        // how a genuine INSERT and a "no signal" conflict update end up with the right value from this same
        // bound parameter despite it only ever being a plain 0/1.
        import_poisoned: contentIdentityHash ? 0 : 1,
    };
}

/**
 * Writes one row plus its change-log entry, synchronously, meant to run inside `db.transaction(...)`. Not
 * exported - all the exported upsert/delete/rename functions below route through this (or its batch-flush
 * sibling, flushBatch()).
 *
 * PHASE 3 (design doc §3.4/Phase 3): `character_tags` is now the source of truth for character<->tag
 * assignments, mutated directly by `POST /api/tags/assign`/`/unassign` (see assignCharacterTag()/
 * unassignCharacterTag() below) - NOT re-derived from tags.json on every ordinary metadata write anymore. This
 * function used to unconditionally `DELETE FROM character_tags WHERE character_id = @id` and reinsert from
 * `tagIds` on every call, which was correct back when character_tags was a read-only mirror kept in sync by
 * resyncTags() (still true through phase 1/2), but became actively destructive once direct-assignment writes
 * existed: an ordinary character edit (rename, fav toggle, whatever) firing this same write path would silently
 * revert any tag assigned/unassigned since tags.json was last read, because tags.json's tag_map is no longer
 * kept current for characters.
 *
 * So `tagIds` is now used ONLY to seed a genuinely brand-new row's tags - once, at the row's first INSERT
 * (`existed` below is false) - which is what carries an existing library's tags.json content forward into this
 * table the first time a character is discovered (bootstrapIfNeeded()'s one-time backfill, or a file dropped
 * into the directory by hand that happens to have a legacy tag_map entry). An UPDATE of an already-existing row
 * never touches character_tags at all here; existing assignments in that table stand as-is regardless of what
 * `tagIds`/tags.json says.
 *
 * The exact same reasoning applies to `fav`, one owner-decision layer further: once a row exists, its `fav`
 * column is the ONLY source of truth for favorite status - a card file's embedded `fav` (or `data.extensions.
 * fav`) only ever seeds the row's *first* INSERT (see buildRow()'s own `fav` field, computed from whatever
 * `character.fav` this call was given), the same one-time role tagIds plays above. An ordinary re-upsert of an
 * existing row (an edit, a reconcile pass picking up an externally-touched file, a re-import of the same avatar
 * id) must not let a stale or attacker/tool-authored embedded value silently override a toggle made through the
 * dedicated fav write path (setCharacterFav() below, the only other writer of this column post-insert) - so
 * `row.fav`/its `shallow_json`'s own embedded `fav` copy are both forced back to the row's current value here
 * before the UPSERT ever runs, regardless of what buildRow() computed them as.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {object} row From buildRow()
 * @param {string[]} tagIds Seed tag ids - applied only if this is a genuine insert, see above.
 */
function writeRowSync(db, row, tagIds) {
    const existingRow = db.get('SELECT fav FROM characters WHERE id = @id', { id: row.id });
    const existed = !!existingRow;

    if (existed) {
        const currentFav = existingRow.fav ? 1 : 0;
        if (row.fav !== currentFav) {
            const shallow = JSON.parse(row.shallow_json);
            shallow.fav = !!currentFav;
            row = { ...row, fav: currentFav, shallow_json: JSON.stringify(shallow) };
        }
    }

    const { lastInsertRowid } = db.run('INSERT INTO changes (id, op) VALUES (@id, @op)', { id: row.id, op: 'upsert' });
    db.run(UPSERT_SQL, { ...row, rev: Number(lastInsertRowid) });

    if (!existed) {
        for (const tagId of tagIds) {
            db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@characterId, @tagId)', { characterId: row.id, tagId });
        }
    }
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 */
function deleteRowSync(db, id) {
    db.run('DELETE FROM characters WHERE id = @id', { id });
    db.run('DELETE FROM character_tags WHERE character_id = @id', { id });
    db.run('INSERT INTO changes (id, op) VALUES (@id, @op)', { id, op: 'delete' });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {string[]} Tag ids currently assigned to this character in tags.json (read-only - phase 1 keeps
 * tags.json as the write source of truth; this table is a query-ready mirror of it, kept in sync by
 * resyncTags() below. Migrating the write path itself onto character_tags is phase 3's job.)
 */
function getTagIdsFor(directories, avatar) {
    const { tag_map } = readTagsData(directories);
    return tag_map[avatar] ?? [];
}

/**
 * Write-path hook for characters.js's writeCharacterData() - the single low-level function every character
 * create/edit/edit-avatar/edit-attribute/merge-attributes/import route funnels a PNG write through. Called
 * right after a write succeeds, with the exact same JSON string that was just written, so this never re-reads
 * the file it was just given.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar Avatar filename (e.g. `Alice.png`)
 * @param {string} cardJson The Spec-V2-normalized character JSON that was just written to disk
 * @param {number} fileMtimeMs mtime of the file that was just written (caller already has this from the write)
 * @param {string|null} [contentHash] sha256 hex digest of the raw uploaded source-file bytes this write came
 * from (bulk-import dedup, see findCharacterIdByContentHash() below) - only the import route has one of these to
 * offer; every other writer (create/edit/rename/etc.) omits it, which buildRow() normalizes to `null` and
 * UPSERT_SQL's ON CONFLICT clause then treats as "don't touch whatever hash is already there" rather than a
 * real candidate value - see that clause's own comment.
 * @returns {Promise<void>}
 */
export async function upsertCharacterFromWrite(directories, avatar, cardJson, fileMtimeMs, contentHash = null) {
    const entry = await getEntry(directories);
    if (!entry) return;

    let character;
    try {
        character = JSON.parse(cardJson);
    } catch (err) {
        console.error(`[character-metadata] Failed to parse just-written card for ${avatar}, skipping metadata upsert:`, err);
        return;
    }

    // Every call here follows a real writeCharacterData() success (see this function's own header), so the file
    // just written necessarily went through the current, minimal-mutation write path regardless of whether this
    // row was poisoned before - buildRow() uses contentIdentityHash's mere presence (not its value) to clear
    // import_poisoned, see that column's SCHEMA_SQL comment.
    const contentIdentityHash = computeContentIdentityHash(character);
    const { chatSize, dateLastChat } = calculateChatSize(path.join(directories.chats, avatar.replace(/\.png$/, '')));
    const row = buildRow(avatar, character, { dateAddedCandidate: Date.now(), fileMtime: fileMtimeMs, chatSize, dateLastChat, contentHash, contentIdentityHash });
    const tagIds = getTagIdsFor(directories, avatar);

    applyOrBuffer(entry, row, tagIds);
}

/**
 * Write-path hook for the fav-toggle UI action (owner decision - see this module's header on `fav` being
 * db-authoritative once a row exists) - the ONE writer, other than a row's first INSERT, ever allowed to change
 * the `fav` column. Deliberately does NOT touch the character's PNG card file at all: no read, no write, no
 * fireMetadataUpsertHook() - a favorite toggle is now a pure metadata-store mutation, matching upsertGroupRow()'s
 * existing `{ fav }` shape for groups.
 *
 * Patches `shallow_json`'s own embedded `fav` field to match, so a `/query` read (queryCharacters(), which
 * returns `JSON.parse(shallow_json)` verbatim - see that function) stays consistent with the `fav` column
 * without needing a separate per-row stamp step the way the live `/all` route's processCharacter() results do
 * (see getCharacterFavsByIds() below, used for exactly that).
 *
 * No-op (returns false) if this avatar isn't tracked yet - a row has to exist for its `fav` column to mean
 * anything; a character encountered for the first time gets its embedded `fav` picked up once by whatever write
 * path (bootstrapIfNeeded()/reconcile()/upsertCharacterFromWrite()) first INSERTs its row, per writeRowSync()'s
 * own doc comment.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar Avatar filename (e.g. `Alice.png`)
 * @param {boolean} fav
 * @returns {Promise<boolean>} True if a row existed and was updated.
 */
export async function setCharacterFav(directories, avatar, fav) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    const existing = entry.db.get('SELECT shallow_json FROM characters WHERE id = @id', { id: avatar });
    if (!existing) return false;

    const shallow = JSON.parse(existing.shallow_json);
    shallow.fav = !!fav;

    const { lastInsertRowid } = entry.db.run('INSERT INTO changes (id, op) VALUES (@id, @op)', { id: avatar, op: 'upsert' });
    entry.db.run(
        'UPDATE characters SET fav = @fav, shallow_json = @shallow_json, rev = @rev WHERE id = @id',
        { id: avatar, fav: fav ? 1 : 0, shallow_json: JSON.stringify(shallow), rev: Number(lastInsertRowid) },
    );
    return true;
}

/**
 * Bulk `fav` lookup for a known set of ids - the batched counterpart to reading `fav` off each row individually,
 * used by the live `/all` route (characters.js) to stamp its already-disk-read `processCharacter()` results with
 * the db's authoritative `fav` value in one query rather than one-per-character. Ids with no tracked row are
 * simply absent from the result (caller's job to decide a fallback - see that route for why "not tracked yet"
 * means "the file is still the source", not "false").
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids Avatar filenames
 * @returns {Promise<{[id: string]: boolean}>}
 */
export async function getCharacterFavsByIds(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry || !Array.isArray(ids) || ids.length === 0) return {};

    const placeholders = ids.map(() => '?').join(',');
    const rows = entry.db.all(`SELECT id, fav FROM characters WHERE id IN (${placeholders})`, ids);

    /** @type {{[id: string]: boolean}} */
    const result = {};
    for (const row of rows) {
        result[row.id] = !!row.fav;
    }
    return result;
}

/**
 * Write-path hook for characters.js's /delete route.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<void>}
 */
export async function deleteCharacterRow(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return;

    if (entry.batch) {
        entry.batch.pending.delete(avatar);
        // Deletes are rare during a batch import (which is about bringing characters IN), so they're applied
        // immediately rather than buffered - simpler, and correctness matters more than the modest transaction
        // savings here.
    }
    entry.db.transaction(() => deleteRowSync(entry.db, avatar));
}

/**
 * Write-path hook for characters.js's /rename route - called AFTER writeCharacterData() has already run for the
 * new filename (which fires upsertCharacterFromWrite() generically via its own embedded hook, per that
 * function's own doc comment - so a row for `newAvatar` already exists in the table, or is sitting in this
 * user's batch buffer, by the time this runs).
 *
 * Under today's pre-Option-A identity (design doc §2.2), a rename changes the primary key itself
 * (avatar == filename == id), so the generic hook necessarily saw `newAvatar` as a brand-new row and gave it
 * date_added = now. That's wrong here: this is conceptually the same character continuing to exist, not a new
 * one being added (see this module's header on date_added), so this function's only job is to correct that -
 * copy date_added over from the old row, then remove the old row entirely. It does not rebuild or re-derive
 * anything else about the row; that's already correct from the generic hook.
 *
 * BOTH the `date_added` column AND `shallow_json`'s own embedded `date_added` field get corrected here, not just
 * the column - found by phase 2's own tests (tests/characters-query.test.js), which read rows back through
 * `shallow_json` (that's what `/query` actually ships - see queryCharacters()) rather than the raw columns.
 * `shallow_json` is a point-in-time snapshot taken at upsert time (buildRow()); patching only the column and
 * leaving the blob's own copy stale would mean every *reader* of this table's shallow projection - not just this
 * phase's endpoint - sees the wrong date_added after any rename, which is exactly the kind of silently-wrong
 * result this design keeps calling out as worse than an explicit failure.
 *
 * PHASE 3 addition: tag assignments get the exact same forward-carry treatment as date_added, for the exact same
 * reason. `character_tags` is now source of truth (see writeRowSync()'s header), so the generic upsert hook that
 * already ran for `newAvatar` seeded it with only whatever tags.json happened to say for that (brand-new, never
 * before seen) id - typically nothing. Without this, the trailing `deleteRowSync(oldAvatar)` below would delete
 * `oldAvatar`'s real tag rows with nothing ever having carried them to `newAvatar`, i.e. every rename would
 * silently drop that character's tags. Tag ids are unioned into `newAvatar`, not overwritten - if the generic
 * hook's seed already gave it something (a legacy tags.json entry already keyed by the new name), both survive.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} oldAvatar
 * @param {string} newAvatar
 * @returns {Promise<void>}
 */
export async function renameCharacterRow(directories, oldAvatar, newAvatar) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const oldRow = entry.db.get('SELECT date_added FROM characters WHERE id = @id', { id: oldAvatar });
    if (oldRow) {
        const dateAdded = Number(oldRow.date_added);
        // The new row may still be sitting in the batch-import buffer rather than the table (a rename landing
        // mid-batch-import is an edge case, but a real one) - patch it in place there rather than via SQL, which
        // wouldn't see it yet.
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

    // Carry oldAvatar's tag assignments forward to newAvatar - see this function's doc comment above. Read
    // BEFORE the transaction that deletes oldAvatar's rows, same ordering the date_added carry-forward above
    // already uses.
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

/**
 * @param {string} shallowJson
 * @param {number} dateAdded
 * @returns {string} `shallowJson` with its `date_added` field overwritten - unmodified if it doesn't parse (this
 * module always writes valid JSON into this column itself, so a parse failure here would mean something else
 * corrupted the row; falling back to the unmodified string rather than throwing keeps this a non-fatal repair).
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

/**
 * Either writes `row` immediately (one small transaction) or, while batch-import mode is active for this
 * user, buffers it and flushes in BATCH_FLUSH_SIZE-sized chunks instead - see beginBatchImport()'s header.
 * @param {MetadataDbEntry} entry
 * @param {object} row
 * @param {string[]} tagIds
 */
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

/**
 * @param {MetadataDbEntry} entry
 */
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

/**
 * Explicit batch-import mode (doc §3.3 item 7): required, not optional, for bringing a large corpus (the
 * owner's stated near-term target is ~300k cards) in without paying one SQLite transaction and one watcher
 * event per file. While active for a user:
 *   - the directory watcher is suspended (a burst of hundreds of thousands of creates is exactly the scenario
 *     the design doc measured inotify's queue silently overflowing at 16384 events under - see this module's
 *     header - so there is nothing useful for the watcher to do here anyway; the reconciler forced at
 *     endBatchImport() is what actually catches anything the suspended watcher would have)
 *   - write-path hook calls buffer into a pending map instead of writing immediately, flushed in
 *     BATCH_FLUSH_SIZE-row transactions (applyOrBuffer()/flushBatch() above)
 * Idempotent: calling this again while already active is a no-op (returns the existing batch state rather than
 * losing whatever's already pending).
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
export async function beginBatchImport(directories) {
    const entry = await getEntry(directories);
    if (!entry || entry.batch) return;

    entry.batch = { pending: new Map() };
    stopWatcher(entry);
}

/**
 * Ends batch-import mode: flushes whatever's still buffered, forces one reconcile pass (the safety net for
 * anything that happened to this directory *outside* the write-path hooks while the watcher was suspended - a
 * file dropped in by hand mid-import, for instance), then resumes the watcher.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
export async function endBatchImport(directories) {
    const entry = await getEntry(directories);
    if (!entry || !entry.batch) return;

    flushBatch(entry);
    entry.batch = null;
    await reconcile(directories);
    startWatcher(entry);
}

/**
 * One-time backfill for a library that predates this metadata store (or a brand-new user with an existing
 * `characters` directory - e.g. restored from a backup). Seeds date_added from each file's ctimeMs, per the
 * design doc's explicit call: "the best available approximation for cards that predate the column" - this is
 * the ONE place ctimeMs is still used as date_added; every other discovery path uses "now" (see this module's
 * header). Recorded in `meta` so it only ever runs once per user, ever - a later reconcile() finding "new" files
 * after this has run is a genuinely different situation (see reconcile()'s own doc comment) and must not reuse
 * this ctimeMs-seeding behavior.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
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

    // Read tags.json ONCE, up front, rather than via the per-call getTagIdsFor() (which re-reads and re-parses
    // tags.json off disk, synchronously, on every invocation) - the same fix characters-search-index.js's
    // makeTagNamesResolver() already applies to this exact file for this exact reason. Calling getTagIdsFor()
    // once per character here (as this loop used to) meant a full sync readFileSync+JSON.parse of tags.json for
    // every single card in the library, not just once - both the redundant I/O and the fact that readFileSync
    // blocks the event loop for the length of the whole bootstrap pass.
    const { tag_map } = readTagsData(directories);

    // Progress visibility for a cold-start bootstrap against a large library (24k+ cards has been measured
    // taking a couple of minutes end to end): a completely silent multi-minute pass with no output on the way
    // is indistinguishable from a hang. Neither this loop nor characters-search-index.js's equivalent
    // index-build pass had any existing progress-log format to match, so this is a new (deliberately minimal)
    // one: throttled to BOOTSTRAP_PROGRESS_LOG_INTERVAL_MS of wall-clock time, never per-row or per-chunk, so it
    // can't meaningfully add overhead regardless of library size.
    const bootstrapStart = Date.now();
    let lastProgressLog = bootstrapStart;
    let processedFiles = 0;

    // Streamed in BATCH_FLUSH_SIZE-sized chunks, each chunk's file reads run with bounded concurrency (see
    // BOOTSTRAP_READ_CONCURRENCY above) instead of one file at a time - this loop used to `await` each file's
    // stat+parse sequentially, which is what made this pass I/O-bound on per-file round-trip latency rather than
    // on actual disk throughput (exactly the mistake characters-search-index.js's readCharacterBatches() already
    // fixed for the equivalent search-index-build pass - see that function's header). Chunking (rather than one
    // mapWithConcurrency call over the whole library) keeps this consistent with BATCH_FLUSH_SIZE's own job of
    // bounding peak memory: at most one chunk's worth of computed rows is ever held before being flushed.
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
                const row = buildRow(file, character, { dateAddedCandidate: Math.round(stat.ctimeMs), fileMtime: stat.mtimeMs, chatSize, dateLastChat });
                return { row, tagIds: tag_map[file] ?? [] };
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

        // Yield the event loop between chunks, matching reconcile()'s own per-batch yield (see that function) -
        // a 24k+-card bootstrap pass must not hog the event loop for its entire duration any more than a
        // reconcile pass is allowed to.
        await new Promise(resolve => setImmediate(resolve));
    }

    if (files.length > 0) {
        const totalSec = (Date.now() - bootstrapStart) / 1000;
        console.log(color.cyan(`[character-metadata] Bootstrap complete: ${files.length} cards in ${totalSec.toFixed(1)}s (${(files.length / totalSec).toFixed(1)} cards/sec).`));
    }

    entry.db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key: 'bootstrap_completed', value: String(Date.now()) });
    await resyncTags(directories);
}

/**
 * One-time-per-boot backfill (NOT one-time-ever - see below) that makes a poisoned row's content_identity_hash
 * trustworthy, turning findCharacterIdByContentIdentityHash() into a real O(1) indexed duplicate check against
 * this install's entire poisoned library, not just the (empty, on a preexisting install) set of rows that have
 * already been re-touched by the fixed write path.
 *
 * THE TRICK: a poisoned row's PNG 'chara' tEXt chunk is pristine (see character-card-parser.js's write() header
 * and readCharaChunkPristine()'s own doc comment for the full mechanism) - the old write() unconditionally wrote
 * 'chara' holding the source `data` verbatim, and only SEPARATELY wrote a 'ccv3' chunk with a locally spec-bumped
 * copy, so the object serialized into 'chara' was never touched by that bump. Reading 'chara' specifically
 * (readCharaChunkPristine()/parsePristine(), not the standard ccv3-preferring read()/parse()) recovers exactly
 * what write() would have received had it gone through today's fixed logic - so hashing that, the same way
 * computeContentIdentityHash() always has, produces a hash that is genuinely comparable to one computed from a
 * fresh import of the same original card.
 *
 * Deliberately does NOT clear `import_poisoned` - see that column's own SCHEMA_SQL comment for why the flag's
 * broader meaning ("this row's file may still carry other old-write-path artifacts") stays true regardless of
 * whether its hash is now trustworthy.
 *
 * IDEMPOTENT/RESUMABLE WITHOUT A `meta` COMPLETION FLAG, unlike bootstrapIfNeeded(): every call re-queries
 * `WHERE import_poisoned = 1 AND content_identity_hash IS NULL` fresh, so a row this pass successfully hashed
 * simply stops matching that WHERE clause and is never re-visited; a row that failed (a missing/corrupt file,
 * logged and skipped) naturally gets retried on the NEXT call (the next server boot) since it's still poisoned
 * with a NULL hash. No separate "backfill complete" bookkeeping needed or wanted - see this function's own
 * caller in initializeMetadataStores() for why running it every boot (not gated on a one-time flag) is exactly
 * the resumability this needs.
 *
 * Same batching/concurrency/progress-logging shape as bootstrapIfNeeded() (BATCH_FLUSH_SIZE-sized chunks,
 * BOOTSTRAP_READ_CONCURRENCY-bounded concurrent reads, a throttled progress log, an event-loop yield between
 * chunks) - this is the same shape of work (stat/read/parse a PNG off disk) at the same potential scale (24k+
 * rows on the owner's real library), so there's no reason for it to behave differently.
 *
 * Gated behind `performance.allowExpensiveDuplicateFallback`, read FRESH via getConfigValue() (not the cached
 * `allowExpensiveDuplicateFallback` export above) so a config/env change takes effect on the very next call
 * without requiring a process restart to be observed - see that export's own updated header comment.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
export async function backfillContentIdentityHashes(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    if (!getConfigValue('performance.allowExpensiveDuplicateFallback', true, 'boolean')) return;

    if (!fs.existsSync(directories.characters)) return;

    // A static snapshot of ids to process THIS call, not a live re-query inside the loop below - re-querying the
    // same WHERE clause without an OFFSET would return the exact same rows again for any that failed to hash
    // this pass (they're still poisoned with a NULL hash), looping forever on a persistently-broken row instead
    // of moving on. Taking the list once up front bounds this call's work to "however many rows were poisoned
    // and hashless when it started", matching bootstrapIfNeeded()'s own fixed-file-list shape.
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
                const pristine = await parseCharacterCardPristine(filePath);
                const character = getCharaCardV2(JSON.parse(pristine), directories, false);
                return { id, hash: computeContentIdentityHash(character) };
            } catch (err) {
                console.error(`[character-metadata] Content-identity backfill failed to process ${id}, leaving it poisoned (will retry next boot):`, err.message);
                return null;
            }
        });

        const updates = chunkResults.filter(Boolean);
        if (updates.length > 0) {
            entry.db.transaction(() => {
                for (const { id, hash } of updates) {
                    entry.db.run('UPDATE characters SET content_identity_hash = @hash WHERE id = @id', { hash, id });
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

        // Same reasoning as bootstrapIfNeeded()'s own per-chunk yield: a 24k+-row backfill pass must not hog the
        // event loop for its entire duration.
        await new Promise(resolve => setImmediate(resolve));
    }

    const totalSec = (Date.now() - backfillStart) / 1000;
    console.log(color.cyan(`[character-metadata] Content-identity backfill complete: processed ${poisonedIds.length} poisoned row(s) in ${totalSec.toFixed(1)}s (${(poisonedIds.length / totalSec).toFixed(1)} cards/sec).`));
}

/**
 * Diffs tags.json's tag_map against the character_tags table and applies only the delta, rather than a full
 * delete-everything-reinsert-everything pass - at 300k+ characters with an already-populated table, most rows
 * agree between passes, so this keeps a routine reconcile cheap. tags.json stays the write source of truth in
 * phase 1 (phase 3 moves tag mutations onto character_tags directly, per the design doc's phase table); this is
 * a read-only mirror, refreshed on every reconcile pass since there's no per-mutation hook into tags.json yet.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
export async function resyncTags(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const { tag_map } = readTagsData(directories);
    const knownIds = new Set(entry.db.all('SELECT id FROM characters').map(r => r.id));

    /** @type {Set<string>} `${characterId} ${tagId}` pairs that should exist */
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

/**
 * The mandatory reconciler backstop (doc §3.2 item 3 / §3.3 item 3's "the reconciler is what makes it safe").
 * Walks the characters directory with async opendir (never blocks the event loop for long - see the
 * yield-every-batch loop below) and diffs it against the metadata table:
 *   - a file on disk with no row -> inserted, with date_added = now (this is the "reconciler first saw it"
 *     case from the design doc's §3.1, distinct from bootstrapIfNeeded()'s one-time ctimeMs seeding - by the
 *     time any reconcile() call happens, bootstrap has necessarily already run for this user, or is running
 *     concurrently and will win the same idempotent upsert either way)
 *   - a row with no file on disk -> deleted
 *   - a file whose stat().mtimeMs disagrees with the stored file_mtime -> re-upserted (refreshes every derived
 *     column; date_added is untouched, per the UPSERT's own ON CONFLICT clause; tag assignments are untouched
 *     too, per writeRowSync()'s header - phase 3 made character_tags the source of truth, so a reconcile pass
 *     over ordinary character metadata must not touch it)
 *
 * PHASE 3: this function used to call resyncTags() at the end of every pass, on the grounds that "nothing
 * watches tags.json for changes yet". That stopped being true (and stopped being safe) once character_tags
 * became a real, directly-mutated table rather than a read-only mirror: resyncTags() diffs FROM tags.json's
 * tag_map, which is no longer kept current for characters (assignments happen via `POST /api/tags/assign`/
 * `/unassign` now, not through tags.json) - so calling it here on every 5-minute interval would periodically
 * revert every direct assignment back to whatever tags.json's now-stale tag_map says, silently. resyncTags()
 * itself is untouched and still exported/tested directly; it's just no longer wired into this automatic pass.
 * The one legitimate ongoing caller of a tags.json-derived seed is bootstrapIfNeeded()'s one-time backfill (see
 * its own doc comment) for a library that predates the new endpoints.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
export async function reconcile(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    if (!fs.existsSync(directories.characters)) {
        return;
    }

    const files = (await fsPromises.readdir(directories.characters)).filter(f => f.endsWith('.png'));
    const onDisk = new Set(files);
    const existingRows = entry.db.all('SELECT id, file_mtime FROM characters');
    const existingMtimeById = new Map(existingRows.map(r => [r.id, Number(r.file_mtime)]));

    // Rows whose file no longer exists on disk.
    for (const row of existingRows) {
        if (!onDisk.has(row.id)) {
            entry.db.transaction(() => deleteRowSync(entry.db, row.id));
        }
    }

    // Files that are new or whose mtime disagrees with what's stored - bounded rate via a yield every batch, so
    // a large library's reconcile pass doesn't hog the event loop for the entire scan.
    let processedSinceYield = 0;
    for (const file of files) {
        try {
            const filePath = path.join(directories.characters, file);
            const stat = await fsPromises.stat(filePath);
            const storedMtime = existingMtimeById.get(file);
            if (storedMtime !== undefined && storedMtime === stat.mtimeMs) {
                continue; // unchanged since last reconcile - nothing to do
            }

            const imgData = await parseCharacterCard(filePath, 'png');
            if (imgData === undefined) continue;
            const character = getCharaCardV2(JSON.parse(imgData), directories, false);
            const { chatSize, dateLastChat } = calculateChatSize(path.join(directories.chats, file.replace(/\.png$/, '')));
            const row = buildRow(file, character, { dateAddedCandidate: Date.now(), fileMtime: stat.mtimeMs, chatSize, dateLastChat });
            const tagIds = getTagIdsFor(directories, file);
            applyOrBuffer(entry, row, tagIds);
        } catch (err) {
            console.error(`[character-metadata] Reconcile failed to process ${file}, will retry next pass:`, err.message);
        }

        processedSinceYield++;
        if (processedSinceYield >= BATCH_FLUSH_SIZE) {
            processedSinceYield = 0;
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    // If batch mode is active, applyOrBuffer() above buffered rather than wrote - flush now so this reconcile
    // pass's own changes are actually durable before returning (relevant when reconcile() is called from
    // endBatchImport() itself).
    if (entry.batch) {
        flushBatch(entry);
    }
}

/**
 * Starts the non-recursive fs.watch on a user's characters directory - see this module's header for why this is
 * a latency optimization only. No-op if a watcher is already running for this entry.
 * @param {MetadataDbEntry} entry
 */
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
            // Per the design doc's own measurement, a dropped/overflowed watch is silent and unreported - this
            // handler is for the rarer case of an actual watcher-level error (e.g. the directory itself being
            // removed). Either way the reconciler remains the source of truth, so this is a log, not a crash.
            console.error('[character-metadata] Directory watcher error (the reconciler remains the source of truth):', err.message);
        });
    } catch (err) {
        console.error('[character-metadata] Failed to start directory watcher (the reconciler remains the source of truth):', err.message);
    }
}

/**
 * @param {MetadataDbEntry} entry
 */
function stopWatcher(entry) {
    if (entry.watcher) {
        entry.watcher.close();
        entry.watcher = null;
    }
    for (const timer of entry.watchTimers.values()) clearTimeout(timer);
    entry.watchTimers.clear();
}

/**
 * @param {MetadataDbEntry} entry
 * @param {string} filename
 */
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
    const row = buildRow(filename, character, { dateAddedCandidate: Date.now(), fileMtime: stat.mtimeMs, chatSize, dateLastChat });
    const tagIds = getTagIdsFor(entry.directories, filename);
    applyOrBuffer(entry, row, tagIds);
}

/**
 * Server-boot entry point: for every user directory, opens/creates its metadata DB, starts the watcher and the
 * reconcile interval, and kicks off the one-time bootstrap backfill in the background (deliberately NOT
 * awaited beyond schema creation - a 300k-card bootstrap must not delay the server actually starting to listen,
 * per the design doc's "Runs at boot (non-blocking)"). Safe to call multiple times; already-initialized users
 * are skipped.
 * @param {import('./users.js').UserDirectoryList[]} directoriesList
 * @returns {Promise<void>}
 */
export async function initializeMetadataStores(directoriesList) {
    for (const directories of directoriesList) {
        const entry = await getEntry(directories);
        if (!entry) continue; // No usable SQLite engine - already warned once in getEntry().
        if (entry.reconcileInterval) continue; // Already initialized this process.

        startWatcher(entry);
        entry.reconcileInterval = setInterval(() => {
            // Wait for any bootstrap backfill still in flight before starting a periodic reconcile pass. Without
            // this, a library big enough that bootstrapIfNeeded() takes longer than RECONCILE_INTERVAL_MS (very
            // real at tens of thousands of characters - the whole reason this file is being sped up) got a
            // reconcile() pass launched concurrently with the still-running bootstrap: both walk the same
            // characters directory and write to the same db at the same time, so every character bootstrap
            // hasn't reached yet looks "new" to reconcile() too, and it re-parses + re-upserts it right alongside
            // bootstrap doing the same thing - real duplicate work, not just lock contention, that was
            // multiplying total bootstrap wall-clock time. entry.bootstrapPromise is read here (not captured
            // earlier) so this always sees whatever's current by the time the interval actually fires.
            const waitForBootstrap = entry.bootstrapPromise ?? Promise.resolve();
            waitForBootstrap
                .then(() => reconcile(directories))
                .catch(err => console.error(`[character-metadata] Periodic reconcile failed for ${directories.root}:`, err));
        }, RECONCILE_INTERVAL_MS);
        // setInterval alone would keep the process alive even if everything else has shut down - unref() so
        // this timer never becomes the reason the server can't exit.
        entry.reconcileInterval.unref?.();

        // Ordering matters: migrateTagsJsonIfNeeded() classifies tag_map's keys against the characters/groups
        // tables, so both bootstraps have to have already populated them (bootstrapIfNeeded() for characters,
        // bootstrapGroupsIfNeeded() for groups) before it runs, or every key would look unresolvable on a
        // brand-new install's very first boot.
        entry.bootstrapPromise = bootstrapIfNeeded(directories)
            .then(() => bootstrapGroupsIfNeeded(directories))
            .then(() => migrateTagsJsonIfNeeded(directories))
            .then(() => reconcile(directories))
            // Runs LAST in the chain, after reconcile() - so this pass sees the maximal set of poisoned rows a
            // single boot can discover (reconcile() may itself have just poisoned-inserted rows for files
            // dropped in while the server was down). Non-blocking in the same sense as the rest of this chain:
            // entry.bootstrapPromise is awaited by the periodic reconcile interval (see below) so THAT stays
            // sequenced correctly, but server startup itself (server-main.js) never awaits this promise at all.
            .then(() => backfillContentIdentityHashes(directories))
            .catch(err => console.error(`[character-metadata] Bootstrap failed for ${directories.root}:`, err));
    }
}

/**
 * Graceful-shutdown counterpart to initializeMetadataStores() - closes every watcher, clears every interval, and
 * closes every open database handle. Mirrors diskCache.dispose()'s role in server-main.js's exitProcess().
 */
export function disposeMetadataStores() {
    for (const entry of entries.values()) {
        stopWatcher(entry);
        if (entry.reconcileInterval) {
            clearInterval(entry.reconcileInterval);
            entry.reconcileInterval = null;
        }
        try {
            entry.db.close();
        } catch {
            // Best-effort on shutdown.
        }
    }
    entries.clear();
}

/**
 * Test/diagnostic accessor: the raw stored row for one character, or undefined. Not used by any route yet -
 * phase 2's query endpoint is what actually serves reads from this table (see design doc §5); phase 1 only
 * needs to guarantee the table's contents are correct and fresh.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<object | undefined>}
 */
export async function getCharacterMetadataRow(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return undefined;
    return entry.db.get('SELECT * FROM characters WHERE id = @id', { id: avatar });
}

/**
 * Exact-duplicate lookup for the bulk-import dedup feature (characters.js's `/import` route): does any character
 * already have this exact content hash, and if so which one. `hash` is the caller's sha256 hex digest of the raw
 * bytes of an uploaded source file - this function does no hashing of its own, it's a pure indexed lookup.
 *
 * Checks TWO places, not just the SQL table, and this is deliberate rather than an oversight: while batch-import
 * mode is active for this user (beginBatchImport()), writes sit buffered in `entry.batch.pending` (see
 * applyOrBuffer()) for up to BATCH_FLUSH_SIZE rows before they ever reach a real SQL transaction. A bulk drop
 * that hashes-and-checks-then-writes strictly sequentially (one `/import` request fully completing before the
 * next one starts - true of the client's actual import loop) still needs in-batch duplicates (two identical
 * files dropped in the same drop) to be caught the moment the first one lands, not only after the next flush -
 * so the pending buffer has to be checked too, or a same-batch duplicate would silently slip through undetected
 * until (if ever) a flush happened to fall between the two files. The pending buffer is small (at most
 * BATCH_FLUSH_SIZE rows) and keyed by id, not hash, so this is a short linear scan, not an index lookup - fine
 * at that bound.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} hash sha256 hex digest to look up
 * @returns {Promise<string | null>} The existing character's id if a match was found, else `null`. Also `null`
 * (fail-open, matching this module's "no usable SQLite backend" convention elsewhere) if the metadata store
 * itself is unavailable - callers must treat that as "dedup can't be determined right now", not as "no
 * duplicate exists".
 */
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

/**
 * Semantic-duplicate lookup, mirroring findCharacterIdByContentHash()'s exact shape (same two places checked, same
 * fail-open-to-null posture, same reasoning for checking the batch-import pending buffer too) but against
 * `content_identity_hash` instead of `content_hash`. Where content_hash only ever matches a byte-identical
 * re-upload, content_identity_hash matches a character whose semantic content (fav/chat/create_date stripped) is
 * the same, even if its stored bytes differ - which is what makes this the O(1)-indexed replacement for an
 * O(m)-over-poisoned-rows expensive fallback (see this module's header on allowExpensiveDuplicateFallback and
 * backfillContentIdentityHashes() below, which is what makes a poisoned row's hash trustworthy enough to be in
 * this index at all).
 *
 * No `import_poisoned` filter here, and deliberately so: a row's content_identity_hash column, whenever it is
 * non-NULL, was always computed the identical way regardless of which of the three producers set it
 * (upsertCharacterFromWrite(), which also clears poison; or backfillContentIdentityHashes(), which doesn't) - see
 * that column's own SCHEMA_SQL comment. Both are equally comparable, so a plain indexed lookup on the column is
 * already correct without needing to know or care which producer set it.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} hash sha256 hex digest to look up (computeContentIdentityHash()'s output)
 * @returns {Promise<string | null>} The existing character's id if a match was found, else `null`. Also `null`
 * (fail-open) if the metadata store itself is unavailable.
 */
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
 * Looks up local-import-scan.js's durable "never importable" record for one source file (see this module's
 * SCHEMA_SQL comment on `local_import_skips`).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath Absolute path to the discovered source file
 * @returns {Promise<{ mtimeMs: number, reason: string } | null>} `null` if no skip is recorded, OR if the
 * metadata store itself is unavailable (fail-open, matching this module's convention elsewhere - callers must
 * treat that as "can't determine, don't skip", not as "confirmed not skipped").
 */
export async function getLocalImportSkip(directories, sourcePath) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const row = entry.db.get('SELECT mtime_ms, reason FROM local_import_skips WHERE source_path = @sourcePath', { sourcePath });
    return row ? { mtimeMs: Number(row.mtime_ms), reason: row.reason } : null;
}

/**
 * Records (or refreshes) local-import-scan.js's durable "never importable" classification for one source file.
 * A no-op (fail-open) if the metadata store is unavailable - the caller's already-emitted one-time log line is
 * the only record that exists in that case, and the file falls back to the pre-existing "retry every pass"
 * behavior, which is wasteful but never incorrect.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath Absolute path to the discovered source file
 * @param {number} mtimeMs The file's mtimeMs at the moment it was classified (see this column's SCHEMA_SQL comment)
 * @param {string} reason Short machine-readable classification tag (e.g. 'not-json', 'unrecognized-shape')
 * @returns {Promise<void>}
 */
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

/**
 * Clears a source file's local-import-skip record, if any - called once local-import-scan.js observes the file
 * itself is gone (ENOENT), so this table doesn't accumulate rows for files that no longer exist on disk. A
 * no-op (fail-open) if the metadata store is unavailable.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath Absolute path to the discovered source file
 * @returns {Promise<void>}
 */
export async function clearLocalImportSkip(directories, sourcePath) {
    const entry = await getEntry(directories);
    if (!entry) return;

    entry.db.run('DELETE FROM local_import_skips WHERE source_path = @sourcePath', { sourcePath });
}

/**
 * Bulk-loads every persisted `local_import_mtimes` row for this user (see this module's SCHEMA_SQL comment on
 * that table) into a single Map, so local-import-scan.js can warm a fresh DirectoryScanState.lastSeenMtimeMs
 * with ONE query at boot instead of one lookup per file - mirrors reconcile()'s own
 * `SELECT id, file_mtime FROM characters` -> Map bulk-load pattern for the same reason (a per-file round trip
 * for a ~300k-file corpus would itself be a real cost, even though each individual lookup is cheap).
 * Not scoped to one configured directory - local-import-scan.js filters the returned Map to the source_path
 * prefixes it cares about, same as this table isn't partitioned by directory (see SCHEMA_SQL comment).
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<Map<string, number>>} source_path -> mtimeMs. Empty (not null) if the metadata store is
 * unavailable - fail-open, matching this module's convention elsewhere: an empty cache just means every file
 * looks new, which is always safe (if wasteful), never incorrect.
 */
export async function getAllLocalImportMtimes(directories) {
    const entry = await getEntry(directories);
    if (!entry) return new Map();

    const rows = entry.db.all('SELECT source_path, mtime_ms FROM local_import_mtimes');
    return new Map(rows.map(row => [row.source_path, Number(row.mtime_ms)]));
}

/**
 * Records (or refreshes) local-import-scan.js's durable "already processed at this mtime" record for one source
 * file - the write-through counterpart to getAllLocalImportMtimes()'s bulk read. A no-op (fail-open) if the
 * metadata store is unavailable, same posture as setLocalImportSkip(): losing this write only means the file
 * gets re-read/re-hashed (wastefully, never incorrectly) on the next restart, not a correctness problem.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath Absolute path to the discovered source file
 * @param {number} mtimeMs The file's mtimeMs as of the pass that just processed it
 * @returns {Promise<void>}
 */
export async function setLocalImportMtime(directories, sourcePath, mtimeMs) {
    const entry = await getEntry(directories);
    if (!entry) return;

    entry.db.run(
        `INSERT INTO local_import_mtimes (source_path, mtime_ms)
         VALUES (@sourcePath, @mtimeMs)
         ON CONFLICT(source_path) DO UPDATE SET mtime_ms = excluded.mtime_ms`,
        { sourcePath, mtimeMs },
    );
}

/**
 * Clears a source file's persisted mtime record, if any - called once local-import-scan.js observes the file
 * itself is gone (ENOENT), so this table doesn't accumulate rows for files that no longer exist on disk, same
 * hygiene reasoning as clearLocalImportSkip(). A no-op (fail-open) if the metadata store is unavailable.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath Absolute path to the discovered source file
 * @returns {Promise<void>}
 */
export async function clearLocalImportMtime(directories, sourcePath) {
    const entry = await getEntry(directories);
    if (!entry) return;

    entry.db.run('DELETE FROM local_import_mtimes WHERE source_path = @sourcePath', { sourcePath });
}

/**
 * Tag ids currently mirrored into character_tags for one character (see resyncTags()'s header on this being a
 * read-only mirror of tags.json in phase 1). Exposed for tests/diagnostics and for phase 2's query endpoint,
 * which needs this table populated to serve `filter.tags`.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<string[]>}
 */
export async function getCharacterTagIds(directories, avatar) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return entry.db.all('SELECT tag_id FROM character_tags WHERE character_id = @id', { id: avatar }).map(r => r.tag_id);
}

/**
 * The trigger-maintained usage count for one tag (character_tags(tag_id, character_id) index makes this an
 * index-only lookup at query time; the count itself lives in tag_usage precisely so this doesn't need to scan
 * character_tags at all - see trg_character_tags_ai/ad in SCHEMA_SQL).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} tagId
 * @returns {Promise<number>}
 */
export async function getTagUsageCount(directories, tagId) {
    const entry = await getEntry(directories);
    if (!entry) return 0;
    const row = entry.db.get('SELECT count FROM tag_usage WHERE tag_id = @tagId', { tagId });
    return row ? Number(row.count) : 0;
}

/**
 * Bumps the single `tags_rev` meta counter to `Date.now()` - the freshness signature for anything derived from
 * tag *content* (definitions or assignments), replacing tags.json's own mtime now that tags.json is gone (see
 * this module's header on its removal). Called by every write below that changes what a `#tags` search field or
 * a cached tag definition would resolve to: saveTagDefinitions(), assignEntityTag(), unassignEntityTag(), and
 * migrateTagsJsonIfNeeded()'s one-time seed. Readers: getTagsRevision() below (consumed by
 * characters-search-index.js/groups-search-index.js in place of the old tags.json-mtime half of their freshness
 * signature, and by tags-cache.js's client-side freshness check in place of `/api/tags/manifest`'s old
 * whole-file mtime).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function bumpTagsRevisionSync(db) {
    db.run(
        "INSERT INTO meta (key, value) VALUES ('tags_rev', @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        { value: String(Date.now()) },
    );
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<number | null>} The current `tags_rev` (0 if nothing has ever bumped it yet), or `null` if
 * the metadata store is unavailable.
 */
export async function getTagsRevision(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = entry.db.get("SELECT value FROM meta WHERE key = 'tags_rev'");
    return row ? Number(row.value) : 0;
}

/**
 * Generic reader over the `meta` key/value table (see SCHEMA_SQL) - the phase-1 header flags this table as
 * under-used ("only ever holds bootstrap_completed... worth fixing before the table has data worth migrating"),
 * so this is the one general-purpose accessor pair (this + setMetaValue() below) rather than a bespoke
 * get/set function per new key. characters-search-index.js's incremental tantivy maintenance uses this to persist
 * "which change-log rev / tags_rev this user's on-disk tantivy index was last caught up to" - state that belongs
 * to the search-index subsystem, not this module's own freshness bookkeeping, but is stored here rather than in
 * a second small file/lock because this table (and this module's write path) already is the single point every
 * character/tag mutation funnels through, so there is no second source of truth to keep in sync.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} key
 * @returns {Promise<string | null>} The stored value, or `null` if unset *or* if the metadata store itself is
 * unavailable - callers that need to tell those two apart should call getEntry()-backed functions directly, none
 * currently need to.
 */
export async function getMetaValue(directories, key) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = entry.db.get('SELECT value FROM meta WHERE key = ?', [key]);
    return row ? String(row.value) : null;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} key
 * @param {string | number} value Stringified before storage - `meta.value` is TEXT (see SCHEMA_SQL).
 * @returns {Promise<void>} No-ops if the metadata store is unavailable.
 */
export async function setMetaValue(directories, key, value) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run(
        'INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        { key, value: String(value) },
    );
}

/**
 * Every character id that currently carries at least one tag - `character_tags`' own id set, not a
 * `SELECT * FROM characters` scan. Used by characters-search-index.js's incremental tantivy maintenance: a tag
 * *rename* (a definition edit, not an assignment change) bumps `tags_rev` without producing any `changes` log
 * row for the characters that display that tag's name in their indexed `resolved_tags` field, so those
 * characters need re-indexing even though nothing in the `changes` table names them. This is a cheap
 * index-only query against `character_tags` regardless of library size - it never touches `characters` or the
 * filesystem - so re-indexing the ids it returns is still per-change-event work, not a library-wide scan.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<string[] | null>} `null` if the metadata store is unavailable.
 */
export async function getAllTaggedCharacterIds(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const rows = entry.db.all('SELECT DISTINCT character_id FROM character_tags');
    return rows.map(row => row.character_id);
}

/**
 * Records that `oldId` is to become `newId` under the phase 4d filename migration (design doc §9) - `INSERT OR
 * IGNORE`, so calling this twice for the same `oldId` is a no-op that keeps whichever `newId` was minted first,
 * which is exactly what makes a resumed run reuse the same id rather than minting a fresh one every restart.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} oldId
 * @param {string} newId
 * @returns {Promise<void>} No-ops if the metadata store is unavailable.
 */
export async function recordIdMigrationMapping(directories, oldId, newId) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run('INSERT OR IGNORE INTO id_migration (old_id, new_id, completed) VALUES (@oldId, @newId, 0)', { oldId, newId });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} oldId
 * @returns {Promise<string | null>} The `newId` already recorded for `oldId`, or `null` if none exists yet /
 * the metadata store is unavailable.
 */
export async function getIdMigrationMapping(directories, oldId) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = entry.db.get('SELECT new_id FROM id_migration WHERE old_id = @oldId', { oldId });
    return row ? String(row.new_id) : null;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} newId A candidate id about to be minted
 * @returns {Promise<boolean>} True if `newId` is already claimed by an in-flight or completed migration row -
 * checked alongside the filesystem so the migration script's collision check covers both "already on disk" and
 * "already promised to a different old_id but not yet renamed onto disk".
 */
export async function isIdMigrationTargetTaken(directories, newId) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return !!entry.db.get('SELECT 1 FROM id_migration WHERE new_id = @newId', { newId });
}

/**
 * Marks an `id_migration` row's underlying identity move (PNG rename, metadata row, chats directory) as done.
 * This is the gate the migration script's cross-cutting sweep (groups/world_info/note.chara/active_character
 * rewrites) checks before touching a given old_id/new_id pair - see this table's own schema comment.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} oldId
 * @returns {Promise<void>} No-ops if the metadata store is unavailable.
 */
export async function markIdMigrationComplete(directories, oldId) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.run('UPDATE id_migration SET completed = 1 WHERE old_id = @oldId', { oldId });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<Array<{old_id: string, new_id: string}>>} Every row not yet marked complete - what a
 * (re)started migration run resumes from, in addition to newly discovered non-uuid filenames.
 */
export async function getPendingIdMigrations(directories) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return entry.db.all('SELECT old_id, new_id FROM id_migration WHERE completed = 0');
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<Array<{old_id: string, new_id: string}>>} Every completed row - the full old-id-to-new-id
 * table the migration script's cross-cutting sweep (groups/world_info/note.chara/active_character) rewrites
 * against. Safe to call repeatedly; the sweep itself is idempotent (see this module's header comment on the
 * `id_migration` table).
 */
export async function getCompletedIdMigrations(directories) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return entry.db.all('SELECT old_id, new_id FROM id_migration WHERE completed = 1');
}

/**
 * Phase 3 (design doc §3.4, extended by owner decision to groups): `POST /api/tags/for`'s backing query - the
 * tag ids assigned to each of `ids`, in one batched read rather than one `getCharacterTagIds()`/
 * `getGroupTagIds()` call per entity. `ids` can freely mix character avatars and group ids - each one is looked
 * up against whichever of `character_tags`/`group_tags` actually has rows for it. Every requested id is a key in
 * the result, `[]` if it has no tags (or doesn't exist) - so a caller never has to distinguish "no tags" from
 * "id absent".
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Record<string, string[]> | null>} `null` if the metadata store is unavailable.
 */
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
    }

    return result;
}

/**
 * Phase 3 (extended by owner decision to groups): `POST /api/tags/assign`'s backing write - a single-row insert
 * into `character_tags` or `group_tags`, whichever table `id` actually exists in, replacing the old
 * whole-tags.json rewrite. Requires the entity to actually exist (checked against `characters` then `groups`,
 * not just attempted blind) so a typo'd id can't create a permanently dangling tag row nothing will ever clean
 * up - neither table has a foreign key enforcing that itself (SQLite FKs are opt-in and this schema doesn't turn
 * them on).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id Character avatar or group id
 * @param {string} tagId
 * @returns {Promise<'ok' | 'not_found' | null>} `null` if the metadata store is unavailable.
 */
export async function assignEntityTag(directories, id, tagId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    if (entry.db.get('SELECT 1 FROM characters WHERE id = @id', { id })) {
        entry.db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@id, @tagId)', { id, tagId });
        bumpTagsRevisionSync(entry.db);
        return 'ok';
    }
    if (entry.db.get('SELECT 1 FROM groups WHERE id = @id', { id })) {
        entry.db.run('INSERT OR IGNORE INTO group_tags (group_id, tag_id) VALUES (@id, @tagId)', { id, tagId });
        bumpTagsRevisionSync(entry.db);
        return 'ok';
    }
    return 'not_found';
}

/**
 * Phase 3 (extended by owner decision to groups): `POST /api/tags/unassign`'s backing write - a single-row
 * delete from `character_tags`/`group_tags`. Deliberately NOT a 404 on a nonexistent entity (unlike
 * assignEntityTag()) - "make sure this assignment doesn't exist" is trivially satisfied when the entity itself
 * doesn't exist either, so there's nothing to reject. Runs the delete against both tables unconditionally rather
 * than resolving which one first - cheaper than a lookup, and harmless since an id is only ever a row in one of
 * them (a character avatar and a group id can't collide in practice - see this module's header on identity).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id Character avatar or group id
 * @param {string} tagId
 * @returns {Promise<'ok' | null>} `null` if the metadata store is unavailable.
 */
export async function unassignEntityTag(directories, id, tagId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    entry.db.run('DELETE FROM character_tags WHERE character_id = @id AND tag_id = @tagId', { id, tagId });
    entry.db.run('DELETE FROM group_tags WHERE group_id = @id AND tag_id = @tagId', { id, tagId });
    bumpTagsRevisionSync(entry.db);
    return 'ok';
}

/**
 * Tag ids currently assigned to one group - the group-side equivalent of getCharacterTagIds(). Exposed mainly
 * for tests/diagnostics; getEntityTagIdsForMany() is what the `/for` endpoint actually uses.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} groupId
 * @returns {Promise<string[]>}
 */
export async function getGroupTagIds(directories, groupId) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return entry.db.all('SELECT tag_id FROM group_tags WHERE group_id = @id', { id: groupId }).map(r => r.tag_id);
}

/**
 * Phase 3: `GET /api/tags/usage`'s backing read - the entire trigger-maintained `tag_usage` table as one object.
 * This is the aggregate the design doc says "subsumes three separate full scans" (§3.4) - a caller no longer
 * needs to walk every character/group to count how many carry a given tag.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<Record<string, number> | null>} `null` if the metadata store is unavailable.
 */
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
    INSERT INTO groups (id, name, name_fold, fav, date_added, date_last_chat, chat_size)
    VALUES (@id, @name, @nameFold, @fav, @dateAdded, @dateLastChat, @chatSize)
    ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        name_fold = excluded.name_fold,
        fav = excluded.fav
    -- date_added/date_last_chat/chat_size are deliberately absent from this SET list, for two different reasons:
    --   - date_added is write-once, exactly mirroring characters' UPSERT_SQL (see this module's header on
    --     "date_added IS RECORDED ONCE") - only a genuine first INSERT's VALUES candidate is ever used.
    --   - date_last_chat/chat_size are owned by bumpGroupChatStats() (the /group/save write hook, below) and by
    --     the backfill passes (bootstrapGroupsIfNeeded()/migrateGroupsColumns()), not by this function's own
    --     callers (upsertGroupRow(), called from groups.js's /create and /edit) - an /edit request (renaming a
    --     group, toggling fav) has no reason to know the group's current chat stats, and must not reset them to
    --     whatever placeholder candidate it happens to be called with.
`;

/**
 * Shared sync core for every place that writes a full groups row (upsertGroupRow() below,
 * bootstrapGroupsIfNeeded()'s backfill loop) - computes name_fold from `name` and normalizes `fav` to 0/1, same
 * shape buildRow()/writeRowSync() play for characters, just without a change-log entry (see upsertGroupRow()'s
 * own doc comment on why groups don't get one).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {object} row
 * @param {string} row.id
 * @param {string} row.name
 * @param {boolean|undefined} row.fav
 * @param {number} row.dateAdded Only used if this is a genuine insert - see GROUP_UPSERT_SQL's own comment.
 * @param {number} row.dateLastChat Likewise.
 * @param {number} row.chatSize Likewise.
 */
function upsertGroupRowSync(db, { id, name, fav, dateAdded, dateLastChat, chatSize }) {
    db.run(GROUP_UPSERT_SQL, {
        id,
        name: name ?? '',
        nameFold: foldName(name),
        fav: fav ? 1 : 0,
        dateAdded,
        dateLastChat,
        chatSize,
    });
}

/**
 * Write-path hook for groups.js's /create and /edit routes - upserts a group's id/name/fav into the `groups`
 * table (see this module's header on why this table exists and what it now carries). Unlike
 * upsertCharacterFromWrite(), there's still no rev/change-log bookkeeping here - nothing reads change history for
 * groups (queryEntities() below reads `changes.MAX(rev)` for its own `rev` field, but that's the shared
 * high-water mark already advanced by character writes; a groups-only change produces no new `changes` row and
 * so does not advance it - acceptable since nothing depends on group mutations being visible through that
 * specific signal today).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @param {string} name
 * @param {object} [extra]
 * @param {boolean} [extra.fav]
 * @returns {Promise<void>}
 */
export async function upsertGroupRow(directories, id, name, { fav } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return;
    // dateAdded/dateLastChat/dateLastChat/chatSize candidates only matter on a genuine first insert (see
    // GROUP_UPSERT_SQL) - Date.now()/0/0 are the right "just discovered this id" defaults, matching how
    // upsertCharacterFromWrite() treats any non-bootstrap discovery.
    upsertGroupRowSync(entry.db, { id, name, fav, dateAdded: Date.now(), dateLastChat: 0, chatSize: 0 });
}

/**
 * Finds which group owns a given chat id, by scanning `directories.groups` for a group whose `chats` array
 * contains it. Needed because chats.js's `/group/save` route only ever receives the *chat's* own id
 * (group-chats.js's client-side saveGroupChat() posts `group.chat_id`, which is not the group's own persistent
 * id - a group's active chat can be renamed/switched independently of the group id itself), so bumpGroupChatStats()
 * below has no group id handed to it directly and has to resolve one.
 *
 * This IS a groups-directory-wide read, unlike everything else this extension adds for groups - deliberately, and
 * safely: there is currently no chat-id -> group-id index anywhere (SQL or otherwise) to look this up in O(1),
 * and building one is out of this extension's scope given there's no route that supplies a group id to key it
 * from. The tradeoff doesn't face the scale this design otherwise guards against: characters are the
 * 300k-then-10M target (design doc §1); groups are a user-curated set of characters, and this module's own header
 * already scopes the whole `groups` table as "minimal... aren't part of the character residency redesign
 * otherwise" - realistically nowhere near enough groups exist for a per-save directory scan to matter, and this
 * only runs once per chat save, never on a per-request list-render path (the thing this whole design exists to
 * eliminate for characters).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} chatId
 * @returns {{ id: string, chats: string[] } | null} The owning group's id and chat-id list, or `null` if no
 * group's `chats` array contains this chat id (also covers an unreadable/missing groups directory).
 */
function resolveGroupForChat(directories, chatId) {
    if (!fs.existsSync(directories.groups)) return null;
    const files = fs.readdirSync(directories.groups).filter(f => f.endsWith('.json'));
    for (const file of files) {
        try {
            const group = JSON.parse(fs.readFileSync(path.join(directories.groups, file), 'utf8'));
            if (typeof group?.id === 'string' && Array.isArray(group.chats) && group.chats.includes(chatId)) {
                return { id: group.id, chats: group.chats };
            }
        } catch {
            // Skip an unreadable/corrupt group file - same tolerance bootstrapGroupsIfNeeded() already has for
            // this exact directory.
        }
    }
    return null;
}

/**
 * Write-path hook for chats.js's `/group/save` route, called with the just-saved chat's own id after the write
 * succeeds - keeps `date_last_chat`/`chat_size` fresh the same way character writes keep those columns fresh for
 * characters (upsertCharacterFromWrite()'s own calculateChatSize() call). Resolves the owning group via
 * resolveGroupForChat() (see that function's own doc comment for why a chat id, not a group id, is what this
 * hook actually receives), then stats only that group's own chat files (calculateGroupChatStats(),
 * character-shallow.js) - never the whole `groupChats` directory.
 *
 * A plain UPDATE, not an upsert - by the time a chat is ever saved for a group, /create's upsertGroupRow() call
 * has necessarily already inserted the row (a group chat can't exist before its group does), so there is nothing
 * here that needs insert-or-update semantics, and no candidate name/fav to supply. If the row is somehow missing
 * (a pre-existing install's group whose bootstrapGroupsIfNeeded() pass hasn't completed yet), this silently
 * affects zero rows rather than erroring - the next bootstrap/edit pass will populate it correctly instead.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} chatId The id of the chat that was just saved (NOT the group's own id - see
 * resolveGroupForChat()'s doc comment).
 * @returns {Promise<void>}
 */
export async function bumpGroupChatStats(directories, chatId) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const group = resolveGroupForChat(directories, chatId);
    if (!group) return; // Not a group chat this store knows about - nothing to bump.

    const { chatSize, dateLastChat } = calculateGroupChatStats(directories.groupChats, group.chats);
    entry.db.run('UPDATE groups SET date_last_chat = @dateLastChat, chat_size = @chatSize WHERE id = @id', { dateLastChat, chatSize, id: group.id });
}

/**
 * Write-path hook for groups.js's /delete route - removes the group's row and cascades to its tag assignments
 * (group_tags has no real foreign key, so this cascade is application code, same as deleteRowSync() does for
 * characters).
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteGroupRow(directories, id) {
    const entry = await getEntry(directories);
    if (!entry) return;
    entry.db.transaction(() => {
        entry.db.run('DELETE FROM groups WHERE id = @id', { id });
        entry.db.run('DELETE FROM group_tags WHERE group_id = @id', { id });
    });
}

/**
 * One-time backfill of the `groups` table for a library that predates it - the group equivalent of
 * bootstrapIfNeeded(), needed for the same reason: groups.js's write-path hooks (upsertGroupRow()) only fire on
 * a *future* create/edit, so a group that already exists on disk needs an explicit one-time scan or
 * migrateTagsJsonIfNeeded() below could never resolve its tag_map entries as "a real group" and would silently
 * drop them. Gated by its own meta flag so it only ever runs once per user, same pattern as
 * bootstrap_completed.
 *
 * Computes the full row (fav/date_added/date_last_chat/chat_size/name_fold), not just id/name - date_added is
 * seeded from the group file's `birthtimeMs`, the same "best available approximation for cards that predate the
 * column" rule bootstrapIfNeeded() applies to characters; date_last_chat/chat_size come from
 * calculateGroupChatStats() (character-shallow.js), the same shared computation bumpGroupChatStats() and
 * getGroupsData() (groups.js) use, scoped to just this group's own `chats` ids.
 *
 * NOTE: this only covers a groups table that has never been bootstrapped at all. An install that already
 * completed this pass under the old 2-column shape (this meta flag already set) gets its backfill from
 * migrateGroupsColumns() instead - see that function's own doc comment for why the write-once date_added rule
 * makes a second pass through this function's normal upsert path unsuitable for that case.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
export async function bootstrapGroupsIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = entry.db.get("SELECT value FROM meta WHERE key = 'groups_bootstrap_completed'");
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
        "INSERT INTO meta (key, value) VALUES ('groups_bootstrap_completed', @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        { value: String(Date.now()) },
    );
}

/**
 * Tag *definitions* (name/color/folder_type/... - see the `tags` table's own schema comment). Returns them in no
 * particular order - sorting is a client concern (compareTagsForSort(), tags.js), same as before this migration.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<object[] | null>} `null` if the metadata store is unavailable.
 */
export async function getTagDefinitions(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    return entry.db.all('SELECT data FROM tags').map(r => JSON.parse(r.data));
}

/**
 * Replaces the entire `tags` table's contents with `tagsArray` - a full replace, not a diff, mirroring exactly
 * what the old `POST /api/tags/save` did to tags.json's `tags` array (a whole-array rewrite), just against a
 * table that costs nothing to rewrite wholesale instead of a multi-megabyte file. Bumps `tags_rev` (see
 * bumpTagsRevisionSync()) so search-index freshness and the client's tags-cache.js both see the change.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object[]} tagsArray
 * @returns {Promise<'ok' | null>} `null` if the metadata store is unavailable.
 */
export async function saveTagDefinitions(directories, tagsArray) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    entry.db.transaction(() => {
        entry.db.run('DELETE FROM tags');
        for (const tag of tagsArray) {
            if (!tag || typeof tag.id !== 'string' || !tag.id) continue;
            entry.db.run('INSERT INTO tags (id, data) VALUES (@id, @data)', { id: tag.id, data: JSON.stringify(tag) });
        }
        bumpTagsRevisionSync(entry.db);
    });
    return 'ok';
}

/**
 * One-time migration off tags.json (owner decision: tags.json is removed entirely, not just drained of
 * character assignments - see this module's header). Seeds the `tags` table from tags.json's `tags` array
 * (saveTagDefinitions()) and `character_tags`/`group_tags` from its `tag_map`, classifying each tag_map key
 * against the now-populated `characters`/`groups` tables (this is why this function must run AFTER
 * bootstrapIfNeeded() AND bootstrapGroupsIfNeeded() - see initializeMetadataStores()'s ordering) - a key that
 * matches neither is dropped with a warning rather than guessed at, matching this module's existing "no
 * dangling rows" stance (resyncTags() applies the identical rule for characters today).
 *
 * On success, tags.json is renamed to `tags.json.migrated` rather than deleted - the migration only needs to
 * stop being *read*, and renaming keeps the original bytes recoverable if anything about this pass turns out to
 * be wrong, at zero ongoing cost (nothing ever looks at `.migrated` files). Gated by its own meta flag so it
 * only ever runs once per user; a JSON parse failure does NOT set that flag, so a corrupt tags.json gets retried
 * next boot rather than silently treated as "migrated, nothing to do".
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
export async function migrateTagsJsonIfNeeded(directories) {
    const entry = await getEntry(directories);
    if (!entry) return;

    const already = entry.db.get("SELECT value FROM meta WHERE key = 'tags_json_migrated'");
    if (already) return;

    const tagsJsonPath = path.join(directories.root, TAGS_FILE);
    if (!fs.existsSync(tagsJsonPath)) {
        entry.db.run(
            "INSERT INTO meta (key, value) VALUES ('tags_json_migrated', @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
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
        "INSERT INTO meta (key, value) VALUES ('tags_json_migrated', @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
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

/**
 * Shared classify-and-insert core for importing a `{[id]: tagId[]}` map into `character_tags`/`group_tags` -
 * used by both migrateTagsJsonIfNeeded() (the one-time tags.json migration) and restoreTagMap() (a settings
 * snapshot restore, see this module's header). Runs inside its own transaction; bumps tags_rev once at the end
 * rather than per-key. Each key is classified against the CURRENT contents of `characters`/`groups` - a key
 * matching neither is dropped (reported via the returned list) rather than guessed at, the same "no dangling
 * rows" stance resyncTags() already took for characters.
 * @param {MetadataDbEntry} entry
 * @param {Record<string, string[]>} tagMap
 * @returns {string[]} Keys that were dropped because they matched neither a known character nor a known group
 */
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
        bumpTagsRevisionSync(entry.db);
    });

    return droppedKeys;
}

/**
 * The full `{[id]: tagId[]}` export of every character's and group's tag assignments, reconstructed from
 * `character_tags`/`group_tags` - the settings-snapshot backup path's (settings.js's backupUserSettings(), via
 * mergeTagsIntoSnapshot() in tags.js) replacement for what used to be tags.json's `tag_map` field verbatim. Same
 * "one file fully captures state" property snapshots have always had, just sourced from sqlite now.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<Record<string, string[]> | null>} `null` if the metadata store is unavailable.
 */
export async function getFullTagMapExport(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    /** @type {Record<string, string[]>} */
    const result = {};
    for (const row of entry.db.all('SELECT character_id as id, tag_id FROM character_tags')) {
        (result[row.id] ??= []).push(row.tag_id);
    }
    for (const row of entry.db.all('SELECT group_id as id, tag_id FROM group_tags')) {
        (result[row.id] ??= []).push(row.tag_id);
    }
    return result;
}

/**
 * The inverse of getFullTagMapExport() - imports a `{[id]: tagId[]}` map (as embedded in a settings snapshot
 * being restored, see settings.js's /restore-snapshot) into `character_tags`/`group_tags`. Additive (uses the
 * same OR IGNORE insert importTagMapSync() always has), not a replace-everything - a snapshot restore is a
 * point-in-time merge of what that snapshot had, not a promise that nothing else has been assigned since, same
 * spirit as the old splitTagsFromSnapshot()'s straight tags.json overwrite except now merge-safe against
 * concurrent direct assignments instead of clobbering them.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {Record<string, string[]>} tagMap
 * @returns {Promise<string[] | null>} Dropped keys (matched neither a known character nor group), or `null` if
 * the metadata store is unavailable.
 */
export async function restoreTagMap(directories, tagMap) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    return importTagMapSync(entry, tagMap && typeof tagMap === 'object' ? tagMap : {});
}

/**
 * Phase 2 (design doc §5): the columns queryCharacters() below is allowed to sort by via a plain `ORDER BY
 * <column>`, mapped to the actual SQLite column each one sorts on. Deliberately NOT including 'random' or
 * 'search' - both are real values in the doc's `sort.field` union, but neither is a plain column sort:
 *   - 'random' (design doc §5.3, decisions 8/13) sorts by `RANDHASH(id, seed)` (a registered SQL function - see
 *     getEntry() above), not a table column, so it's handled as its own branch in queryCharacters() below rather
 *     than living in this lookup table.
 *   - 'search' means "preserve the relevance order the caller's own full-text search already computed"
 *     (characters-search-index.js's tantivy/FTS5 tier) - there is no SQL column for text relevance, so
 *     queryCharacters() takes that order as a caller-supplied `idOrder` array (see its `sortField === 'search'`
 *     branch) instead of computing anything here.
 */
const QUERYABLE_SORT_COLUMNS = {
    name: 'name_fold',
    date_added: 'date_added',
    date_last_chat: 'date_last_chat',
    chat_size: 'chat_size',
    fav: 'fav',
};

/**
 * Builds a `WHERE ...` clause (or '' if no filter applies) plus its positional-`?` bind values, from the same
 * filter shape the design doc's §5 query contract defines (minus `search`, handled by the caller - see this
 * module's header comment on QUERYABLE_SORT_COLUMNS for why full-text search doesn't route through this table).
 *
 * `ids: []` (an explicit, present-but-empty array) is handled specially by the caller (queryCharacters()) rather
 * than here: "resolve exactly these ids" over zero ids is trivially "match nothing", which is a different
 * question from "no id filter was requested at all" (an absent `ids` key). This function only ever sees a
 * non-empty `ids` array, or none.
 * @param {object} filter
 * @param {{ include?: string[], exclude?: string[], mode?: 'and'|'or' }} [filter.tags]
 * @param {boolean} [filter.fav]
 * @param {string} [filter.world]
 * @param {string[]} [filter.excludeIds]
 * @param {string[]} [filter.ids]
 * @returns {{ where: string, args: any[] }}
 */
function buildWhereClause({ tags, fav, world, excludeIds, ids } = {}) {
    const clauses = [];
    const args = [];

    if (Array.isArray(ids) && ids.length > 0) {
        clauses.push(`id IN (${ids.map(() => '?').join(', ')})`);
        args.push(...ids);
    }
    if (Array.isArray(excludeIds) && excludeIds.length > 0) {
        clauses.push(`id NOT IN (${excludeIds.map(() => '?').join(', ')})`);
        args.push(...excludeIds);
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
        const mode = tags.mode === 'or' ? 'or' : 'and'; // doc §5: 'and'|'or', defaulting to 'and'
        if (include.length > 0) {
            if (mode === 'and') {
                // A character must carry every included tag - COUNT(DISTINCT tag_id) over the IN-filtered rows
                // equalling include.length is the standard "all of these" pattern for a many-to-many table.
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
 * Phase 2's query endpoint (design doc §5), minus full-text search - the browse/sort/filter half of
 * `POST /api/characters/query`, backed entirely by SQLite reads against this table: zero PNG parses, zero
 * `statSync` calls, regardless of library size. This is what makes plain browse pagination "real" rather than
 * fs.readdirSync()+PNG-parse-everything+slice-in-JS the way the pre-phase-2 `/all` endpoint's non-search path
 * still works (see design doc §1.2/§3.3).
 *
 * `total` is always an EXACT `COUNT(*)` over the same WHERE clause as the row query - never capped, matching the
 * doc's explicit "approximate is fine, capped is not" rule (§5's `total` notes) by construction, since an exact
 * count can't ever be a truncated one. The doc also permits (and, at genuinely broad filters and 10M+ rows,
 * eventually prefers) a maintained counter or a SQLite-estimate for the unfiltered/broad case - deliberately not
 * implemented here: the doc's own guidance throughout is "start with the simple correct thing, measure before
 * optimizing", and an index-backed exact COUNT(*) is that simple correct thing, not a placeholder that silently
 * lies. Revisit only if profiling this against a real large library shows it's the bottleneck.
 *
 * Pagination is offset/limit here (page/pageSize -> offset/limit translation is the /query route's job in
 * characters.js, matching how paginateCharacters()/paginateEntities() already take offset/limit) - kept internal
 * to this module rather than exposed at the SQL layer as anything fancier (keyset pagination, say), since the
 * doc's own contract is page-number-based, not cursor-based.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {{ include?: string[], exclude?: string[], mode?: 'and'|'or' }} [params.tags]
 * @param {boolean} [params.fav]
 * @param {string} [params.world]
 * @param {string[]} [params.excludeIds]
 * @param {string[]} [params.ids] Present-but-empty means "resolve nothing" (short-circuits to an empty result,
 * no query run) - see buildWhereClause()'s doc comment. When `filter.search` is also active (see the /query
 * route in characters.js), the caller is expected to have already intersected any explicit `filter.ids` with the
 * search engine's own matched-id set before calling, so this one `ids` restriction is all this function needs to
 * honor both at once.
 * @param {string} [params.sortField] One of QUERYABLE_SORT_COLUMNS' keys, or 'random' (needs `params.seed`), or
 * 'search' (needs `params.idOrder` - see that param's doc). Anything else is the caller's responsibility to have
 * already rejected - this function just no-ops an unrecognized field into "no primary sort", which would
 * silently misbehave as a *pagination* endpoint (same items could reappear or vanish across pages), so the
 * caller must not let that happen. Omitted -> id order only (still fully deterministic, just not meaningful).
 * @param {string} [params.sortOrder] 'asc' (default) or 'desc'. Not meaningful for 'search' (relevance order is
 * whatever `idOrder` already is - see decision 23, random and search compose but neither one has an inherent
 * "reverse" the way a column sort does).
 * @param {number} [params.seed] Required (and validated finite) when `sortField === 'random'` - design doc §5.3
 * decision 10: the seed is client-owned and must travel on every page request, or page 2 silently comes from a
 * different permutation than page 1.
 * @param {string[]} [params.idOrder] Required when `sortField === 'search'`: the caller's own full-text search
 * engine's already-relevance-ordered id list (characters-search-index.js). Rows are re-ordered to match this
 * array's order rather than any SQL `ORDER BY`, since there is no SQL column for text relevance - offset/limit
 * are applied in JS against the reordered set, not pushed into the SQL query, for the same reason. Every id in
 * this array should already be a member of the `ids`/other-filter-restricted candidate set (the /query route
 * arranges this); an id present here but absent from that set (a stale search-index hit for a since-deleted
 * character, or one excluded by another filter) is silently dropped rather than erroring, exactly like a normal
 * SQL join would.
 * @param {number} [params.offset]
 * @param {number} [params.limit]
 * @param {boolean} [params.wantRows] Default true.
 * @param {boolean} [params.wantTotal] Default true.
 * @returns {Promise<{ rows: object[] | undefined, total: number | undefined, rev: number } | null>} `rows` are
 * already-parsed `toShallow()` projections, ready to ship as-is. `rev` is the change log's current high-water
 * mark (doc §5's "`rev` lets the client detect that its cache is stale relative to what it just rendered"), always
 * present regardless of `want`. `null` means the metadata store itself is unavailable on this install (no usable
 * SQLite backend) - callers must treat that as a hard "can't serve this endpoint right now", not silently fall
 * back to a live filesystem scan (see this module's `getEntry()` for the one place that's already logged).
 */
export async function queryCharacters(directories, params = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const {
        tags, fav, world, excludeIds, ids,
        sortField, sortOrder, seed, idOrder,
        offset, limit,
        wantRows = true, wantTotal = true,
    } = params;

    const revRow = entry.db.get('SELECT COALESCE(MAX(rev), 0) as rev FROM changes');
    const rev = Number(revRow?.rev ?? 0);

    if (Array.isArray(ids) && ids.length === 0) {
        // "Resolve exactly these ids" over zero ids - trivially empty, and worth short-circuiting rather than
        // building `id IN ()` (invalid SQL) or `id IN (NULL)` (a footgun that means something else entirely).
        return { rows: wantRows ? [] : undefined, total: wantTotal ? 0 : undefined, rev };
    }

    const { where, args } = buildWhereClause({ tags, fav, world, excludeIds, ids });

    let total;
    if (wantTotal) {
        const countRow = entry.db.get(`SELECT COUNT(*) as total FROM characters ${where}`, args);
        total = Number(countRow?.total ?? 0);
    }

    let rows;
    if (wantRows && sortField === 'search') {
        // Relevance order has no SQL column - fetch every candidate row (already bounded by the `ids` restriction
        // buildWhereClause() applied above, which the /query route sizes to the search engine's own matched-id
        // cap, not this table's size) with no SQL ORDER BY/LIMIT, then reorder and slice in JS to match idOrder.
        const orderedIds = Array.isArray(idOrder) ? idOrder : [];
        const rawRows = entry.db.all(`SELECT id, shallow_json FROM characters ${where}`, args);
        const shallowById = new Map(rawRows.map(r => [r.id, r.shallow_json]));
        const numericOffset = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
        const numericLimit = Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : DEFAULT_QUERY_LIMIT;
        rows = orderedIds
            .filter(id => shallowById.has(id))
            .slice(numericOffset, numericOffset + numericLimit)
            .map(id => JSON.parse(shallowById.get(id)));
    } else if (wantRows) {
        const orderParts = [];
        if (sortField === 'random') {
            // Design doc §5.3, decisions 8/13: a per-query hash order, computed via the RANDHASH SQL function
            // registered in getEntry() above - never materialized. `seed` must be finite (the /query route
            // validates this before calling, same "explicit 400, not a silent wrong result" rule the doc calls
            // out for the pre-phase-2 `/all` endpoint's sortOrder=random bug).
            const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
            orderParts.push(`RANDHASH(id, ?) ${direction}`);
        } else {
            const column = QUERYABLE_SORT_COLUMNS[sortField];
            const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
            if (column) {
                orderParts.push(`${column} ${direction}`);
                // fav is boolean-valued, so a great many rows tie on it - name_fold is the natural secondary key
                // (this is exactly what the schema's idx_characters_fav_name_fold composite index exists for, per
                // design doc §3.1).
                if (sortField === 'fav') {
                    orderParts.push('name_fold ASC');
                }
            }
        }
        // Always-present final tie-break: without one, rows tying on the primary key have no guaranteed stable
        // order across two separate SQL queries (unlike JS's spec-guaranteed-stable Array#sort, which is what
        // the pre-phase-2 paginateCharacters()/paginateEntities() relied on for this same guarantee) - and an
        // unstable order across page 1 and page 2's separate queries means a row can silently appear on both or
        // neither page. `id` is unique, so this always fully disambiguates.
        orderParts.push('id ASC');
        const orderBy = `ORDER BY ${orderParts.join(', ')}`;

        const numericOffset = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
        const numericLimit = Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : DEFAULT_QUERY_LIMIT;

        // The RANDHASH(id, ?) placeholder above (when present) is the first `?` after the WHERE clause's own
        // args, so its bind value goes right after `args` and before the LIMIT/OFFSET pair - SQLite binds `?`
        // placeholders strictly in the order they appear in the SQL text.
        const orderArgs = sortField === 'random' ? [Number(seed) || 0] : [];
        const rawRows = entry.db.all(`SELECT shallow_json FROM characters ${where} ${orderBy} LIMIT ? OFFSET ?`, [...args, ...orderArgs, numericLimit, numericOffset]);
        rows = rawRows.map(r => JSON.parse(r.shallow_json));
    }

    return { rows, total, rev };
}

// Mirrors characters.js's own DEFAULT_PAGE_LIMIT - a caller genuinely omitting `limit` (rather than the /query
// route, which always computes one from page/pageSize) still gets a bounded result instead of the entire table.
const DEFAULT_QUERY_LIMIT = 500;

/**
 * The groups-side WHERE clause for queryEntities() below - the group equivalent of buildWhereClause(), restricted
 * to what a group row actually has. Two filter keys buildWhereClause() accepts are deliberately absent here,
 * both by owner decision (see the design doc extension this module's header references):
 *   - `world`: groups have no lorebook binding, so a `filter.world` request simply never narrows the groups arm
 *     of a merged query - a `{filter: {world: 'X', includeGroups: true}}` request matches world-X characters
 *     PLUS every group that otherwise passes the rest of the filter, not "nothing, since no group has a world".
 *   - `search`: queryEntities() is never called at all when `filter.search` is non-empty - see that function's
 *     own header for why (the /query route in characters.js routes a search request through the pre-existing
 *     queryCharacters() instead, characters-only, and only wraps the result in `{type, item}` shape).
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
        clauses.push(`id IN (${ids.map(() => '?').join(', ')})`);
        args.push(...ids);
    }
    if (Array.isArray(excludeIds) && excludeIds.length > 0) {
        clauses.push(`id NOT IN (${excludeIds.map(() => '?').join(', ')})`);
        args.push(...excludeIds);
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
 * `filter.includeGroups: true` half of `POST /api/characters/query` (owner decision, extending the
 * character-data-residency-redesign to groups - see this module's header and queryCharacters()'s own doc
 * comment, which this function deliberately does NOT modify: every existing caller of queryCharacters() -
 * favsToHotswap, CharacterRepository.queryAll, the whole of characters-query.test.js - keeps calling that
 * function and seeing byte-for-byte the same behavior it always has. This is a genuinely separate function
 * rather than an `includeGroups` branch threaded through queryCharacters() itself, both to keep that guarantee
 * trivially true by construction and because the two queries are a different shape at the SQL level (a single
 * table vs. a `UNION ALL` of two).
 *
 * Implementation: one `UNION ALL` between a characters-shaped subquery and a groups-shaped subquery, projecting
 * the same column names on both sides (id, name_fold, fav, date_added, date_last_chat, chat_size) so a single
 * `ORDER BY`/`LIMIT`/`OFFSET` can run over the combined result - the approach the design doc extension asks to
 * try first. The compound SELECT is wrapped in an outer `SELECT * FROM (...)` rather than ordering the UNION ALL
 * directly: confirmed by direct probe against better-sqlite3 that SQLite rejects `ORDER BY <expr>` on a compound
 * SELECT when `<expr>` is anything other than a bare result-column reference (needed for
 * `ORDER BY RANDHASH(id, ?)` - a plain `ORDER BY date_added` would have worked unwrapped, but `RANDHASH(id, ?)`
 * would not, and this function needs one code path that works for both).
 *
 * NEVER called when `filter.search` is non-empty (see the /query route in characters.js) - groups have no
 * full-text index and this extension does not add one (owner decision), so a search request is answered entirely
 * by queryCharacters(), characters-only, with the result wrapped into `{type: 'character', item}` shape by the
 * caller. That also means this function never needs an `idOrder`/`sortField === 'search'` branch the way
 * queryCharacters() does.
 *
 * Characters are re-materialized from `shallow_json` exactly as queryCharacters() already does. Groups are NOT
 * hydrated here at all - only `id`/`type` come back for a group row, bounded to this page's rows. The caller
 * (the /query route) hydrates just those ids via groups.js's getGroupsByIds() (a lean few-id JSON read, not
 * getGroupsData()'s whole-directory listing) and stamps this function's own fav/date_added/date_last_chat/
 * chat_size onto each hydrated group object, so what's displayed always agrees with what was just sorted by.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {{ include?: string[], exclude?: string[], mode?: 'and'|'or' }} [params.tags]
 * @param {boolean} [params.fav]
 * @param {string} [params.world] Applies to the characters arm only - see buildGroupWhereClause()'s doc comment.
 * @param {string[]} [params.excludeIds]
 * @param {string[]} [params.ids] Present-but-empty means "resolve nothing" (short-circuits, no query run) - same
 * rule as queryCharacters().
 * @param {string} [params.sortField] One of QUERYABLE_SORT_COLUMNS' keys, or 'random' (needs `params.seed`).
 * NEVER 'search' - see this function's header.
 * @param {string} [params.sortOrder] 'asc' (default) or 'desc'.
 * @param {number} [params.seed] Required (and validated finite by the route) when `sortField === 'random'`.
 * @param {number} [params.offset]
 * @param {number} [params.limit]
 * @param {boolean} [params.wantRows] Default true.
 * @param {boolean} [params.wantTotal] Default true.
 * @returns {Promise<{ rows: {type: 'character'|'group', id: string, fav: boolean, date_added: number, date_last_chat: number, chat_size: number, item: object}[] | undefined, total: number | undefined, rev: number } | null>}
 * `null` if the metadata store is unavailable, matching queryCharacters(). A group row's `item` is `null` here -
 * see this function's own header on why hydration is the caller's job; a character row's `item` is already the
 * full `toShallow()` projection.
 */
export async function queryEntities(directories, params = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const {
        tags, fav, world, excludeIds, ids,
        sortField, sortOrder, seed,
        offset, limit,
        wantRows = true, wantTotal = true,
    } = params;

    const revRow = entry.db.get('SELECT COALESCE(MAX(rev), 0) as rev FROM changes');
    const rev = Number(revRow?.rev ?? 0);

    if (Array.isArray(ids) && ids.length === 0) {
        return { rows: wantRows ? [] : undefined, total: wantTotal ? 0 : undefined, rev };
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

    let rows;
    if (wantRows) {
        const orderParts = [];
        if (sortField === 'random') {
            // See queryCharacters()'s identical branch - RANDHASH is the same registered SQL function, and
            // works unmodified against this UNION (confirmed by the probe this function's header describes).
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

        const unionArgs = [...charWhere.args, ...groupWhere.args, ...orderArgs, numericLimit, numericOffset];
        const rawRows = entry.db.all(
            `SELECT * FROM (
                SELECT id, 'character' as type, name_fold, fav, date_added, date_last_chat, chat_size, shallow_json
                FROM characters ${charWhere.where}
                UNION ALL
                SELECT id, 'group' as type, name_fold, fav, date_added, date_last_chat, chat_size, NULL as shallow_json
                FROM groups ${groupWhere.where}
            )
            ${orderBy}
            LIMIT ? OFFSET ?`,
            unionArgs,
        );

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

    return { rows, total, rev };
}

/**
 * `POST /api/characters/exists` (design doc §4.2): chunked existence-by-primary-key, answered straight from this
 * table's index rather than the filesystem. Every requested id is a key in the returned object - `true` if a row
 * exists for it, `false` otherwise - so a caller never has to distinguish "false" from "key absent".
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Record<string, boolean> | null>} `null` if the metadata store is unavailable - see
 * queryCharacters()'s doc comment on why callers must treat that as a hard failure, not a silent "assume it
 * exists" (doc §4.2: "a failed or partial existence check must abort the mutation, never fall through to
 * 'delete it'").
 */
export async function checkCharactersExist(directories, ids) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    /** @type {Record<string, boolean>} */
    const result = {};
    for (const id of ids) {
        result[id] = false;
    }

    // Chunked to stay well clear of SQLite's bound-parameter ceiling (SQLITE_MAX_VARIABLE_NUMBER, historically as
    // low as 999 on some builds) at the input sizes §4.2's callers actually use (chunked by the caller's input,
    // not the library size, per the doc) - BATCH_FLUSH_SIZE is reused here purely because it's already a
    // known-reasonable chunk size in this module, not because the two operations are otherwise related.
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

/**
 * The change log's current high-water mark - the same value queryCharacters()/getChangesSince() already compute
 * inline, factored out as its own lightweight call for a caller (characters-search-index.js's incremental
 * tantivy maintenance) that only needs "what revision are we at right now", not a full changes page.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<number | null>} `null` if the metadata store is unavailable.
 */
export async function getCurrentRev(directories) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    const row = entry.db.get('SELECT COALESCE(MAX(rev), 0) as rev FROM changes');
    return Number(row?.rev ?? 0);
}

/**
 * `POST /api/characters/changes` (design doc §5.2): the change-feed replacement for a whole-library manifest scan.
 * Not yet wired to replace `/api/characters/manifest` in characters.js - the doc scopes that client-side switch to
 * a later phase (§5.2's own framing: "once browse is server-paginated" client-side, which is phase 5, not this
 * one) - this only adds the server-side capability.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} sinceRev
 * @returns {Promise<{ rev: number, changes: { id: string, op: 'upsert'|'delete' }[], truncated: boolean } | null>}
 * `truncated: true` means `sinceRev` predates the oldest change-log row this table still has (nothing prunes the
 * log yet - see this module's header on phase 1's freshness mechanisms - so today this can only trigger for a
 * `sinceRev` that was never valid for this table to begin with, e.g. a cache built against a different user's
 * store; it's still computed for real rather than hardcoded `false`, since a pruning job is explicitly a future
 * addition this response shape already has to be correct against). `null` if the metadata store is unavailable.
 */
export async function getChangesSince(directories, sinceRev) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const numericSince = Number.isFinite(sinceRev) && sinceRev >= 0 ? Math.trunc(sinceRev) : 0;
    const bounds = entry.db.get('SELECT MIN(rev) as minRev, MAX(rev) as maxRev FROM changes');
    const minRev = bounds?.minRev != null ? Number(bounds.minRev) : undefined;
    const maxRev = bounds?.maxRev != null ? Number(bounds.maxRev) : 0;

    const truncated = minRev !== undefined && numericSince < minRev - 1;
    if (truncated) {
        return { rev: maxRev, changes: [], truncated: true };
    }

    const rawChanges = entry.db.all('SELECT rev, id, op FROM changes WHERE rev > ? ORDER BY rev ASC', [numericSince]);
    // Collapse to one entry per id (keeping the latest op for that id in this window) - a client only cares
    // "what do I need to refetch/drop", not how many times it changed in between, and this keeps a busy id from
    // inflating the response with redundant entries. Safe because rawChanges is already rev-ascending, so a
    // later Map.set() for the same id always overwrites with the more recent op.
    const latestOpById = new Map();
    for (const row of rawChanges) {
        latestOpById.set(row.id, row.op);
    }
    const changes = [...latestOpById.entries()].map(([id, op]) => ({ id, op }));

    return { rev: maxRev, changes, truncated: false };
}
