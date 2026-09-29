import fs from 'node:fs';
import path from 'node:path';

import { getTagDefinitions, getEntityTagIdsForMany, getTagDeletions, getGroupFavsByIds, getGroupsVersion, trySetMetaValues } from '../character-metadata-db.js';
import { getGroupsData } from './groups.js';
import { buildSchema as buildTantivySchema, buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch, DATA_FIELD, FAV_FIELD, stringToSortKey, withFavFilter, buildTagFilterQuery, fastFieldOrderValue } from './tantivy-search.js';
import { resolveSearchEngine } from './search-engine.js';
import { getSearchIndex, GROUPS_INDEX_VERSION_META_KEY } from './search-index-coordinator.js';
import { rebuildTempDir, cleanupStaleRebuildDirs, swapIndexIntoPlace } from './tantivy-engine.js';
import { timePhase } from '../search-timing.js';
import { expandTagFilter } from '../tag-deletions.js';

/** Fast full-content group search, mirroring characters-search-index.js. The index is maintained by the same
 * per-handle search index worker (search-index-coordinator.js). */

// Column order/weights mirror fuzzySearchGroups() in public/scripts/power-user.js exactly.
const BM25_INDEXED_COLUMNS = ['name', 'resolved_tags', 'members', 'id'];
const BM25_WEIGHTS = [20, 10, 15, 1];

const TANTIVY_FIELD_WEIGHTS = Object.fromEntries(BM25_INDEXED_COLUMNS.map((name, i) => [name, BM25_WEIGHTS[i]]));

// Groups use a subset of characters-search-index.js's fast fields: no create_date, no data_size.
const TANTIVY_FAST_FIELDS = ['date_added', 'date_last_chat', 'chat_size'];
const TANTIVY_COLLATION_FIELDS = ['name_sort_key', 'fav_name_sort_key'];
const ALL_FAST_FIELDS = [...TANTIVY_FAST_FIELDS, ...TANTIVY_COLLATION_FIELDS];
const TAG_IDS_FIELD = 'tag_ids';
const TANTIVY_FILTER_TEXT_FIELDS = [{ name: TAG_IDS_FIELD, tokenizerName: 'whitespace' }];

const TANTIVY_FIELD_LABELS = {
    name: ['name'],
    tag: ['resolved_tags'],
    tags: ['resolved_tags'],
    member: ['members'],
    members: ['members'],
    id: ['id'],
};

const DEFAULT_TANTIVY_MAX_ROWS = 500;

const INDEX_DIR_NAME = 'groups-tantivy';

/** Fetches tag definitions/assignments once up front (two batched reads total) instead of one call per group.
 * @returns {Promise<{ tagNamesFor: (groupId: string) => string, tagIdsFor: (groupId: string) => string }>} */
