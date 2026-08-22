import fs from 'node:fs';
import path from 'node:path';

import {
    getTagDefinitions, getEntityTagIdsForMany, getTagsRevision,
    getChangesSince, getCurrentRev, getAllTaggedCharacterIds, getMetaValue, setMetaValue,
    getCharacterFavsByIds,
} from '../character-metadata-db.js';
import { processCharacter } from './characters.js';
import { buildFtsQuery } from './search-query.js';
import { buildSchema as buildTantivySchema, buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch, DATA_FIELD, FAV_FIELD } from './tantivy-search.js';
import { resolveSearchEngine } from './search-engine.js';
import { createIndexCoordinator } from './search-index-coordinator.js';
import { getConfigValue, mapWithConcurrency, color } from '../util.js';

/**
 * Fast full-content character search, backed by a persistent per-user SQLite FTS5 index built from *full*
 * (non-shallow) character data - so the "search" sort mode can be paginated server-side without losing ranking
 * quality, and (this is the part that actually matters) without silently missing most of a character's content
 * the way the client's own fuzzySearchCharacters() (power-user.js) does when `performance.lazyLoadCharacters`
 * is on: in shallow mode the client's resident `characters` array never has description/mes_example/scenario/
 * personality/first_mes/creator_notes/alternate_greetings populated for any character that hasn't been
 * individually opened this session, so client-side search has effectively only been searching name/tags for
 * most of the library. This index is always built from full data server-side, so that gap doesn't exist here
 * regardless of the shallow-list setting.
 *
 * WHY SQLITE FTS5 AND NOT AN IN-MEMORY JS INDEX (the first version of this file used Fuse.js, in-process, the
 * same way the client does): Fuse's bitap scan takes multiple seconds *per query* at real-world library sizes
 * (measured: 8-17s/query against a 24k-character-card install) - not viable for search-as-you-type. Swapping to
 * an in-memory inverted-index engine (minisearch was tested) drops query time to ~15ms, which sounds like a
 * fix, but its memory cost doesn't - measured 47.6KB of Node heap per indexed card. That's fine at a few
 * thousand cards, but extrapolates to ~13GB of heap at 300k cards and into the tens-of-GB range past a million
 * - a hard ceiling for a resident library that self-hosted installs can and do grow to, not a tuning knob.
 *
 * SQLite FTS5 keeps the index on disk instead of the JS heap: measured build cost for the same 24k-card dataset
 * was ~6s (faster than the in-memory options, not slower), query latency 1-5ms on the native engine, and the
 * *Node process* memory cost of building it was under 4MB regardless of dataset size, because the index lives
 * in SQLite's own file and page cache, not V8's heap. That's what makes this viable at library sizes an
 * in-memory JS index can't reach at all, not just "a bit better."
 *
 * TANTIVY IS NOW THE PRIMARY ENGINE, SQLITE FTS5 A FALLBACK TIER: FTS5's MATCH cost scales with a term's
 * posting-list size, not result-set size - measured a single common word ("the") at ~78ms against this install's
 * real library, and getting *worse*, not staying flat, as the library grows. Tantivy (see tantivy-engine.js,
 * tantivy-search.js) measured a flat 0-1ms for the same shape of query regardless of term commonality - a real
 * inverted-index search engine rather than a general relational engine with FTS bolted on. search-engine.js
 * resolves the actual tier used (tantivy first, then this module's native/wasm SQLite chain, matching this
 * header's original native-vs-wasm reasoning below) - see that module's header for the tantivy-not-usable
 * fallback story (its own platform coverage is narrower than SQLite's, so this fallback exists for real, not
 * hypothetically). Both this file's own two SQLite tiers still run the exact same SQLite/FTS5 code and produce
 * identical ranking and `label:query` behavior (search-query.js) when they're the tier in use.
 *
 * Freshness (for both backends) is checked cheaply (a characters-directory stat() plus getTagsRevision(),
 * character-metadata-db.js's monotonic tag-revision counter - see getFreshnessSignature() below) on every
 * search rather than via push-based invalidation hooks on every character-mutating route: characters.js has ~9
 * routes that touch character files (create/rename/edit/edit-avatar/edit-attribute/merge-attributes/delete/
 * import/duplicate), and this module needs to import processCharacter() *from* characters.js - having
 * characters.js import an invalidate() call back from here would be the exact characters.js<->other-module
 * circular import shape that already caused a real TDZ crash earlier this session (see the tags.js fix). A
 * directory's mtime changes on any add/remove/rename, and write-file-atomic's rename-over-target means an
 * in-place edit changes it too - so comparing "has the characters dir (or any tag definition/assignment)
 * changed since we indexed" catches every mutation path automatically, with no route-by-route hook list to keep
 * in sync and no import cycle. On staleness the SQLite index is rebuilt from scratch (not updated
 * incrementally row-by-row) - FTS5 absolutely supports incremental INSERT/UPDATE/DELETE, but wiring that up
 * per-route would reintroduce the same circular-import problem this stat-based check avoids, for a marginal
 * win given a full rebuild is already a ~6s one-time cost at real-world scale, not the multi-second-*per-query*
 * cost this module exists to eliminate.
 *
 * A stale signature does NOT mean the *request* pays that ~6s rebuild cost, and concurrent requests observing
 * the same stale signature don't each start their own redundant rebuild - see search-index-coordinator.js
 * (shared with groups-search-index.js) for how a stale-but-present index gets served immediately while a single
 * background rebuild catches the next request up to date. That module's header has the full story, including
 * the real production incident (an 18+ second search request, root-caused to exactly this rebuild-on-stale path
 * racing itself) that motivated it.
 *
 * DESIGN DOC §5.1/§3.3'S TANTIVY SUB-SCOPE (payload shrink, a real delete key, incremental maintenance, an
 * explicit repair path) - IMPLEMENTED HERE, CHARACTERS ONLY (groups-search-index.js keeps the pre-existing
 * full-JSON/full-rebuild-only behavior; groups have no metadata-store change log to drive incremental
 * maintenance off of, and §5.1's "rows now come from SQLite" rationale is specific to characters):
 *
 * - PAYLOAD SHRINK: `DATA_FIELD` (tantivy-search.js) now stores just a character's id (its avatar filename),
 *   not the full character JSON. This is also what makes the same field the delete-by-term key (see below) -
 *   see DATA_FIELD's own doc comment. A consequence: `runSearch()` no longer hands back full character data, so
 *   both searchCharacters() (the existing full-item contract `/all`'s search branch relies on) and the new
 *   searchCharacterIds() (id-only, for `/query`'s filter.search - see characters.js) resolve what they actually
 *   need from the matched id list themselves - searchCharacters() via processCharacter()'s own mtime-keyed cache
 *   (characters.js), searchCharacterIds() not at all, since `/query` resolves rows from the phase-1 SQLite
 *   metadata store instead (design doc §5's "push the FTS hit-id set into SQLite" composition).
 * - DELETE KEY: DATA_FIELD is `tokenizerName: 'raw'` (tantivy-search.js's buildSchema()) - already exactly what
 *   design doc §3's probe requires for `deleteDocumentsByTerm()` to hit precisely one document instead of
 *   collateral-damaging every document that happens to share a token with a `default`-tokenized field.
 * - INCREMENTAL MAINTENANCE: applyIncrementalTantivyChanges() below reads the phase-1 metadata store's own
 *   change log (getChangesSince(), character-metadata-db.js) instead of the coarse characters-directory
 *   `statSync` this module used before - see getFreshnessSignature() below for the new rev-based signature, and
 *   loadOrUpdateTantivyIndex() for the "reopen the persisted index (`Index.open`) and catch it up" path that
 *   replaces "rmSync the whole directory and reparse every PNG" as the *default* response to staleness. A tag
 *   *rename* (not an assignment change - see decision log) bumps `tags_rev` without producing any `changes` row,
 *   so applyIncrementalTantivyChanges() also re-indexes every currently-tagged character
 *   (getAllTaggedCharacterIds()) whenever `tags_rev` moved, an index-only SQL query independent of library size.
 * - REPAIR, NOT DEFAULT: rebuildCharacterSearchIndex() (exported below) is the only remaining caller of a genuine
 *   full rebuild for characters, wired to an explicit `POST /api/characters/search-index/rebuild` endpoint
 *   (characters.js) - a directory-mtime change (or, now, any content/tag change at all) can no longer trigger
 *   one implicitly. The very first index build for a fresh install still has to be a full pass (nothing to
 *   incrementally update from), and a persisted-index reopen that fails for any reason (corrupt directory, a
 *   truncated change log with nothing incremental to catch up from) also falls back to a full rebuild - both are
 *   loadOrUpdateTantivyIndex()'s job, not something a caller has to know to ask for separately.
 */

