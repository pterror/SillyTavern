import fs from 'node:fs';
import path from 'node:path';

import Fuse from 'fuse.js';

import { TAGS_FILE } from '../constants.js';
import { readTagsData } from './tags-data.js';
import { getGroupsData } from './groups.js';
import { getBetterSqlite3 } from './native-sqlite.js';
import { buildFtsQuery, hasLabelSyntax } from './search-query.js';

/**
 * Fast full-content group search, mirroring characters-search-index.js but for groups - see that module's
 * header comment for the full rationale (why SQLite FTS5 over an in-memory JS index, why better-sqlite3 needs
 * a Fuse.js fallback, why freshness is a cheap stat-based check rather than push invalidation from groups.js's
 * own mutation routes - same import-cycle concern applies here, since this module needs getGroupsData() *from*
 * groups.js).
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

/** @type {Map<string, { db: import('better-sqlite3').Database, signature: string }>} */
const sqliteIndexes = new Map();
/** @type {Map<string, { fuse: Fuse<object>, signature: string }>} */
const fuseIndexes = new Map();

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
 * @param {typeof import('better-sqlite3')} DatabaseCtor The loaded better-sqlite3 constructor
 * @returns {import('better-sqlite3').Database} The freshly built, open database handle
 */
function buildSqliteIndex(directories, DatabaseCtor) {
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

    const db = new DatabaseCtor(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE VIRTUAL TABLE groups USING fts5(
            groupId UNINDEXED,
            data UNINDEXED,
            ${BM25_INDEXED_COLUMNS.join(', ')}
        );
    `);

    const groups = getGroupsData(directories);
    const tagNamesFor = makeTagNamesResolver(directories);

    const insert = db.prepare(`
        INSERT INTO groups (groupId, data, ${BM25_INDEXED_COLUMNS.join(', ')})
        VALUES (@groupId, @data, @name, @resolved_tags, @members, @id)
    `);
    const insertMany = db.transaction((rows) => {
        for (const group of rows) {
            insert.run({
                groupId: group.id,
                data: JSON.stringify(group),
                name: group.name ?? '',
                resolved_tags: tagNamesFor(group.id),
                members: Array.isArray(group.members) ? group.members.join(' ') : '',
                id: group.id ?? '',
            });
        }
    });
    insertMany(groups);

    // See characters-search-index.js's buildSqliteIndex() for why this checkpoint matters - same reasoning.
    db.pragma('wal_checkpoint(TRUNCATE)');

    return db;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} searchTerm
 * @returns {{ item: object, score: number }[]} Results sorted best-first (ascending bm25 score)
 */
function querySqliteIndex(db, searchTerm) {
    const ftsQuery = buildFtsQuery(searchTerm, FIELD_LABELS);
    if (!ftsQuery) {
        return [];
    }
    const weightsArg = BM25_WEIGHTS.join(', ');
    const stmt = db.prepare(`SELECT groupId, data, bm25(groups, ${weightsArg}) as score FROM groups WHERE groups MATCH ? ORDER BY score`);
    return stmt.all(ftsQuery).map(row => ({ item: JSON.parse(row.data), score: row.score }));
}

/**
 * Fallback path used only when better-sqlite3 isn't usable on this install (see native-sqlite.js) - identical
 * in shape and options to this file's original Fuse.js-only implementation.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Fuse<object>}
 */
function buildFuseFallbackIndex(directories) {
    const data = getGroupsData(directories);
    const tagNamesFor = makeTagNamesResolver(directories);

    const keys = [
        { name: 'name', weight: 20 },
        { name: 'members', weight: 15 },
        { name: '#tags', weight: 10, getFn: (group) => tagNamesFor(group.id) },
        { name: 'id', weight: 1 },
    ];

    return new Fuse(data, {
        keys,
        includeScore: true,
        ignoreLocation: true,
        useExtendedSearch: true,
        threshold: 0.2,
    });
}

/**
 * Fuzzy-searches a user's groups, rebuilding the persistent index first if it's missing or stale. Tries the
 * fast SQLite FTS5 backend first, falling back to Fuse.js if better-sqlite3 isn't usable on this install.
 * See characters-search-index.js's searchCharacters() for the full rationale behind the `backend` and
 * `labelSyntaxUnsupported` fields - identical reasoning applies here.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @returns {Promise<{ results: { item: object, score: number }[], backend: 'sqlite' | 'fuse', labelSyntaxUnsupported: boolean }>}
 */
export async function searchGroups(handle, directories, searchTerm) {
    const signature = getFreshnessSignature(directories);
    const DatabaseCtor = await getBetterSqlite3();

    if (DatabaseCtor) {
        let entry = sqliteIndexes.get(handle);
        if (!entry || entry.signature !== signature) {
            entry?.db?.close();
            const db = buildSqliteIndex(directories, DatabaseCtor);
            entry = { db, signature };
            sqliteIndexes.set(handle, entry);
        }
        return { results: querySqliteIndex(entry.db, searchTerm), backend: 'sqlite', labelSyntaxUnsupported: false };
    }

    if (hasLabelSyntax(searchTerm, FIELD_LABELS)) {
        return { results: [], backend: 'fuse', labelSyntaxUnsupported: true };
    }

    let entry = fuseIndexes.get(handle);
    if (!entry || entry.signature !== signature) {
        const fuse = buildFuseFallbackIndex(directories);
        entry = { fuse, signature };
        fuseIndexes.set(handle, entry);
    }
    return { results: entry.fuse.search(searchTerm), backend: 'fuse', labelSyntaxUnsupported: false };
}
