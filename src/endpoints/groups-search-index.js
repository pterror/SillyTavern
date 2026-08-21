import fs from 'node:fs';
import path from 'node:path';

import { TAGS_FILE } from '../constants.js';
import { readTagsData } from './tags-data.js';
import { getGroupsData } from './groups.js';
import { getSqliteEngine } from './sqlite-engine.js';
import { buildFtsQuery } from './search-query.js';
import { createIndexCoordinator } from './search-index-coordinator.js';

/**
 * Fast full-content group search, mirroring characters-search-index.js but for groups - see that module's
 * header comment for the full rationale (why SQLite FTS5 over an in-memory JS index, how the native/wasm engine
 * fallback in sqlite-engine.js works, why freshness is a cheap stat-based check rather than push invalidation
 * from groups.js's own mutation routes - same import-cycle concern applies here, since this module needs
 * getGroupsData() *from* groups.js). Rebuild coordination (no blocking on a stale-but-usable index, no racing
 * rebuilds from concurrent requests) is shared with characters-search-index.js via search-index-coordinator.js -
 * see that module's header for the full rationale and the production incident that motivated it.
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

/** @type {ReturnType<typeof createIndexCoordinator<import('./sqlite-engine.js').SqliteEngineHandle>>} */
const indexCoordinator = createIndexCoordinator();

/**
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string} A cheap fingerprint that changes whenever a group or tags.json is added/removed/edited
 */
function getFreshnessSignature(directories) {
    const groupsDirMtime = fs.existsSync(directories.groups) ? fs.statSync(directories.groups).mtimeMs : 0;
    const pathToTags = path.join(directories.root, TAGS_FILE);
    const tagsMtime = fs.existsSync(pathToTags) ? fs.statSync(pathToTags).mtimeMs : 0;
    return `${groupsDirMtime}:${tagsMtime}`;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {(groupId: string) => string} Resolves a group's tag names (space-joined) from tags.json
 */
function makeTagNamesResolver(directories) {
    const { tags, tag_map } = readTagsData(directories);
    const tagsById = new Map(tags.map(tag => [tag.id, tag]));
    return (groupId) => (tag_map[groupId] ?? [])
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
 * @returns {import('./sqlite-engine.js').SqliteEngineHandle} The freshly built, open database handle
 */
function buildSqliteIndex(directories, engine) {
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
            ${BM25_INDEXED_COLUMNS.join(', ')}
        );
    `);

    const groups = getGroupsData(directories);
    const tagNamesFor = makeTagNamesResolver(directories);
    const insertSql = `INSERT INTO groups (groupId, data, ${BM25_INDEXED_COLUMNS.join(', ')})
         VALUES (@groupId, @data, @name, @resolved_tags, @members, @id)`;

    let batchIndex = 0;
    for (let i = 0; i < groups.length; i += INDEX_BUILD_BATCH_SIZE) {
        const rows = groups.slice(i, i + INDEX_BUILD_BATCH_SIZE).map(group => ({
            groupId: group.id,
            data: JSON.stringify(group),
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
 * @param {import('./sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} searchTerm
 * @param {number} [maxRows] Caps how many matching rows get fetched and JSON.parse()'d - see
 * characters-search-index.js's querySqliteIndex() for the full rationale (that module's version of this same
 * unbounded fetch is what actually OOM'd this server on a real install).
 * @returns {{ item: object, score: number }[]} Results sorted best-first (ascending bm25 score)
 */
function querySqliteIndex(db, searchTerm, maxRows) {
    const ftsQuery = buildFtsQuery(searchTerm, FIELD_LABELS);
    if (!ftsQuery) {
        return [];
    }
    const weightsArg = BM25_WEIGHTS.join(', ');
    // maxRows is always a value this module computed via Number.isFinite + Math.trunc (see searchGroups()),
    // never raw request input, so interpolating it directly is safe - it can only ever be digits/a minus sign.
    const limitClause = Number.isFinite(maxRows) ? ` LIMIT ${Math.max(0, Math.trunc(maxRows))}` : '';
    return db.query(`SELECT groupId, data, bm25(groups, ${weightsArg}) as score FROM groups WHERE groups MATCH ? ORDER BY score${limitClause}`, ftsQuery)
        .map(row => ({ item: JSON.parse(row.data), score: row.score }));
}

/**
 * Counts how many rows match a query, independent of `maxRows` - see characters-search-index.js's
 * countSqliteIndexMatches() for the full rationale (identical reasoning applies here).
 * @param {import('./sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} searchTerm
 * @returns {number} Total number of matching rows
 */
function countSqliteIndexMatches(db, searchTerm) {
    const ftsQuery = buildFtsQuery(searchTerm, FIELD_LABELS);
    if (!ftsQuery) {
        return 0;
    }
    const [row] = db.query('SELECT COUNT(*) as total FROM groups WHERE groups MATCH ?', ftsQuery);
    return row ? Number(row.total) : 0;
}

/**
 * Fuzzy-searches a user's groups, rebuilding the persistent index first if it's missing or stale. See
 * characters-search-index.js's searchCharacters() for the full rationale behind the `backend` field - identical
 * reasoning applies here.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @param {number} [maxRows] Forwarded to querySqliteIndex() - see that function's doc comment.
 * @returns {Promise<{ results: { item: object, score: number }[], total: number, backend: 'native' | 'wasm' | 'unavailable' }>}
 * `total` is the true match count, independent of `maxRows` - see countSqliteIndexMatches().
 */
export async function searchGroups(handle, directories, searchTerm, maxRows) {
    const signature = getFreshnessSignature(directories);
    const engine = await getSqliteEngine();

    if (!engine) {
        return { results: [], total: 0, backend: 'unavailable' };
    }

    const db = await indexCoordinator.getIndex(handle, signature, () => buildSqliteIndex(directories, engine));
    return {
        results: querySqliteIndex(db, searchTerm, maxRows),
        total: countSqliteIndexMatches(db, searchTerm),
        backend: engine.kind,
    };
}
