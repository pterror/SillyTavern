import fs from 'node:fs';
import path from 'node:path';

import { getTagDefinitions, getEntityTagIdsForMany, getTagsRevision } from '../character-metadata-db.js';
import { getGroupsData } from './groups.js';
import { buildFtsQuery } from './search-query.js';
import { buildSchema as buildTantivySchema, buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch, DATA_FIELD, FAV_FIELD } from './tantivy-search.js';
import { resolveSearchEngine } from './search-engine.js';
import { createIndexCoordinator } from './search-index-coordinator.js';

/**
 * Fast full-content group search, mirroring characters-search-index.js but for groups - see that module's
 * header comment for the full rationale (why tantivy is the primary engine and SQLite FTS5 a fallback chain, how
 * the tantivy/native/wasm resolution in search-engine.js works, why freshness is a cheap stat-based check rather
 * than push invalidation from groups.js's own mutation routes - same import-cycle concern applies here, since
 * this module needs getGroupsData() *from* groups.js). Rebuild coordination (no blocking on a stale-but-usable
 * index, no racing rebuilds from concurrent requests) is shared with characters-search-index.js via
 * search-index-coordinator.js - see that module's header for the full rationale and the production incident
 * that motivated it.
 */

// Column order/weights mirror fuzzySearchGroups() in public/scripts/power-user.js (and this file's original
// Fuse-based version) exactly.
const BM25_INDEXED_COLUMNS = ['name', 'resolved_tags', 'members', 'id'];
const BM25_WEIGHTS = [20, 10, 15, 1];

// `label:value` search syntax - see search-query.js and characters-search-index.js's FIELD_LABELS for the full
// rationale. Groups only have this smaller set of indexed columns.
const FIELD_LABELS = {
    name: 'name',
    tag: 'resolved_tags',
    tags: 'resolved_tags',
    member: 'members',
    members: 'members',
    id: 'id',
};

// tantivy-search.js's field-name-array equivalent of FIELD_LABELS/BM25_WEIGHTS above - see
// characters-search-index.js's TANTIVY_FIELD_WEIGHTS/TANTIVY_FIELD_LABELS for the full rationale (identical here,
// just the smaller groups field set).
const TANTIVY_FIELD_WEIGHTS = Object.fromEntries(BM25_INDEXED_COLUMNS.map((name, i) => [name, BM25_WEIGHTS[i]]));
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

/** @type {ReturnType<typeof createIndexCoordinator<import('./sqlite-engine.js').SqliteEngineHandle>>} */
const indexCoordinator = createIndexCoordinator();

/**
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Promise<string>} A cheap fingerprint that changes whenever a group is added/removed/edited or a tag
 * definition/assignment changes (getTagsRevision() - see character-metadata-db.js - replaces the old
 * tags.json-mtime half of this signature now that tags.json is gone)
 */
async function getFreshnessSignature(directories) {
    const groupsDirMtime = fs.existsSync(directories.groups) ? fs.statSync(directories.groups).mtimeMs : 0;
    const tagsRev = await getTagsRevision(directories);
    return `${groupsDirMtime}:${tagsRev}`;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} groupIds Every group id about to be indexed - fetched once up front so this resolves with
 * two batched sqlite reads total (tag definitions + getEntityTagIdsForMany()) rather than one getGroupTagIds()
 * call per group - see characters-search-index.js's makeTagNamesResolver() for the full rationale.
 * @returns {Promise<(groupId: string) => string>} A sync closure over the pre-fetched data, resolving a group's
 * tag names (space-joined)
 */
