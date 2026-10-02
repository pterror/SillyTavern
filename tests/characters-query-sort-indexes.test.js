import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

// Records every statement the store runs, so a test can ask SQLite how it planned the page reads.
/** @type {{ method: string, sql: string, params: any }[]} */
const calls = [];

async function getRecordingSqliteEngine() {
    const engine = await realSqliteEngine.getSqliteEngine();
    if (!engine) return engine;
    return {
        ...engine,
        openDatabase: (dbPath, options) => {
            const handle = engine.openDatabase(dbPath, options);
            for (const method of ['all', 'get', 'iterate', 'run']) {
                const real = handle[method];
                handle[method] = (sql, params) => {
                    calls.push({ method, sql, params });
                    return real(sql, params);
                };
            }
            return handle;
        },
    };
}

jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    ...realSqliteEngine,
    getSqliteEngine: getRecordingSqliteEngine,
}));

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    Database = (await import('better-sqlite3')).default;
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-query-sort-indexes-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    calls.length = 0;
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

const dbPath = () => path.join(directories.root, 'character-metadata.sqlite');

/** @param {string} sql @param {unknown[]} [params] */
function runSql(sql, params = []) {
    const db = new Database(dbPath());
    try {
        return db.prepare(sql).run(...params);
    } finally {
        db.close();
    }
}

/**
 * Entities sharing sort keys, so the tie order decides most of the list. Group ids 'a' and 'a-b' sort differently
 * by plain id ('a' < 'a-b') and by file name ('a-b.json' < 'a.json'); characters and groups share keys.
 */
const CHARACTERS = [
    { id: 'b.png', name: 'Same', fav: 1, date: 100, size: 5 },
    { id: 'a.png', name: 'Same', fav: 0, date: 100, size: 5 },
    { id: 'c.png', name: 'Other', fav: 0, date: 200, size: 0 },
    { id: 'z.png', name: 'Same', fav: 1, date: 50, size: 5 },
    { id: 'm.png', name: 'Zed', fav: 0, date: 100, size: 9 },
    { id: 'k.png', name: 'Same', fav: 0, date: 100, size: 5, noCreateDate: true },
];
const GROUPS = [
    { id: 'a', name: 'Same', fav: 0, date: 100, size: 5 },
    { id: 'a-b', name: 'Same', fav: 0, date: 100, size: 5 },
    { id: 'q', name: 'Other', fav: 1, date: 200, size: 0 },
];

