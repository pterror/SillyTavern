import fs from 'node:fs';
import path from 'node:path';

import { getTagDefinitions, getEntityTagIdsForMany, getTagsHash } from '../character-metadata-db.js';
import { getGroupsData } from './groups.js';
import { buildSchema as buildTantivySchema, buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch, DATA_FIELD, FAV_FIELD } from './tantivy-search.js';
import { resolveSearchEngine } from './search-engine.js';
import { createIndexCoordinator } from './search-index-coordinator.js';

/**
 * Fast full-content group search, mirroring characters-search-index.js but for groups - see that module's
 * header comment for the full rationale (tantivy-backed only, no SQLite FTS5 fallback, why freshness is a cheap
 * stat-based check rather than push invalidation from groups.js's own mutation routes - same import-cycle
 * concern applies here, since this module needs getGroupsData() *from* groups.js). Rebuild coordination (no
 * blocking on a stale-but-usable index, no racing rebuilds from concurrent requests) is shared with
 * characters-search-index.js via search-index-coordinator.js - see that module's header for the full rationale
 * and the production incident that motivated it.
 */

// Column order/weights mirror fuzzySearchGroups() in public/scripts/power-user.js (and this file's original
// Fuse-based version) exactly.
const BM25_INDEXED_COLUMNS = ['name', 'resolved_tags', 'members', 'id'];
const BM25_WEIGHTS = [20, 10, 15, 1];

// tantivy-search.js's field-name-array equivalent of the old FTS5 FIELD_LABELS/BM25_WEIGHTS above - see
// characters-search-index.js's TANTIVY_FIELD_WEIGHTS/TANTIVY_FIELD_LABELS for the full rationale (identical here,
// just the smaller groups field set).
const TANTIVY_FIELD_WEIGHTS = Object.fromEntries(BM25_INDEXED_COLUMNS.map((name, i) => [name, BM25_WEIGHTS[i]]));

// Fast fields for native tantivy sorting, mirroring characters-search-index.js's TANTIVY_FAST_FIELDS.
// Groups use a subset: no create_date (groups use date_added for that), no data_size (not tracked for groups).
const TANTIVY_FAST_FIELDS = ['date_added', 'date_last_chat', 'chat_size'];
const TANTIVY_COLLATION_FIELDS = ['name_sort_key', 'fav_name_sort_key'];
const ALL_FAST_FIELDS = [...TANTIVY_FAST_FIELDS, ...TANTIVY_COLLATION_FIELDS];
const TANTIVY_FILTER_TEXT_FIELDS = [{ name: 'tag_ids', tokenizerName: 'whitespace' }];

// Byte-count capped at 6 for the same JS-double precision reason characters-search-index.js's own
// stringToSortKey() documents in full: 7 bytes is 2^56, past Number.MAX_SAFE_INTEGER (2^53 - 1), and
// silently rounds the low byte away so names differing only at the 7th character collide.
function stringToSortKey(str, byteCount = 6) {
    const lower = (str || '').toLowerCase();
    let key = 0;
    for (let i = 0; i < byteCount; i++) {
        key = key * 256 + (i < lower.length ? lower.charCodeAt(i) & 0xFF : 0);
    }
    return key;
}
const TANTIVY_FIELD_LABELS = {
    name: ['name'],
    tag: ['resolved_tags'],
    tags: ['resolved_tags'],
    member: ['members'],
    members: ['members'],
    id: ['id'],
};

// Fallback cap on the tantivy tier's maxRows when a caller genuinely omits it - see
// characters-search-index.js's DEFAULT_TANTIVY_MAX_ROWS for the full rationale.
const DEFAULT_TANTIVY_MAX_ROWS = 500;

const indexCoordinator = createIndexCoordinator();

/**
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Promise<string>} A cheap fingerprint that changes whenever a group is added/removed/edited or a tag
 * definition/assignment changes (getTagsHash() - see character-metadata-db.js - replaces the old
 * tags.json-mtime half of this signature now that tags.json is gone)
 */