// Column order/weights mirror fuzzySearchCharacters() in public/scripts/power-user.js (and this file's
// original Fuse-based version) so a result ranks similarly to what the same term produced there.
const BM25_INDEXED_COLUMNS = ['name', 'resolved_tags', 'description', 'mes_example', 'scenario', 'personality', 'first_mes', 'creator_notes', 'creator', 'tags', 'alternate_greetings'];
const BM25_WEIGHTS = [20, 10, 3, 3, 2, 2, 2, 2, 1, 1, 1];

// `label:value` search syntax (see search-query.js) - maps a friendly label to the real FTS5 column-filter
// expression it becomes. `tag:`/`tags:` searches BOTH tag-ish columns via FTS5's `{col1 col2}:` group syntax,
// since BM25_WEIGHTS above already treats resolved_tags (tags.json names) and tags (raw embedded card data) as
// the same "does this character have this tag" concept - a label filter should honor that, not just pick one.
const FIELD_LABELS = {
    name: 'name',
    tag: '{resolved_tags tags}',
    tags: '{resolved_tags tags}',
    desc: 'description',
    description: 'description',
    example: 'mes_example',
    scenario: 'scenario',
    personality: 'personality',
    greeting: 'first_mes',
    notes: 'creator_notes',
    creator: 'creator',
    alt: 'alternate_greetings',
    alternate: 'alternate_greetings',
};

// tantivy-search.js's field-name-array equivalent of FIELD_LABELS above - same labels, same target fields, just
// expressed as arrays of tantivy field names instead of FTS5 column-filter expression strings (tantivy-search.js
// is agnostic to which shape parseLabeledToken()'s `fieldLabels` map uses, so these are just a different view of
// the same mapping, not a second source of truth to keep in sync by hand-checking - a mismatch here would only
// ever change which fields a `label:` filter searches, not break anything silently).
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
    alt: ['alternate_greetings'],
    alternate: ['alternate_greetings'],
};

/** @type {ReturnType<typeof createIndexCoordinator<import('./sqlite-engine.js').SqliteEngineHandle>>} */
const indexCoordinator = createIndexCoordinator();

/**
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Promise<string>} A cheap fingerprint that changes whenever a character is added/removed/edited or a
 * tag definition/assignment changes. Prefers the phase-1 metadata store's own change-log high-water mark
 * (getCurrentRev()) over a directory `statSync`, now that the store exists and tracks exactly this - a `rev`
 * change is a strictly more precise signal (it can't miss a same-mtime-different-content edit, and the
 * reconciler's drift-catching also bumps it, so a mutation that bypassed the write-path hooks still shows up
 * here once the reconciler catches it). Falls back to the old directory-mtime signature only if the metadata
 * store itself is unavailable (`getCurrentRev()` returns `null` - a broken-SQLite-install edge case distinct
 * from "tantivy works but SQLite doesn't", since tantivy and the metadata store resolve their engines
 * independently) - loadOrUpdateTantivyIndex() below has the matching fallback: without a change log there is
 * nothing to incrementally catch up from, so that state always full-rebuilds.
 */
async function getFreshnessSignature(directories) {
    const tagsRev = await getTagsRevision(directories);
    const rev = await getCurrentRev(directories);
    if (rev === null) {
        const charDirMtime = fs.statSync(directories.characters).mtimeMs;
        return `mtime:${charDirMtime}:${tagsRev}`;
    }
    return `rev:${rev}:${tagsRev}`;
}

