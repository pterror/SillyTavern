import fs from 'node:fs';
import path from 'node:path';

import {
    getTagDefinitionsByIds, getEntityTagIdsForMany, getTagDeletions,
    getChangesSince, getCurrentSeq, getCurrentTagNameChangeSeq, getTagNameChangesSince, streamCharacterIdsForTagIds, streamCharacterCardJsonBatches,
    streamDeletedIdsBetween, getMetaValue, trySetMetaValues, getCharacterFavsByIds, getCharacterIndexRowsByIds,
} from '../character-metadata-db.js';
import { processCharacter } from './characters.js';
import { buildSchema as buildTantivySchema, buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch, DATA_FIELD, FAV_FIELD, buildTagFilterQuery, buildExcludeIdsQuery, buildIdsQuery, withFavFilter, stringToSortKey } from './tantivy-search.js';
import { resolveSearchEngine } from './search-engine.js';
import { getSearchIndex, rebuildSearchIndex, startSearchWorker, CHARACTERS_INDEX_SEQ_META_KEY, CHARACTERS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY } from './search-index-coordinator.js';
import { rebuildTempDir, cleanupStaleRebuildDirs, swapIndexIntoPlace } from './tantivy-engine.js';
import { getConfigValue, mapWithConcurrency, color } from '../util.js';
import { timePhase } from '../search-timing.js';
import { expandTagFilter } from '../tag-deletions.js';
import { getBusyWaitMs } from './sqlite-engine.js';

// Mirrors fuzzySearchCharacters() (public/scripts/power-user.js) so ranking is consistent client/server.
const BM25_INDEXED_COLUMNS = ['name', 'resolved_tags', 'description', 'mes_example', 'scenario', 'personality', 'first_mes', 'creator_notes', 'creator', 'tags', 'alternate_greetings'];
const BM25_WEIGHTS = [20, 10, 3, 3, 2, 2, 2, 2, 1, 1, 1];

// Fast fields for native tantivy sorting (orderByField), avoiding a full-match-set SQLite round trip.
const TANTIVY_FAST_FIELDS = ['create_date', 'date_added', 'date_last_chat', 'chat_size', 'data_size'];

// name_sort_key: first 6 bytes of the lowercased name as a u64 sort key.
// fav_name_sort_key: bit 48 = inverted fav, bits 0-47 = name_sort_key. ASC gives favorites-first-then-alpha.
const TANTIVY_COLLATION_FIELDS = ['name_sort_key', 'fav_name_sort_key'];
const ALL_FAST_FIELDS = [...TANTIVY_FAST_FIELDS, ...TANTIVY_COLLATION_FIELDS];

const TANTIVY_FILTER_TEXT_FIELDS = [{ name: 'tag_ids', tokenizerName: 'whitespace' }];

const TAG_IDS_FIELD = 'tag_ids';

export const TANTIVY_SORT_FIELDS = new Set([...TANTIVY_FAST_FIELDS, 'name', 'fav']);

const SORT_FIELD_TO_TANTIVY_FIELD = {
    create_date: 'create_date',
    date_added: 'date_added',
    date_last_chat: 'date_last_chat',
    chat_size: 'chat_size',
    data_size: 'data_size',
    name: 'name_sort_key',
    fav: 'fav_name_sort_key',
};

export { SORT_FIELD_TO_TANTIVY_FIELD };

// Bump whenever characterToTantivyDoc()'s schema shape or field encoding changes; a mismatch forces a rebuild.
const TANTIVY_SCHEMA_VERSION = 4;

// `tag:`/`tags:` maps to both tag-ish fields since BM25_WEIGHTS treats resolved_tags and tags as the same concept.
const TANTIVY_FIELD_WEIGHTS = Object.fromEntries(BM25_INDEXED_COLUMNS.map((name, i) => [name, BM25_WEIGHTS[i]]));
const TANTIVY_FIELD_LABELS = {
    name: ['name'],
    tag: ['resolved_tags', 'tags'],
    tags: ['resolved_tags', 'tags'],
    desc: ['description'],
    description: ['description'],
    example: ['mes_example'],
    scenario: ['scenario'],
    personality: ['personality'],
    greeting: ['first_mes'],
    notes: ['creator_notes'],
    creator: ['creator'],
    from: ['creator'],
    by: ['creator'],
    author: ['creator'],
    alt: ['alternate_greetings'],
    alternate: ['alternate_greetings'],
};

// Bounds peak memory during (re)build regardless of library size.
const INDEX_BUILD_BATCH_SIZE = 500;

