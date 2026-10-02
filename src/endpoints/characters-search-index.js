import fs from 'node:fs';
import path from 'node:path';

import {
    getTagDefinitionsByIds, getEntityTagIdsForMany, getTagDeletions,
    getChangesSince, getCurrentSeq, getCurrentTagNameChangeSeq, getTagNameChangesSince, streamCharacterIdsForTagIds, streamCharacterCardJsonBatches,
    streamDeletedIdsBetween, getMetaValue, trySetMetaValuesAndRetryMarks, getCharacterFavsByIds, getCharacterIndexRowsByIds,
    getCharacterIndexRetryMarksByIds, getDueCharacterIndexRetries, checkCharactersExist,
} from '../character-metadata-db.js';
import { processCharacter, processCharacterOrPlaceholder } from './characters.js';
import { buildSchema as buildTantivySchema, buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch, DATA_FIELD, FAV_FIELD, buildTagFilterQuery, buildExcludeIdsQuery, buildIdsQuery, withFavFilter, stringToSortKey } from './tantivy-search.js';
import { resolveSearchEngine } from './search-engine.js';
import { getSearchIndex, rebuildSearchIndex, startSearchWorker, CHARACTERS_INDEX_SEQ_META_KEY, CHARACTERS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY, CHARACTERS_INDEX_RETRY_SEQ_META_KEY } from './search-index-coordinator.js';
import { rebuildTempDir, cleanupStaleRebuildDirs, swapIndexIntoPlace } from './tantivy-engine.js';
import { getConfigValue, mapWithConcurrency, color } from '../util.js';
import { timePhase } from '../search-timing.js';
import { searchIndexTagFilter } from '../tag-deletions.js';
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
const TANTIVY_INDEX_RETRY_SEQ_META_KEY = CHARACTERS_INDEX_RETRY_SEQ_META_KEY;
const TANTIVY_INDEX_SCHEMA_VERSION_META_KEY = 'tantivy_char_index_schema_version';
const TANTIVY_INDEX_TAG_RENAME_RESUME_META_KEY = 'tantivy_char_index_tag_rename_resume';

const CHECKPOINT_EVERY_N_BATCHES = 20;

const REBUILD_PERSIST_RETRY_MS = 100;

// The share of a tick's budget the tag-rename loop always gets, so a change backlog can't starve renames.
const TAG_RENAME_BUDGET_SHARE = 0.25;

// A card that fails to re-index is retried after RETRY_INITIAL_DELAY_MS, then after twice the previous wait on each
// failed attempt, up to RETRY_MAX_DELAY_MS.
const RETRY_INITIAL_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 5 * 60 * 1000;
/** The most due retries one tick attempts. */
export const CHARACTER_INDEX_RETRY_BATCH_SIZE = 100;

/**
 * The retry mark for a failed attempt at indexing a card, given the mark it had. log: its error differs from the last
 * one logged for it.
 * @param {import('../character-metadata-db.js').CharacterIndexRetryMark | null} previous
 * @param {unknown} err
 */
function failedAttemptMark(previous, err) {
    const lastError = String(err);
    const delayMs = previous ? Math.min(previous.delayMs * 2, RETRY_MAX_DELAY_MS) : RETRY_INITIAL_DELAY_MS;
    return { mark: { nextAttemptAt: Date.now() + delayMs, delayMs, lastError }, log: previous?.lastError !== lastError };
}

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

/**
 * What adding docs for a set of ids did. indexed: got a new doc. missing: no row, so not indexed. failures: the card
 * couldn't be processed, so it got no new doc; name is its row's.
 * @typedef {{ indexed: string[], missing: string[], failures: { id: string, name: string, err: unknown }[] }} AddOutcome
 */

// Adds a doc per id, INDEX_BUILD_BATCH_SIZE ids at a time, reading each batch's rows by id.
/**
 * @param {TickPhases} [phases]
 * @param {{ replace?: boolean }} [options] See addCharacterBatch().
 * @returns {Promise<AddOutcome>}
 */
async function addCharacterDocs(directories, tantivy, schema, writer, ids, phases, options) {
    /** @type {AddOutcome} */
    const outcome = { indexed: [], missing: [], failures: [] };
    for (let i = 0; i < ids.length; i += INDEX_BUILD_BATCH_SIZE) {
        const batchIds = ids.slice(i, i + INDEX_BUILD_BATCH_SIZE);
        const rowById = await timeAsync(phases, 'load', () => getCharacterIndexRowsByIds(directories, batchIds));
        const batch = await addCharacterBatch(directories, tantivy, schema, writer, batchIds, rowById, phases, options);
        outcome.indexed.push(...batch.indexed);
        outcome.missing.push(...batch.missing);
        outcome.failures.push(...batch.failures);
    }
    return outcome;
}

