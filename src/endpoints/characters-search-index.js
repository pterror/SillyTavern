import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
    getTagDefinitions, getEntityTagIdsForMany, getTagsHash,
    getChangesSince, getCurrentSeq, getAllTaggedCharacterIds, getMetaValue, setMetaValue,
    getCharacterFavsByIds,
} from '../character-metadata-db.js';
import { processCharacter } from './characters.js';
import { buildSchema as buildTantivySchema, buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch, DATA_FIELD, FAV_FIELD, buildTagFilterQuery, buildExcludeIdsQuery } from './tantivy-search.js';
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
 * TANTIVY IS NOW THE ONLY ENGINE, THERE IS NO FALLBACK TIER: FTS5's MATCH cost scales with a term's
 * posting-list size, not result-set size - measured a single common word ("the") at ~78ms against this install's
 * real library, and getting *worse*, not staying flat, as the library grows. Tantivy (see tantivy-engine.js,
 * tantivy-search.js) measured a flat 0-1ms for the same shape of query regardless of term commonality - a real
 * inverted-index search engine rather than a general relational engine with FTS bolted on. search-engine.js now
 * resolves either the tantivy tier or 'unavailable' - the SQLite FTS5 tier this module used to fall back to (a
 * native better-sqlite3 engine, or a WebAssembly one on platforms without a native binding available) has been
 * removed now that tantivy covers every platform this fallback used to exist for.
 *
 * Freshness is checked cheaply (a characters-directory stat() plus getTagsHash(),
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
 * - "FULL REBUILD" IS NOT A SEPARATE CODE PATH ANYMORE: a first-ever index build is just incremental maintenance
 *   starting from an empty index at rev 0/tagsRev 0 - getChangesSince(directories, 0) already returns the entire
 *   library as `op: 'upsert'` entries per its own documented contract, so running
 *   applyIncrementalTantivyChanges() against a brand-new empty index with sinceRev=0 IS a full build, through the
 *   exact same code that handles every later incremental catch-up. rebuildTantivyIndexFromScratch() below is that
 *   "fresh empty index + incremental-from-rev-0" sequence, factored into one shared helper, because it turns out
 *   to be needed in three places that used to each think of themselves as doing something different: a genuinely
 *   fresh install (nothing persisted yet), recovering from a persisted index that can't be trusted (corrupt, or -
 *   now - a schema-version mismatch, see openPersistedTantivyIndexStale()), and rebuildCharacterSearchIndex()'s
 *   explicit owner-triggered repair endpoint. All three are really asking for the same thing: "throw away
 *   whatever's on disk and build a guaranteed-correct index" - none of them need a bespoke full-scan
 *   implementation to get it. Every fresh build goes through an atomic build-into-a-temp-directory-then-swap
 *   (see rebuildTantivyIndexFromScratch()'s and buildTantivyIndexFromFilesystemScan()'s own doc comments) rather
 *   than wiping the real index directory in place, so a build that fails partway never leaves a half-written or
 *   missing index where a previously-working one used to be.
 * - THE ONE GENUINE EXCEPTION: buildTantivyIndexFromFilesystemScan() below - a full filesystem scan
 *   (readCharacterBatches()) reading character PNGs directly off disk, the same shape this module always used for
 *   character data. This can't be expressed as "incremental from rev 0" because it doesn't go through
 *   applyIncrementalTantivyChanges() at all: that function (and therefore rebuildTantivyIndexFromScratch()) reads
 *   getChangesSince(), which depends on the phase-1 metadata store - so when that store itself is unavailable
 *   (getCurrentSeq() returns `null`), there is no change log to be incremental against, full stop, regardless of
 *   starting seq. This is loadOrUpdateTantivyIndex()'s narrow top-of-function fallback, not something any of the
 *   three cases above ever need.
 * - REPAIR, NOT DEFAULT: rebuildCharacterSearchIndex() (exported below) is the only remaining caller of a genuine
 *   full rebuild for characters, wired to an explicit `POST /api/characters/search-index/rebuild` endpoint
 *   (characters.js) - a directory-mtime change (or, now, any content/tag change at all) can no longer trigger
 *   one implicitly. The very first index build for a fresh install still has to be a full pass (nothing to
 *   incrementally update from), and a persisted-index reopen that fails for any reason (corrupt directory, a
 *   schema-version mismatch, a truncated change log with nothing incremental to catch up from) also falls back to
 *   a full rebuild - both are loadOrUpdateTantivyIndex()'s job, not something a caller has to know to ask for
 *   separately.
 */

// Column order/weights mirror fuzzySearchCharacters() in public/scripts/power-user.js (and this file's
// original Fuse-based version) so a result ranks similarly to what the same term produced there.
const BM25_INDEXED_COLUMNS = ['name', 'resolved_tags', 'description', 'mes_example', 'scenario', 'personality', 'first_mes', 'creator_notes', 'creator', 'tags', 'alternate_greetings'];
const BM25_WEIGHTS = [20, 10, 3, 3, 2, 2, 2, 2, 1, 1, 1];

// Unsigned fast fields for native tantivy sorting (orderByField) - these numeric metadata columns
// are stored as columnar data in the tantivy index so search results can be sorted by them directly,
// without materializing the full match set and round-tripping it through SQLite for ORDER BY.
const TANTIVY_FAST_FIELDS = ['create_date', 'date_added', 'date_last_chat', 'chat_size', 'data_size'];

// Additional fast fields for sorts that need a numeric collation key rather than a real column value.
// name_sort_key: first 7 bytes of the lowercased name encoded as a u64, giving correct lexicographic
// order for the vast majority of names (ties broken by tantivy's internal doc ordering, which is stable).
// fav_name_sort_key: bit 63 = inverted fav (0 for favorites, 1 for non-favorites), bits 0-55 = first 7
// bytes of lowercased name. ASC order gives the desired "favorites first, then alphabetical" behavior.
const TANTIVY_COLLATION_FIELDS = ['name_sort_key', 'fav_name_sort_key'];
const ALL_FAST_FIELDS = [...TANTIVY_FAST_FIELDS, ...TANTIVY_COLLATION_FIELDS];