const TANTIVY_INDEX_SEQ_META_KEY = CHARACTERS_INDEX_SEQ_META_KEY;
const TANTIVY_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY = CHARACTERS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY;
const TANTIVY_INDEX_SCHEMA_VERSION_META_KEY = 'tantivy_char_index_schema_version';

const CHECKPOINT_EVERY_N_BATCHES = 20;

const REBUILD_PERSIST_RETRY_MS = 100;

// The share of a tick's budget the tag-rename loop always gets, so a change backlog can't starve renames.
const TAG_RENAME_BUDGET_SHARE = 0.25;

const INDEX_BUILD_READ_CONCURRENCY = getConfigValue('performance.characterIndexBuildConcurrency', 64, 'number');

/** @param {TickPhases} [phases] */
async function makeTagResolvers(directories, avatars, phases) {
    const assignments = await timeAsync(phases, 'load', () => getEntityTagIdsForMany(directories, avatars, { type: 'character' }));
    const tagIds = [...new Set(Object.values(assignments ?? {}).flat())];
    const definitions = await timeAsync(phases, 'tags', () => getTagDefinitionsByIds(directories, tagIds));
    /** @type {Map<string, { name?: string }>} */
    const tagsById = new Map((definitions ?? []).map(tag => [tag.id, tag]));
    return {
        tagNamesFor: (avatar) => (assignments?.[avatar] ?? [])
            .map(id => tagsById.get(id)?.name)
            .filter(Boolean)
            .join(' '),
        tagIdsFor: (avatar) => (assignments?.[avatar] ?? []).join(' '),
    };
}

// The db's `fav` column is authoritative once a row is tracked; falls back to the card's embedded
// `data.extensions.fav` for a character the metadata store hasn't picked up yet.
async function makeFavResolver(directories, avatars) {
    const favById = await getCharacterFavsByIds(directories, avatars);
    return (character) => Object.prototype.hasOwnProperty.call(favById, character.avatar)
        ? favById[character.avatar]
        : Boolean(character.data?.extensions?.fav);
}

function characterToTantivyDoc(tantivy, schema, character, tagNamesFor, favFor, tagIdsFor) {
    return tantivy.Document.fromDict({
        name: character.data?.name ?? '',
        resolved_tags: tagNamesFor(character.avatar),
        description: character.data?.description ?? '',
        mes_example: character.data?.mes_example ?? '',
        scenario: character.data?.scenario ?? '',
        personality: character.data?.personality ?? '',
        first_mes: character.data?.first_mes ?? '',
        creator_notes: character.data?.creator_notes ?? '',
        creator: character.data?.creator ?? '',
        tags: Array.isArray(character.data?.tags) ? character.data.tags.join(' ') : '',
        alternate_greetings: Array.isArray(character.data?.alternate_greetings) ? character.data.alternate_greetings.join(' ') : '',
        create_date: Math.max(0, Date.parse(character.create_date) || character.date_added || 0),
        date_added: Math.max(0, Number(character.date_added) || 0),
        date_last_chat: Math.max(0, Number(character.date_last_chat) || 0),
        chat_size: Math.max(0, Number(character.chat_size) || 0),
        data_size: Math.max(0, Number(character.data_size) || 0),
        name_sort_key: stringToSortKey(character.data?.name ?? ''),
        fav_name_sort_key: (favFor(character) ? 0 : 1) * (2 ** 48) + stringToSortKey(character.data?.name ?? '', 6),
        tag_ids: tagIdsFor(character.avatar),
        [DATA_FIELD]: character.avatar,
        [FAV_FIELD]: favFor(character),
    }, schema);
}

const INDEX_DIR_NAME = 'characters-tantivy';

function searchIndexParentDir(directories) {
    return path.join(directories.root, 'search-index');
}

function tantivyIndexDir(directories) {
    return path.join(searchIndexParentDir(directories), INDEX_DIR_NAME);
}

function createEmptyTantivyIndexAt(tantivy, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const schema = buildTantivySchema(tantivy, BM25_INDEXED_COLUMNS, ALL_FAST_FIELDS, TANTIVY_FILTER_TEXT_FIELDS);
    const index = new tantivy.Index(schema, dir, false);
    return { index, schema };
}

/**
 * Wall ms per catch-up phase, summed over a tick. Phases can overlap lockwait: a write blocked on a lock counts in
 * both its phase and lockwait.
 * @typedef {{ read: number, deletes: number, tags: number, load: number, build: number, add: number, commit: number, persist: number }} TickPhases
 */

/** @returns {TickPhases} */
function newTickPhases() {
    return { read: 0, deletes: 0, tags: 0, load: 0, build: 0, add: 0, commit: 0, persist: 0 };
}

/**
 * @template T
 * @param {TickPhases | undefined} phases
 * @param {keyof TickPhases} phase
 * @param {() => T} fn
 * @returns {T}
 */