// Adds a doc per id as one unit: tag/fav lookups cover exactly these ids. An id with no row was deleted after the
// change being applied, so it isn't indexed.
/**
 * @param {Map<string, import('../character-metadata-db.js').CharacterIndexRow>} rowById
 * @param {TickPhases} [phases]
 * @param {{ replace?: boolean }} [options] replace: the writer's index may already hold docs for these ids. Each id
 * that gets a new doc or has no row loses its old docs; one whose card fails to process keeps them.
 * @returns {Promise<AddOutcome>}
 */
async function addCharacterBatch(directories, tantivy, schema, writer, batchIds, rowById, phases, { replace = false } = {}) {
    const ids = batchIds.filter(id => rowById.has(id));
    const missing = batchIds.filter(id => !rowById.has(id));
    /** @type {AddOutcome} */
    const outcome = { indexed: [], missing, failures: [] };
    if (replace) {
        timeSync(phases, 'add', () => {
            for (const id of missing) writer.deleteDocumentsByTerm(DATA_FIELD, id);
        });
    }
    if (ids.length === 0) return outcome;
    const { tagNamesFor, tagIdsFor } = await makeTagResolvers(directories, ids, phases);
    const favFor = await timeAsync(phases, 'load', () => makeFavResolver(directories, ids));
    const results = await timeAsync(phases, 'build', () => mapWithConcurrency(ids, INDEX_BUILD_READ_CONCURRENCY, async (id) => {
        const row = rowById.get(id);
        try {
            return {
                id,
                character: await processCharacter(id, directories, {
                    shallow: false,
                    cardJson: row.card_json,
                    chatStats: { chatSize: row.chat_size, dateLastChat: row.date_last_chat },
                }),
            };
        } catch (err) {
            return { id, err };
        }
    }));
    for (const result of results) {
        if (!('character' in result)) {
            outcome.failures.push({ id: result.id, name: rowById.get(result.id).name, err: result.err });
            continue;
        }
        const doc = timeSync(phases, 'build', () => characterToTantivyDoc(tantivy, schema, result.character, tagNamesFor, favFor, tagIdsFor));
        timeSync(phases, 'add', () => {
            if (replace) writer.deleteDocumentsByTerm(DATA_FIELD, result.id);
            writer.addDocument(doc);
        });
        outcome.indexed.push(result.id);
    }
    return outcome;
}

/**
 * One committed catch-up. seqFrom..seq and tagNameSeqFrom..tagNameSeq are the change-log and tag-rename cursors
 * before and after. backlog: the change-log seq read at the tick's end minus the new cursor. writers: upserted
 * ids per changed field name (`null` for a whole-record change); an id with several fields counts under each.
 * tagRenames: distinct renamed tag ids applied. lockWaitMs: time this tick's writes spent on a database lock.
 * persistSkipped: the cursors, retry counter and retry marks couldn't be persisted because the database was locked,
 * so they stayed at their values from before the tick (seq === seqFrom) and the next tick redoes this one's work.
 * retrySeq: the retry counter after the tick. retried: due retries attempted. failed: cards that failed to process,
 * retries included.
 * @typedef {{ changed: boolean, deletes: number, upserts: number, ms: number, seq: number, seqFrom: number,
 *   tagNameSeqFrom: number, tagNameSeq: number, retrySeq: number, retried: number, failed: number, backlog: number,
 *   writers: Record<string, number>, tagRenames: number,
 *   phases: TickPhases, lockWaitMs: number, persistSkipped?: boolean }} TickResult
 */

/**
 * Whether a committed catch-up is worth a console line. A tick that only applied one card's ordinary edit is the
 * steady trickle of single updates and stays quiet; a tick that applied several changes, renamed tags, left a
 * backlog, retried or failed a card, or couldn't persist its cursors is a batch and is logged. A failed card is
 * also logged on its own line when it fails, so quiet ticks never hide one.
 * @param {TickResult} r
 */
export function isBatchCatchUp(r) {
    return r.deletes + r.upserts > 1 || r.tagRenames > 0 || r.backlog > 0
        || r.retried > 0 || r.failed > 0 || Boolean(r.persistSkipped);
}