// Whitespace-tokenized text field for structured tag-ID filtering inside tantivy (term queries by
// exact tag UUID, composed with AND/OR/MustNot via buildTagFilterQuery in tantivy-search.js).
const TANTIVY_FILTER_TEXT_FIELDS = [{ name: 'tag_ids', tokenizerName: 'whitespace' }];

const TAG_IDS_FIELD = 'tag_ids';

export const TANTIVY_SORT_FIELDS = new Set([...TANTIVY_FAST_FIELDS, 'name', 'fav']);

// Maps the /query route's sort.field value to the tantivy fast field name used by orderByField.
// Fields not in this map don't have a tantivy fast field equivalent.
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

/**
 * Manually-bumped identifier for the shape of the tantivy schema characterToTantivyDoc() builds documents against
 * (buildTantivySchema(), tantivy-search.js - itself derived from BM25_INDEXED_COLUMNS plus DATA_FIELD/FAV_FIELD).
 * Bump this by hand whenever that shape changes meaningfully enough that a persisted index built under the old
 * shape can no longer be trusted (a field added/removed/retokenized) - same manually-bumped-constant pattern as
 * webpack.config.js's FRONTEND_CACHE_VERSION, and for the same reason: there's no way to derive "is this old index
 * still compatible" automatically from the schema definition alone, so a human has to say so. Persisted alongside
 * a built index (TANTIVY_INDEX_SCHEMA_VERSION_META_KEY below) and checked by openPersistedTantivyIndexStale() -
 * a mismatch there is treated exactly like a corrupt or missing index (nothing usable persisted), which naturally
 * routes into a fresh rebuild the same way those already do, without needing a separate branch anywhere else.
 */
const TANTIVY_SCHEMA_VERSION = 3;

// `label:value` search syntax (see search-query.js) - maps a friendly label to the tantivy field(s) it targets.
// `tag:`/`tags:` searches BOTH tag-ish fields, since BM25_WEIGHTS above already treats resolved_tags (tags.json
// names) and tags (raw embedded card data) as the same "does this character have this tag" concept - a label
// filter should honor that, not just pick one.
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

const indexCoordinator = createIndexCoordinator();

/**
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Promise<string>} A cheap fingerprint that changes whenever a character is added/removed/edited or a
 * tag definition/assignment changes. Prefers the phase-1 metadata store's own change-log high-water mark
 * (getCurrentSeq()) over a directory `statSync`, now that the store exists and tracks exactly this - a `seq`
 * change is a strictly more precise signal (it can't miss a same-mtime-different-content edit, and the
 * reconciler's drift-catching also bumps it, so a mutation that bypassed the write-path hooks still shows up
 * here once the reconciler catches it). Falls back to the old directory-mtime signature only if the metadata
 * store itself is unavailable (`getCurrentSeq()` returns `null` - a broken-SQLite-install edge case distinct
 * from "tantivy works but SQLite doesn't", since tantivy and the metadata store resolve their engines
 * independently) - loadOrUpdateTantivyIndex() below has the matching fallback: without a change log there is
 * nothing to incrementally catch up from, so that state always full-rebuilds.
 */
async function getFreshnessSignature(directories) {
    const tagsHash = await getTagsHash(directories);
    const seq = await getCurrentSeq(directories);
    if (seq === null) {
        const charDirMtime = fs.statSync(directories.characters).mtimeMs;
        return `mtime:${charDirMtime}:${tagsHash}`;
    }
    return `rev:${seq}:${tagsHash}`;
}

// How many characters get read, processed, and inserted into the tantivy index per batch while (re)building
// it. This is a pure memory/throughput knob, not a correctness one - every character still gets
// visited exactly once regardless of batch size. What it bounds is peak memory: readCharacterBatches() below
// never holds more than one batch's worth of full (non-shallow) character objects at a time, so index-build
// memory stays flat as a library grows from thousands of characters to (per this install's owner) a target of
// tens of millions, instead of scaling linearly with total library size the way an eager
// `Promise.all(everyCharacter)` does. 500 is a starting point, not a measured-optimal number - large enough
// that per-batch overhead (one directory-batch of file reads, plus a periodic tantivy writer.commit() - see
// CHECKPOINT_EVERY_N_BATCHES below) stays small relative to the work done, small enough that a batch's worth
// of full character objects (each
// averaging tens of KB of text - see the json_data comment below) is a rounding error against any reasonable
// heap size.
const INDEX_BUILD_BATCH_SIZE = 500;

// Fallback cap on the tantivy tier's maxRows when a caller genuinely omits it - mirrors characters.js's own
// DEFAULT_PAGE_LIMIT. Even though a tantivy hit is now (design doc §5.1's payload shrink) just a bare id, not
// full character JSON, an unbounded fetch is still worth capping: searchCharacters() resolves every hit's full
// character data afterward (processCharacter()), so an uncapped short/broad query prefix-matching most of a
// large library would still mean resolving most of the library's worth of character data for a page the caller
// never asked for.
const DEFAULT_TANTIVY_MAX_ROWS = 500;

// `meta` table keys (character-metadata-db.js's getMetaValue()/setMetaValue()) this module uses to remember
// which change-log rev / tags_rev the on-disk tantivy index was last caught up to - see this module's header on
// why that table, not a second file, holds this. Namespaced with a `tantivy_char_` prefix since `meta` is a flat
// key/value table shared with the metadata store's own bootstrap_completed/tags_rev keys.
const TANTIVY_INDEX_SEQ_META_KEY = 'tantivy_char_index_seq';
const TANTIVY_INDEX_TAGS_HASH_META_KEY = 'tantivy_char_index_tags_hash';
// The TANTIVY_SCHEMA_VERSION a persisted index was built under - see that constant's own doc comment for why this
// exists and how openPersistedTantivyIndexStale() uses it.
const TANTIVY_INDEX_SCHEMA_VERSION_META_KEY = 'tantivy_char_index_schema_version';

