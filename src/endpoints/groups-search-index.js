import fs from 'node:fs';
import path from 'node:path';

import { getTagDefinitions, getEntityTagIdsForMany, getTagsHash } from '../character-metadata-db.js';
import { getGroupsData } from './groups.js';
import { buildSchema as buildTantivySchema, buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch, DATA_FIELD, FAV_FIELD } from './tantivy-search.js';
import { resolveSearchEngine } from './search-engine.js';
import { createIndexCoordinator } from './search-index-coordinator.js';

/** Fast full-content group search, mirroring characters-search-index.js. Rebuild coordination is shared with
 * it via search-index-coordinator.js. */

// Column order/weights mirror fuzzySearchGroups() in public/scripts/power-user.js exactly.
const BM25_INDEXED_COLUMNS = ['name', 'resolved_tags', 'members', 'id'];
const BM25_WEIGHTS = [20, 10, 15, 1];

const TANTIVY_FIELD_WEIGHTS = Object.fromEntries(BM25_INDEXED_COLUMNS.map((name, i) => [name, BM25_WEIGHTS[i]]));

// Groups use a subset of characters-search-index.js's fast fields: no create_date, no data_size.
const TANTIVY_FAST_FIELDS = ['date_added', 'date_last_chat', 'chat_size'];
const TANTIVY_COLLATION_FIELDS = ['name_sort_key', 'fav_name_sort_key'];
const ALL_FAST_FIELDS = [...TANTIVY_FAST_FIELDS, ...TANTIVY_COLLATION_FIELDS];
const TANTIVY_FILTER_TEXT_FIELDS = [{ name: 'tag_ids', tokenizerName: 'whitespace' }];

// Capped at 6 bytes: 7 bytes is 2^56, past Number.MAX_SAFE_INTEGER, and silently loses the low byte.
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

const DEFAULT_TANTIVY_MAX_ROWS = 500;

const indexCoordinator = createIndexCoordinator();

/** @returns {Promise<string>} A cheap fingerprint that changes whenever a group is added/removed/edited or a
 * tag definition/assignment changes. */
async function getFreshnessSignature(directories) {
    const groupsDirMtime = fs.existsSync(directories.groups) ? fs.statSync(directories.groups).mtimeMs : 0;
    const tagsHash = await getTagsHash(directories);
    return `${groupsDirMtime}:${tagsHash}`;
}

/** Fetches tag definitions/assignments once up front (two batched reads total) instead of one call per group.
 * @returns {Promise<{ tagNamesFor: (groupId: string) => string, tagIdsFor: (groupId: string) => string }>} */
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

// Groups come from getGroupsData() as one already-in-memory array, but the insert side is still batched to
// avoid holding a full stringified duplicate of `groups` in memory at once (this doubling OOM'd the characters
// index build on a real install).
const INDEX_BUILD_BATCH_SIZE = 500;
const CHECKPOINT_EVERY_N_BATCHES = 20;

/** (Re)builds the persistent on-disk tantivy index for a user's groups. */
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
 * Fuzzy-searches a user's groups, rebuilding the persistent index first if it's missing or stale.
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
        const items = results.map(r => ({ item: JSON.parse(r.raw), score: r.score }));
        return { results: items, total, backend: 'tantivy' };
    }

    return { results: [], total: 0, backend: 'unavailable' };
}

/** Id-only counterpart to searchGroups() - just discards `item` from its already-in-memory result rather than
 * running a separate id-only query, since group counts are small enough not to need that.
 * @returns {Promise<{ ids: string[], scoresById: Map<string, number>, total: number, backend: 'tantivy' | 'unavailable' }>} */
export async function searchGroupIds(handle, directories, searchTerm, maxRows, favOnly) {
    const { results, total, backend } = await searchGroups(handle, directories, searchTerm, maxRows, favOnly);
    return {
        ids: results.map(r => r.item.id),
        scoresById: new Map(results.map(r => [r.item.id, r.score])),
        total,
        backend,
    };
}