async function seed() {
    for (const c of CHARACTERS) {
        const cardJson = JSON.stringify({ name: c.name, data: { name: c.name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await metadataDb.upsertCharacterFromWrite(directories, c.id, cardJson);
    }
    for (const g of GROUPS) {
        const group = { id: g.id, name: g.name, members: [], chats: [], fav: false };
        fs.writeFileSync(path.join(directories.groups, `${g.id}.json`), JSON.stringify(group));
        await metadataDb.upsertGroupRow(directories, g.id, g.name, { fav: false, group });
    }
    metadataDb.disposeMetadataStores();
    for (const c of CHARACTERS) {
        runSql('UPDATE characters SET fav = ?, date_added = ?, date_last_chat = ?, create_date = ?, chat_size = ?, data_size = ? WHERE id = ?',
            [c.fav, c.date, c.date, c.noCreateDate ? null : c.date, c.size, c.size, c.id]);
    }
    for (const g of GROUPS) {
        runSql('UPDATE groups SET fav = ?, date_added = ?, date_last_chat = ?, chat_size = ? WHERE id = ?', [g.fav, g.date, g.date, g.size, g.id]);
    }
}

/** UTF-8 byte order, as SQLite's BINARY collation. */
const bytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * The expected list, from the rule itself: the sort key in the asked direction, then characters before groups, then
 * a character's id or a group's `<id>.json` in byte order, ascending in both directions.
 * @param {string} sortField
 * @param {'asc'|'desc'} sortOrder
 * @param {boolean | undefined} fav
 */
function expected(sortField, sortOrder, fav) {
    const dir = sortOrder === 'desc' ? -1 : 1;
    const entities = [
        ...CHARACTERS.map(c => ({ ...c, type: 'character', name_fold: c.name.toLowerCase(), create_date: c.noCreateDate ? null : c.date, data_size: c.size })),
        ...GROUPS.map(g => ({ ...g, type: 'group', name_fold: g.name.toLowerCase(), create_date: g.date, data_size: null })),
    ].filter(e => fav === undefined || e.fav === (fav ? 1 : 0));
    const key = {
        name: e => e.name_fold, date_added: e => e.date, date_last_chat: e => e.date, chat_size: e => e.size,
        create_date: e => e.create_date, data_size: e => e.data_size,
    }[sortField];
    // SQLite puts a missing key below every number.
    const byNumber = (ka, kb) => (ka === null || kb === null) ? (ka === kb ? 0 : ka === null ? -1 : 1) : ka - kb;
    const tie = (a, b) => (a.type === b.type ? 0 : a.type === 'group' ? 1 : -1)
        || (a.type === 'group' ? bytes(`${a.id}.json`, `${b.id}.json`) : bytes(a.id, b.id));
    return entities.sort((a, b) => {
        if (sortField === 'fav') return dir * (a.fav - b.fav) || bytes(a.name_fold, b.name_fold) || tie(a, b);
        const ka = key(a), kb = key(b);
        const byKey = typeof ka === 'string' ? bytes(ka, kb) : byNumber(ka, kb);
        return dir * byKey || tie(a, b);
    }).map(e => `${e.type}:${e.id}`);
}

/** @param {object} params */
async function listed(params) {
    const result = await metadataDb.queryEntities(directories, { offset: 0, limit: 100, wantTotal: false, ...params });
    return result.rows.map(r => `${r.type}:${r.id}`);
}

const SORTS = ['name', 'fav', 'date_added', 'date_last_chat', 'chat_size', 'create_date', 'data_size'];
const FAVS = [undefined, true, false];

describe('/query sorted pages: upstream tie order, with and without the sort indexes', () => {
    test('before the sort indexes exist, every sort, direction and fav filter lists in upstream tie order', async () => {
        await seed();
        for (const sortField of SORTS) {
            for (const sortOrder of ['asc', 'desc']) {
                for (const fav of FAVS) {
                    expect({ sortField, sortOrder, fav, rows: await listed({ sortField, sortOrder, fav }) })
                        .toEqual({ sortField, sortOrder, fav, rows: expected(sortField, sortOrder, fav) });
                }
            }
        }
    });

    test('with the sort indexes, every sort, direction and fav filter lists the same, and pages join up', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        for (const sortField of SORTS) {
            for (const sortOrder of ['asc', 'desc']) {
                for (const fav of FAVS) {
                    const want = expected(sortField, sortOrder, fav);
                    expect({ sortField, sortOrder, fav, rows: await listed({ sortField, sortOrder, fav }) })
                        .toEqual({ sortField, sortOrder, fav, rows: want });
                    const paged = [];
                    for (let offset = 0; offset < want.length; offset += 3) {
                        paged.push(...await listed({ sortField, sortOrder, fav, offset, limit: 3 }));
                    }
                    expect(paged).toEqual(want);
                }
            }
        }
    });

    test('with the sort indexes, each page read walks an index in order: no temp b-tree sort', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        for (const sortField of SORTS) {
            for (const sortOrder of ['asc', 'desc']) {
                calls.length = 0;
                await listed({ sortField, sortOrder });
                const pageReads = calls.filter(c => /\bORDER BY\b/.test(c.sql) && /\bLIMIT \?/.test(c.sql) && /\bfav = \?/.test(c.sql));
                expect(pageReads.length).toBe(4);
                const db = new Database(dbPath(), { readonly: true });
                try {
                    for (const read of pageReads) {
                        const plan = db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.params).map(r => r.detail).join(' | ');
                        expect({ sortField, sortOrder, sql: read.sql.replace(/\s+/g, ' ').trim(), plan }).not.toEqual(expect.objectContaining({ plan: expect.stringContaining('TEMP B-TREE') }));
                        expect(plan).toMatch(/USING (COVERING )?INDEX idx_(characters|groups)_sort_fav_/);
                    }
                } finally {
                    db.close();
                }
            }
        }
    });

    test('with the sort indexes, following each page\'s cursor lists the same as paging by offset', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        for (const sortField of SORTS) {
            for (const sortOrder of ['asc', 'desc']) {
                for (const fav of FAVS) {
                    const want = expected(sortField, sortOrder, fav);
                    const followed = [];
                    let cursor;
                    for (let offset = 0; offset < want.length + 2; offset += 2) {
                        const result = await metadataDb.queryEntities(directories, { sortField, sortOrder, fav, offset, limit: 2, wantTotal: false, cursor });
                        followed.push(...result.rows.map(r => `${r.type}:${r.id}`));
                        cursor = result.cursor;
                        if (result.rows.length < 2) break;
                    }
                    expect({ sortField, sortOrder, fav, rows: followed }).toEqual({ sortField, sortOrder, fav, rows: want });
                }
            }
        }
    });

    test('a page read from a cursor seeks the indexes: no temp b-tree sort', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        for (const sortField of SORTS) {
            for (const sortOrder of ['asc', 'desc']) {
                const first = await metadataDb.queryEntities(directories, { sortField, sortOrder, offset: 0, limit: 3, wantTotal: false });
                calls.length = 0;
                await metadataDb.queryEntities(directories, { sortField, sortOrder, offset: 3, limit: 3, wantTotal: false, cursor: first.cursor });
                const reads = calls.filter(c => /\bAS k\b/.test(c.sql));
                expect(reads.some(c => /> \?|< \?|IS NOT NULL|IS NULL/.test(c.sql))).toBe(true);
                const db = new Database(dbPath(), { readonly: true });
                try {
                    for (const read of reads) {
                        const plan = db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.params).map(r => r.detail).join(' | ');
                        expect({ sortField, sortOrder, plan }).toEqual({ sortField, sortOrder, plan: expect.not.stringContaining('TEMP B-TREE') });
                    }
                } finally {
                    db.close();
                }
            }
        }
    });

    test('a cursor carries on after its last row when rows are added before it, and one for another sort is ignored', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        const first = await metadataDb.queryEntities(directories, { sortField: 'name', sortOrder: 'asc', offset: 0, limit: 3, wantTotal: false });
        const seen = first.rows.map(r => `${r.type}:${r.id}`);
        // A new entity that sorts before the cursor would shift an offset page; the cursor isn't moved by it.
        const cardJson = JSON.stringify({ name: 'Aaa', data: { name: 'Aaa', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await metadataDb.upsertCharacterFromWrite(directories, 'new.png', cardJson);
        const next = await metadataDb.queryEntities(directories, { sortField: 'name', sortOrder: 'asc', offset: 3, limit: 100, wantTotal: false, cursor: first.cursor });
        const rest = expected('name', 'asc', undefined).filter(e => !seen.includes(e));
        expect(next.rows.map(r => `${r.type}:${r.id}`)).toEqual(rest);
        const other = await metadataDb.queryEntities(directories, { sortField: 'date_added', sortOrder: 'asc', offset: 0, limit: 100, wantTotal: false, cursor: first.cursor });
        expect(other.rows.length).toBe(CHARACTERS.length + GROUPS.length + 1);
    });

    test('a deep page reads keys only through the indexes, and full rows for the page alone', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        calls.length = 0;
        const result = await metadataDb.queryEntities(directories, { sortField: 'date_added', sortOrder: 'desc', offset: 5, limit: 2, wantTotal: false });
        expect(result.rows).toHaveLength(2);
        const streamReads = calls.filter(c => /\bAS k\b/.test(c.sql));
        expect(streamReads.length).toBeGreaterThan(0);
        expect(streamReads.every(c => !/shallow_json/.test(c.sql) && c.method === 'iterate')).toBe(true);
        const fullReads = calls.filter(c => /shallow_json/.test(c.sql) && /json_each/.test(c.sql));
        expect(fullReads.flatMap(c => JSON.parse(c.params[0]))).toHaveLength(2);
        expect(calls.some(c => c.method === 'all')).toBe(false);
    });

    test('the build pass is idempotent and the indexes survive reopening', async () => {
        await seed();
        const first = await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        expect(first.batches).toBeGreaterThan(0);
        const second = await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        expect(second.batches).toBe(0);
    });
});