// How many characters get read, processed, and inserted into the FTS5 index per batch/transaction while
// (re)building it. This is a pure memory/throughput knob, not a correctness one - every character still gets
// visited exactly once regardless of batch size. What it bounds is peak memory: readCharacterBatches() below
// never holds more than one batch's worth of full (non-shallow) character objects at a time, so index-build
// memory stays flat as a library grows from thousands of characters to (per this install's owner) a target of
// tens of millions, instead of scaling linearly with total library size the way an eager
// `Promise.all(everyCharacter)` does. 500 is a starting point, not a measured-optimal number - large enough
// that per-batch/per-transaction overhead (one SQLite transaction and one directory-batch of file reads each)
// stays small relative to the work done, small enough that a batch's worth of full character objects (each
// averaging tens of KB of text - see the json_data comment below) is a rounding error against any reasonable
// heap size.
const INDEX_BUILD_BATCH_SIZE = 500;

// Fallback cap on the tantivy tier's maxRows when a caller genuinely omits it - mirrors characters.js's own
// DEFAULT_PAGE_LIMIT. querySqliteIndex()'s doc comment explains why an unbounded fetch is a real OOM risk (a
// short/broad query prefix-matching most of a large library, each match then JSON.parse()'d in full); that risk
// applies identically to runTantivySearch()'s per-hit JSON.parse() of the stored `data` field, tantivy's raw
// per-query speed doesn't change how many full character objects an unbounded result set would parse.
const DEFAULT_TANTIVY_MAX_ROWS = 500;

// `meta` table keys (character-metadata-db.js's getMetaValue()/setMetaValue()) this module uses to remember
// which change-log rev / tags_rev the on-disk tantivy index was last caught up to - see this module's header on
// why that table, not a second file, holds this. Namespaced with a `tantivy_char_` prefix since `meta` is a flat
// key/value table shared with the metadata store's own bootstrap_completed/tags_rev keys.
const TANTIVY_INDEX_REV_META_KEY = 'tantivy_char_index_rev';
const TANTIVY_INDEX_TAGS_REV_META_KEY = 'tantivy_char_index_tags_rev';

// Fallback cap for callers that need the *whole* (or a generous approximation of the whole) matched-id set, not
// just a relevance-ranked page of it - specifically sort:'random' combined with filter.search (design doc §5.3,
// decision 23: "random and search compose unconditionally"), where hash order has no relationship to text
// relevance, so bounding tightly by relevance rank would silently bias which matches are ever reachable under a
// random ordering. This is affordable now in a way it wasn't before the payload shrink: a tantivy hit is a bare
// id string, not a 13KB-mean JSON.parse (DEFAULT_TANTIVY_MAX_ROWS's original OOM concern - see querySqliteIndex()
// below), so fetching orders of magnitude more ids costs orders of magnitude less than fetching that many full
// rows used to. The /query route (characters.js) marks a total as approximate whenever a search itself matched
// more ids than this cap - decision 6 permits an approximate total, never a silently-truncated one.
export const SEARCH_ID_CAP = 50000;

// How many batches to insert before folding the WAL back into the main db file (native engine only - see
// buildSqliteIndex()'s checkpoint comment for why this matters and why the wasm engine's checkpoint is a
// no-op). Checkpointing only once at the very end - the original approach - meant the WAL grew to roughly the
// size of the *entire* index before ever being reclaimed (confirmed: ~1.7GB WAL alongside a ~1.7GB db file for
// this install's real 24,171-character library) - fine at that scale, not at a target of millions of
// characters, where an unbounded WAL is a real multi-gigabyte-plus disk cost, not just an odd transient. This
// interval is a disk-usage/checkpoint-overhead tradeoff, not a correctness knob.
const CHECKPOINT_EVERY_N_BATCHES = 20;

// How many character files get read+processed concurrently *within* a batch. Separate knob from
// INDEX_BUILD_BATCH_SIZE on purpose: batch size bounds peak memory (how many full character objects are held
// at once before being inserted and discarded), this bounds read concurrency, and they don't need to move
// together. Measured directly against this install's real character library (not assumed): timing
// concurrency 1/4/8/16/32/64/128 all plateaued at ~195 files/sec once concurrency passed ~4, and raising
// UV_THREADPOOL_SIZE well above its default of 4 didn't move that plateau either - so neither Node's libuv
// threadpool nor this concurrency number was ever the bottleneck at this install's disk, actual I/O throughput
// was. That means there's no real cost to setting this high - it only matters on hardware fast enough that it
// becomes the limiting factor instead of disk, so it's exposed as `performance.characterIndexBuildConcurrency`
// (config.yaml) rather than hardcoded, for exactly that case.
const INDEX_BUILD_READ_CONCURRENCY = getConfigValue('performance.characterIndexBuildConcurrency', 64, 'number');

/**
 * Streams a user's characters off disk in fixed-size batches (see INDEX_BUILD_BATCH_SIZE) instead of returning
 * one array of the whole library, so buildSqliteIndex() below never has to hold more than one batch's worth of
 * full character objects in memory at once. The eager Promise.all-over-everything version this replaces OOM'd
 * this server on a real 24,171-character install (confirmed by reproducing the crash locally) and has no
 * ceiling that helps at real self-hosted-scale libraries far larger than that.
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {AsyncGenerator<object[]>} Batches of full (non-shallow) character objects, each minus `json_data`
 */
async function* readCharacterBatches(directories) {
    const files = fs.readdirSync(directories.characters);
    const pngFiles = files.filter(file => file.endsWith('.png'));
    for (let i = 0; i < pngFiles.length; i += INDEX_BUILD_BATCH_SIZE) {
        const batchFiles = pngFiles.slice(i, i + INDEX_BUILD_BATCH_SIZE);
        const processed = await mapWithConcurrency(batchFiles, INDEX_BUILD_READ_CONCURRENCY, file => processCharacter(file, directories, { shallow: false }));
        const batch = processed.filter(c => c.name);
        // `json_data` (set by processCharacter(), characters.js) is the *raw* original card JSON verbatim - kept
        // around so the character-editor's "raw data" view and a couple of extensions (GroupGreetings) can
        // round-trip fields the app's own schema doesn't model. It's pure waste here though: it duplicates
        // content already present in structured form on the rest of the object (the same description/
        // scenario/etc. text, just also as one giant escaped string), and nothing downstream of a *search*
        // result ever reads it - the /api/characters/all search branch (characters.js) either shallow-trims
        // results before they leave the server (toShallow() never includes json_data) or, for the one real
        // caller today (fetchServerCharacterSearchResults(), script.js), only ever looks at `.avatar`/`.id` to
        // re-rank the client's own already-resident list. Measured on this install's real library: this field
        // alone averages ~25KB per character - dropping it here roughly halves this batch's footprint, on top
        // of an equally large structured copy of the same text.
        for (const character of batch) {
            delete character.json_data;
        }
        yield batch;
    }
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} avatars Every character avatar about to be indexed - fetched once up front so this resolves
 * with two batched sqlite reads total (tag definitions + getEntityTagIdsForMany()) rather than one
 * getCharacterTagIds() call per character, which would turn an index build into N round trips instead of the 2
 * batched reads the old single readTagsData() call effectively was.
 * @returns {Promise<(avatar: string) => string>} A sync closure over the pre-fetched data, resolving a
 * character's tag names (space-joined) - the same `#tags` concept the client's fuzzySearchCharacters() resolves
 * from its in-memory tag_map.
 */