/** @param {TickResult} r */
export function formatCatchUpLine(r) {
    const p = r.phases;
    const tagSeq = r.tagNameSeq !== r.tagNameSeqFrom ? ` tagseq=${r.tagNameSeqFrom}..${r.tagNameSeq}` : '';
    const writers = Object.entries(r.writers).map(([field, n]) => `${field === 'null' ? 'whole-record' : field}:${n}`).join(',');
    return `[search] catch-up: seq=${r.seqFrom}..${r.seq}${tagSeq} backlog=${r.backlog} writers=${writers} tagrenames=${r.tagRenames}`
        + ` deletes=${r.deletes} upserts=${r.upserts} total_ms=${r.ms} read_ms=${p.read} deletes_ms=${p.deletes} tags_ms=${p.tags}`
        + ` load_ms=${p.load} build_ms=${p.build} add_ms=${p.add} commit_ms=${p.commit} persist_ms=${p.persist}`
        + `${r.retried || r.failed ? ` retried=${r.retried} failed=${r.failed}` : ''}`
        + `${r.persistSkipped ? ' persist=skipped' : ''} lockwait_ms=${r.lockWaitMs}`;
}

/**
 * The warning for a card that couldn't be indexed, handed on whenever its failure is logged. name: its row's, which
 * may be empty. error: as its retry mark records it. retryInMs: when it's retried. keptEntry: whether it keeps the
 * search entry it had, if it had one; false when a full rebuild that started empty left it with none.
 * @typedef {{ id: string, name: string, error: string, retryInMs: number, keptEntry: boolean }} CharacterIndexFailure
 * @typedef {{ line: string, warning: CharacterIndexFailure }} FailureReport
 */

/**
 * The only writer of a user's characters index. Runs in search-index-worker.js, never in the request process:
 * every call here is synchronous work (better-sqlite3, processCharacter()'s fs reads, tantivy's napi calls) that
 * would otherwise hold the event loop.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {{ tickBudgetMs?: number, onIndexFailure?: (warning: CharacterIndexFailure) => void }} [options]
 * tickBudgetMs: how long one tick keeps taking change-log pages before it commits, so a large backlog still commits
 * about once per tick. onIndexFailure: called with each failure's warning right after its log line, so under the
 * same once-per-new-error rule.
 */
