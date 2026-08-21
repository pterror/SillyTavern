import fs from 'node:fs';
import path from 'node:path';

import { TAGS_FILE } from '../constants.js';
import { readTagsData } from './tags-data.js';
import { getGroupsData } from './groups.js';
import { getSqliteEngine } from './sqlite-engine.js';
import { buildFtsQuery } from './search-query.js';

/**
 * Fast full-content group search, mirroring characters-search-index.js but for groups - see that module's
 * header comment for the full rationale (why SQLite FTS5 over an in-memory JS index, how the native/wasm engine
 * fallback in sqlite-engine.js works, why freshness is a cheap stat-based check rather than push invalidation
 * from groups.js's own mutation routes - same import-cycle concern applies here, since this module needs
 * getGroupsData() *from* groups.js).
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

/** @type {Map<string, { db: import('./sqlite-engine.js').SqliteEngineHandle, signature: string }>} */
const sqliteIndexes = new Map();

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

    db.insertMany(
        `INSERT INTO groups (groupId, data, ${BM25_INDEXED_COLUMNS.join(', ')})
         VALUES (@groupId, @data, @name, @resolved_tags, @members, @id)`,
        groups.map(group => ({
            groupId: group.id,
            data: JSON.stringify(group),
            name: group.name ?? '',
            resolved_tags: tagNamesFor(group.id),
            members: Array.isArray(group.members) ? group.members.join(' ') : '',
            id: group.id ?? '',
        })),
    );

    // See characters-search-index.js's buildSqliteIndex() for why this checkpoint matters - same reasoning.
    db.checkpoint();

    return db;
}

/**
 * @param {import('./sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} searchTerm
 * @returns {{ item: object, score: number }[]} Results sorted best-first (ascending bm25 score)
 */
function querySqliteIndex(db, searchTerm) {
    const ftsQuery = buildFtsQuery(searchTerm, FIELD_LABELS);
    if (!ftsQuery) {
        return [];
    }
    const weightsArg = BM25_WEIGHTS.join(', ');
    return db.query(`SELECT groupId, data, bm25(groups, ${weightsArg}) as score FROM groups WHERE groups MATCH ? ORDER BY score`, ftsQuery)
        .map(row => ({ item: JSON.parse(row.data), score: row.score }));
}

/**
 * Fuzzy-searches a user's groups, rebuilding the persistent index first if it's missing or stale. See
 * characters-search-index.js's searchCharacters() for the full rationale behind the `backend` field - identical
 * reasoning applies here.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @returns {Promise<{ results: { item: object, score: number }[], backend: 'native' | 'wasm' | 'unavailable' }>}
 */
export async function searchGroups(handle, directories, searchTerm) {
    const signature = getFreshnessSignature(directories);
    const engine = await getSqliteEngine();

    if (!engine) {
        return { results: [], backend: 'unavailable' };
    }

    let entry = sqliteIndexes.get(handle);
    if (!entry || entry.signature !== signature) {
        entry?.db?.close();
        const db = buildSqliteIndex(directories, engine);
        entry = { db, signature };
        sqliteIndexes.set(handle, entry);
    }
    return { results: querySqliteIndex(entry.db, searchTerm), backend: engine.kind };
}