function timeSync(phases, phase, fn) {
    if (!phases) return fn();
    const start = Date.now();
    try {
        return fn();
    } finally {
        phases[phase] += Date.now() - start;
    }
}

/**
 * @template T
 * @param {TickPhases | undefined} phases
 * @param {keyof TickPhases} phase
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function timeAsync(phases, phase, fn) {
    if (!phases) return fn();
    const start = Date.now();
    try {
        return await fn();
    } finally {
        phases[phase] += Date.now() - start;
    }
}

// Adds a doc per id, INDEX_BUILD_BATCH_SIZE ids at a time, reading each batch's rows by id.
/** @param {TickPhases} [phases] */
async function addCharacterDocs(directories, tantivy, schema, writer, ids, phases) {
    for (let i = 0; i < ids.length; i += INDEX_BUILD_BATCH_SIZE) {
        const batchIds = ids.slice(i, i + INDEX_BUILD_BATCH_SIZE);
        const rowById = await timeAsync(phases, 'load', () => getCharacterIndexRowsByIds(directories, batchIds));
        await addCharacterBatch(directories, tantivy, schema, writer, batchIds, rowById, phases);
    }
}

// Adds a doc per id as one unit: tag/fav lookups cover exactly these ids. An id with no row was deleted after the
// change being applied, so it isn't indexed.
/**
 * @param {Map<string, import('../character-metadata-db.js').CharacterIndexRow>} rowById
 * @param {TickPhases} [phases]
 */
async function addCharacterBatch(directories, tantivy, schema, writer, batchIds, rowById, phases) {
    const ids = batchIds.filter(id => rowById.has(id));
    if (ids.length === 0) return;
    const { tagNamesFor, tagIdsFor } = await makeTagResolvers(directories, ids, phases);
    const favFor = await timeAsync(phases, 'load', () => makeFavResolver(directories, ids));
    const characters = await timeAsync(phases, 'build', () => mapWithConcurrency(ids, INDEX_BUILD_READ_CONCURRENCY, async (id) => {
        try {
            const row = rowById.get(id);
            return await processCharacter(id, directories, {
                shallow: false,
                cardJson: row.card_json,
                chatStats: { chatSize: row.chat_size, dateLastChat: row.date_last_chat },
            });
        } catch {
            // File gone or corrupt - leave it deleted rather than throwing the whole pass away.
            return null;
        }
    }));
    for (const character of characters) {
        if (!character?.name) continue;
        const doc = timeSync(phases, 'build', () => characterToTantivyDoc(tantivy, schema, character, tagNamesFor, favFor, tagIdsFor));
        timeSync(phases, 'add', () => writer.addDocument(doc));
    }
}

/**
 * One committed catch-up. seqFrom..seq and tagNameSeqFrom..tagNameSeq are the change-log and tag-rename cursors
 * before and after. backlog: the change-log seq read at the tick's end minus the new cursor. writers: upserted
 * ids per changed field name (`null` for a whole-record change); an id with several fields counts under each.
 * tagRenames: distinct renamed tag ids applied. lockWaitMs: time this tick's writes spent on a database lock.
 * persistSkipped: the cursors couldn't be persisted because the database was locked, so they stayed at their
 * values from before the tick (seq === seqFrom) and the next tick redoes this one's work.
 * @typedef {{ changed: boolean, deletes: number, upserts: number, ms: number, seq: number, seqFrom: number,
 *   tagNameSeqFrom: number, tagNameSeq: number, backlog: number, writers: Record<string, number>, tagRenames: number,
 *   phases: TickPhases, lockWaitMs: number, persistSkipped?: boolean }} TickResult
 */

/** @param {TickResult} r */
export function formatCatchUpLine(r) {
    const p = r.phases;
    const tagSeq = r.tagNameSeq !== r.tagNameSeqFrom ? ` tagseq=${r.tagNameSeqFrom}..${r.tagNameSeq}` : '';
    const writers = Object.entries(r.writers).map(([field, n]) => `${field === 'null' ? 'whole-record' : field}:${n}`).join(',');
    return `[search] catch-up: seq=${r.seqFrom}..${r.seq}${tagSeq} backlog=${r.backlog} writers=${writers} tagrenames=${r.tagRenames}`
        + ` deletes=${r.deletes} upserts=${r.upserts} total_ms=${r.ms} read_ms=${p.read} deletes_ms=${p.deletes} tags_ms=${p.tags}`
        + ` load_ms=${p.load} build_ms=${p.build} add_ms=${p.add} commit_ms=${p.commit} persist_ms=${p.persist}`
        + `${r.persistSkipped ? ' persist=skipped' : ''} lockwait_ms=${r.lockWaitMs}`;
}