async function makeTagNamesResolver(directories, avatars) {
    const [definitions, assignments] = await Promise.all([
        getTagDefinitions(directories),
        getEntityTagIdsForMany(directories, avatars),
    ]);
    const tagsById = new Map((definitions ?? []).map(tag => [tag.id, tag]));
    return (avatar) => (assignments?.[avatar] ?? [])
        .map(id => tagsById.get(id)?.name)
        .filter(Boolean)
        .join(' ');
}

/**
 * Resolves the search-index-authoritative `fav` value for a character - the db's own `fav` column once a row is
 * tracked (character-metadata-db.js's setCharacterFav()/writeRowSync() doc comments: `fav` is db-authoritative
 * once a row exists, and the fav-toggle write path deliberately never touches the card file), falling back to
 * the card's own embedded `data.extensions.fav` for a character the metadata store hasn't picked up yet - the
 * same fallback characters.js's stampDbFav() uses for the live `/all` route. Without this, a full rebuild or an
 * incremental catch-up would both keep baking in whatever the card file says forever, since fav toggles no
 * longer touch that file at all.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} avatars Every character avatar about to be indexed - fetched once up front, one batched
 * query rather than one per character (same rationale as makeTagNamesResolver() above).
 * @returns {Promise<(character: object) => boolean>} A sync closure over the pre-fetched data.
 */
async function makeFavResolver(directories, avatars) {
    const favById = await getCharacterFavsByIds(directories, avatars);
    return (character) => Object.prototype.hasOwnProperty.call(favById, character.avatar)
        ? favById[character.avatar]
        : Boolean(character.data?.extensions?.fav);
}

/**
 * (Re)builds the persistent on-disk SQLite FTS5 index for a user's characters.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {{ kind: 'native' | 'wasm', openDatabase: (path: string) => import('./sqlite-engine.js').SqliteEngineHandle }} engine
 * The resolved SQLite engine (sqlite-engine.js)
 * @returns {Promise<import('./sqlite-engine.js').SqliteEngineHandle>} The freshly built, open database handle
 */
async function buildSqliteIndex(directories, engine) {
    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    const dbPath = path.join(dbDir, 'characters.db');

    for (const suffix of ['', '-wal', '-shm']) {
        const filePath = dbPath + suffix;
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    const db = engine.openDatabase(dbPath);
    db.exec(`
        CREATE VIRTUAL TABLE cards USING fts5(
            avatar UNINDEXED,
            data UNINDEXED,
            fav UNINDEXED,
            ${BM25_INDEXED_COLUMNS.join(', ')}
        );
    `);

    const avatars = fs.readdirSync(directories.characters).filter(file => file.endsWith('.png'));
    const tagNamesFor = await makeTagNamesResolver(directories, avatars);
    const favFor = await makeFavResolver(directories, avatars);
    const insertSql = `INSERT INTO cards (avatar, data, fav, ${BM25_INDEXED_COLUMNS.join(', ')})
         VALUES (@avatar, @data, @fav, @name, @resolved_tags, @description, @mes_example, @scenario, @personality, @first_mes, @creator_notes, @creator, @tags, @alternate_greetings)`;

    // One insertMany() call - and, per CHECKPOINT_EVERY_N_BATCHES, one checkpoint - per batch, not one giant
    // call/transaction over the whole library: see readCharacterBatches() and the two constants above this
    // function for why. Each batch's rows only need to live long enough for this one insertMany() call; nothing
    // here accumulates across batches.
    let batchIndex = 0;
    for await (const batch of readCharacterBatches(directories)) {
        const rows = batch.map(character => ({
            avatar: character.avatar,
            data: JSON.stringify(character),
            // db-authoritative via favFor() (falls back to the card's own embedded fav only for an untracked
            // character - see makeFavResolver()'s doc comment). SQLite has no real boolean type, so this stores
            // 0/1 for the plain `AND fav = 1` predicate querySqliteIndex()/countSqliteIndexMatches() add when
            // favOnly is set.
            fav: favFor(character) ? 1 : 0,
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
        }));
        db.insertMany(insertSql, rows);

        batchIndex++;
        if (batchIndex % CHECKPOINT_EVERY_N_BATCHES === 0) {
            db.checkpoint();
        }
    }

    // Final checkpoint (native engine only - see sqlite-engine.js on why the wasm engine's checkpoint is a
    // no-op) folds back whatever's accumulated in the WAL since the last periodic checkpoint above, so
    // steady-state disk usage after a build reflects the actual index size rather than up to
    // CHECKPOINT_EVERY_N_BATCHES batches' worth more.
    db.checkpoint();

    return db;
}

/** No-op `close()` for a tantivy index handle - this binding has no explicit index-handle-close API, so every
 * function below that produces one of these handles uses this same no-op rather than each defining its own
 * (which previously left `close()`'s actual behavior implicit at each call site). */
const NOOP_CLOSE = () => { /* no explicit close API on this binding's Index */ };

/**
 * One character's tantivy document, factored out so buildTantivyIndex() (full build) and
 * applyIncrementalTantivyChanges() (incremental update) build byte-identical documents from the same inputs -
 * a full rebuild and an incremental catch-up for the same character must never disagree about what its indexed
 * fields are.
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {object} character A full (non-shallow) processed character (processCharacter()'s `shallow: false` shape)
 * @param {(avatar: string) => string} tagNamesFor
 * @param {(character: object) => boolean} favFor Resolves the db-authoritative `fav` value - see
 * makeFavResolver()'s doc comment on why this can't just read `character.data.extensions.fav` directly.
 * @returns {import('@oxdev03/node-tantivy-binding').Document}
 */
function characterToTantivyDoc(tantivy, schema, character, tagNamesFor, favFor) {
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
        // Design doc §5.1's payload shrink: just the id (== the avatar filename, under today's pre-Option-A
        // identity - design doc §2.2), not the full character JSON - see DATA_FIELD's doc comment
        // (tantivy-search.js) for why this is also exactly what qualifies as the delete-by-term key.
        [DATA_FIELD]: character.avatar,
        [FAV_FIELD]: favFor(character),
    }, schema);
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {string} The on-disk directory tantivy persists a user's character index to.
 */