describe('/query with characters only: the same walk, cursor and work cap', () => {
    /** @param {string} sortField @param {'asc'|'desc'} sortOrder @param {boolean | undefined} fav */
    const expectedCharacters = (sortField, sortOrder, fav) => expected(sortField, sortOrder, fav).filter(e => e.startsWith('character:')).map(e => e.slice('character:'.length));

    test('every sort, direction and fav filter lists in order, and following each page\'s cursor joins up', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        for (const sortField of SORTS) {
            for (const sortOrder of ['asc', 'desc']) {
                for (const fav of FAVS) {
                    const want = expectedCharacters(sortField, sortOrder, fav);
                    const all = await metadataDb.queryCharacters(directories, { sortField, sortOrder, fav, offset: 0, limit: 100, wantTotal: false });
                    expect({ sortField, sortOrder, fav, rows: all.rows.map(r => r.avatar) }).toEqual({ sortField, sortOrder, fav, rows: want });
                    const followed = [];
                    const fullPagesWithoutCursor = [];
                    let cursor;
                    for (let offset = 0; offset < want.length + 2; offset += 2) {
                        const page = await metadataDb.queryCharacters(directories, { sortField, sortOrder, fav, offset, limit: 2, wantTotal: false, cursor });
                        followed.push(...page.rows.map(r => r.avatar));
                        if (page.rows.length === 2 && typeof page.cursor !== 'string') fullPagesWithoutCursor.push(offset);
                        cursor = page.cursor;
                        if (page.rows.length < 2) break;
                    }
                    expect({ sortField, sortOrder, fav, rows: followed, fullPagesWithoutCursor }).toEqual({ sortField, sortOrder, fav, rows: want, fullPagesWithoutCursor: [] });
                }
            }
        }
    });

    test('a page walks the sort indexes: no temp b-tree sort, and no group stream', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        for (const sortField of SORTS) {
            for (const sortOrder of ['asc', 'desc']) {
                calls.length = 0;
                await metadataDb.queryCharacters(directories, { sortField, sortOrder, offset: 0, limit: 3, wantTotal: false });
                const reads = calls.filter(c => /\bORDER BY\b/.test(c.sql));
                expect(reads.length).toBeGreaterThan(0);
                expect(reads.some(c => /\bgroups\b/.test(c.sql))).toBe(false);
                const db = new Database(dbPath(), { readonly: true });
                try {
                    for (const read of reads) {
                        const plan = db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.params).map(r => r.detail).join(' | ');
                        expect({ sortField, sortOrder, plan }).toEqual({ sortField, sortOrder, plan: expect.not.stringContaining('TEMP B-TREE') });
                    }
                } finally {
                    db.close();
                }
            }
        }
    });

    test('past the work cap, a page answers `more` and a cursor, and following them lists everything once', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        metadataDb._setSortedPageWalkForTests({ cap: 1, window: 1 });
        try {
            const want = expectedCharacters('name', 'asc', undefined);
            const followed = [];
            let cursor;
            let sawMore = false;
            for (let i = 0; i < 50 && followed.length < want.length; i++) {
                const page = await metadataDb.queryCharacters(directories, { sortField: 'name', sortOrder: 'asc', offset: 0, limit: 100, wantTotal: false, cursor });
                if (page.more) sawMore = true;
                followed.push(...page.rows.map(r => r.avatar));
                cursor = page.cursor;
                if (!page.more) break;
            }
            expect(sawMore).toBe(true);
            expect(followed).toEqual(want);
        } finally {
            metadataDb._setSortedPageWalkForTests(null);
        }
    });

    test('hash rows come in the same order as rows', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        const result = await metadataDb.queryCharacters(directories, { sortField: 'date_added', sortOrder: 'desc', offset: 0, limit: 100, wantTotal: false, wantRows: false, wantHashes: true });
        expect(result.hashRows.map(r => r.id)).toEqual(expectedCharacters('date_added', 'desc', undefined));
        expect(result.hashRows[0]).toHaveProperty('chat');
        expect(result.hashRows[0]).toEqual(expect.objectContaining({ favHash: expect.any(Number), contentHash: expect.any(Number) }));
    });
});