// Fallback cap for callers that need the *whole* (or a generous approximation of the whole) matched-id set, not
// just a relevance-ranked page of it - specifically sort:'random' combined with filter.search (design doc §5.3,
// decision 23: "random and search compose unconditionally"), where hash order has no relationship to text
// relevance, so bounding tightly by relevance rank would silently bias which matches are ever reachable under a
// random ordering. This is affordable now in a way it wasn't before the payload shrink: a tantivy hit is a bare
// id string, not a 13KB-mean JSON.parse (DEFAULT_TANTIVY_MAX_ROWS's original OOM concern), so fetching orders
// of magnitude more ids costs orders of magnitude less than fetching that many full rows used to. The /query
// route (characters.js) marks a total as approximate whenever a search itself matched
// more ids than this cap - decision 6 permits an approximate total, never a silently-truncated one.
export const SEARCH_ID_CAP = 50000;

// How many batches to commit before the next one, while (re)building a tantivy index
// (buildTantivyIndexFromFilesystemScan() and applyIncrementalTantivyChanges() below). Committing only once at
// the very end would mean an IndexWriter accumulating an unbounded amount of unflushed state across an entire
// library before ever flushing it - fine at a few thousand characters, not at a target of millions, where
// that's a real multi-gigabyte-plus memory cost, not just an odd transient. This interval is a
// memory-usage/commit-overhead tradeoff, not a correctness knob.
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
 * one array of the whole library, so a tantivy index build never has to hold more than one batch's worth of
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
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} avatars
 * @returns {Promise<(avatar: string) => string>} A sync closure returning space-joined tag IDs for a character.
 */
async function makeTagIdsResolver(directories, avatars) {
    const assignments = await getEntityTagIdsForMany(directories, avatars);
    return (avatar) => (assignments?.[avatar] ?? []).join(' ');
}

/** No-op `close()` for a tantivy index handle - this binding has no explicit index-handle-close API, so every
 * function below that produces one of these handles uses this same no-op rather than each defining its own
 * (which previously left `close()`'s actual behavior implicit at each call site). */
const NOOP_CLOSE = () => { /* no explicit close API on this binding's Index */ };

/**
 * Encodes the first `byteCount` bytes of a lowercased string as an unsigned integer for use as a
 * fast-field sort key. Gives correct lexicographic ordering for names that differ within the first
 * `byteCount` characters; ties are broken by tantivy's stable internal ordering.
 * @param {string} str
 * @param {number} [byteCount=7]
 * @returns {number} A non-negative integer safe for tantivy's unsigned fast field.
 */
function stringToSortKey(str, byteCount = 7) {
    const lower = (str || '').toLowerCase();
    let key = 0;
    for (let i = 0; i < byteCount; i++) {
        key = key * 256 + (i < lower.length ? lower.charCodeAt(i) & 0xFF : 0);
    }
    return key;
}

/**
 * One character's tantivy document, factored out so buildTantivyIndexFromFilesystemScan() (the metadata-store-
 * unavailable full scan) and applyIncrementalTantivyChanges() (incremental update - which is also what every
 * other fresh build now goes through, see rebuildTantivyIndexFromScratch()) build byte-identical documents from
 * the same inputs - a full rebuild and an incremental catch-up for the same character must never disagree about
 * what its indexed fields are.
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {object} character A full (non-shallow) processed character (processCharacter()'s `shallow: false` shape)
 * @param {(avatar: string) => string} tagNamesFor
 * @param {(character: object) => boolean} favFor Resolves the db-authoritative `fav` value - see
 * makeFavResolver()'s doc comment on why this can't just read `character.data.extensions.fav` directly.
 * @returns {import('@oxdev03/node-tantivy-binding').Document}
 */
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
        // Fast fields for native tantivy sorting (see TANTIVY_FAST_FIELDS) - stored as unsigned
        // integers so orderByField can sort on them without round-tripping through SQLite.
        create_date: Math.max(0, Date.parse(character.create_date) || character.date_added || 0),
        date_added: Math.max(0, Number(character.date_added) || 0),
        date_last_chat: Math.max(0, Number(character.date_last_chat) || 0),
        chat_size: Math.max(0, Number(character.chat_size) || 0),
        data_size: Math.max(0, Number(character.data_size) || 0),
        name_sort_key: stringToSortKey(character.data?.name ?? ''),
        fav_name_sort_key: (favFor(character) ? 0 : 1) * (2 ** 48) + stringToSortKey(character.data?.name ?? '', 6),
        tag_ids: tagIdsFor(character.avatar),
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
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {string} A fresh, unique sibling directory to build a new tantivy index into, on the same filesystem
 * as tantivyIndexDir() (both live under `directories.root/search-index`) so swapTantivyIndexIntoPlace() below can
 * move it into place with a single atomic fs.renameSync rather than a cross-filesystem copy.
 */
function tantivyIndexTempDir(directories) {
    return path.join(directories.root, 'search-index', `characters-tantivy.rebuild-${crypto.randomUUID()}`);
}

/**
 * Removes any `characters-tantivy.rebuild-*`/`characters-tantivy.old-*` sibling directories left behind under
 * `directories.root/search-index` - debris from a build-into-temp-then-swap (see swapTantivyIndexIntoPlace() and
 * its callers below) that crashed or was killed mid-build, before the swap that would have cleaned them up ever
 * ran. Run defensively at the start of every fresh build, not just after a crash is suspected - a leftover temp
 * directory costs nothing to remove if there isn't one (fs.rmSync with `force: true` on a nonexistent path is a
 * no-op), and it's cheap insurance against disk usage silently growing across repeated crashed attempts.
 * @param {import('../users.js').UserDirectoryList} directories
 */
function cleanupStaleTantivyRebuildTempDirs(directories) {
    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) {
        return;
    }
    for (const entry of fs.readdirSync(dbDir)) {
        if (entry.startsWith('characters-tantivy.rebuild-') || entry.startsWith('characters-tantivy.old-')) {
            fs.rmSync(path.join(dbDir, entry), { recursive: true, force: true });
        }
    }
}