function tantivyIndexDir(directories) {
    return path.join(directories.root, 'search-index', 'characters-tantivy');
}

/**
 * (Re)builds the persistent on-disk tantivy index for a user's characters FROM SCRATCH - the tantivy-tier
 * equivalent of buildSqliteIndex() above, reusing the exact same batched-read discipline
 * (readCharacterBatches(), INDEX_BUILD_BATCH_SIZE/INDEX_BUILD_READ_CONCURRENCY/CHECKPOINT_EVERY_N_BATCHES) for
 * the same OOM-avoidance reasons documented on those constants - a tantivy IndexWriter can still accumulate an
 * unbounded amount of unflushed state if fed the entire library in one go, so periodic writer.commit() calls
 * here play the same role periodic db.checkpoint() calls do for the SQLite tier.
 *
 * NOT the default response to staleness anymore (design doc §3.2/§3.3 item 3) - loadOrUpdateTantivyIndex()
 * below only falls back to this when there's nothing to incrementally update from (no persisted index, a
 * truncated change log, or a corrupt/unreadable persisted index), or when rebuildCharacterSearchIndex()'s
 * explicit repair endpoint asks for it directly. Records the change-log rev and tags_rev in effect *before*
 * scanning the directory (not after) as the "caught up to" watermark, so a write landing mid-build is treated as
 * a change still pending for the next incremental pass rather than silently missed.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy The resolved tantivy module (tantivy-engine.js)
 * @returns {Promise<{ index: import('@oxdev03/node-tantivy-binding').Index, schema: import('@oxdev03/node-tantivy-binding').Schema, close: () => void, lastRev: number | null, lastTagsRev: number | null }>}
 * The freshly built, open index handle, plus the rev/tagsRev watermark it was built against (`null` if the
 * metadata store was unavailable at the time - matches getFreshnessSignature()'s own fallback).
 */
async function buildTantivyIndex(directories, tantivy) {
    const lastRev = await getCurrentRev(directories);
    const lastTagsRev = await getTagsRevision(directories);

    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    const indexDir = tantivyIndexDir(directories);
    fs.rmSync(indexDir, { recursive: true, force: true });
    fs.mkdirSync(indexDir, { recursive: true });

    const schema = buildTantivySchema(tantivy, BM25_INDEXED_COLUMNS);
    const index = new tantivy.Index(schema, indexDir, false);
    const writer = index.writer();

    const avatars = fs.readdirSync(directories.characters).filter(file => file.endsWith('.png'));
    const tagNamesFor = await makeTagNamesResolver(directories, avatars);
    const favFor = await makeFavResolver(directories, avatars);

    let batchIndex = 0;
    for await (const batch of readCharacterBatches(directories)) {
        for (const character of batch) {
            writer.addDocument(characterToTantivyDoc(tantivy, schema, character, tagNamesFor, favFor));
        }

        batchIndex++;
        if (batchIndex % CHECKPOINT_EVERY_N_BATCHES === 0) {
            writer.commit();
        }
    }

    writer.commit();
    index.reload();
    // Releases this writer's exclusive on-disk lock deterministically (see this module's header note above on
    // why this matters). This binding's IndexWriter has no explicit close/drop - the underlying Rust lock guard
    // only releases when the writer is actually dropped, which for a napi wrapper otherwise means "whenever V8
    // happens to GC the JS object", not "when this function returns". `commit()` alone does NOT release it -
    // confirmed by direct reproduction: a second `index.writer()` call on this same `index` object, immediately
    // after a first commit with no `waitMergingThreads()` in between, reliably throws "Failed to acquire
    // Lockfile: LockBusy" (the process's own prior writer still holds it) - which is exactly what
    // applyIncrementalTantivyChanges() below does on every catch-up call against a `previous.index` handle this
    // function (or an earlier catch-up) already wrote through. `waitMergingThreads()` takes tantivy's
    // IndexWriter by value in the underlying Rust API (joins background merge threads, then drops it), so this
    // is the one binding-exposed call that actually finalizes and releases the lock on a predictable schedule.
    writer.waitMergingThreads();

    if (lastRev !== null) {
        await setMetaValue(directories, TANTIVY_INDEX_REV_META_KEY, String(lastRev));
        await setMetaValue(directories, TANTIVY_INDEX_TAGS_REV_META_KEY, String(lastTagsRev ?? 0));
    }

    return { index, schema, close: NOOP_CLOSE, lastRev, lastTagsRev };
}

/**
 * Applies every character change since `sinceRev` (design doc §3.3 item 3's "a changed card is one
 * delete-plus-add, not a rebuild") to an already-open tantivy index/writer, in place - the incremental
 * alternative to buildTantivyIndex()'s full rescan. Delete-then-add for every touched id, including updates
 * (not just genuine deletes): tantivy has no update-in-place (design doc §3's probe finding), so a changed row
 * costs exactly the same as a new one either way.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Index} index An already-open index (freshly built this
 * process, or reopened via `Index.open()` - either way, safe to mutate directly).
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {number | null} sinceRev The rev this index was last caught up to, or `null`/non-finite to mean "assume
 * nothing" (the first incremental pass after a fresh full build already covers everything up to its own
 * `lastRev`, so this is normally a real number, not `null`, in practice).
 * @param {number} sinceTagsRev The tags_rev this index was last caught up to.
 * @returns {Promise<{ lastRev: number, lastTagsRev: number } | null>} The new watermark, or `null` if incremental
 * maintenance isn't possible right now (metadata store unavailable, or the change log was pruned past `sinceRev`
 * - `truncated: true`, not implemented as of phase 1, but this function is already correct against it) - the
 * caller (loadOrUpdateTantivyIndex()) must fall back to a full rebuild in that case.
 */