async function makeTagNamesResolver(directories, groupIds) {
    const [definitions, assignments] = await Promise.all([
        getTagDefinitions(directories),
        getEntityTagIdsForMany(directories, groupIds, { type: 'group' }),
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

const PERSIST_VERSION_RETRY_MS = 100;

/** Builds a user's groups index into a temp dir and swaps it into place, so a reader open on the old one never
 * sits under a removed dir. @returns {Promise<string>} The index dir. */
async function buildTantivyIndex(directories, tantivy) {
    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    const indexDir = path.join(dbDir, INDEX_DIR_NAME);
    cleanupStaleRebuildDirs(dbDir, INDEX_DIR_NAME);
    const tempDir = rebuildTempDir(dbDir, INDEX_DIR_NAME);
    fs.mkdirSync(tempDir, { recursive: true });

    const schema = buildTantivySchema(tantivy, BM25_INDEXED_COLUMNS, ALL_FAST_FIELDS, TANTIVY_FILTER_TEXT_FIELDS);
    const index = new tantivy.Index(schema, tempDir, false);
    const writer = index.writer();

    const groups = await getGroupsData(directories);
    const { tagNamesFor, tagIdsFor } = await makeTagNamesResolver(directories, groups.map(group => group.id));

    let batchIndex = 0;
    for (let i = 0; i < groups.length; i += INDEX_BUILD_BATCH_SIZE) {
        const batch = groups.slice(i, i + INDEX_BUILD_BATCH_SIZE);
        const favById = await getGroupFavsByIds(directories, batch.map(group => group.id));
        for (const group of batch) {
            group.fav = !!favById[group.id];
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
    // commit() alone does not release the writer's on-disk lock; waitMergingThreads() does.
    writer.waitMergingThreads();

    swapIndexIntoPlace(indexDir, tempDir);
    return indexDir;
}

/**
 * Keeps a user's groups index current by a full rebuild whenever the groups version log (group_changes) has
 * moved past the version the index was built from. Runs in search-index-worker.js, never in the request process.
 * Each build records the groups version (getGroupsVersion()) it was built from, and persists it under
 * GROUPS_INDEX_VERSION_META_KEY once the new index is in place, so read-only mode can read it.
 * Without a metadata store there is no log, so it rebuilds whenever the groups folder's mtime moves instead: that
 * catches groups added or removed, though not a file edited in place.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 */
export function createGroupIndexMaintainer(directories, tantivy) {
    /** @type {number | null} */
    let builtVersion = null;
    /** @type {number | null} */
    let builtDirMtime = null;

    const groupsDirMtime = () => fs.existsSync(directories.groups) ? fs.statSync(directories.groups).mtimeMs : 0;

    /** @returns {Promise<string>} The index dir. */
    async function build() {
        // Read before the build, so a change made during it moves them again.
        const version = await getGroupsVersion(directories);
        const dirMtime = version === null ? groupsDirMtime() : null;
        const dir = await buildTantivyIndex(directories, tantivy);
        builtVersion = version;
        builtDirMtime = dirMtime;
        // null: the metadata store is unavailable, so there is no version and nowhere to persist one.
        if (version !== null) {
            // Not skipped on a lock: the new index is already in place, and the version persisted for the old
            // one would say it shows less than it does.
            while (!await trySetMetaValues(directories, { [GROUPS_INDEX_VERSION_META_KEY]: String(version) })) {
                await new Promise(resolve => setTimeout(resolve, PERSIST_VERSION_RETRY_MS));
            }
        }
        return dir;
    }

    return {
        build,
        /** @returns {number | null} The groups version the current index was built from; null before the first
         * build or when the metadata store was unavailable. */
        version: () => builtVersion,
        /** @returns {Promise<string | null>} The index dir when it was rebuilt, else null. */
        async tick() {
            const version = await getGroupsVersion(directories);
            const unchanged = version === null ? groupsDirMtime() === builtDirMtime : version === builtVersion;
            return unchanged ? null : build();
        },
    };
}

// `filter`'s fav and tags are ANDed into the query the same way searchGroupsSorted() does it (withFavFilter(),
// buildTagFilterQuery()/TAG_IDS_FIELD), so they narrow the matches before `maxRows` caps them.
// `position` is the reader's position (search-index-coordinator.js) as of the search, null when unknown.
async function runGroupSearch(handle, directories, searchTerm, maxRows, filter = {}) {
    const { fav, tags } = filter;
    const engine = await timePhase('groups_index_get', () => resolveSearchEngine());

    if (engine.tier !== 'unavailable') {
        const tantivyIndex = await timePhase('groups_index_get', () => getSearchIndex(handle, directories, 'groups'));
        if (!tantivyIndex) {
            return { results: [], total: 0, backend: 'unavailable', position: null };
        }
        const expandedTags = tags ? expandTagFilter(tags, await getTagDeletions(directories)) : null;
        // Nothing below awaits, so the reader can't move between here and the search.
        const position = groupsPositionOf(tantivyIndex);
        if (expandedTags?.none) {
            return { results: [], total: 0, backend: 'tantivy', position };
        }
        const query = timePhase('groups_query_build', () => {
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
            return q;
        });
        if (!query) {
            return { results: [], total: 0, backend: 'tantivy', position };
        }
        const boundedMaxRows = Number.isFinite(maxRows) ? maxRows : DEFAULT_TANTIVY_MAX_ROWS;
        const { results, total } = runTantivySearch(tantivyIndex.index, query, boundedMaxRows, { timingLabel: 'groups' });
        const items = timePhase('groups_ids', () => results.map(r => ({ item: JSON.parse(r.raw), score: r.score })));
        return { results: items, total, backend: 'tantivy', position };
    }

    return { results: [], total: 0, backend: 'unavailable', position: null };
}

/**
 * @param {import('./search-index-coordinator.js').SearchIndexReader} reader
 * @returns {import('./search-index-coordinator.js').GroupsIndexPosition | null}
 */
function groupsPositionOf(reader) {
    return /** @type {import('./search-index-coordinator.js').GroupsIndexPosition | null | undefined} */ (reader.position) ?? null;
}

/**
 * The groups index's position as searches read it now (search-index-coordinator.js), or null when it isn't known
 * or there is no index.
 * @param {string} handle
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<import('./search-index-coordinator.js').GroupsIndexPosition | null>}
 */
export async function getGroupIndexPosition(handle, directories) {
    const engine = await resolveSearchEngine();
    if (engine.tier === 'unavailable') return null;
    const tantivyIndex = await getSearchIndex(handle, directories, 'groups');
    return tantivyIndex ? groupsPositionOf(tantivyIndex) : null;
}

/**
 * Fuzzy-searches a user's groups, rebuilding the persistent index first if it's missing or stale.
 * @returns {Promise<{ results: { item: object, score: number }[], total: number, backend: 'tantivy' | 'unavailable' }>}
 * `total` is the true match count, independent of `maxRows`.
 */
export async function searchGroups(handle, directories, searchTerm, maxRows, favOnly) {
    return runGroupSearch(handle, directories, searchTerm, maxRows, { fav: favOnly ? true : undefined });
}

/**
 * A group's value for a characters-index sort field, encoded the way characterToTantivyDoc()
 * (characters-search-index.js) encodes a character's. create_date is the group's date_added (as in
 * queryEntities()); a group has no data_size.
 * @param {object} group
 * @param {string} sortField
 * @returns {number}
 */
function groupSortValue(group, sortField) {
    switch (sortField) {
        case 'create_date':
        case 'date_added': return Math.max(0, Number(group.date_added) || 0);
        case 'date_last_chat': return Math.max(0, Number(group.date_last_chat) || 0);
        case 'chat_size': return Math.max(0, Number(group.chat_size) || 0);
        case 'data_size': return 0;
        case 'name': return stringToSortKey(group.name ?? '');
        case 'fav': return (group.fav ? 0 : 1) * (2 ** 48) + stringToSortKey(group.name ?? '', 6);
        default: throw new Error(`no group sort value for ${sortField}`);
    }
}

/**
 * Every matching group, in the order tantivy would sort them among characters: descending
 * fastFieldOrderValue(), ties by exact sort value in `order`, then by id. A user's groups are few, so all of them are read and sorted here.
 * @param {'asc'|'desc'} order The order tantivy sorts characters in (tantivySortOrder()).
 * @param {{ fav?: boolean, tags?: object, excludeIds?: string[], ids?: string[] }} [filter]
 * @returns {Promise<{ groups: { id: string, order: number }[], backend: 'tantivy' | 'unavailable', position: import('./search-index-coordinator.js').GroupsIndexPosition | null }>}
 * `position` is the reader's position (search-index-coordinator.js) as of the search, null when unknown.
 */
export async function searchGroupsSorted(handle, directories, searchTerm, sortField, order, filter = {}) {
    const { fav, tags, excludeIds, ids } = filter;
    const engine = await timePhase('groups_index_get', () => resolveSearchEngine());
    if (engine.tier === 'unavailable') {
        return { groups: [], backend: 'unavailable', position: null };
    }
    const tantivyIndex = await timePhase('groups_index_get', () => getSearchIndex(handle, directories, 'groups'));
    if (!tantivyIndex) {
        return { groups: [], backend: 'unavailable', position: null };
    }
    const expandedTags = tags ? expandTagFilter(tags, await getTagDeletions(directories)) : null;
    // Nothing below awaits, so the reader can't move between here and the search.
    const position = groupsPositionOf(tantivyIndex);
    if (expandedTags?.none) {
        return { groups: [], backend: 'tantivy', position };
    }
    const query = timePhase('groups_query_build', () => {
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
        return q;
    });
    if (!query) {
        return { groups: [], backend: 'tantivy', position };
    }
    const { results } = runTantivySearch(tantivyIndex.index, query, undefined, { timingLabel: 'groups' });
    const groups = timePhase('groups_ids', () => {
        const allowed = Array.isArray(ids) ? new Set(ids) : null;
        const excluded = new Set(Array.isArray(excludeIds) ? excludeIds : []);
        return results
            .map(r => JSON.parse(r.raw))
            .filter(group => (!allowed || allowed.has(group.id)) && !excluded.has(group.id))
            .map(group => {
                const value = groupSortValue(group, sortField);
                return { id: String(group.id), order: fastFieldOrderValue(value, order), value };
            })
            .sort((a, b) => b.order - a.order || (order === 'asc' ? a.value - b.value : b.value - a.value) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .map(({ id, order: groupOrder }) => ({ id, order: groupOrder }));
    });
    return { groups, backend: 'tantivy', position };
}

/** Id-only counterpart to searchGroups() - just discards `item` from its already-in-memory result rather than
 * running a separate id-only query, since group counts are small enough not to need that.
 * @returns {Promise<{ ids: string[], scoresById: Map<string, number>, total: number, backend: 'tantivy' | 'unavailable', position: import('./search-index-coordinator.js').GroupsIndexPosition | null }>} */
export async function searchGroupIds(handle, directories, searchTerm, maxRows, filter = {}) {
    const { results, total, backend, position } = await runGroupSearch(handle, directories, searchTerm, maxRows, filter);
    return timePhase('groups_ids', () => ({
        ids: results.map(r => r.item.id),
        scoresById: new Map(results.map(r => [r.item.id, r.score])),
        total,
        backend,
        position,
    }));
}