async function getFreshnessSignature(directories) {
    const groupsDirMtime = fs.existsSync(directories.groups) ? fs.statSync(directories.groups).mtimeMs : 0;
    const tagsHash = await getTagsHash(directories);
    return `${groupsDirMtime}:${tagsHash}`;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} groupIds Every group id about to be indexed - fetched once up front so this resolves with
 * two batched sqlite reads total (tag definitions + getEntityTagIdsForMany()) rather than one getGroupTagIds()
 * call per group - see characters-search-index.js's makeTagNamesResolver() for the full rationale.
 * @returns {Promise<{ tagNamesFor: (groupId: string) => string, tagIdsFor: (groupId: string) => string }>} Sync
 * closures over the pre-fetched data, resolving a group's tag names (space-joined) and raw tag ids (space-joined)
 */
async function makeTagNamesResolver(directories, groupIds) {
    const [definitions, assignments] = await Promise.all([
        getTagDefinitions(directories),
        getEntityTagIdsForMany(directories, groupIds),
    ]);
    const tagsById = new Map((definitions ?? []).map(tag => [tag.id, tag]));
    const tagNamesFor = (groupId) => (assignments?.[groupId] ?? [])
        .map(id => tagsById.get(id)?.name)
        .filter(Boolean)
        .join(' ');
    const tagIdsFor = (groupId) => (assignments?.[groupId] ?? []).join(' ');
    return { tagNamesFor, tagIdsFor };
}

// Groups (unlike characters) come from getGroupsData() as one already-in-memory array - a group is a curated
// multi-character chat setup, not something that realistically scales into the millions the way a character
// library can, so there's no equivalent of characters-search-index.js's readCharacterBatches() here reading
// files in bounded chunks. What's still worth batching is the *insert* side: building one giant second array of
// JSON.stringify()'d rows (the old `groups.map(...)`) held `groups` and its full stringified duplicate in
// memory at once, the same doubling that (compounded by an equivalent `json_data`-sized field on the character
// side) actually OOM'd this server's characters index build on a real install. Batching the insert avoids ever
// holding more than one batch's worth of stringified rows alongside `groups`.
const INDEX_BUILD_BATCH_SIZE = 500;
const CHECKPOINT_EVERY_N_BATCHES = 20;

/**
 * (Re)builds the persistent on-disk tantivy index for a user's groups. See
 * characters-search-index.js's buildTantivyIndex() for the full rationale (same
 * batching/commit discipline applies, even though groups come from one already-in-memory array rather than
 * per-file reads - see this file's own INDEX_BUILD_BATCH_SIZE comment for why the insert side still gets
 * batched).
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy The resolved tantivy module (tantivy-engine.js)
 * @returns {Promise<{ index: import('@oxdev03/node-tantivy-binding').Index, schema: import('@oxdev03/node-tantivy-binding').Schema, close: () => void }>}
 * The freshly built, open index handle - `close()` is a no-op, see characters-search-index.js's
 * buildTantivyIndex() for why.
 */