async function applyIncrementalTantivyChanges(directories, tantivy, index, schema, sinceRev, sinceTagsRev) {
    const currentRev = await getCurrentRev(directories);
    const currentTagsRev = await getTagsRevision(directories);
    if (currentRev === null) {
        return null;
    }

    const changesResult = await getChangesSince(directories, Number.isFinite(sinceRev) ? sinceRev : 0);
    if (!changesResult || changesResult.truncated) {
        return null;
    }

    /** @type {Map<string, 'upsert'|'delete'>} */
    const idsToReindex = new Map(changesResult.changes.map(({ id, op }) => [id, op]));

    // A tag *rename* (a tags.js definition edit, not an assignment change) bumps tags_rev without producing any
    // `changes` row naming the characters whose indexed resolved_tags text it affects - see this module's header.
    if (currentTagsRev !== sinceTagsRev) {
        const taggedIds = await getAllTaggedCharacterIds(directories);
        for (const id of taggedIds ?? []) {
            if (!idsToReindex.has(id)) {
                idsToReindex.set(id, 'upsert');
            }
        }
    }

    if (idsToReindex.size > 0) {
        const writer = index.writer();
        const idsNeedingData = [...idsToReindex.entries()].filter(([, op]) => op !== 'delete').map(([id]) => id);
        const tagNamesFor = idsNeedingData.length > 0 ? await makeTagNamesResolver(directories, idsNeedingData) : () => '';
        const favFor = idsNeedingData.length > 0 ? await makeFavResolver(directories, idsNeedingData) : () => false;

        for (const [id, op] of idsToReindex) {
            writer.deleteDocumentsByTerm(DATA_FIELD, id);
            if (op === 'delete') {
                continue;
            }
            let character = null;
            try {
                character = await processCharacter(id, directories, { shallow: false });
            } catch {
                // File gone (raced a delete that hasn't reached the metadata store's write hook/reconciler yet,
                // or a corrupt PNG) - leave it deleted above rather than throwing the whole incremental pass away.
            }
            if (!character?.name) {
                continue;
            }
            writer.addDocument(characterToTantivyDoc(tantivy, schema, character, tagNamesFor, favFor));
        }

        writer.commit();
        index.reload();
        // Releases this writer's lock before it's possible for a later call (another incremental catch-up
        // against this same long-lived `index` handle, or a background rebuild racing in - see
        // search-index-coordinator.js) to request a new one - see buildTantivyIndex()'s matching comment for why
        // `commit()` alone leaves the lock held.
        writer.waitMergingThreads();
    }

    return { lastRev: currentRev, lastTagsRev: currentTagsRev ?? 0 };
}

/**
 * The `build` callback passed to indexCoordinator.getIndex() for the tantivy tier - decides between three paths,
 * in order: update an already-open handle in place, reopen a persisted-on-disk handle and catch it up, or fall
 * back to a full rebuild (buildTantivyIndex()). This is what makes staleness resolve to incremental maintenance
 * by default (design doc §3.2's "the existing full-rebuild path stays, demoted to a repair tool") instead of the
 * pre-existing rmSync-and-reparse-everything behavior.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {Awaited<ReturnType<typeof buildTantivyIndex>> | undefined} previous The currently-live handle for this
 * handle's tantivy index, if this process already has one open (see search-index-coordinator.js's `build`
 * param) - `undefined` on a handle's first-ever call this process.
 * @returns {Promise<Awaited<ReturnType<typeof buildTantivyIndex>>>}
 */
async function loadOrUpdateTantivyIndex(directories, tantivy, previous) {
    // No change log to incrementally read from at all (metadata store unavailable) - getFreshnessSignature()'s
    // matching mtime-based fallback means this gets called on *every* directory-mtime change in that state, and
    // a full rebuild is the only thing that can possibly be correct without a change log.
    if (await getCurrentRev(directories) === null) {
        return buildTantivyIndex(directories, tantivy);
    }

    if (previous?.index) {
        const updated = await applyIncrementalTantivyChanges(directories, tantivy, previous.index, previous.schema, previous.lastRev, previous.lastTagsRev ?? 0);
        if (updated) {
            if (updated.lastRev !== null) {
                await setMetaValue(directories, TANTIVY_INDEX_REV_META_KEY, String(updated.lastRev));
                await setMetaValue(directories, TANTIVY_INDEX_TAGS_REV_META_KEY, String(updated.lastTagsRev));
            }
            return { ...previous, ...updated };
        }
    } else {
        const indexDir = tantivyIndexDir(directories);
        const persistedRev = await getMetaValue(directories, TANTIVY_INDEX_REV_META_KEY);
        if (persistedRev !== null) {
            try {
                if (tantivy.Index.exists(indexDir)) {
                    const index = tantivy.Index.open(indexDir);
                    const schema = index.schema;
                    const persistedTagsRev = Number((await getMetaValue(directories, TANTIVY_INDEX_TAGS_REV_META_KEY)) ?? 0);
                    const updated = await applyIncrementalTantivyChanges(directories, tantivy, index, schema, Number(persistedRev), persistedTagsRev);
                    if (updated) {
                        await setMetaValue(directories, TANTIVY_INDEX_REV_META_KEY, String(updated.lastRev));
                        await setMetaValue(directories, TANTIVY_INDEX_TAGS_REV_META_KEY, String(updated.lastTagsRev));
                        return { index, schema, close: NOOP_CLOSE, ...updated };
                    }
                }
            } catch (err) {
                console.error(color.red('[search] failed to reopen the persisted character tantivy index for incremental update, falling back to a full rebuild:'));
                console.error(color.red(`[search]   ${err.message}`));
            }
        }
    }

    // Nothing to incrementally update from (first-ever build, a truncated change log, or a reopen that failed) -
    // buildTantivyIndex() itself persists the new rev/tagsRev watermark.
    return buildTantivyIndex(directories, tantivy);
}