/**
 * The only writer of a user's characters index. Runs in search-index-worker.js, never in the request process:
 * every call here is synchronous work (better-sqlite3, processCharacter()'s fs reads, tantivy's napi calls) that
 * would otherwise hold the event loop.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {{ tickBudgetMs?: number }} [options] tickBudgetMs: how long one tick keeps taking change-log pages
 * before it commits, so a large backlog still commits about once per tick.
 */
export function createCharacterIndexMaintainer(directories, tantivy, { tickBudgetMs = 1000 } = {}) {
    const indexDir = tantivyIndexDir(directories);
    /** @type {any} */
    let index = null;
    /** @type {any} */
    let schema = null;
    /** @type {any} */
    let writer = null;
    // Everything up to seqCursor / tagNameCursor is applied and committed. Deletes are applied ahead of the
    // upsert pages, so deleteCursor can run ahead of seqCursor: deletes up to it are already committed.
    let seqCursor = 0;
    let tagNameCursor = 0;
    let deleteCursor = 0;

    function getWriter() {
        return writer ?? (writer = index.writer());
    }

    function setCursors(seq, tagNameSeq) {
        seqCursor = seq;
        tagNameCursor = tagNameSeq;
        deleteCursor = Math.max(deleteCursor, seq);
    }

    /** @returns {Promise<boolean>} false: the database was locked and nothing was persisted. */
    function persistCursors() {
        return trySetMetaValues(directories, {
            [TANTIVY_INDEX_SEQ_META_KEY]: String(seqCursor),
            [TANTIVY_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY]: String(tagNameCursor),
            [TANTIVY_INDEX_SCHEMA_VERSION_META_KEY]: String(TANTIVY_SCHEMA_VERSION),
        });
    }

    /**
     * Opens the persisted index as-is, with no catch-up, and takes its writer.
     * @returns {Promise<string | null>} The index dir, or null if nothing usable is persisted.
     */
    async function openPersisted() {
        const persistedSeq = await getMetaValue(directories, TANTIVY_INDEX_SEQ_META_KEY);
        if (persistedSeq === null) {
            return null;
        }
        let opened;
        try {
            if (!tantivy.Index.exists(indexDir)) {
                return null;
            }
            opened = tantivy.Index.open(indexDir);
            const persistedSchemaVersion = await getMetaValue(directories, TANTIVY_INDEX_SCHEMA_VERSION_META_KEY);
            // A persisted index built under a different schema version can't be trusted.
            if (Number(persistedSchemaVersion) !== TANTIVY_SCHEMA_VERSION) {
                return null;
            }
        } catch (err) {
            console.error(color.red('[search] failed to reopen the persisted character tantivy index, falling back to a full rebuild:'));
            console.error(color.red(`[search]   ${err.message}`));
            return null;
        }
        const persistedTagNameChangeSeq = await getMetaValue(directories, TANTIVY_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY);
        index = opened;
        schema = opened.schema;
        getWriter();
        deleteCursor = 0;
        setCursors(Number(persistedSeq), persistedTagNameChangeSeq !== null ? Number(persistedTagNameChangeSeq) : 0);
        return indexDir;
    }

    /**
     * Streams every characters row into a brand-new index in a temp dir, then swaps it into place. The
     * watermarks are read before the stream starts, so the next tick picks up whatever changed during it.
     * @returns {Promise<string | null>} The index dir, or null when the metadata store is unavailable (it is
     * the only source of truth, so there is no index).
     */
    async function rebuild() {
        const lastSeq = await getCurrentSeq(directories);
        const lastTagNameChangeSeq = await getCurrentTagNameChangeSeq(directories);
        if (lastSeq === null || lastTagNameChangeSeq === null) {
            return null;
        }

        const parentDir = searchIndexParentDir(directories);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        cleanupStaleRebuildDirs(parentDir, INDEX_DIR_NAME);

        const tempDir = rebuildTempDir(parentDir, INDEX_DIR_NAME);
        const built = createEmptyTantivyIndexAt(tantivy, tempDir);
        const tempWriter = built.index.writer();
        try {
            let batchIndex = 0;
            // Each streamed batch is one unit: its rows came with it, and its tag/fav lookups cover exactly it.
            for await (const rows of streamCharacterCardJsonBatches(directories)) {
                await addCharacterBatch(directories, tantivy, built.schema, tempWriter, rows.map(row => row.id), new Map(rows.map(row => [row.id, row])));
                batchIndex++;
                if (batchIndex % CHECKPOINT_EVERY_N_BATCHES === 0) {
                    tempWriter.commit();
                }
            }
            tempWriter.commit();
        } finally {
            // commit() alone does not release the writer's on-disk lock; waitMergingThreads() does.
            tempWriter.waitMergingThreads();
        }

        // The old dir is about to be renamed away; its writer's lock goes with it.
        if (writer) {
            writer.waitMergingThreads();
            writer = null;
        }
        swapIndexIntoPlace(indexDir, tempDir);
        index = tantivy.Index.open(indexDir);
        schema = index.schema;
        getWriter();

        deleteCursor = 0;
        setCursors(lastSeq, lastTagNameChangeSeq);
        // Not skipped on a lock like a tick's: the new index is already in place, and the cursors persisted for the
        // old one would have the next start replay the change log from there.
        while (!await persistCursors()) {
            await new Promise(resolve => setTimeout(resolve, REBUILD_PERSIST_RETRY_MS));
        }
        return indexDir;
    }

    /**
     * One catch-up pass, committed at most once. Every delete in the log up to its current end is applied first,
     * whatever upsert backlog is in front of it; then upsert pages, then tag-rename pages, each until its log is
     * drained or its part of tickBudgetMs has passed. An upsert page never undoes an applied delete: it reads the row's current
     * card_json, and a deleted row has none.
     * @returns {Promise<TickResult | { swapped: string | null } | null>}
     * null when the metadata store is unavailable; `swapped` when a truncated change log forced a full rebuild.
     */
    async function tick() {
        const start = Date.now();
        const lockWaitAtStart = getBusyWaitMs();
        const phases = newTickPhases();
        const { maxSeq, maxTagNameChangeSeq } = await timeAsync(phases, 'read', async () => ({
            maxSeq: await getCurrentSeq(directories),
            maxTagNameChangeSeq: await getCurrentTagNameChangeSeq(directories),
        }));
        if (maxSeq === null || maxTagNameChangeSeq === null) {
            return null;
        }

        const w = getWriter();
        let deletes = 0;
        let upserts = 0;
        const seqFrom = seqCursor;
        const tagNameSeqFrom = tagNameCursor;
        const deleteCursorFrom = deleteCursor;
        let lastSeq = seqCursor;
        let lastTagNameChangeSeq = tagNameCursor;
        /** @type {Map<string, number>} */
        const writers = new Map();
        /** @type {Set<string>} */
        const renamedTagIds = new Set();
        try {
            // Starts past seqCursor too: upsert pages aren't capped at a tick's maxSeq, so rows up to seqCursor are
            // already applied, and re-applying a delete there could remove a doc an upsert page has since re-created.
            await timeAsync(phases, 'deletes', async () => {
                for await (const ids of streamDeletedIdsBetween(directories, Math.max(deleteCursor, seqCursor), maxSeq)) {
                    for (const id of ids) {
                        w.deleteDocumentsByTerm(DATA_FIELD, id);
                    }
                    deletes += ids.length;
                }
            });

            // With renames waiting, the change loop leaves their share of the budget to them.
            const renamesPending = maxTagNameChangeSeq > tagNameCursor;
            const changesDeadline = start + (renamesPending ? tickBudgetMs * (1 - TAG_RENAME_BUDGET_SHARE) : tickBudgetMs);

            for (;;) {
                const page = await timeAsync(phases, 'read', () => getChangesSince(directories, lastSeq, { limit: INDEX_BUILD_BATCH_SIZE }));
                if (!page) {
                    w.rollback();
                    return null;
                }
                if (page.truncated) {
                    w.rollback();
                    return { swapped: await rebuild() };
                }
                if (page.changes.length > 0) {
                    // Delete-by-term for every touched id; tantivy has no update-in-place.
                    timeSync(phases, 'add', () => {
                        for (const { id } of page.changes) {
                            w.deleteDocumentsByTerm(DATA_FIELD, id);
                        }
                    });
                    const upsertIds = [];
                    for (const change of page.changes) {
                        if (change.op === 'delete') continue;
                        upsertIds.push(change.id);
                        for (const field of change.fields ?? ['null']) {
                            writers.set(field, (writers.get(field) ?? 0) + 1);
                        }
                    }
                    deletes += page.changes.length - upsertIds.length;
                    upserts += upsertIds.length;
                    await addCharacterDocs(directories, tantivy, schema, w, upsertIds, phases);
                }
                lastSeq = page.seq;
                if (!page.hasMore || Date.now() >= changesDeadline) break;
            }

            // A tag rename doesn't produce a `changes` row for the characters carrying it, so it's tracked separately.
            // Its loop always takes at least one page and gets its share of the budget from its own start, even when
            // the last change page ran past the change loop's deadline, plus whatever the change loop left unused.
            const renamesStart = Date.now();
            const renamesDeadline = renamesStart + tickBudgetMs * TAG_RENAME_BUDGET_SHARE + Math.max(0, changesDeadline - renamesStart);
            for (;;) {
                const page = await timeAsync(phases, 'read', () => getTagNameChangesSince(directories, lastTagNameChangeSeq, { limit: INDEX_BUILD_BATCH_SIZE }));
                if (!page) {
                    w.rollback();
                    return null;
                }
                if (page.truncated) {
                    w.rollback();
                    return { swapped: await rebuild() };
                }
                if (page.tagIds.length > 0) {
                    for (const tagId of page.tagIds) renamedTagIds.add(tagId);
                    const affected = streamCharacterIdsForTagIds(directories, page.tagIds)[Symbol.asyncIterator]();
                    try {
                        for (;;) {
                            const next = await timeAsync(phases, 'read', () => affected.next());
                            if (next.done) break;
                            const affectedIds = next.value;
                            timeSync(phases, 'add', () => {
                                for (const id of affectedIds) {
                                    w.deleteDocumentsByTerm(DATA_FIELD, id);
                                }
                            });
                            upserts += affectedIds.length;
                            await addCharacterDocs(directories, tantivy, schema, w, affectedIds, phases);
                        }
                    } finally {
                        await affected.return?.();
                    }
                }
                lastTagNameChangeSeq = page.seq;
                if (!page.hasMore || Date.now() >= renamesDeadline) break;
            }
        } catch (err) {
            try {
                w.rollback();
            } catch (rollbackErr) {
                console.error(color.red(`[search] rollback after a failed catch-up also failed: ${rollbackErr.message}`));
            }
            throw err;
        }

        // The watermarks are persisted only for what a commit made durable.
        const changed = deletes > 0 || upserts > 0;
        if (changed) {
            timeSync(phases, 'commit', () => w.commit());
        }
        const moved = lastSeq !== seqCursor || lastTagNameChangeSeq !== tagNameCursor;
        setCursors(lastSeq, lastTagNameChangeSeq);
        deleteCursor = Math.max(deleteCursor, maxSeq);
        let persistSkipped = false;
        if (moved) {
            persistSkipped = !await timeAsync(phases, 'persist', () => persistCursors());
        }
        // Rather than wait on the lock, the next tick redoes this one's work: every doc it touched is deleted and
        // re-added by id, so applying it twice changes nothing.
        if (persistSkipped) {
            seqCursor = seqFrom;
            tagNameCursor = tagNameSeqFrom;
            deleteCursor = deleteCursorFrom;
        }
        // Not maxSeq: upsert pages aren't capped at it, so a change written during the tick puts seqCursor past it.
        const endSeq = await timeAsync(phases, 'read', () => getCurrentSeq(directories));
        return {
            changed,
            deletes,
            upserts,
            ms: Date.now() - start,
            seq: seqCursor,
            seqFrom,
            tagNameSeqFrom,
            tagNameSeq: tagNameCursor,
            backlog: endSeq !== null ? endSeq - seqCursor : Math.max(0, maxSeq - seqCursor),
            writers: Object.fromEntries(writers),
            tagRenames: renamedTagIds.size,
            phases,
            lockWaitMs: getBusyWaitMs() - lockWaitAtStart,
            persistSkipped,
        };
    }

    return {
        openPersisted,
        rebuild,
        tick,
        isOpen: () => index !== null,
        /** The change-log seq the index covers. */
        seq: () => seqCursor,
        /** The tag-rename-log seq the index covers. */
        tagNameSeq: () => tagNameCursor,
        /** Releases the writer's on-disk lock. */
        close() {
            if (writer) {
                writer.waitMergingThreads();
                writer = null;
            }
        },
    };
}

