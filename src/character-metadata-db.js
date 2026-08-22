import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import _ from 'lodash';

import { color, getConfigValue, mapWithConcurrency } from './util.js';
import { parse as parseCharacterCard } from './character-card-parser.js';
import { getCharaCardV2 } from './character-card-normalize.js';
import { calculateChatSize, calculateDataSize, toShallow } from './character-shallow.js';
import { readTagsData } from './endpoints/tags-data.js';
import { getSqliteEngine } from './endpoints/sqlite-engine.js';

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

// How often the background reconciler re-walks a user's characters directory (see this module's header, freshness
// mechanism 3). This is a backstop, not the primary freshness path (that's the write-path hooks), so it doesn't
// need to be aggressive - it exists to catch what the other two mechanisms missed.
const RECONCILE_INTERVAL_MS = getConfigValue('performance.characterMetadataReconcileIntervalMs', 5 * 60 * 1000, 'number');

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
`;

const UPSERT_SQL = `
    INSERT INTO characters (
        id, name, name_fold, fav, date_added, create_date, date_last_chat, chat_size, data_size,
        file_mtime, world, creator, version, creator_notes, shallow_json, rev
    ) VALUES (
        @id, @name, @name_fold, @fav, @date_added, @create_date, @date_last_chat, @chat_size, @data_size,
        @file_mtime, @world, @creator, @version, @creator_notes, @shallow_json, @rev
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
 * @returns {object} Row fields (minus `rev`)
 */
function buildRow(id, character, { dateAddedCandidate, fileMtime, chatSize, dateLastChat }) {
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
    };
}

/**
 * Writes one row plus its change-log entry and tag relations, synchronously, meant to run inside
 * `db.transaction(...)`. Not exported - all the exported upsert/delete/rename functions below route through
 * this (or its batch-flush sibling, flushPendingSync()).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {object} row From buildRow()
 * @param {string[]} tagIds
 */
function writeRowSync(db, row, tagIds) {
    const { lastInsertRowid } = db.run('INSERT INTO changes (id, op) VALUES (@id, @op)', { id: row.id, op: 'upsert' });
    db.run(UPSERT_SQL, { ...row, rev: Number(lastInsertRowid) });

    db.run('DELETE FROM character_tags WHERE character_id = @id', { id: row.id });
    for (const tagId of tagIds) {
        db.run('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (@characterId, @tagId)', { characterId: row.id, tagId });
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
 * @returns {Promise<void>}
 */
export async function upsertCharacterFromWrite(directories, avatar, cardJson, fileMtimeMs) {
    const entry = await getEntry(directories);
    if (!entry) return;

    let character;
    try {
        character = JSON.parse(cardJson);
    } catch (err) {
        console.error(`[character-metadata] Failed to parse just-written card for ${avatar}, skipping metadata upsert:`, err);
        return;
    }

    const { chatSize, dateLastChat } = calculateChatSize(path.join(directories.chats, avatar.replace(/\.png$/, '')));
    const row = buildRow(avatar, character, { dateAddedCandidate: Date.now(), fileMtime: fileMtimeMs, chatSize, dateLastChat });
    const tagIds = getTagIdsFor(directories, avatar);

    applyOrBuffer(entry, row, tagIds);
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

        // Yield the event loop between chunks, matching reconcile()'s own per-batch yield (see that function) -
        // a 24k+-card bootstrap pass must not hog the event loop for its entire duration any more than a
        // reconcile pass is allowed to.
        await new Promise(resolve => setImmediate(resolve));
    }

    entry.db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key: 'bootstrap_completed', value: String(Date.now()) });
    await resyncTags(directories);
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
 *     column; date_added is untouched, per the UPSERT's own ON CONFLICT clause)
 * Also calls resyncTags() at the end, since nothing watches tags.json for changes yet.
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

    await resyncTags(directories);
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

        entry.bootstrapPromise = bootstrapIfNeeded(directories)
            .then(() => reconcile(directories))
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
 * Phase 2 (design doc §5): the columns queryCharacters() below is allowed to sort by, mapped to the actual SQLite
 * column each one sorts on. Deliberately NOT including 'random' or 'search' - both are real values in the doc's
 * `sort.field` union, but neither belongs to this module: 'random' is the seeded-hash comparator design doc §5.3
 * scopes to phase 5b (it needs the client-owned seed plumbing that phase adds), and 'search' means routing
 * through the tantivy/FTS5 index (characters-search-index.js) rather than this table, which is explicitly out of
 * scope for this pass - see the caller (characters.js's /query route) for why it 400s on both instead of
 * silently falling back to name order the way the pre-phase-2 `/all` endpoint's `sortOrder=random` bug did (doc
 * §5.3: "silent wrong result, not a failure" is exactly the failure mode being avoided here).
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
 * no query run) - see buildWhereClause()'s doc comment.
 * @param {string} [params.sortField] One of QUERYABLE_SORT_COLUMNS' keys. Anything else (including 'random'/
 * 'search') is the caller's responsibility to have already rejected - this function just no-ops it into "no
 * primary sort", which would silently misbehave as a *pagination* endpoint (same items could reappear or vanish
 * across pages), so the caller must not let that happen. Omitted -> id order only (still fully deterministic,
 * just not meaningful).
 * @param {string} [params.sortOrder] 'asc' (default) or 'desc'.
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
        sortField, sortOrder,
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
    if (wantRows) {
        const column = QUERYABLE_SORT_COLUMNS[sortField];
        const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
        const orderParts = [];
        if (column) {
            orderParts.push(`${column} ${direction}`);
            // fav is boolean-valued, so a great many rows tie on it - name_fold is the natural secondary key
            // (this is exactly what the schema's idx_characters_fav_name_fold composite index exists for, per
            // design doc §3.1).
            if (sortField === 'fav') {
                orderParts.push('name_fold ASC');
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

        const rawRows = entry.db.all(`SELECT shallow_json FROM characters ${where} ${orderBy} LIMIT ? OFFSET ?`, [...args, numericLimit, numericOffset]);
        rows = rawRows.map(r => JSON.parse(r.shallow_json));
    }

    return { rows, total, rev };
}

// Mirrors characters.js's own DEFAULT_PAGE_LIMIT - a caller genuinely omitting `limit` (rather than the /query
// route, which always computes one from page/pageSize) still gets a bounded result instead of the entire table.
const DEFAULT_QUERY_LIMIT = 500;

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