/**
 * The AND-by-default rationale for multi-word queries is documented in search-query.js; the specific numbers it
 * was measured against: a search for "vampire romance" OR-combined matched 11,101 of 24,171 cards (worthless as
 * a filter), AND-combined matched 315 (a result set someone could actually use). Known tradeoff: FTS5 prefix
 * matching (buildFtsQuery(), search-query.js) handles partial words (typing-in-progress) but not misspellings.
 * @param {import('./sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} searchTerm
 * @param {number} [maxRows] Caps how many matching rows get fetched *and JSON.parse()'d* here. Without this, a
 * broad/short query (a single letter typed while typing, for instance) can prefix-match most of a large
 * library - every one of those rows' full character JSON then gets pulled off disk and parsed into a JS object
 * regardless of how small a page the caller actually wants, *before* pagination slicing (paginateSearchResults()
 * in characters.js) ever runs. That unbounded parse - not the final response serialization - is what actually
 * OOM'd this server on a real 24,171-character install (confirmed by reproducing it: the crash's V8 stack was
 * inside JsonParser, not JsonStringifier, i.e. this line, not response.send()). Left undefined only for a
 * caller that genuinely wants every match - none currently do.
 * @param {boolean} [favOnly] When true, adds `AND fav = 1` to the WHERE clause - see the `favOnly` doc on
 * buildSearchQuery() (tantivy-search.js) for why this has to be a query-level predicate (applied before
 * `LIMIT`), not a post-fetch filter over the already-capped page: a favorited row can rank arbitrarily far below
 * `maxRows` other, more textually-relevant rows, so filtering after the LIMIT would silently miss it.
 * @returns {{ item: object, score: number }[]} Results sorted best-first (ascending bm25 score - lower is
 * better, same convention the rest of this codebase's search results already use)
 */
function querySqliteIndex(db, searchTerm, maxRows, favOnly) {
    const ftsQuery = buildFtsQuery(searchTerm, FIELD_LABELS);
    if (!ftsQuery) {
        return [];
    }
    const weightsArg = BM25_WEIGHTS.join(', ');
    // maxRows is always a value this module computed via Number.isFinite + Math.trunc (see searchCharacters()),
    // never raw request input, so interpolating it directly is safe - it can only ever be digits/a minus sign.
    const limitClause = Number.isFinite(maxRows) ? ` LIMIT ${Math.max(0, Math.trunc(maxRows))}` : '';
    const favClause = favOnly ? ' AND fav = 1' : '';
    return db.query(`SELECT avatar, data, bm25(cards, ${weightsArg}) as score FROM cards WHERE cards MATCH ?${favClause} ORDER BY score${limitClause}`, ftsQuery)
        .map(row => ({ item: JSON.parse(row.data), score: row.score }));
}

/**
 * Counts how many rows match a query, independent of `maxRows`'s cap on `querySqliteIndex()` above - that cap
 * exists to bound how many *full character rows* get fetched and JSON.parse()'d (see that function's doc
 * comment), but a client paginating results still needs the real total match count (e.g. "showing 50 of 315")
 * even when it's well past whatever page it actually requested. FTS5's COUNT(*) is index-only - no row data is
 * read or parsed - so this stays cheap regardless of how many rows match.
 * @param {import('./sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} searchTerm
 * @param {boolean} [favOnly] Same `AND fav = 1` predicate as querySqliteIndex() above, kept in sync so the
 * reported total matches what querySqliteIndex() with the same favOnly value would actually return.
 * @returns {number} Total number of matching rows
 */
function countSqliteIndexMatches(db, searchTerm, favOnly) {
    const ftsQuery = buildFtsQuery(searchTerm, FIELD_LABELS);
    if (!ftsQuery) {
        return 0;
    }
    const favClause = favOnly ? ' AND fav = 1' : '';
    const [row] = db.query(`SELECT COUNT(*) as total FROM cards WHERE cards MATCH ?${favClause}`, ftsQuery);
    return row ? Number(row.total) : 0;
}

/**
 * Fuzzy-searches a user's characters, rebuilding the persistent index first if it's missing or stale. Resolves
 * the full search engine chain via resolveSearchEngine() (search-engine.js) - tantivy first, falling back to
 * SQLite FTS5 (native better-sqlite3, then WebAssembly node-sqlite3-wasm) if tantivy's native binding isn't
 * usable on this install.
 *
 * The returned `backend` field lets callers (see the /api/characters/all handler in characters.js) tell the
 * client which engine actually served a given search - the client surfaces that as a visible indicator whenever
 * it's not the best available tier ('tantivy'), since every fallback tier below it is measurably slower (the
 * SQLite tiers are otherwise behaviorally identical to each other - same ranking, same `label:query` support -
 * see sqlite-engine.js), and 'unavailable' means search produced no results because nothing usable could be
 * loaded, not because the query didn't match anything. Nothing about a degraded-but-still-200-OK response would
 * otherwise reveal any of that to whoever's looking at an empty or slow result list.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @param {number} [maxRows] Caps how many matching ids get fetched - see querySqliteIndex()'s doc comment for
 * the SQLite tier's rationale. For the tantivy tier this is now (design doc §5.1's payload shrink) a cap on bare
 * id strings, not full-JSON hits, so it's cheap to size generously - see SEARCH_ID_CAP.
 * @param {boolean} [favOnly] When true, restricts matches to favorited characters only, applied inside the query
 * itself (not after `maxRows` truncates the page) - see buildSearchQuery()'s `favOnly` doc comment
 * (tantivy-search.js) for why a post-fetch filter here would be wrong: it lets the caller's own client-side
 * favorites filter (FilterHelper.favFilter(), public/scripts/filters.js) actually work when combined with a
 * search term, instead of only ever narrowing whichever relevance-ranked page happened to survive the cap.
 * @returns {Promise<{ hits: { id: string, score: number }[], total: number, backend: 'tantivy' | 'native' | 'wasm' | 'unavailable' }>}
 * `hits` sorted best-first (ascending score - see tantivy-search.js's runSearch() for why the tantivy tier's
 * naturally-higher-is-better score gets negated to match this convention), the true total match count
 * (independent of `maxRows`), and which engine tier produced them.
 */