async function makeTagNamesResolver(directories, groupIds) {
    const [definitions, assignments] = await Promise.all([
        getTagDefinitions(directories),
        getEntityTagIdsForMany(directories, groupIds),
    ]);
    const tagsById = new Map((definitions ?? []).map(tag => [tag.id, tag]));
    return (groupId) => (assignments?.[groupId] ?? [])
        .map(id => tagsById.get(id)?.name)
        .filter(Boolean)
        .join(' ');
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
 * (Re)builds the persistent on-disk SQLite FTS5 index for a user's groups.
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
    const dbPath = path.join(dbDir, 'groups.db');

    for (const suffix of ['', '-wal', '-shm']) {
        const filePath = dbPath + suffix;
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    const db = engine.openDatabase(dbPath);
    db.exec(`
        CREATE VIRTUAL TABLE groups USING fts5(
            groupId UNINDEXED,
            data UNINDEXED,
            fav UNINDEXED,
            ${BM25_INDEXED_COLUMNS.join(', ')}
        );
    `);

    const groups = getGroupsData(directories);
    const tagNamesFor = await makeTagNamesResolver(directories, groups.map(group => group.id));
    const insertSql = `INSERT INTO groups (groupId, data, fav, ${BM25_INDEXED_COLUMNS.join(', ')})
         VALUES (@groupId, @data, @fav, @name, @resolved_tags, @members, @id)`;

    let batchIndex = 0;
    for (let i = 0; i < groups.length; i += INDEX_BUILD_BATCH_SIZE) {
        const rows = groups.slice(i, i + INDEX_BUILD_BATCH_SIZE).map(group => ({
            groupId: group.id,
            data: JSON.stringify(group),
            // Boolean, not a string - see characters-search-index.js's buildSqliteIndex() for why SQLite gets 0/1.
            fav: group.fav ? 1 : 0,
            name: group.name ?? '',
            resolved_tags: tagNamesFor(group.id),
            members: Array.isArray(group.members) ? group.members.join(' ') : '',
            id: group.id ?? '',
        }));
        db.insertMany(insertSql, rows);

        batchIndex++;
        if (batchIndex % CHECKPOINT_EVERY_N_BATCHES === 0) {
            db.checkpoint();
        }
    }

    // Final checkpoint (native engine only) - see characters-search-index.js's buildSqliteIndex() for why this
    // matters, same reasoning.
    db.checkpoint();

    return db;
}

/**
 * (Re)builds the persistent on-disk tantivy index for a user's groups - the tantivy-tier equivalent of
 * buildSqliteIndex() above. See characters-search-index.js's buildTantivyIndex() for the full rationale (same
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

    const schema = buildTantivySchema(tantivy, BM25_INDEXED_COLUMNS);
    const index = new tantivy.Index(schema, indexDir, false);
    const writer = index.writer();

    const groups = getGroupsData(directories);
    const tagNamesFor = await makeTagNamesResolver(directories, groups.map(group => group.id));

    let batchIndex = 0;
    for (let i = 0; i < groups.length; i += INDEX_BUILD_BATCH_SIZE) {
        const batch = groups.slice(i, i + INDEX_BUILD_BATCH_SIZE);
        for (const group of batch) {
            const doc = tantivy.Document.fromDict({
                name: group.name ?? '',
                resolved_tags: tagNamesFor(group.id),
                members: Array.isArray(group.members) ? group.members.join(' ') : '',
                id: group.id ?? '',
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
 * @param {import('./sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} searchTerm
 * @param {number} [maxRows] Caps how many matching rows get fetched and JSON.parse()'d - see
 * characters-search-index.js's querySqliteIndex() for the full rationale (that module's version of this same
 * unbounded fetch is what actually OOM'd this server on a real install).
 * @param {boolean} [favOnly] Same `AND fav = 1` predicate as characters-search-index.js's querySqliteIndex() -
 * see that function's doc comment for why this has to be applied inside the query, before `LIMIT`.
 * @returns {{ item: object, score: number }[]} Results sorted best-first (ascending bm25 score)
 */
function querySqliteIndex(db, searchTerm, maxRows, favOnly) {
    const ftsQuery = buildFtsQuery(searchTerm, FIELD_LABELS);
    if (!ftsQuery) {
        return [];
    }
    const weightsArg = BM25_WEIGHTS.join(', ');
    // maxRows is always a value this module computed via Number.isFinite + Math.trunc (see searchGroups()),
    // never raw request input, so interpolating it directly is safe - it can only ever be digits/a minus sign.
    const limitClause = Number.isFinite(maxRows) ? ` LIMIT ${Math.max(0, Math.trunc(maxRows))}` : '';
    const favClause = favOnly ? ' AND fav = 1' : '';
    return db.query(`SELECT groupId, data, bm25(groups, ${weightsArg}) as score FROM groups WHERE groups MATCH ?${favClause} ORDER BY score${limitClause}`, ftsQuery)
        .map(row => ({ item: JSON.parse(row.data), score: row.score }));
}

/**
 * Counts how many rows match a query, independent of `maxRows` - see characters-search-index.js's
 * countSqliteIndexMatches() for the full rationale (identical reasoning applies here).
 * @param {import('./sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} searchTerm
 * @param {boolean} [favOnly] Same `AND fav = 1` predicate as querySqliteIndex() above, kept in sync.
 * @returns {number} Total number of matching rows
 */
function countSqliteIndexMatches(db, searchTerm, favOnly) {
    const ftsQuery = buildFtsQuery(searchTerm, FIELD_LABELS);
    if (!ftsQuery) {
        return 0;
    }
    const favClause = favOnly ? ' AND fav = 1' : '';
    const [row] = db.query(`SELECT COUNT(*) as total FROM groups WHERE groups MATCH ?${favClause}`, ftsQuery);
    return row ? Number(row.total) : 0;
}

/**
 * Fuzzy-searches a user's groups, rebuilding the persistent index first if it's missing or stale. See
 * characters-search-index.js's searchCharacters() for the full rationale behind the `backend` field and the
 * tantivy-first engine resolution - identical reasoning applies here.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @param {number} [maxRows] Forwarded to querySqliteIndex()/runTantivySearch() - see those functions' doc
 * comments.
 * @param {boolean} [favOnly] Forwarded to querySqliteIndex()/countSqliteIndexMatches()/buildTantivyQuery() -
 * restricts matches to favorited groups, applied inside the query itself so it composes correctly with
 * `maxRows` - see characters-search-index.js's searchCharacters() `favOnly` doc for the full rationale.
 * @returns {Promise<{ results: { item: object, score: number }[], total: number, backend: 'tantivy' | 'native' | 'wasm' | 'unavailable' }>}
 * `total` is the true match count, independent of `maxRows`.
 */
export async function searchGroups(handle, directories, searchTerm, maxRows, favOnly) {
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
        // Groups still store the full group JSON in DATA_FIELD (see that constant's doc comment,
        // tantivy-search.js) - runSearch() no longer parses it for the caller, since characters-search-index.js's
        // id-only payload has nothing to parse, so this tier does it here instead.
        const items = results.map(r => ({ item: JSON.parse(r.raw), score: r.score }));
        return { results: items, total, backend: 'tantivy' };
    }

    const db = await indexCoordinator.getIndex(handle, signature, () => buildSqliteIndex(directories, engine.sqlite));
    return {
        results: querySqliteIndex(db, searchTerm, maxRows, favOnly),
        total: countSqliteIndexMatches(db, searchTerm, favOnly),
        backend: engine.sqlite.kind,
    };
}