// `backend: 'unavailable'` distinguishes "nothing usable could be loaded" from a genuine no-match.
// `filter`'s fav, tags, ids and excludeIds are ANDed into the query the same way searchCharacterIdsSorted() does
// it (withFavFilter(), buildTagFilterQuery()/TAG_IDS_FIELD, buildIdsQuery(), buildExcludeIdsQuery()), so they
// narrow the matches before `maxRows` caps them: a hit they rule out never takes a place in the capped list.
// `world` has no equivalent: no field for it exists in the tantivy schema (buildSchema()'s fast/filter field
// lists), so it isn't applied here and a caller has to check it itself.
// `position` is the reader's position (search-index-coordinator.js) as of the search, null when unknown.
async function runIdSearch(handle, directories, searchTerm, maxRows, filter = {}) {
    const { fav, tags, excludeIds, ids } = filter;
    const engine = await timePhase('chars_index_get', () => resolveSearchEngine());

    if (engine.tier === 'unavailable') {
        return { hits: [], total: 0, backend: 'unavailable', position: null };
    }

    const tantivyIndex = await timePhase('chars_index_get', () => getSearchIndex(handle, directories, 'characters'));
    if (!tantivyIndex) {
        return { hits: [], total: 0, backend: 'unavailable', position: null };
    }
    const expandedTags = tags ? expandTagFilter(tags, await getTagDeletions(directories)) : null;
    // Nothing below awaits, so the reader can't move between here and the search.
    const position = tantivyIndex.position ?? null;
    if (expandedTags?.none) {
        return { hits: [], total: 0, backend: 'tantivy', position };
    }
    const query = timePhase('chars_query_build', () => {
        const { tantivy } = engine;
        const { schema } = tantivyIndex;
        let q = buildTantivyQuery(tantivy, schema, searchTerm, TANTIVY_FIELD_WEIGHTS, TANTIVY_FIELD_LABELS);
        if (!q) return null;
        q = withFavFilter(tantivy, schema, q, fav);
        const tagQuery = tags ? buildTagFilterQuery(tantivy, schema, tags, TAG_IDS_FIELD, expandedTags) : null;
        if (tagQuery) {
            q = tantivy.Query.booleanQuery([
                { occur: tantivy.Occur.Must, query: q },
                { occur: tantivy.Occur.Must, query: tagQuery },
            ]);
        }
        if (Array.isArray(ids)) {
            q = tantivy.Query.booleanQuery([
                { occur: tantivy.Occur.Must, query: q },
                { occur: tantivy.Occur.Must, query: buildIdsQuery(tantivy, schema, ids) },
            ]);
        }
        if (Array.isArray(excludeIds) && excludeIds.length > 0) {
            q = tantivy.Query.booleanQuery([
                { occur: tantivy.Occur.Must, query: q },
                { occur: tantivy.Occur.MustNot, query: buildExcludeIdsQuery(tantivy, schema, excludeIds) },
            ]);
        }
        return q;
    });
    if (!query) {
        return { hits: [], total: 0, backend: 'tantivy', position };
    }
    const boundedMaxRows = Number.isFinite(maxRows) && maxRows > 0 ? maxRows : undefined;
    const { results, total } = runTantivySearch(tantivyIndex.index, query, boundedMaxRows, { timingLabel: 'chars' });
    return { hits: timePhase('chars_ids', () => results.map(r => ({ id: r.raw, score: r.score }))), total, backend: 'tantivy', position };
}