async function runIdSearch(handle, directories, searchTerm, maxRows, favOnly) {
    const signature = await getFreshnessSignature(directories);
    const engine = await resolveSearchEngine();

    if (engine.tier === 'unavailable') {
        return { hits: [], total: 0, backend: 'unavailable' };
    }

    if (engine.tier === 'tantivy') {
        const tantivyIndex = await indexCoordinator.getIndex(handle, signature, (previous) => loadOrUpdateTantivyIndex(directories, engine.tantivy, previous));
        const query = buildTantivyQuery(engine.tantivy, tantivyIndex.schema, searchTerm, TANTIVY_FIELD_WEIGHTS, TANTIVY_FIELD_LABELS, { favOnly });
        if (!query) {
            return { hits: [], total: 0, backend: 'tantivy' };
        }
        const boundedMaxRows = Number.isFinite(maxRows) ? maxRows : DEFAULT_TANTIVY_MAX_ROWS;
        const { results, total } = runTantivySearch(tantivyIndex.index, query, boundedMaxRows);
        // DATA_FIELD now stores just the id (design doc §5.1) - `raw` *is* the id, nothing to parse.
        return { hits: results.map(r => ({ id: r.raw, score: r.score })), total, backend: 'tantivy' };
    }

    const db = await indexCoordinator.getIndex(handle, signature, () => buildSqliteIndex(directories, engine.sqlite));
    const results = querySqliteIndex(db, searchTerm, maxRows, favOnly);
    return {
        hits: results.map(r => ({ id: r.item.avatar, score: r.score })),
        total: countSqliteIndexMatches(db, searchTerm, favOnly),
        backend: engine.sqlite.kind,
    };
}

/**
 * Fuzzy-searches a user's characters and resolves each match's full character data - the pre-existing contract
 * `/api/characters/all`'s search branch (characters.js) relies on. Built on runIdSearch() (above) plus a
 * resolution step that didn't used to be necessary: before design doc §5.1's payload shrink, a tantivy hit
 * already carried the full character JSON; now it's just an id, so this resolves each matched id's full
 * character data itself, via processCharacter()'s own mtime-keyed cache (characters.js) - cheap for anything
 * unchanged since the index was built, and bounded to at most `maxRows` reads regardless of library size, not a
 * per-request full-library scan (design doc §3.3's "read and parse once per change event, never once per
 * request" - a cache hit here pays neither cost).
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @param {number} [maxRows] Forwarded to runIdSearch() - see that function's doc comment. Callers should always
 * pass this (the /api/characters/all handler in characters.js passes offset+limit, sized to cover whatever page
 * it's about to slice out of the merged character+group results).
 * @param {boolean} [favOnly] Forwarded to runIdSearch() - see that function's doc comment.
 * @returns {Promise<{ results: { item: object, score: number }[], total: number, backend: 'tantivy' | 'native' | 'wasm' | 'unavailable' }>}
 * Results sorted best-first, the true total match count (independent of `maxRows`), and which engine tier
 * produced them. A matched id whose character data can no longer be resolved (deleted since the index was last
 * caught up, or a corrupt/unreadable card) is silently dropped, the same way readCharacterBatches() already
 * drops any character missing `.name`.
 */
export async function searchCharacters(handle, directories, searchTerm, maxRows, favOnly) {
    const { hits, total, backend } = await runIdSearch(handle, directories, searchTerm, maxRows, favOnly);
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

/**
 * Fuzzy-searches a user's characters and returns just the matched ids, in relevance order - the id-only
 * counterpart to searchCharacters() above, for a caller that resolves rows itself instead of needing full
 * character data back (design doc §5's "push the FTS hit-id set into SQLite as a temporary table and let SQLite
 * do the filtering and ordering" composition plan - `POST /api/characters/query`'s `filter.search` handling,
 * characters.js, is the first caller). No per-hit disk read here at all, unlike searchCharacters() - the whole
 * point of this variant.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @param {number} [maxRows] Forwarded to runIdSearch() - see that function's doc comment and SEARCH_ID_CAP for
 * how a caller that needs the *whole* matched set (not just a relevance-ranked page of it - e.g. sort:'random'
 * combined with filter.search, design doc §5.3 decision 23) should size this.
 * @param {boolean} [favOnly] Forwarded to runIdSearch() - see that function's doc comment.
 * @returns {Promise<{ ids: string[], total: number, backend: 'tantivy' | 'native' | 'wasm' | 'unavailable' }>}
 * `ids` in relevance order (best match first), the true total match count (independent of `maxRows`), and which
 * engine tier produced them.
 */
export async function searchCharacterIds(handle, directories, searchTerm, maxRows, favOnly) {
    const { hits, total, backend } = await runIdSearch(handle, directories, searchTerm, maxRows, favOnly);
    return { ids: hits.map(hit => hit.id), total, backend };
}

/**
 * Forces an immediate, blocking, full rebuild of a user's character search index, regardless of the current
 * freshness signature - design doc §3.2's explicit repair endpoint ("the existing full-rebuild path stays,
 * demoted to a repair tool behind an explicit endpoint rather than something a directory mtime change can
 * trigger implicitly"). Wired to `POST /api/characters/search-index/rebuild` (characters.js). Not needed for
 * correctness in normal operation - loadOrUpdateTantivyIndex() already falls back to a full rebuild whenever
 * incremental maintenance genuinely can't proceed - this exists for an owner who wants to force one anyway (a
 * corrupted index suspected, or recovering from an incident) without waiting for the next staleness check.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Promise<{ ok: boolean, backend: 'tantivy' | 'native' | 'wasm' | 'unavailable' }>}
 */
export async function rebuildCharacterSearchIndex(handle, directories) {
    const engine = await resolveSearchEngine();
    if (engine.tier === 'unavailable') {
        return { ok: false, backend: 'unavailable' };
    }

    const signature = await getFreshnessSignature(directories);
    if (engine.tier === 'tantivy') {
        await indexCoordinator.forceRebuild(handle, signature, () => buildTantivyIndex(directories, engine.tantivy));
        return { ok: true, backend: 'tantivy' };
    }

    await indexCoordinator.forceRebuild(handle, signature, () => buildSqliteIndex(directories, engine.sqlite));
    return { ok: true, backend: engine.sqlite.kind };
}