async function buildTantivyIndex(directories, tantivy) {
    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    const indexDir = path.join(dbDir, 'groups-tantivy');
    fs.rmSync(indexDir, { recursive: true, force: true });
    fs.mkdirSync(indexDir, { recursive: true });

    const schema = buildTantivySchema(tantivy, BM25_INDEXED_COLUMNS, ALL_FAST_FIELDS, TANTIVY_FILTER_TEXT_FIELDS);
    const index = new tantivy.Index(schema, indexDir, false);
    const writer = index.writer();

    const groups = getGroupsData(directories);
    const { tagNamesFor, tagIdsFor } = await makeTagNamesResolver(directories, groups.map(group => group.id));

    let batchIndex = 0;
    for (let i = 0; i < groups.length; i += INDEX_BUILD_BATCH_SIZE) {
        const batch = groups.slice(i, i + INDEX_BUILD_BATCH_SIZE);
        for (const group of batch) {
            const doc = tantivy.Document.fromDict({
                name: group.name ?? '',
                resolved_tags: tagNamesFor(group.id),
                members: Array.isArray(group.members) ? group.members.join(' ') : '',
                id: group.id ?? '',
                // Fast fields for native sorting
                date_added: Math.max(0, Number(group.date_added) || 0),
                date_last_chat: Math.max(0, Number(group.date_last_chat) || 0),
                chat_size: Math.max(0, Number(group.chat_size) || 0),
                name_sort_key: stringToSortKey(group.name ?? ''),
                fav_name_sort_key: (group.fav ? 0 : 1) * (2 ** 48) + stringToSortKey(group.name ?? '', 6),
                tag_ids: tagIdsFor(group.id),
                [DATA_FIELD]: JSON.stringify(group),
                [FAV_FIELD]: Boolean(group.fav),
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

    return { index, schema, close: () => { /* no explicit close API on this binding's Index */ } };
}

/**
 * Fuzzy-searches a user's groups, rebuilding the persistent index first if it's missing or stale. See
 * characters-search-index.js's searchCharacters() for the full rationale behind the `backend` field and the
 * tantivy-first engine resolution - identical reasoning applies here.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @param {number} [maxRows] Forwarded to runTantivySearch() - see that function's doc comment.
 * @param {boolean} [favOnly] Forwarded to buildTantivyQuery() - restricts matches to favorited groups, applied
 * inside the query itself so it composes correctly with `maxRows` - see characters-search-index.js's
 * searchCharacters() `favOnly` doc for the full rationale.
 * @returns {Promise<{ results: { item: object, score: number }[], total: number, backend: 'tantivy' | 'unavailable' }>}
 * `total` is the true match count, independent of `maxRows`.
 */
export async function searchGroups(handle, directories, searchTerm, maxRows, favOnly) {
    const signature = await getFreshnessSignature(directories);
    const engine = await resolveSearchEngine();

    if (engine.tier !== 'unavailable') {
        const tantivyIndex = await indexCoordinator.getIndex(handle, signature, () => buildTantivyIndex(directories, engine.tantivy));
        const query = buildTantivyQuery(engine.tantivy, tantivyIndex.schema, searchTerm, TANTIVY_FIELD_WEIGHTS, TANTIVY_FIELD_LABELS, { favOnly });
        if (!query) {
            return { results: [], total: 0, backend: 'tantivy' };
        }
        const boundedMaxRows = Number.isFinite(maxRows) ? maxRows : DEFAULT_TANTIVY_MAX_ROWS;
        const { results, total } = runTantivySearch(tantivyIndex.index, query, boundedMaxRows);
        // Groups still store the full group JSON in DATA_FIELD (see that constant's doc comment,
        // tantivy-search.js) - runSearch() no longer parses it for the caller, since characters-search-index.js's
        // id-only payload has nothing to parse, so this tier does it here instead.
        const items = results.map(r => ({ item: JSON.parse(r.raw), score: r.score }));
        return { results: items, total, backend: 'tantivy' };
    }

    return { results: [], total: 0, backend: 'unavailable' };
}

/**
 * Fuzzy-searches a user's groups and returns just the matched ids (plus their scores), in relevance order - the
 * id-only counterpart to searchGroups() above, mirroring characters-search-index.js's searchCharacterIds() for
 * the same reason: `POST /api/characters/query`'s `filter.search` + `filter.includeGroups` handling
 * (characters.js) resolves group rows itself from the phase-1 metadata store (queryEntities()), it doesn't need
 * this function's full group JSON - just which ids matched and how they rank, to intersect/merge against the
 * candidate set the same way the characters side already does.
 *
 * Unlike characters-search-index.js's `searchCharacterIds()`, this one does not skip a per-hit disk read to get
 * there - it just discards `item` from `searchGroups()`'s own already-in-memory result. At the group counts this
 * install actually has (tens, not tens of thousands - see the design note this function's caller cites), that's
 * not worth a second, parallel id-only tantivy/SQLite query path; `searchCharacterIds()`'s id-only path exists
 * because characters-search-index.js's own header documents a *measured* per-hit disk-read cost at real character
 * library sizes (24k+ cards) that groups, structurally, never reach the way characters can (a group is hand
 * -created, not imported in bulk from card packs).
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @param {number} [maxRows] Forwarded to searchGroups().
 * @param {boolean} [favOnly] Forwarded to searchGroups().
 * @returns {Promise<{ ids: string[], scoresById: Map<string, number>, total: number, backend: 'tantivy' | 'unavailable' }>}
 */
export async function searchGroupIds(handle, directories, searchTerm, maxRows, favOnly) {
    const { results, total, backend } = await searchGroups(handle, directories, searchTerm, maxRows, favOnly);
    return {
        ids: results.map(r => r.item.id),
        scoresById: new Map(results.map(r => [r.item.id, r.score])),
        total,
        backend,
    };
}
