import fs from 'node:fs';
import path from 'node:path';

import { getTagDefinitions, getEntityTagIdsForMany, getTagsRevision } from '../character-metadata-db.js';
import { processCharacter } from './characters.js';
import { buildFtsQuery } from './search-query.js';
import { buildSchema as buildTantivySchema, buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch, DATA_FIELD, FAV_FIELD } from './tantivy-search.js';
import { resolveSearchEngine } from './search-engine.js';
import { createIndexCoordinator } from './search-index-coordinator.js';
import { getConfigValue, mapWithConcurrency } from '../util.js';

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
 * tag definition/assignment changes (getTagsRevision() - see character-metadata-db.js - replaces the old
 * tags.json-mtime half of this signature now that tags.json is gone)
 */
async function getFreshnessSignature(directories) {
    const charDirMtime = fs.statSync(directories.characters).mtimeMs;
    const tagsRev = await getTagsRevision(directories);
    return `${charDirMtime}:${tagsRev}`;
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
            // Boolean, not the string this codebase's fav flag is sometimes coerced from elsewhere (see
            // character-card-normalize.js) - SQLite has no real boolean type, so this stores 0/1 for the plain
            // `AND fav = 1` predicate querySqliteIndex()/countSqliteIndexMatches() add when favOnly is set.
            fav: character.data?.extensions?.fav ? 1 : 0,
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

/**
 * (Re)builds the persistent on-disk tantivy index for a user's characters - the tantivy-tier equivalent of
 * buildSqliteIndex() above, reusing the exact same batched-read discipline (readCharacterBatches(),
 * INDEX_BUILD_BATCH_SIZE/INDEX_BUILD_READ_CONCURRENCY/CHECKPOINT_EVERY_N_BATCHES) for the same OOM-avoidance
 * reasons documented on those constants - a tantivy IndexWriter can still accumulate an unbounded amount of
 * unflushed state if fed the entire library in one go, so periodic writer.commit() calls here play the same role
 * periodic db.checkpoint() calls do for the SQLite tier.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy The resolved tantivy module (tantivy-engine.js)
 * @returns {Promise<{ index: import('@oxdev03/node-tantivy-binding').Index, schema: import('@oxdev03/node-tantivy-binding').Schema, close: () => void }>}
 * The freshly built, open index handle - `close()` is a no-op (this binding has no explicit index-handle-close
 * API; the coordinator's swap-and-close still calls it via optional chaining, this just makes the no-op explicit
 * instead of relying on that chaining silently skipping a missing method).
 */
async function buildTantivyIndex(directories, tantivy) {
    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    const indexDir = path.join(dbDir, 'characters-tantivy');
    fs.rmSync(indexDir, { recursive: true, force: true });
    fs.mkdirSync(indexDir, { recursive: true });

    const schema = buildTantivySchema(tantivy, BM25_INDEXED_COLUMNS);
    const index = new tantivy.Index(schema, indexDir, false);
    const writer = index.writer();

    const avatars = fs.readdirSync(directories.characters).filter(file => file.endsWith('.png'));
    const tagNamesFor = await makeTagNamesResolver(directories, avatars);

    let batchIndex = 0;
    for await (const batch of readCharacterBatches(directories)) {
        for (const character of batch) {
            const doc = tantivy.Document.fromDict({
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
                [DATA_FIELD]: JSON.stringify(character),
                [FAV_FIELD]: Boolean(character.data?.extensions?.fav),
            }, schema);
            writer.addDocument(doc);
        }

        batchIndex++;
        if (batchIndex % CHECKPOINT_EVERY_N_BATCHES === 0) {
            writer.commit();
        }
    }

    writer.commit();
    index.reload();

    return { index, schema, close: () => { /* no explicit close API on this binding's Index - see doc comment above */ } };
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
 * @param {number} [maxRows] Caps how many matching rows/docs get fetched and JSON.parse()'d - see
 * querySqliteIndex()'s doc comment for the full rationale (the OOM this guards against is real, not
 * hypothetical, and applies just as much to the tantivy tier's per-hit JSON.parse() of the stored `data` field).
 * Callers should always pass this (the /api/characters/all handler in characters.js passes offset+limit, sized
 * to cover whatever page it's about to slice out of the merged character+group results).
 * @param {boolean} [favOnly] When true, restricts matches to favorited characters only, applied inside the query
 * itself (not after `maxRows` truncates the page) - see buildSearchQuery()'s `favOnly` doc comment
 * (tantivy-search.js) for why a post-fetch filter here would be wrong: it lets the caller's own client-side
 * favorites filter (FilterHelper.favFilter(), public/scripts/filters.js) actually work when combined with a
 * search term, instead of only ever narrowing whichever relevance-ranked page happened to survive the cap.
 * @returns {Promise<{ results: { item: object, score: number }[], total: number, backend: 'tantivy' | 'native' | 'wasm' | 'unavailable' }>}
 * Results sorted best-first (ascending score - see tantivy-search.js's runSearch() for why the tantivy tier's
 * naturally-higher-is-better score gets negated to match this convention), the true total match count
 * (independent of `maxRows`), and which engine tier produced them.
 */
export async function searchCharacters(handle, directories, searchTerm, maxRows, favOnly) {
    const signature = await getFreshnessSignature(directories);
    const engine = await resolveSearchEngine();

    if (engine.tier === 'unavailable') {
        return { results: [], total: 0, backend: 'unavailable' };
    }

    if (engine.tier === 'tantivy') {
        const tantivyIndex = await indexCoordinator.getIndex(handle, signature, () => buildTantivyIndex(directories, engine.tantivy));
        const query = buildTantivyQuery(engine.tantivy, tantivyIndex.schema, searchTerm, TANTIVY_FIELD_WEIGHTS, TANTIVY_FIELD_LABELS, { favOnly });
        if (!query) {
            return { results: [], total: 0, backend: 'tantivy' };
        }
        const boundedMaxRows = Number.isFinite(maxRows) ? maxRows : DEFAULT_TANTIVY_MAX_ROWS;
        const { results, total } = runTantivySearch(tantivyIndex.index, query, boundedMaxRows);
        return { results, total, backend: 'tantivy' };
    }

    const db = await indexCoordinator.getIndex(handle, signature, () => buildSqliteIndex(directories, engine.sqlite));
    return {
        results: querySqliteIndex(db, searchTerm, maxRows, favOnly),
        total: countSqliteIndexMatches(db, searchTerm, favOnly),
        backend: engine.sqlite.kind,
    };
}