/**
 * Atomically swaps a freshly-built tantivy index (built into `tempDir` - a sibling of the real index directory
 * produced by tantivyIndexTempDir() above, never the real directory itself) into place at `indexDir`, the path
 * every reader (openPersistedTantivyIndexStale(), tantivy.Index.exists/open) actually looks at. This replaces the
 * old buildTantivyIndex()'s "rmSync the real directory, then rebuild in place" approach specifically so a build
 * that fails or crashes partway through never leaves `indexDir` missing, empty, or half-written where a
 * previously-working persisted index used to be - every caller below finishes building and committing a complete
 * index in `tempDir` *before* this function is ever called, so nothing here can observe or propagate a
 * partial build.
 *
 * The old directory (if any) is moved aside with its own renameSync first, then the new one is renamed into
 * place, then the old one is removed - two renames (both fast, metadata-only operations on the same filesystem)
 * rather than one, so there's never a window where `indexDir` doesn't exist at all while an old, fully-valid
 * index sits under a temporary name instead of just being deleted outright before the new one is confirmed in
 * place.
 * @param {string} indexDir The real, persistent tantivy index directory (tantivyIndexDir()).
 * @param {string} tempDir A fully-built index directory (tantivyIndexTempDir()) ready to become the new `indexDir`.
 */
function swapTantivyIndexIntoPlace(indexDir, tempDir) {
    if (fs.existsSync(indexDir)) {
        const oldDir = `${indexDir}.old-${crypto.randomUUID()}`;
        fs.renameSync(indexDir, oldDir);
        fs.renameSync(tempDir, indexDir);
        fs.rmSync(oldDir, { recursive: true, force: true });
    } else {
        fs.renameSync(tempDir, indexDir);
    }
}

/**
 * Reopens a tantivy `Index` handle at `dir` fresh via `tantivy.Index.open()`, discarding whatever `Index` object a
 * caller built it with. Every fresh-build function below MUST call this on `indexDir` immediately after
 * swapTantivyIndexIntoPlace() and hand back the reopened handle, not the original one it built into `tempDir` -
 * confirmed by direct reproduction: this binding's `Index` object carries the directory path it was constructed
 * with forward into every later operation that needs to re-touch the on-disk lock/segment files (a subsequent
 * `.writer()` call, in particular - exactly what applyIncrementalTantivyChanges() issues on every later
 * incremental catch-up against whatever handle a fresh build returns as the new "live" index). An `Index` built
 * against `tempDir` and then silently moved out from under it by fs.renameSync (the "old-directory-only" half of
 * the point of building into a temp dir at all) keeps pointing at the now-nonexistent `tempDir` path for that
 * later work, so a real fav/search-content update lands on a directory nothing reads from anymore and the caller
 * observes it as "the incremental catch-up silently did nothing" - not an exception, just a change that never
 * takes effect. Reopening at the real, final path here is what keeps every fresh build's returned handle correct
 * for as long as it stays the coordinator's live entry (search-index-coordinator.js), the same way
 * openPersistedTantivyIndexStale()'s own `Index.open()` call already is.
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {string} dir
 * @returns {{ index: import('@oxdev03/node-tantivy-binding').Index, schema: import('@oxdev03/node-tantivy-binding').Schema }}
 */
function reopenTantivyIndexAt(tantivy, dir) {
    const index = tantivy.Index.open(dir);
    return { index, schema: index.schema };
}

/**
 * Creates a brand-new, empty tantivy index at `dir` (which must not already exist as a populated index - callers
 * always pass a freshly-created temp directory) - just the schema-and-Index setup step, factored out because both
 * rebuildTantivyIndexFromScratch() and buildTantivyIndexFromFilesystemScan() below need exactly this before they
 * diverge on how they populate it (incremental-from-rev-0 vs. a raw filesystem scan).
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {string} dir
 * @returns {{ index: import('@oxdev03/node-tantivy-binding').Index, schema: import('@oxdev03/node-tantivy-binding').Schema }}
 */
function createEmptyTantivyIndexAt(tantivy, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const schema = buildTantivySchema(tantivy, BM25_INDEXED_COLUMNS, ALL_FAST_FIELDS, TANTIVY_FILTER_TEXT_FIELDS);
    const index = new tantivy.Index(schema, dir, false);
    return { index, schema };
}

/**
 * Builds a genuinely fresh tantivy index for a user's characters by reading the phase-1 metadata store's own
 * change log from the very beginning (`sinceRev`/`sinceTagsRev` of 0) against a brand-new empty index - the
 * "first-ever index creation is just incremental update from an empty starting state, not conceptually
 * different" idea this module's header describes: getChangesSince(directories, 0) already returns the entire
 * library as `op: 'upsert'` entries per its own documented contract, so applyIncrementalTantivyChanges() run this
 * way IS a full build, through the exact same code path every later incremental catch-up uses - not a second,
 * parallel implementation to keep in sync with it.
 *
 * This is the single shared helper behind every case that needs a genuinely fresh, guaranteed-correct index:
 * loadOrUpdateTantivyIndex()'s fallback when there's nothing to incrementally update an already-open handle from
 * (no persisted index, a corrupt one, or a schema-version mismatch - see openPersistedTantivyIndexStale()), and
 * rebuildCharacterSearchIndex()'s explicit owner-triggered repair endpoint. Both are really asking for the same
 * thing - "throw away whatever's on disk and build a correct index" - so both call this instead of each keeping
 * their own full-rebuild implementation.
 *
 * If the metadata store turns out to be unavailable right now (getCurrentSeq() returns `null`), there is no
 * change log to be incremental against at all, regardless of starting seq - this redirects to
 * buildTantivyIndexFromFilesystemScan() for that case rather than silently building an empty index, so this
 * function stays correct even when called from a context (rebuildCharacterSearchIndex()'s repair endpoint) that
 * doesn't already know whether the store is up.
 *
 * Builds into a temp directory and atomically swaps it into place (swapTantivyIndexIntoPlace()) rather than
 * touching the real index directory until the new one is fully committed and verified-open - see that function's
 * doc comment for why.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy The resolved tantivy module (tantivy-engine.js)
 * @returns {Promise<{ index: import('@oxdev03/node-tantivy-binding').Index, schema: import('@oxdev03/node-tantivy-binding').Schema, close: () => void, lastRev: number | null, lastTagsRev: string | null }>}
 * The freshly built, open index handle, plus the rev/tagsRev watermark it was built against (`null` if the
 * metadata store was unavailable at the time - matches getFreshnessSignature()'s own fallback).
 */