// A matched id that can no longer be resolved (deleted, or corrupt) is silently dropped.
export async function searchCharacters(handle, directories, searchTerm, maxRows, favOnly, tags) {
    const { hits, total, backend } = await runIdSearch(handle, directories, searchTerm, maxRows, { fav: favOnly ? true : undefined, tags });
    if (hits.length === 0) {
        return { results: [], total, backend };
    }

    const resolved = await mapWithConcurrency(hits, INDEX_BUILD_READ_CONCURRENCY, async (hit) => {
        try {
            const character = await processCharacter(hit.id, directories, { shallow: false });
            return character?.name ? { item: character, score: hit.score } : null;
        } catch {
            return null;
        }
    });

    return { results: resolved.filter(Boolean), total, backend };
}

// Id-only counterpart to searchCharacters() - no per-hit disk read, for a caller that resolves rows itself.
export async function searchCharacterIds(handle, directories, searchTerm, maxRows, filter = {}) {
    const { hits, total, backend, position } = await runIdSearch(handle, directories, searchTerm, maxRows, filter);
    return timePhase('chars_ids', () => ({ ids: hits.map(hit => hit.id), scoresById: new Map(hits.map(hit => [hit.id, hit.score])), total, backend, position }));
}

// fav_name_sort_key is encoded so ascending order gives favorites-first-then-alpha, whatever order was asked for.
export function tantivySortOrder(sortField, sortOrder) {
    return sortField === 'fav' ? 'asc' : (sortOrder === 'asc' ? 'asc' : 'desc');
}

