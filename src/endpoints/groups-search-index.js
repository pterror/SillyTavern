import fs from 'node:fs';
import path from 'node:path';

import {
    getTagDefinitionsForIds, getEntityTagIdsForMany, getTagDeletions, getGroupFavsByIds, getGroupsVersion, getGroupChangesSince,
    getCurrentTagNameChangeSeq, getTagNameChangesSince, streamGroupIdsForTagIds, trySetMetaValues,
} from '../character-metadata-db.js';
import { streamGroupsDataBatches, readGroupsDataFiles } from './groups.js';
import { buildSchema as buildTantivySchema, buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch, DATA_FIELD, FAV_FIELD, stringToSortKey, withFavFilter, buildTagFilterQuery, fastFieldOrderValue } from './tantivy-search.js';
import { resolveSearchEngine } from './search-engine.js';
import { getSearchIndex, GROUPS_INDEX_VERSION_META_KEY, GROUPS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY } from './search-index-coordinator.js';
import { rebuildTempDir, cleanupStaleRebuildDirs, swapIndexIntoPlace } from './tantivy-engine.js';
import { timePhase } from '../search-timing.js';
import { color } from '../util.js';
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
// The group file's name, the key its doc is replaced and deleted by. Stored, so the files indexed under a group id
// can be found.
const FILE_NAME_FIELD = 'file_name';
// The id inside the group file, absent when it has none (group_changes logs the same id).
const GROUP_ID_FIELD = 'group_id';
const TANTIVY_FILTER_TEXT_FIELDS = [
    { name: TAG_IDS_FIELD, tokenizerName: 'whitespace' },
    { name: FILE_NAME_FIELD, tokenizerName: 'raw', stored: true },
    { name: GROUP_ID_FIELD, tokenizerName: 'raw' },
];

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

/** @returns {Promise<{ tagNamesFor: (groupId: string) => string, tagIdsFor: (groupId: string) => string }>} */
async function makeTagNamesResolver(directories, groupIds) {
    const assignments = await getEntityTagIdsForMany(directories, groupIds, { type: 'group' });
    const definitions = await getTagDefinitionsForIds(directories, Object.values(assignments ?? {}).flat());
    const tagsById = new Map((definitions ?? []).map(tag => [tag.id, tag]));
    const tagNamesFor = (groupId) => (assignments?.[groupId] ?? [])
        .map(id => tagsById.get(id)?.name)
        .filter(Boolean)
        .join(' ');
    const tagIdsFor = (groupId) => (assignments?.[groupId] ?? []).join(' ');
    return { tagNamesFor, tagIdsFor };
}

// Also the page size for reading the version and tag-rename logs, and for the files indexed under one group id.
const INDEX_BUILD_BATCH_SIZE = 500;
const CHECKPOINT_EVERY_N_BATCHES = 20;

const PERSIST_VERSION_RETRY_MS = 100;

// The share of a tick's budget the tag-rename loop always gets, so a version-log backlog can't starve renames.
const TAG_RENAME_BUDGET_SHARE = 0.25;

/**
 * @param {any} group
 * @returns {string | null} The id group_changes logs for the group's file: null when it has no non-empty string id.
 */
function groupIdOf(group) {
    return typeof group.id === 'string' && group.id !== '' ? group.id : null;
}

/**
 * Adds a doc per group read from its file. The fav and tag lookups cover exactly these groups.
 * @param {{ fileName: string, group: any }[]} entries As readGroupsDataFiles() returns them.
 */