async function rebuildTantivyIndexFromScratch(directories, tantivy) {
    if (await getCurrentSeq(directories) === null) {
        return buildTantivyIndexFromFilesystemScan(directories, tantivy);
    }

    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    cleanupStaleTantivyRebuildTempDirs(directories);

    const indexDir = tantivyIndexDir(directories);
    const tempDir = tantivyIndexTempDir(directories);
    const { index, schema } = createEmptyTantivyIndexAt(tantivy, tempDir);

    // sinceSeq/prevTagsHash of 0 against a brand-new empty index - see this function's own doc comment for why
    // that's a full build, not a special case. `updated` can still come back `null` here if the metadata store
    // went away in between the getCurrentSeq() check above and this call (a narrow race, not the common case) -
    // in that event there's nothing indexed yet in `tempDir`, so falling back to the filesystem-scan path (which
    // starts its own fresh build from scratch) is correct rather than swapping in an empty index.
    const updated = await applyIncrementalTantivyChanges(directories, tantivy, index, schema, 0, null);
    if (!updated) {
        return buildTantivyIndexFromFilesystemScan(directories, tantivy);
    }

    swapTantivyIndexIntoPlace(indexDir, tempDir);
    // Reopen at the real path - see reopenTantivyIndexAt()'s doc comment for why the `index` built into `tempDir`
    // above can't just keep being used after the rename.
    const reopened = reopenTantivyIndexAt(tantivy, indexDir);

    await setMetaValue(directories, TANTIVY_INDEX_SEQ_META_KEY, String(updated.lastSeq));
    await setMetaValue(directories, TANTIVY_INDEX_TAGS_HASH_META_KEY, String(updated.lastTagsHash));
    await setMetaValue(directories, TANTIVY_INDEX_SCHEMA_VERSION_META_KEY, String(TANTIVY_SCHEMA_VERSION));

    return { ...reopened, close: NOOP_CLOSE, lastSeq: updated.lastSeq, lastTagsHash: updated.lastTagsHash };
}

/**
 * Builds a genuinely fresh tantivy index for a user's characters by reading every character PNG directly off disk
 * (readCharacterBatches()) rather than through the phase-1 metadata store's change log - the one case that
 * structurally cannot go through rebuildTantivyIndexFromScratch()/applyIncrementalTantivyChanges() above, because
 * that path depends on getChangesSince(), which depends on the metadata store itself. When the store is
 * unavailable (getCurrentSeq() returns `null`) there is no change log to be incremental against at all, so a raw
 * filesystem scan is the only way to index anything in that state - this is loadOrUpdateTantivyIndex()'s narrow
 * top-of-function fallback, and rebuildTantivyIndexFromScratch()'s own redirect target when it discovers the
 * store went unavailable out from under it.
 *
 * Reuses the same batched-read discipline (readCharacterBatches(), INDEX_BUILD_BATCH_SIZE/
 * INDEX_BUILD_READ_CONCURRENCY/CHECKPOINT_EVERY_N_BATCHES) for the same OOM-avoidance reasons documented on
 * those constants - a tantivy IndexWriter can still accumulate an unbounded amount of unflushed state if fed
 * the entire library in one go, so periodic writer.commit() calls here bound that.
 *
 * Since the metadata store is unavailable whenever this runs, there is no rev/tags_rev to record - the returned
 * watermark is always `null`/`null`, and no meta values get written (setMetaValue() would no-op against an
 * unavailable store anyway, but this function doesn't even try, since there's genuinely nothing valid to persist
 * yet). Still builds into a temp directory and atomically swaps it into place (swapTantivyIndexIntoPlace()) rather
 * than wiping the real index directory in place, for the same partial-build-safety reason every other fresh-build
 * path here does, even though this path is rarer.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy The resolved tantivy module (tantivy-engine.js)
 * @returns {Promise<{ index: import('@oxdev03/node-tantivy-binding').Index, schema: import('@oxdev03/node-tantivy-binding').Schema, close: () => void, lastRev: null, lastTagsRev: null }>}
 * The freshly built, open index handle. `lastRev`/`lastTagsRev` are always `null` - see above.
 */