/**
 * One window of the matches in fast-field order. `hits[].order` is tantivy's sort value (see fastFieldOrderValue()).
 * Returns null when sortField has no fast-field equivalent; caller uses the SQL sort path for those. `position`
 * is the reader's position (search-index-coordinator.js) as of the search, null when unknown.
 * @param {{ fav?: boolean, tags?: object, excludeIds?: string[], ids?: string[] }} [filter]
 * @returns {Promise<{ hits: { id: string, order: number }[], total: number, backend: string, position: import('./search-index-coordinator.js').SearchIndexPosition | null } | null>}
 */
export async function searchCharacterIdsSorted(handle, directories, searchTerm, sortField, sortOrder, offset, limit, filter = {}) {
    const { fav, tags, excludeIds, ids } = filter;
    const tantivySortField = SORT_FIELD_TO_TANTIVY_FIELD[sortField];
    if (!tantivySortField) return null;

    const engine = await timePhase('chars_index_get', () => resolveSearchEngine());
    if (engine.tier === 'unavailable') return { hits: [], total: 0, backend: 'unavailable', position: null };

    const tantivyIndex = await timePhase('chars_index_get', () => getSearchIndex(handle, directories, 'characters'));
    if (!tantivyIndex) return { hits: [], total: 0, backend: 'unavailable', position: null };
    const expandedTags = tags ? expandTagFilter(tags, await getTagDeletions(directories)) : null;
    // Nothing below awaits, so the reader can't move between here and the search.
    const position = tantivyIndex.position ?? null;
    if (expandedTags?.none) return { hits: [], total: 0, backend: 'tantivy', position };

    const query = timePhase('chars_query_build', () => {
        const { tantivy } = engine;
        const { schema } = tantivyIndex;
        let q = buildTantivyQuery(tantivy, schema, searchTerm, TANTIVY_FIELD_WEIGHTS, TANTIVY_FIELD_LABELS);
        if (!q) return null;
        q = withFavFilter(tantivy, schema, q, fav);
        const tagQuery = tags ? buildTagFilterQuery(tantivy, schema, tags, TAG_IDS_FIELD, expandedTags) : null;
        if (tagQuery) {
            q = tantivy.Query.booleanQuery([
                { occur: tantivy.Occur.Must, query: q },
                { occur: tantivy.Occur.Must, query: tagQuery },
            ]);
        }
        if (Array.isArray(ids)) {
            q = tantivy.Query.booleanQuery([
                { occur: tantivy.Occur.Must, query: q },
                { occur: tantivy.Occur.Must, query: buildIdsQuery(tantivy, schema, ids) },
            ]);
        }
        if (Array.isArray(excludeIds) && excludeIds.length > 0) {
            q = tantivy.Query.booleanQuery([
                { occur: tantivy.Occur.Must, query: q },
                { occur: tantivy.Occur.MustNot, query: buildExcludeIdsQuery(tantivy, schema, excludeIds) },
            ]);
        }
        return q;
    });
    if (!query) return { hits: [], total: 0, backend: 'tantivy', position };

    // The exact count costs about 1 ms on top of the sorted window; the binding offers no cheaper estimate.
    const { results, total } = runTantivySearch(tantivyIndex.index, query, limit, {
        orderByField: tantivySortField,
        order: tantivySortOrder(sortField, sortOrder),
        offset,
        count: true,
        timingLabel: 'chars',
    });
    return { hits: timePhase('chars_ids', () => results.map(r => ({ id: r.raw, order: /** @type {number} */ (r.order) }))), total, backend: 'tantivy', position };
}