async function addGroupDocs(directories, tantivy, schema, writer, entries) {
    if (entries.length === 0) return;
    const groupIds = entries.map(({ group }) => group.id);
    const { tagNamesFor, tagIdsFor } = await makeTagNamesResolver(directories, groupIds);
    const favById = await getGroupFavsByIds(directories, groupIds);
    for (const { fileName, group } of entries) {
        group.fav = !!favById[group.id];
        const groupId = groupIdOf(group);
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
            [FILE_NAME_FIELD]: fileName,
            ...(groupId !== null ? { [GROUP_ID_FIELD]: groupId } : {}),
            [DATA_FIELD]: JSON.stringify(group),
            [FAV_FIELD]: Boolean(group.fav),
        }, schema);
        writer.addDocument(doc);
    }
}

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

    let batchIndex = 0;
    for await (const batch of streamGroupsDataBatches(directories, INDEX_BUILD_BATCH_SIZE)) {
        await addGroupDocs(directories, tantivy, schema, writer, batch);

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
 * One committed catch-up. versionFrom..version and tagNameSeqFrom..tagNameSeq are the index's position before and
 * after. refreshed: group files re-read or whose entry was removed. persistSkipped: the position couldn't be
 * persisted because the database was locked, so it stayed where it was and the next tick redoes this one's work.
 * @typedef {{ changed: boolean, refreshed: number, version: number, versionFrom: number, tagNameSeq: number,
 *   tagNameSeqFrom: number, persistSkipped: boolean }} GroupsTickResult
 */

/**
 * The only writer of a user's groups index. Runs in search-index-worker.js, never in the request process.
 * Every entry is keyed by its group file's name. build() indexes every `.json` in the groups folder; tick() then
 * applies the groups version log (group_changes) and the tag-rename log (tag_name_changes) past the position the
 * index covers:
 *   - a row with a file name re-reads exactly that file, or removes its entry when the file is gone or unreadable
 *     (the build leaves such a file out too);
 *   - a row with only a group id re-reads every file indexed under that id;
 *   - a renamed tag re-reads every file indexed under the ids of the groups carrying it;
 *   - a row with neither, which only older versions logged, rebuilds in full.
 * Its position is the groups version and tag-rename seq it covers, persisted under GROUPS_INDEX_VERSION_META_KEY and
 * GROUPS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY so read-only mode can read them. When either log is behind that
 * position (a database replaced by an older one), or the tag-rename log was truncated past it, it rebuilds in full.
 * Without a metadata store there are no logs, so it rebuilds whenever the groups folder's mtime moves instead: that
 * catches groups added or removed, though not a file edited in place.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {{ tickBudgetMs?: number }} [options] tickBudgetMs: how long one tick keeps taking log pages before it
 * commits, as for the characters index.
 */
export function createGroupIndexMaintainer(directories, tantivy, { tickBudgetMs = 1000 } = {}) {
    /** @type {any} */
    let index = null;
    /** @type {any} */
    let writer = null;
    /** @type {number | null} */
    let builtVersion = null;
    /** @type {number | null} */
    let builtTagNameSeq = null;
    /** @type {number | null} */
    let builtDirMtime = null;

    const groupsDirMtime = () => fs.existsSync(directories.groups) ? fs.statSync(directories.groups).mtimeMs : 0;

    function releaseWriter() {
        if (writer) {
            writer.waitMergingThreads();
            writer = null;
        }
    }

    const positionMetaValues = () => ({
        [GROUPS_INDEX_VERSION_META_KEY]: String(builtVersion),
        [GROUPS_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY]: String(builtTagNameSeq),
    });

    /** @returns {Promise<string>} The index dir. */
    async function build() {
        // Read before the build, so a change made during it moves them again.
        const version = await getGroupsVersion(directories);
        const tagNameSeq = version === null ? null : await getCurrentTagNameChangeSeq(directories);
        const known = version !== null && tagNameSeq !== null;
        const dirMtime = groupsDirMtime();
        // Its dir is about to be swapped away; its lock goes with it.
        releaseWriter();
        const dir = await buildTantivyIndex(directories, tantivy);
        index = tantivy.Index.open(dir);
        builtVersion = known ? version : null;
        builtTagNameSeq = known ? tagNameSeq : null;
        builtDirMtime = known ? null : dirMtime;
        // Unknown: the metadata store is unavailable, so there is no position and nowhere to persist one.
        if (known) {
            // Not skipped on a lock: the new index is already in place, and the position persisted for the old one
            // would say it shows less than it does.
            while (!await trySetMetaValues(directories, positionMetaValues())) {
                await new Promise(resolve => setTimeout(resolve, PERSIST_VERSION_RETRY_MS));
            }
        }
        return dir;
    }

    /**
     * The names of the files indexed under `groupId` as of the index's last commit, a page at a time.
     * @param {any} searcher
     * @param {string} groupId
     * @returns {Generator<string, void, undefined>}
     */
    function* filesIndexedUnder(searcher, groupId) {
        if (searcher.numDocs === 0) return;
        const query = tantivy.Query.termQuery(index.schema, GROUP_ID_FIELD, groupId);
        for (let offset = 0; ; offset += INDEX_BUILD_BATCH_SIZE) {
            const { hits } = searcher.search(query, INDEX_BUILD_BATCH_SIZE, false, undefined, offset);
            for (const hit of hits) {
                const fileName = searcher.doc(hit.docAddress).getFirst(FILE_NAME_FIELD);
                if (typeof fileName === 'string') yield fileName;
            }
            if (hits.length < INDEX_BUILD_BATCH_SIZE) return;
        }
    }

    /**
     * One catch-up pass, committed at most once: version-log pages, then tag-rename pages, each until its log is
     * drained or its part of tickBudgetMs has passed, as the characters index does.
     * @returns {Promise<GroupsTickResult | { swapped: string } | null>} null: nothing to apply, or the metadata
     * store is unavailable and the groups folder's mtime hasn't moved. `swapped`: the index was rebuilt in full.
     */
    async function tick() {
        const start = Date.now();
        const maxVersion = await getGroupsVersion(directories);
        const maxTagNameSeq = maxVersion === null ? null : await getCurrentTagNameChangeSeq(directories);
        if (maxVersion === null || maxTagNameSeq === null) {
            return groupsDirMtime() === builtDirMtime ? null : { swapped: await build() };
        }
        if (index === null || builtVersion === null || builtTagNameSeq === null
            || maxVersion < builtVersion || maxTagNameSeq < builtTagNameSeq) {
            return { swapped: await build() };
        }
        if (maxVersion === builtVersion && maxTagNameSeq === builtTagNameSeq) {
            return null;
        }

        const w = writer ?? (writer = index.writer());
        const versionFrom = builtVersion;
        const tagNameSeqFrom = builtTagNameSeq;
        let lastVersion = builtVersion;
        let lastTagNameSeq = builtTagNameSeq;
        let refreshed = 0;
        /** @type {any} */
        let searcher = null;
        /**
         * The files this tick gave a doc, by the group id inside: the searcher sees only the last commit.
         * @type {Map<string, Set<string>>}
         */
        const addedUnder = new Map();
        /** @type {Set<string>} */
        let pending = new Set();

        const flush = async () => {
            if (pending.size === 0) return;
            const fileNames = [...pending];
            pending = new Set();
            for (const fileName of fileNames) w.deleteDocumentsByTerm(FILE_NAME_FIELD, fileName);
            // A name the build would never index (not a .json directly in the folder) keeps no entry.
            const present = fileNames.filter(fileName => path.basename(fileName) === fileName && path.extname(fileName) === '.json'
                && fs.existsSync(path.join(directories.groups, fileName)));
            const entries = await readGroupsDataFiles(directories, present);
            await addGroupDocs(directories, tantivy, index.schema, w, entries);
            for (const { fileName, group } of entries) {
                const groupId = groupIdOf(group);
                if (groupId === null) continue;
                if (!addedUnder.has(groupId)) addedUnder.set(groupId, new Set());
                addedUnder.get(groupId).add(fileName);
            }
            refreshed += fileNames.length;
        };
        /** @param {string} fileName */
        const refreshFile = async (fileName) => {
            pending.add(fileName);
            if (pending.size >= INDEX_BUILD_BATCH_SIZE) await flush();
        };
        /** @param {string} groupId */
        const refreshGroup = async (groupId) => {
            for (const fileName of [...(addedUnder.get(groupId) ?? [])]) await refreshFile(fileName);
            if (!searcher) {
                index.reload();
                searcher = index.searcher();
            }
            for (const fileName of filesIndexedUnder(searcher, groupId)) await refreshFile(fileName);
        };
        const rollback = () => {
            try {
                w.rollback();
            } catch (rollbackErr) {
                console.error(color.red(`[search] rollback after a failed groups catch-up also failed: ${rollbackErr.message}`));
            }
        };

        try {
            // With renames waiting, the version-log loop leaves their share of the budget to them.
            const renamesPending = maxTagNameSeq > builtTagNameSeq;
            const changesDeadline = start + (renamesPending ? tickBudgetMs * (1 - TAG_RENAME_BUDGET_SHARE) : tickBudgetMs);
            for (;;) {
                const page = await getGroupChangesSince(directories, lastVersion, { limit: INDEX_BUILD_BATCH_SIZE });
                if (!page) {
                    rollback();
                    return null;
                }
                for (const row of page.rows) {
                    if (row.fileName === null && row.groupId === null) {
                        rollback();
                        return { swapped: await build() };
                    }
                    if (row.fileName !== null) await refreshFile(row.fileName);
                    // Fav and chat stats come from the group's row, keyed by id, so every file under it shows them.
                    if (row.groupId !== null) await refreshGroup(row.groupId);
                }
                await flush();
                lastVersion = page.version;
                if (!page.hasMore || Date.now() >= changesDeadline) break;
            }

            // Always at least one page, with its share of the budget from its own start plus whatever the
            // version-log loop left unused.
            const renamesStart = Date.now();
            const renamesDeadline = renamesStart + tickBudgetMs * TAG_RENAME_BUDGET_SHARE + Math.max(0, changesDeadline - renamesStart);
            for (;;) {
                const page = await getTagNameChangesSince(directories, lastTagNameSeq, { limit: INDEX_BUILD_BATCH_SIZE });
                if (!page) {
                    rollback();
                    return null;
                }
                if (page.truncated) {
                    rollback();
                    return { swapped: await build() };
                }
                if (page.tagIds.length > 0) {
                    for await (const groupIds of streamGroupIdsForTagIds(directories, page.tagIds)) {
                        for (const groupId of groupIds) await refreshGroup(groupId);
                    }
                    await flush();
                }
                lastTagNameSeq = page.seq;
                if (!page.hasMore || Date.now() >= renamesDeadline) break;
            }
        } catch (err) {
            rollback();
            throw err;
        }

        const changed = refreshed > 0;
        if (changed) w.commit();
        builtVersion = lastVersion;
        builtTagNameSeq = lastTagNameSeq;
        let persistSkipped = false;
        if (builtVersion !== versionFrom || builtTagNameSeq !== tagNameSeqFrom) {
            persistSkipped = !await trySetMetaValues(directories, positionMetaValues());
        }
        // Rather than wait on the lock, the next tick redoes this one's work: each file it touched is deleted and
        // re-read by name, so applying it twice changes nothing.
        if (persistSkipped) {
            builtVersion = versionFrom;
            builtTagNameSeq = tagNameSeqFrom;
        }
        return { changed, refreshed, version: builtVersion, versionFrom, tagNameSeq: builtTagNameSeq, tagNameSeqFrom, persistSkipped };
    }

    return {
        build,
        tick,
        /** @returns {number | null} The groups version the index covers; null before the first build or when the
         * metadata store was unavailable. */
        version: () => builtVersion,
        /** @returns {number | null} The tag-rename-log seq the index covers; null when version() is. */
        tagNameSeq: () => builtTagNameSeq,
        /** Releases the writer's on-disk lock. */
        close: releaseWriter,
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