export function createCharacterIndexMaintainer(directories, tantivy, { tickBudgetMs = 1000, onIndexFailure = () => { } } = {}) {
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
    // Bumped by each catch-up whose retries changed the index, which moves neither cursor.
    let retrySeq = 0;
    /**
     * A tag-rename page a tick stopped partway through: the page ends at untilSeq, and its characters up to and
     * including afterId are re-indexed. null when no page is part done.
     * @type {{ untilSeq: number, afterId: string } | null}
     */
    let renameResume = null;

    function getWriter() {
        return writer ?? (writer = index.writer());
    }

    function setCursors(seq, tagNameSeq) {
        seqCursor = seq;
        tagNameCursor = tagNameSeq;
        deleteCursor = Math.max(deleteCursor, seq);
    }

    function positionMetaValues() {
        return {
            [TANTIVY_INDEX_SEQ_META_KEY]: String(seqCursor),
            [TANTIVY_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY]: String(tagNameCursor),
            [TANTIVY_INDEX_RETRY_SEQ_META_KEY]: String(retrySeq),
            [TANTIVY_INDEX_SCHEMA_VERSION_META_KEY]: String(TANTIVY_SCHEMA_VERSION),
            [TANTIVY_INDEX_TAG_RENAME_RESUME_META_KEY]: renameResume ? JSON.stringify(renameResume) : '',
        };
    }

    /**
     * @param {string | null} stored
     * @returns {{ untilSeq: number, afterId: string } | null}
     */
    function parseRenameResume(stored) {
        if (!stored) return null;
        try {
            const parsed = JSON.parse(stored);
            return Number.isInteger(parsed?.untilSeq) && typeof parsed?.afterId === 'string' ? { untilSeq: parsed.untilSeq, afterId: parsed.afterId } : null;
        } catch {
            return null;
        }
    }

    /** @returns {Promise<boolean>} false: the database was locked and nothing was persisted. */
    function persistCursors() {
        return trySetMetaValuesAndRetryMarks(directories, positionMetaValues(), []);
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
        const persistedRetrySeq = await getMetaValue(directories, TANTIVY_INDEX_RETRY_SEQ_META_KEY);
        index = opened;
        schema = opened.schema;
        getWriter();
        deleteCursor = 0;
        setCursors(Number(persistedSeq), persistedTagNameChangeSeq !== null ? Number(persistedTagNameChangeSeq) : 0);
        retrySeq = persistedRetrySeq !== null ? Number(persistedRetrySeq) : 0;
        renameResume = parseRenameResume(await getMetaValue(directories, TANTIVY_INDEX_TAG_RENAME_RESUME_META_KEY));
        return indexDir;
    }

    /**
     * Writes one rebuild batch's retry marks in a transaction of their own, then logs. A crashed rebuild just starts
     * over, and the marks it wrote are still true.
     * @param {string[]} cleared Ids that got a new doc or have no row: their marks are deleted.
     * @param {AddOutcome['failures']} failures
     * @param {boolean} keptOldDocs Whether the rebuild started from the old index, so a failing card keeps its doc.
     */
    async function persistRebuildMarks(cleared, failures, keptOldDocs) {
        const ids = [...new Set([...cleared, ...failures.map(f => f.id)])];
        if (ids.length === 0) return;
        const stored = await getCharacterIndexRetryMarksByIds(directories, ids);
        /** @type {{ id: string, mark: import('../character-metadata-db.js').CharacterIndexRetryMark | null }[]} */
        const writes = [...new Set(cleared)].filter(id => stored.has(id)).map(id => ({ id, mark: null }));
        /** @type {FailureReport[]} */
        const reports = [];
        for (const { id, name, err } of failures) {
            const next = failedAttemptMark(stored.get(id) ?? null, err);
            writes.push({ id, mark: next.mark });
            if (next.log) {
                reports.push({
                    line: keptOldDocs
                        ? `[search] couldn't index character ${id} in the full rebuild, so it keeps its search entry from before the rebuild, if it had one, and it's retried in ${next.mark.delayMs} ms: ${next.mark.lastError}`
                        : `[search] couldn't index character ${id} in the full rebuild, so it has no search entry until it's retried in ${next.mark.delayMs} ms and that succeeds: ${next.mark.lastError}`,
                    warning: { id, name, error: next.mark.lastError, retryInMs: next.mark.delayMs, keptEntry: keptOldDocs },
                });
            }
        }
        if (writes.length === 0) return;
        while (!await trySetMetaValuesAndRetryMarks(directories, {}, writes)) {
            await new Promise(resolve => setTimeout(resolve, REBUILD_PERSIST_RETRY_MS));
        }
        report(reports);
    }

    /**
     * Logs each failure and hands its warning on.
     * @param {FailureReport[]} reports
     */
    function report(reports) {
        for (const { line, warning } of reports) {
            console.error(color.red(line));
            try {
                onIndexFailure(warning);
            } catch (err) {
                console.error(color.red(`[search] handing on the warning for character ${warning.id} failed: ${err?.message ?? err}`));
            }
        }
    }

    /**
     * Makes `dir` a copy of the persisted index to rebuild from, when that index was built under this schema version.
     * Segment files are hard-linked, not copied: tantivy never changes one once written, so both dirs can share it at
     * no extra disk. The json files tantivy rewrites are copied, and lock files are left out. The old writer must
     * have finished merging, so the persisted index doesn't change while it's linked.
     * @param {string} dir
     * @returns {Promise<{ index: any, schema: any, searcher: any } | null>} searcher: the copy as it was linked, before
     * any rebuild write. null: there's nothing usable to start from, and `dir` doesn't exist.
     */
    async function linkPersistedIndexInto(dir) {
        if (Number(await getMetaValue(directories, TANTIVY_INDEX_SCHEMA_VERSION_META_KEY)) !== TANTIVY_SCHEMA_VERSION
            || !fs.existsSync(path.join(indexDir, 'meta.json'))) {
            return null;
        }
        fs.mkdirSync(dir);
        for (const entry of fs.readdirSync(indexDir, { withFileTypes: true })) {
            if (!entry.isFile() || entry.name.endsWith('.lock')) continue;
            const from = path.join(indexDir, entry.name);
            const to = path.join(dir, entry.name);
            if (entry.name.endsWith('.json')) {
                fs.copyFileSync(from, to);
                continue;
            }
            try {
                fs.linkSync(from, to);
            } catch (err) {
                fs.rmSync(dir, { recursive: true, force: true });
                console.error(color.red(`[search] the filesystem can't hard-link the character search index (${err.code ?? err.message}), so this full rebuild starts empty and can't keep the old search entry of a card that fails to index`));
                return null;
            }
        }
        try {
            const index = tantivy.Index.open(dir);
            return { index, schema: index.schema, searcher: index.searcher() };
        } catch (err) {
            fs.rmSync(dir, { recursive: true, force: true });
            console.error(color.red('[search] failed to open the persisted character tantivy index to rebuild from, so this full rebuild starts empty:'));
            console.error(color.red(`[search]   ${err.message}`));
            return null;
        }
    }

    /**
     * Deletes through `w` every doc in `searcher`'s segments whose card has no row, INDEX_BUILD_BATCH_SIZE stored ids
     * at a time, and clears those cards' retry marks.
     * @param {any} searcher
     * @param {any} w
     */
    async function removeDocsWithoutRows(searcher, w) {
        /** @type {string[]} */
        let batch = [];
        const flush = async () => {
            if (batch.length === 0) return;
            const exists = await checkCharactersExist(directories, batch);
            if (!exists) throw new Error('the metadata store became unavailable during the full rebuild');
            const gone = [...new Set(batch.filter(id => !exists[id]))];
            for (const id of gone) w.deleteDocumentsByTerm(DATA_FIELD, id);
            await persistRebuildMarks(gone, [], true);
            batch = [];
        };
        // A segment ordinal past numSegments panics in tantivy, so it's never asked for. A doc number past a
        // segment's last doc throws this error; a deleted doc is still read.
        for (let segmentOrd = 0; segmentOrd < searcher.numSegments; segmentOrd++) {
            for (let doc = 0; ; doc++) {
                let stored;
                try {
                    stored = searcher.doc({ segmentOrd, doc });
                } catch (err) {
                    if (/Failed to lookup Doc/.test(String(err?.message))) break;
                    throw err;
                }
                const id = stored.toDict()[DATA_FIELD]?.[0];
                if (typeof id === 'string') batch.push(id);
                if (batch.length >= INDEX_BUILD_BATCH_SIZE) await flush();
            }
        }
        await flush();
    }

    /**
     * Streams every characters row into a new index in a temp dir, then swaps it into place. The watermarks are read
     * before the stream starts, so the next tick picks up whatever changed during it.
     * The new index starts as a hard-linked copy of the persisted one when that was built under this schema version
     * (see linkPersistedIndexInto()); otherwise it starts empty. Each card gets its doc replaced, and a card that
     * fails to process keeps the doc it had, stale rather than gone. A second pass then deletes the copied docs whose
     * row is gone. Each batch's retry marks (see tick()) are written as the batch is done, not with the cursors.
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

        // Its dir is linked into the rebuild, and is about to be renamed away; its lock goes with it.
        if (writer) {
            writer.waitMergingThreads();
            writer = null;
        }
        const tempDir = rebuildTempDir(parentDir, INDEX_DIR_NAME);
        const linked = await linkPersistedIndexInto(tempDir);
        const built = linked ?? createEmptyTantivyIndexAt(tantivy, tempDir);
        const tempWriter = built.index.writer();
        try {
            let batchIndex = 0;
            // Each streamed batch is one unit: its rows came with it, and its tag/fav lookups cover exactly it.
            for await (const rows of streamCharacterCardJsonBatches(directories)) {
                const { indexed, failures } = await addCharacterBatch(directories, tantivy, built.schema, tempWriter, rows.map(row => row.id), new Map(rows.map(row => [row.id, row])), undefined, { replace: Boolean(linked) });
                await persistRebuildMarks(indexed, failures, Boolean(linked));
                batchIndex++;
                if (batchIndex % CHECKPOINT_EVERY_N_BATCHES === 0) {
                    tempWriter.commit();
                }
            }
            if (linked) await removeDocsWithoutRows(linked.searcher, tempWriter);
            tempWriter.commit();
        } finally {
            // commit() alone does not release the writer's on-disk lock; waitMergingThreads() does.
            tempWriter.waitMergingThreads();
        }

        swapIndexIntoPlace(indexDir, tempDir);
        index = tantivy.Index.open(indexDir);
        schema = index.schema;
        getWriter();

        deleteCursor = 0;
        setCursors(lastSeq, lastTagNameChangeSeq);
        renameResume = null;
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
     * drained or its part of tickBudgetMs has passed; then up to CHARACTER_INDEX_RETRY_BATCH_SIZE due retries. An
     * upsert page or retry never undoes an applied delete: it reads the row's current card_json, and a deleted row
     * has none.
     * A card that fails to process keeps the doc it had and is marked for retry (character_index_retries). Any
     * failed attempt doubles its delay, capped at RETRY_MAX_DELAY_MS; a new doc or a deleted card clears the mark.
     * The marks are persisted in the same transaction as the cursors, and a failure is logged, once that
     * transaction lands, only when its error differs from the last one logged for that card.
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
        let retried = 0;
        let failed = 0;
        let retriesChanged = false;
        const seqFrom = seqCursor;
        const tagNameSeqFrom = tagNameCursor;
        const deleteCursorFrom = deleteCursor;
        const retrySeqFrom = retrySeq;
        const renameResumeFrom = renameResume;
        let lastSeq = seqCursor;
        let lastTagNameChangeSeq = tagNameCursor;
        let resume = renameResume;
        /** @type {Map<string, number>} */
        const writers = new Map();
        /** @type {Set<string>} */
        const renamedTagIds = new Set();
        /**
         * This tick's retry mark writes (mark null: delete). stored: the card had a mark in the db before the tick.
         * @type {Map<string, { mark: import('../character-metadata-db.js').CharacterIndexRetryMark | null, stored: boolean }>}
         */
        const markWrites = new Map();
        /** @type {FailureReport[]} */
        const failureReports = [];

        /**
         * @param {string[]} cleared Ids that got a new doc or are deleted.
         * @param {AddOutcome['failures']} [failures]
         */
        async function noteOutcomes(cleared, failures = []) {
            const unseen = [...cleared, ...failures.map(f => f.id)].filter(id => !markWrites.has(id));
            const stored = unseen.length > 0
                ? await timeAsync(phases, 'load', () => getCharacterIndexRetryMarksByIds(directories, unseen))
                : new Map();
            const current = (id) => markWrites.has(id)
                ? { mark: markWrites.get(id).mark, stored: markWrites.get(id).stored }
                : { mark: stored.get(id) ?? null, stored: stored.has(id) };
            for (const id of cleared) {
                const { mark, stored: inDb } = current(id);
                if (inDb) {
                    markWrites.set(id, { mark: null, stored: true });
                } else if (mark) {
                    markWrites.delete(id);
                }
            }
            for (const { id, name, err } of failures) {
                failed++;
                const { mark, stored: inDb } = current(id);
                const next = failedAttemptMark(mark, err);
                if (next.log) {
                    failureReports.push({
                        line: `[search] couldn't index character ${id}, so its previous search entry is kept and it's retried in ${next.mark.delayMs} ms: ${next.mark.lastError}`,
                        warning: { id, name, error: next.mark.lastError, retryInMs: next.mark.delayMs, keptEntry: true },
                    });
                }
                markWrites.set(id, { mark: next.mark, stored: inDb });
            }
        }

        try {
            // Starts past seqCursor too: upsert pages aren't capped at a tick's maxSeq, so rows up to seqCursor are
            // already applied, and re-applying a delete there could remove a doc an upsert page has since re-created.
            await timeAsync(phases, 'deletes', async () => {
                for await (const ids of streamDeletedIdsBetween(directories, Math.max(deleteCursor, seqCursor), maxSeq)) {
                    for (const id of ids) {
                        w.deleteDocumentsByTerm(DATA_FIELD, id);
                    }
                    deletes += ids.length;
                    await noteOutcomes(ids);
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
                    const deletedIds = [];
                    const upsertIds = [];
                    for (const change of page.changes) {
                        if (change.op === 'delete') {
                            deletedIds.push(change.id);
                            continue;
                        }
                        upsertIds.push(change.id);
                        for (const field of change.fields ?? ['null']) {
                            writers.set(field, (writers.get(field) ?? 0) + 1);
                        }
                    }
                    timeSync(phases, 'add', () => {
                        for (const id of deletedIds) {
                            w.deleteDocumentsByTerm(DATA_FIELD, id);
                        }
                    });
                    await noteOutcomes(deletedIds);
                    deletes += deletedIds.length;
                    upserts += upsertIds.length;
                    const outcome = await addCharacterDocs(directories, tantivy, schema, w, upsertIds, phases, { replace: true });
                    await noteOutcomes([...outcome.indexed, ...outcome.missing], outcome.failures);
                }
                lastSeq = page.seq;
                if (!page.hasMore || Date.now() >= changesDeadline) break;
            }

            // A tag rename doesn't produce a `changes` row for the characters carrying it, so it's tracked separately.
            // Its loop always takes at least one batch of characters and gets its share of the budget from its own
            // start, even when the last change page ran past the change loop's deadline, plus whatever the change loop
            // left unused. A page whose characters outlast the deadline is left part done, and the next tick goes on
            // from the character after the last one re-indexed.
            const renamesStart = Date.now();
            const renamesDeadline = renamesStart + tickBudgetMs * TAG_RENAME_BUDGET_SHARE + Math.max(0, changesDeadline - renamesStart);
            for (;;) {
                const resumed = resume;
                const page = await timeAsync(phases, 'read', () => getTagNameChangesSince(directories, lastTagNameChangeSeq, { limit: INDEX_BUILD_BATCH_SIZE, untilSeq: resumed?.untilSeq }));
                if (!page) {
                    w.rollback();
                    return null;
                }
                if (page.truncated) {
                    w.rollback();
                    return { swapped: await rebuild() };
                }
                /** @type {string | null} */
                let stoppedAfter = null;
                if (page.tagIds.length > 0) {
                    for (const tagId of page.tagIds) renamedTagIds.add(tagId);
                    const affected = streamCharacterIdsForTagIds(directories, page.tagIds, { after: resumed?.afterId ?? null })[Symbol.asyncIterator]();
                    try {
                        let next = await timeAsync(phases, 'read', () => affected.next());
                        while (!next.done) {
                            const affectedIds = next.value;
                            upserts += affectedIds.length;
                            const outcome = await addCharacterDocs(directories, tantivy, schema, w, affectedIds, phases, { replace: true });
                            await noteOutcomes([...outcome.indexed, ...outcome.missing], outcome.failures);
                            next = await timeAsync(phases, 'read', () => affected.next());
                            if (!next.done && Date.now() >= renamesDeadline) {
                                stoppedAfter = affectedIds[affectedIds.length - 1];
                                break;
                            }
                        }
                    } finally {
                        await affected.return?.();
                    }
                }
                if (stoppedAfter !== null) {
                    resume = { untilSeq: page.seq, afterId: stoppedAfter };
                    break;
                }
                resume = null;
                lastTagNameChangeSeq = page.seq;
                // A resumed page was read only up to where it ended, so rows may lie past it whatever hasMore says.
                if ((!page.hasMore && !resumed) || Date.now() >= renamesDeadline) break;
            }

            // Cards this tick already re-indexed or failed on aren't attempted again in it.
            const due = await timeAsync(phases, 'read', () => getDueCharacterIndexRetries(directories, Date.now(), CHARACTER_INDEX_RETRY_BATCH_SIZE));
            const retryIds = due.map(mark => mark.id).filter(id => !markWrites.has(id));
            if (retryIds.length > 0) {
                retried = retryIds.length;
                const outcome = await addCharacterDocs(directories, tantivy, schema, w, retryIds, phases, { replace: true });
                retriesChanged = outcome.indexed.length > 0 || outcome.missing.length > 0;
                await noteOutcomes([...outcome.indexed, ...outcome.missing], outcome.failures);
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
        const changed = deletes > 0 || upserts > 0 || retriesChanged;
        if (changed) {
            timeSync(phases, 'commit', () => w.commit());
        }
        const moved = lastSeq !== seqCursor || lastTagNameChangeSeq !== tagNameCursor || retriesChanged
            || resume?.untilSeq !== renameResume?.untilSeq || resume?.afterId !== renameResume?.afterId;
        setCursors(lastSeq, lastTagNameChangeSeq);
        renameResume = resume;
        deleteCursor = Math.max(deleteCursor, maxSeq);
        if (retriesChanged) retrySeq++;
        let persistSkipped = false;
        if (moved || markWrites.size > 0) {
            const retryMarks = [...markWrites].map(([id, { mark }]) => ({ id, mark }));
            persistSkipped = !await timeAsync(phases, 'persist', () => trySetMetaValuesAndRetryMarks(directories, moved ? positionMetaValues() : {}, retryMarks));
        }
        // Rather than wait on the lock, the next tick redoes this one's work: every doc it touched is deleted and
        // re-added by id, so applying it twice changes nothing.
        if (persistSkipped) {
            seqCursor = seqFrom;
            tagNameCursor = tagNameSeqFrom;
            renameResume = renameResumeFrom;
            deleteCursor = deleteCursorFrom;
            retrySeq = retrySeqFrom;
        } else {
            report(failureReports);
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
            retrySeq,
            retried,
            failed,
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
        /** How many catch-ups changed the index through retries alone. */
        retrySeq: () => retrySeq,
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
async function runIdSearch(handle, directories, searchTerm, maxRows, filter = {}, { offset } = {}) {
    const { fav, tags, excludeIds, ids } = filter;
    const engine = await timePhase('chars_index_get', () => resolveSearchEngine());

    if (engine.tier === 'unavailable') {
        return { hits: [], total: 0, backend: 'unavailable', position: null };
    }

    const tantivyIndex = await timePhase('chars_index_get', () => getSearchIndex(handle, directories, 'characters'));
    if (!tantivyIndex) {
        return { hits: [], total: 0, backend: 'unavailable', position: null };
    }
    const tagFilter = tags ? searchIndexTagFilter(tags, await getTagDeletions(directories)) : null;
    // Nothing below awaits, so the reader can't move between here and the search.
    const position = tantivyIndex.position ?? null;
    if (tagFilter?.none) {
        return { hits: [], total: 0, backend: 'tantivy', position };
    }
    const tagsLeftToSql = tagFilter?.leftToSql ?? false;
    const query = timePhase('chars_query_build', () => {
        const { tantivy } = engine;
        const { schema } = tantivyIndex;
        let q = buildTantivyQuery(tantivy, schema, searchTerm, TANTIVY_FIELD_WEIGHTS, TANTIVY_FIELD_LABELS);
        if (!q) return null;
        q = withFavFilter(tantivy, schema, q, fav);
        const tagQuery = tags && !tagFilter?.leftToSql ? buildTagFilterQuery(tantivy, schema, tags, TAG_IDS_FIELD, tagFilter?.expanded) : null;
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
    // With the tags left to SQL, a capped list could be filled with hits the tags rule out, so every match is returned,
    // unless the caller asked for one window of the ranking (`offset`), which it checks against the tags itself.
    const windowed = Number.isFinite(offset);
    const boundedMaxRows = (windowed || !tagsLeftToSql) && Number.isFinite(maxRows) && maxRows > 0 ? maxRows : undefined;
    const { results, total } = runTantivySearch(tantivyIndex.index, query, boundedMaxRows, { timingLabel: 'chars', ...(windowed ? { offset } : {}) });
    return { hits: timePhase('chars_ids', () => results.map(r => ({ id: r.raw, score: r.score }))), total, backend: 'tantivy', position, tagsLeftToSql };
}

// A matched id that can no longer be resolved (deleted, or corrupt) is logged and dropped.
export async function searchCharacters(handle, directories, searchTerm, maxRows, favOnly, tags) {
    const { hits, total, backend } = await runIdSearch(handle, directories, searchTerm, maxRows, { fav: favOnly ? true : undefined, tags });
    if (hits.length === 0) {
        return { results: [], total, backend };
    }

    const resolved = await mapWithConcurrency(hits, INDEX_BUILD_READ_CONCURRENCY, async (hit) => {
        const character = await processCharacterOrPlaceholder(hit.id, directories, { shallow: false });
        return 'name' in character ? { item: character, score: hit.score } : null;
    });

    return { results: resolved.filter(Boolean), total, backend };
}

// Id-only counterpart to searchCharacters() - no per-hit disk read, for a caller that resolves rows itself.
export async function searchCharacterIds(handle, directories, searchTerm, maxRows, filter = {}) {
    const { hits, total, backend, position, tagsLeftToSql = false } = await runIdSearch(handle, directories, searchTerm, maxRows, filter);
    return timePhase('chars_ids', () => ({ ids: hits.map(hit => hit.id), scoresById: new Map(hits.map(hit => [hit.id, hit.score])), total, backend, position, tagsLeftToSql }));
}

/**
 * One window of the matches in relevance order: ranks [offset, offset + count). fav, ids and excludeIds are applied
 * by the index; tags too unless searchIndexTagFilter() leaves them to SQL (`tagsLeftToSql`), in which case the caller
 * checks each window against them. `total` counts what the index matched, before any tags it left to SQL.
 * @param {string} handle
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} searchTerm
 * @param {number} offset
 * @param {number} count
 * @param {{ fav?: boolean, tags?: object, excludeIds?: string[], ids?: string[] }} [filter]
 */
export async function searchCharacterIdsWindow(handle, directories, searchTerm, offset, count, filter = {}) {
    const { hits, total, backend, position, tagsLeftToSql = false } = await runIdSearch(handle, directories, searchTerm, count, filter, { offset });
    return { hits, total, backend, position, tagsLeftToSql };
}

/**
 * Whether the search indexes can't take this tag filter (searchIndexTagFilter()'s leftToSql), so a search with it
 * must check its matches against the tags in SQL.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object | undefined} tags
 * @returns {Promise<boolean>}
 */
export async function searchTagsLeftToSql(directories, tags) {
    if (!tags) return false;
    return searchIndexTagFilter(tags, await getTagDeletions(directories)).leftToSql;
}

// fav_name_sort_key is encoded so ascending order gives favorites-first-then-alpha, whatever order was asked for.
export function tantivySortOrder(sortField, sortOrder) {
    return sortField === 'fav' ? 'asc' : (sortOrder === 'asc' ? 'asc' : 'desc');
}

/**
 * One window of the matches in fast-field order. `hits[].order` is tantivy's sort value (see fastFieldOrderValue()).
 * Returns null when sortField has no fast-field equivalent, or the index can't take the tag filter
 * (searchIndexTagFilter()'s leftToSql); caller uses the SQL sort path for those. `position`
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
    const tagFilter = tags ? searchIndexTagFilter(tags, await getTagDeletions(directories)) : null;
    // The index can't take these tags; the caller's SQL path applies them.
    if (tagFilter?.leftToSql) return null;
    // Nothing below awaits, so the reader can't move between here and the search.
    const position = tantivyIndex.position ?? null;
    if (tagFilter?.none) return { hits: [], total: 0, backend: 'tantivy', position };

    const query = timePhase('chars_query_build', () => {
        const { tantivy } = engine;
        const { schema } = tantivyIndex;
        let q = buildTantivyQuery(tantivy, schema, searchTerm, TANTIVY_FIELD_WEIGHTS, TANTIVY_FIELD_LABELS);
        if (!q) return null;
        q = withFavFilter(tantivy, schema, q, fav);
        const tagQuery = tags && !tagFilter?.leftToSql ? buildTagFilterQuery(tantivy, schema, tags, TAG_IDS_FIELD, tagFilter?.expanded) : null;
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