/**
 * The characters index's position as searches read it now (search-index-coordinator.js), or null when it isn't
 * known or there is no index.
 * @param {string} handle
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<import('./search-index-coordinator.js').SearchIndexPosition | null>}
 */
export async function getCharacterIndexPosition(handle, directories) {
    const engine = await resolveSearchEngine();
    if (engine.tier === 'unavailable') return null;
    const tantivyIndex = await getSearchIndex(handle, directories, 'characters');
    return tantivyIndex?.position ?? null;
}

/**
 * Starts the user's search index worker when their characters index exists, without waiting for the index to be
 * ready. A user with no index is left to their first search, which builds it.
 * @param {string} handle
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<boolean>} Whether the worker was started.
 */
export async function startSearchWorkerIfIndexed(handle, directories) {
    const engine = await resolveSearchEngine();
    // tantivy's own Index.exists() check, without its throw on a missing dir.
    if (engine.tier === 'unavailable' || !fs.existsSync(path.join(tantivyIndexDir(directories), 'meta.json'))) {
        return false;
    }
    await startSearchWorker(handle, directories);
    return true;
}

// Explicit repair endpoint: a full rebuild-and-swap in the handle's search index worker. Resolves once the
// rebuilt index is the one searches read.
export async function rebuildCharacterSearchIndex(handle, directories) {
    const engine = await resolveSearchEngine();
    if (engine.tier === 'unavailable') {
        return { ok: false, backend: 'unavailable' };
    }

    const rebuilt = await rebuildSearchIndex(handle, directories);
    if (!rebuilt) {
        return { ok: false, backend: 'unavailable' };
    }
    return { ok: true, backend: 'tantivy' };
}