async function buildTantivyIndexFromFilesystemScan(directories, tantivy) {
    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    cleanupStaleTantivyRebuildTempDirs(directories);

    const indexDir = tantivyIndexDir(directories);
    const tempDir = tantivyIndexTempDir(directories);
    const { index, schema } = createEmptyTantivyIndexAt(tantivy, tempDir);
    const writer = index.writer();

    const avatars = fs.readdirSync(directories.characters).filter(file => file.endsWith('.png'));
    const tagNamesFor = await makeTagNamesResolver(directories, avatars);
    const favFor = await makeFavResolver(directories, avatars);
    const tagIdsFor = await makeTagIdsResolver(directories, avatars);

    let batchIndex = 0;
    for await (const batch of readCharacterBatches(directories)) {
        for (const character of batch) {
            writer.addDocument(characterToTantivyDoc(tantivy, schema, character, tagNamesFor, favFor, tagIdsFor));
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

    swapTantivyIndexIntoPlace(indexDir, tempDir);
    // Reopen at the real path - see reopenTantivyIndexAt()'s doc comment for why the `index` built into `tempDir`
    // above can't just keep being used after the rename.
    const reopened = reopenTantivyIndexAt(tantivy, indexDir);

    return { ...reopened, close: NOOP_CLOSE, lastSeq: null, lastTagsHash: null };
}

/**
 * Applies every character change since `sinceRev` (design doc §3.3 item 3's "a changed card is one
 * delete-plus-add, not a rebuild") to an already-open tantivy index/writer, in place - both the incremental
 * catch-up alternative to a full rescan for an already-populated index, AND (called with `sinceRev`/
 * `sinceTagsRev` of 0 against a brand-new empty index - see rebuildTantivyIndexFromScratch()) the mechanism a
 * genuinely fresh build now goes through too, since getChangesSince(directories, 0) already returns the whole
 * library as `op: 'upsert'` entries. Delete-then-add for every touched id, including updates (not just genuine
 * deletes): tantivy has no update-in-place (design doc §3's probe finding), so a changed row costs exactly the
 * same as a new one either way - including, for a from-rev-0 call, every row in the library.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Index} index An already-open index (freshly built this
 * process, or reopened via `Index.open()` - either way, safe to mutate directly).
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {number | null} sinceRev The rev this index was last caught up to, or `null`/non-finite to mean "assume
 * nothing" (the first incremental pass after a fresh full build already covers everything up to its own
 * `lastRev`, so this is normally a real number, not `null`, in practice).
 * @param {string | null} sinceTagsRev The tags_rev this index was last caught up to.
 * @returns {Promise<{ lastRev: number, lastTagsRev: string | null } | null>} The new watermark, or `null` if incremental
 * maintenance isn't possible right now (metadata store unavailable, or the change log was pruned past `sinceRev`
 * - `truncated: true`, not implemented as of phase 1, but this function is already correct against it) - the
 * caller (loadOrUpdateTantivyIndex()) must fall back to a full rebuild in that case.
 */
async function applyIncrementalTantivyChanges(directories, tantivy, index, schema, sinceSeq, prevTagsHash) {
    const currentSeq = await getCurrentSeq(directories);
    const currentTagsHash = await getTagsHash(directories);
    if (currentSeq === null) {
        return null;
    }

    const changesResult = await getChangesSince(directories, Number.isFinite(sinceSeq) ? sinceSeq : 0);
    if (!changesResult || changesResult.truncated) {
        return null;
    }

    /** @type {Map<string, 'upsert'|'delete'>} */
    const idsToReindex = new Map(changesResult.changes.map(({ id, op }) => [id, op]));

    // A tag *rename* (a tags.js definition edit, not an assignment change) bumps tags_rev without producing any
    // `changes` row naming the characters whose indexed resolved_tags text it affects - see this module's header.
    if (currentTagsHash !== prevTagsHash) {
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
        const tagIdsFor = idsNeedingData.length > 0 ? await makeTagIdsResolver(directories, idsNeedingData) : () => '';

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
            writer.addDocument(characterToTantivyDoc(tantivy, schema, character, tagNamesFor, favFor, tagIdsFor));
        }

        writer.commit();
        index.reload();
        // Releases this writer's lock before it's possible for a later call (another incremental catch-up
        // against this same long-lived `index` handle, or a background rebuild racing in - see
        // search-index-coordinator.js) to request a new one - see buildTantivyIndexFromFilesystemScan()'s
        // matching comment for why `commit()` alone leaves the lock held.
        writer.waitMergingThreads();
    }

    return { lastSeq: currentSeq, lastTagsHash: currentTagsHash ?? null };
}

/**
 * Opens the persisted on-disk tantivy index AS-IS - no incremental catch-up, no watermark write, just whatever
 * was last committed to disk (`Index.open()` plus reading the persisted rev/tagsRev meta values) - fast because
 * it does none of applyIncrementalTantivyChanges()'s work. This is search-index-coordinator.js's `openStale`
 * hook for the tantivy tier (see runIdSearch() below): on a cold start (this process's first search for this
 * handle) the coordinator calls this instead of blocking on loadOrUpdateTantivyIndex() below, so a request lands
 * on whatever the index was caught up to as of the *last* process (or the last catch-up this process), while the
 * real catch-up runs in the background exactly the same way a warm-stale hit already does.
 *
 * THE INCIDENT THIS EXISTS FOR: a boot-time bulk import (local-import-scan.js) runs before any search request
 * has happened, so the very first search after it is necessarily a cold start with a large backlog of changes -
 * confirmed as the root cause of an observed 60+ second search request server-side. Before this function existed,
 * loadOrUpdateTantivyIndex()'s own `previous` - undefined branch did this same reopen-and-immediately-catch-up
 * inline, which is exactly the blocking shape that produced the incident; splitting "open" from "catch up" here
 * is what lets the coordinator serve the open step's result immediately and hand the catch-up step to
 * loadOrUpdateTantivyIndex() (now always called with a real `previous`, or genuinely `undefined` only when there
 * was nothing to reopen at all) as a background `build()` call instead.
 *
 * Also the schema-version gate: a persisted index built under an older TANTIVY_SCHEMA_VERSION than this running
 * process expects can't be trusted to mean what its documents look like it means (a field's tokenizer/indexing
 * config, or the set of fields, may have changed since it was built) - so a mismatch here is treated exactly like
 * a corrupt or missing index (return `null`), which already naturally routes into a fresh rebuild via
 * loadOrUpdateTantivyIndex()'s existing empty-`previous` fallback, with no separate branch needed anywhere else.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @returns {Promise<Awaited<ReturnType<typeof rebuildTantivyIndexFromScratch>> | null>} `null` if there's nothing
 * usable persisted to reopen (a genuinely fresh install, a corrupt/unreadable index directory, or one built under
 * a different schema version) - the coordinator's cold-start path falls back to blocking on a full build in that
 * case, same as before this function existed.
 */
async function openPersistedTantivyIndexStale(directories, tantivy) {
    const indexDir = tantivyIndexDir(directories);
    const persistedSeq = await getMetaValue(directories, TANTIVY_INDEX_SEQ_META_KEY);
    if (persistedSeq === null) {
        return null;
    }
    try {
        if (!tantivy.Index.exists(indexDir)) {
            return null;
        }
        const index = tantivy.Index.open(indexDir);
        const schema = index.schema;

        const persistedSchemaVersion = await getMetaValue(directories, TANTIVY_INDEX_SCHEMA_VERSION_META_KEY);
        // A persisted index built under a different schema version can't be trusted.
        if (Number(persistedSchemaVersion) !== TANTIVY_SCHEMA_VERSION) {
            return null;
        }

        const persistedTagsHash = (await getMetaValue(directories, TANTIVY_INDEX_TAGS_HASH_META_KEY)) ?? null;
        return { index, schema, close: NOOP_CLOSE, lastSeq: Number(persistedSeq), lastTagsHash: persistedTagsHash };
    } catch (err) {
        console.error(color.red('[search] failed to reopen the persisted character tantivy index, falling back to a full rebuild:'));
        console.error(color.red(`[search]   ${err.message}`));
        return null;
    }
}

/**
 * The `build` callback passed to indexCoordinator.getIndex() for the tantivy tier - either updates an
 * already-open handle in place (`previous` set - the common case, since a cold start now goes through
 * openPersistedTantivyIndexStale() above first and hands its result here as `previous` too, see runIdSearch())
 * or falls back to a genuinely fresh build (rebuildTantivyIndexFromScratch()) when there's nothing to
 * incrementally update from at all - no persisted index, one that failed to reopen, or one openPersistedTantivyIndexStale()
 * rejected for a schema-version mismatch. This is what makes staleness resolve to incremental maintenance by
 * default (design doc §3.2's "the existing full-rebuild path stays, demoted to a repair tool") instead of the
 * pre-existing rmSync-and-reparse-everything behavior - and, since rebuildTantivyIndexFromScratch() itself is just
 * "fresh empty index + incremental catch-up from rev 0" (this module's header), even that fallback no longer means
 * a structurally different code path, just a different starting point for the same one.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {Awaited<ReturnType<typeof rebuildTantivyIndexFromScratch>> | undefined} previous The currently-live
 * handle for this handle's tantivy index (either an in-process handle, or one openPersistedTantivyIndexStale()
 * just opened) - see search-index-coordinator.js's `build` param. `undefined` only when there's genuinely nothing
 * on disk to reopen yet (a fresh install).
 * @returns {Promise<Awaited<ReturnType<typeof rebuildTantivyIndexFromScratch>>>}
 */
async function loadOrUpdateTantivyIndex(directories, tantivy, previous) {
    // No change log to incrementally read from at all (metadata store unavailable) - getFreshnessSignature()'s
    // matching mtime-based fallback means this gets called on *every* directory-mtime change in that state, and
    // a full filesystem scan (the one case that can't be expressed as "incremental from rev 0" - see this
    // module's header) is the only thing that can possibly be correct without a change log.
    if (await getCurrentSeq(directories) === null) {
        return buildTantivyIndexFromFilesystemScan(directories, tantivy);
    }

    if (previous?.index) {
        const updated = await applyIncrementalTantivyChanges(directories, tantivy, previous.index, previous.schema, previous.lastSeq, previous.lastTagsHash ?? null);
        if (updated) {
            if (updated.lastSeq !== null) {
                await setMetaValue(directories, TANTIVY_INDEX_SEQ_META_KEY, String(updated.lastSeq));
                await setMetaValue(directories, TANTIVY_INDEX_TAGS_HASH_META_KEY, String(updated.lastTagsHash));
                await setMetaValue(directories, TANTIVY_INDEX_SCHEMA_VERSION_META_KEY, String(TANTIVY_SCHEMA_VERSION));
            }
            return { ...previous, ...updated };
        }
    }

    // Nothing to incrementally update an already-open handle from (first-ever build, a truncated change log, or
    // applyIncrementalTantivyChanges() itself declining) - rebuildTantivyIndexFromScratch() below is the shared
    // "fresh empty index + incremental catch-up from rev 0" sequence (this module's header), and itself persists
    // the new rev/tagsRev/schema-version watermark.
    return rebuildTantivyIndexFromScratch(directories, tantivy);
}

/**
 * Fuzzy-searches a user's characters, rebuilding the persistent index first if it's missing or stale. Resolves
 * the search engine via resolveSearchEngine() (search-engine.js) - tantivy is the only engine now; there is no
 * fallback tier.
 *
 * The returned `backend` field lets callers (see the /api/characters/all handler in characters.js) tell the
 * client which engine actually served a given search - 'unavailable' means search produced no results because
 * nothing usable could be loaded, not because the query didn't match anything. Nothing about a degraded-but-
 * still-200-OK response would otherwise reveal that to whoever's looking at an empty result list.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @param {number} [maxRows] Caps how many matching ids get fetched. This is now (design doc §5.1's payload
 * shrink) a cap on bare id strings, not full-JSON hits, so it's cheap to size generously - see SEARCH_ID_CAP.
 * @param {boolean} [favOnly] When true, restricts matches to favorited characters only, applied inside the query
 * itself (not after `maxRows` truncates the page) - see buildSearchQuery()'s `favOnly` doc comment
 * (tantivy-search.js) for why a post-fetch filter here would be wrong: it lets the caller's own client-side
 * favorites filter (FilterHelper.favFilter(), public/scripts/filters.js) actually work when combined with a
 * search term, instead of only ever narrowing whichever relevance-ranked page happened to survive the cap.
 * @returns {Promise<{ hits: { id: string, score: number }[], total: number, backend: 'tantivy' | 'unavailable' }>}
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

    const tantivyIndex = await indexCoordinator.getIndex(
        handle, signature,
        (previous) => loadOrUpdateTantivyIndex(directories, engine.tantivy, previous),
        // Cold-start fast path (search-index-coordinator.js's `openStale`) - see openPersistedTantivyIndexStale()'s
        // doc comment for the incident this closes. Only consulted when this process has no live handle for
        // `handle` yet at all; every other call (including the very next one right after this) goes through
        // the `build` callback above like normal.
        () => openPersistedTantivyIndexStale(directories, engine.tantivy),
    );
    const query = buildTantivyQuery(engine.tantivy, tantivyIndex.schema, searchTerm, TANTIVY_FIELD_WEIGHTS, TANTIVY_FIELD_LABELS, { favOnly });
    if (!query) {
        return { hits: [], total: 0, backend: 'tantivy' };
    }
    const boundedMaxRows = Number.isFinite(maxRows) && maxRows > 0 ? maxRows : undefined;
    const { results, total } = runTantivySearch(tantivyIndex.index, query, boundedMaxRows);
    // DATA_FIELD now stores just the id (design doc §5.1) - `raw` *is* the id, nothing to parse.
    return { hits: results.map(r => ({ id: r.raw, score: r.score })), total, backend: 'tantivy' };
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
 * @returns {Promise<{ results: { item: object, score: number }[], total: number, backend: 'tantivy' | 'unavailable' }>}
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
 * @returns {Promise<{ ids: string[], scoresById: Map<string, number>, total: number, backend: 'tantivy' | 'unavailable' }>}
 * `ids` in relevance order (best match first), `scoresById` the same hits keyed by id (ascending-is-better, the
 * Fuse/BM25 convention this codebase already uses elsewhere) - needed by a caller that has to merge this result
 * against a *different* index's relevance order (characters+groups search, `/query`'s `filter.includeGroups`
 * branch, characters.js) where rank alone from each side isn't enough to interleave correctly, only the actual
 * score values are - the true total match count (independent of `maxRows`), and which engine tier produced them.
 */
export async function searchCharacterIds(handle, directories, searchTerm, maxRows, favOnly) {
    const { hits, total, backend } = await runIdSearch(handle, directories, searchTerm, maxRows, favOnly);
    return { ids: hits.map(hit => hit.id), scoresById: new Map(hits.map(hit => [hit.id, hit.score])), total, backend };
}

/**
 * Searches characters and returns a page-sized window sorted by a tantivy fast field, plus the
 * exact match count - no full-match-set materialization, no SQL sort step. Only usable when the
 * sort field is in TANTIVY_SORT_FIELDS AND the current index was built with those fast fields
 * (schema version >= 2). Falls back to null if the fast field isn't available (the caller should
 * use the SQL sort path instead).
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} searchTerm
 * @param {string} sortField One of TANTIVY_SORT_FIELDS
 * @param {'asc'|'desc'} sortOrder
 * @param {number} offset Row offset (0-based)
 * @param {number} pageSize
 * @param {boolean} [favOnly]
 * @returns {Promise<{ ids: string[], total: number, backend: 'tantivy' | 'unavailable' } | null>}
 * null when the current index doesn't support fast-field sorting (schema too old or field missing).
 */
export async function searchCharacterIdsSorted(handle, directories, searchTerm, sortField, sortOrder, offset, pageSize, favOnly, { tags, excludeIds } = {}) {
    if (!TANTIVY_SORT_FIELDS.has(sortField)) return null;

    const tantivySortField = SORT_FIELD_TO_TANTIVY_FIELD[sortField];
    if (!tantivySortField) return null;

    const signature = await getFreshnessSignature(directories);
    const engine = await resolveSearchEngine();
    if (engine.tier === 'unavailable') return { ids: [], total: 0, backend: 'unavailable' };

    const tantivyIndex = await indexCoordinator.getIndex(
        handle, signature,
        (previous) => loadOrUpdateTantivyIndex(directories, engine.tantivy, previous),
        () => openPersistedTantivyIndexStale(directories, engine.tantivy),
    );

    const query = buildTantivyQuery(engine.tantivy, tantivyIndex.schema, searchTerm, TANTIVY_FIELD_WEIGHTS, TANTIVY_FIELD_LABELS, { favOnly });
    if (!query) return { ids: [], total: 0, backend: 'tantivy' };

    // fav_name_sort_key encodes DESC-fav + ASC-name into a single key, so always sort ASC.
    // name_sort_key is a lexicographic key, always ASC for ascending name order (the most common).
    // Other fields use the caller's sortOrder directly.
    const effectiveOrder = (sortField === 'fav' || sortField === 'name') ? 'asc' : sortOrder;

    let fullQuery = query;

    // Compose tag filter if present
    if (tags && (tags.include?.length > 0 || tags.exclude?.length > 0)) {
        const tagQuery = buildTagFilterQuery(engine.tantivy, tantivyIndex.schema, tags, TAG_IDS_FIELD);
        if (tagQuery) {
            fullQuery = engine.tantivy.Query.booleanQuery([
                { occur: engine.tantivy.Occur.Must, query: fullQuery },
                { occur: engine.tantivy.Occur.Must, query: tagQuery },
            ]);
        }
    }

    // Compose excludeIds if present
    if (Array.isArray(excludeIds) && excludeIds.length > 0) {
        const excludeQuery = buildExcludeIdsQuery(engine.tantivy, tantivyIndex.schema, excludeIds);
        fullQuery = engine.tantivy.Query.booleanQuery([
            { occur: engine.tantivy.Occur.Must, query: fullQuery },
            { occur: engine.tantivy.Occur.MustNot, query: excludeQuery },
        ]);
    }

    const { results, total } = runTantivySearch(tantivyIndex.index, fullQuery, pageSize, {
        orderByField: tantivySortField,
        order: effectiveOrder,
        offset,
    });
    return { ids: results.map(r => r.raw), total, backend: 'tantivy' };
}

/**
 * Forces an immediate, blocking, full rebuild of a user's character search index, regardless of the current
 * freshness signature - design doc §3.2's explicit repair endpoint ("the existing full-rebuild path stays,
 * demoted to a repair tool behind an explicit endpoint rather than something a directory mtime change can
 * trigger implicitly"). Wired to `POST /api/characters/search-index/rebuild` (characters.js). Not needed for
 * correctness in normal operation - loadOrUpdateTantivyIndex() already falls back to a full rebuild whenever
 * incremental maintenance genuinely can't proceed - this exists for an owner who wants to force one anyway (a
 * corrupted index suspected, or recovering from an incident) without waiting for the next staleness check.
 * For the tantivy tier this is the same rebuildTantivyIndexFromScratch() (fresh empty index + incremental catch-up
 * from rev 0) every other genuinely-fresh build goes through - see this module's header - rather than a bespoke
 * "repair" implementation; it just calls it unconditionally instead of waiting for loadOrUpdateTantivyIndex() to
 * decide one's needed.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Promise<{ ok: boolean, backend: 'tantivy' | 'unavailable' }>}
 */
export async function rebuildCharacterSearchIndex(handle, directories) {
    const engine = await resolveSearchEngine();
    if (engine.tier === 'unavailable') {
        return { ok: false, backend: 'unavailable' };
    }

    const signature = await getFreshnessSignature(directories);
    await indexCoordinator.forceRebuild(handle, signature, () => rebuildTantivyIndexFromScratch(directories, engine.tantivy));
    return { ok: true, backend: 'tantivy' };
}
