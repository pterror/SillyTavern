import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';

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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-query-tag-sort-test-'));
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

/** Runs statements on a connection of its own, with the store closed, so the store's triggers are what keep up. */
function withDb(fn) {
    metadataDb.disposeMetadataStores();
    const db = new Database(dbPath());
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

// Entities with sort keys that tie, and tags: T1 on most, T2 on some, T3 on few.
const CHARACTERS = [
    { id: 'b.png', name: 'Same', fav: 1, date: 100, size: 5, tags: ['T1', 'T2'] },
    { id: 'a.png', name: 'Same', fav: 0, date: 100, size: 5, tags: ['T1'] },
    { id: 'c.png', name: 'Other', fav: 0, date: 200, size: 0, tags: ['T1', 'T2', 'T3'] },
    { id: 'z.png', name: 'Same', fav: 1, date: 50, size: 5, tags: ['T2'] },
    { id: 'm.png', name: 'Zed', fav: 0, date: 100, size: 9, tags: ['T1', 'T3'] },
    { id: 'n.png', name: 'Alpha', fav: 0, date: 300, size: 1, tags: [] },
];
const GROUPS = [
    { id: 'a', name: 'Same', fav: 0, date: 100, size: 5, tags: ['T1'] },
    { id: 'a-b', name: 'Same', fav: 0, date: 100, size: 5, tags: ['T1', 'T2'] },
    { id: 'q', name: 'Other', fav: 1, date: 200, size: 0, tags: ['T2'] },
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
    withDb(db => {
        for (const c of CHARACTERS) {
            db.prepare('UPDATE characters SET fav = ?, date_added = ?, date_last_chat = ?, create_date = ?, chat_size = ?, data_size = ? WHERE id = ?')
                .run(c.fav, c.date, c.date, c.date, c.size, c.size, c.id);
            for (const t of c.tags) db.prepare('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (?, ?)').run(c.id, t);
        }
        for (const g of GROUPS) {
            db.prepare('UPDATE groups SET fav = ?, date_added = ?, date_last_chat = ?, chat_size = ? WHERE id = ?').run(g.fav, g.date, g.date, g.size, g.id);
            for (const t of g.tags) db.prepare('INSERT OR IGNORE INTO group_tags (group_id, tag_id) VALUES (?, ?)').run(g.id, t);
        }
    });
}

/** @param {object} params */
async function listed(params) {
    const result = await metadataDb.queryEntities(directories, { offset: 0, limit: 100, wantTotal: false, ...params });
    return result.rows.map(r => `${r.type}:${r.id}`);
}

const SORTS = ['name', 'fav', 'date_added', 'date_last_chat', 'chat_size', 'create_date', 'data_size'];
const FILTERS = [
    { include: ['T1'] },
    { include: ['T2'] },
    { include: ['T1', 'T2'] },
    { include: ['T1', 'T3'] },
    { include: ['T1'], exclude: ['T3'] },
    { include: ['T1', 'T2'], exclude: ['T3'] },
];

/** Every combination's list, as `/query` gives it now. */
async function everyList() {
    const out = [];
    for (const sortField of SORTS) {
        for (const sortOrder of ['asc', 'desc']) {
            for (const fav of [undefined, true, false]) {
                for (const tags of FILTERS) {
                    out.push({ sortField, sortOrder, fav, tags, rows: await listed({ sortField, sortOrder, fav, tags: { mode: 'and', ...tags } }) });
                }
            }
        }
    }
    return out;
}

describe('/query included tags read from the tag sort tables', () => {
    test('once filled, every sort, direction, fav filter and tag filter lists exactly as the plain query does', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        const before = await everyList();
        expect(before.some(l => l.rows.length > 0)).toBe(true);
        // The triggers already wrote these rows; the fill finds nothing missing and marks the tables ready.
        const filled = await metadataDb.fillTagSortTablesIfNeeded(directories);
        expect(filled.batches).toBeGreaterThan(0);
        calls.length = 0;
        const after = await everyList();
        expect(calls.some(c => /FROM character_tag_sort s CROSS JOIN characters/.test(c.sql))).toBe(true);
        expect(after).toEqual(before);
    });

    test('pages join up to the whole list', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        await metadataDb.fillTagSortTablesIfNeeded(directories);
        for (const sortField of ['name', 'date_added', 'fav']) {
            for (const sortOrder of ['asc', 'desc']) {
                const tags = { mode: 'and', include: ['T1'] };
                const whole = await listed({ sortField, sortOrder, tags });
                const paged = [];
                for (let offset = 0; offset < whole.length; offset += 2) paged.push(...await listed({ sortField, sortOrder, tags, offset, limit: 2 }));
                expect(paged).toEqual(whole);
            }
        }
    });

    test('the triggers keep the tables right through tag, sort key, fav, insert and delete writes', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        await metadataDb.fillTagSortTablesIfNeeded(directories);
        withDb(db => {
            db.prepare('UPDATE characters SET date_added = 1, fav = 1 WHERE id = ?').run('m.png');
            db.prepare('DELETE FROM character_tags WHERE character_id = ? AND tag_id = ?').run('b.png', 'T1');
            db.prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)').run('n.png', 'T1');
            db.prepare('UPDATE groups SET date_added = 999 WHERE id = ?').run('a');
            db.prepare('DELETE FROM groups WHERE id = ?').run('a-b');
        });
        const viaTables = await everyList();
        withDb(db => db.prepare('DELETE FROM meta WHERE key = ?').run('tag_sort_tables_filled'));
        const plain = await everyList();
        expect(viaTables).toEqual(plain);
        withDb(db => {
            const rows = db.prepare('SELECT tag_id, entity_id, k_fav, k_date_added FROM character_tag_sort ORDER BY tag_id, entity_id').all();
            const expected = db.prepare(`SELECT t.tag_id, c.id AS entity_id, c.fav AS k_fav, c.date_added AS k_date_added
                FROM character_tags t JOIN characters c ON c.id = t.character_id ORDER BY t.tag_id, c.id`).all();
            expect(rows).toEqual(expected);
            expect(db.prepare('SELECT COUNT(*) AS n FROM group_tag_sort WHERE entity_id = ?').get('a-b').n).toBe(0);
        });
    });

    test('a one-tag page walks the tag sort index in order: no temp b-tree sort', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        await metadataDb.fillTagSortTablesIfNeeded(directories);
        for (const sortField of SORTS) {
            for (const sortOrder of ['asc', 'desc']) {
                calls.length = 0;
                await listed({ sortField, sortOrder, tags: { mode: 'and', include: ['T1'] } });
                const reads = calls.filter(c => /_tag_sort s CROSS JOIN/.test(c.sql));
                expect(reads.length).toBe(4);
                const db = new Database(dbPath(), { readonly: true });
                try {
                    for (const read of reads) {
                        const plan = db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.params).map(r => r.detail).join(' | ');
                        expect({ sortField, sortOrder, plan }).toEqual({ sortField, sortOrder, plan: expect.not.stringContaining('TEMP B-TREE') });
                        expect(plan).toMatch(/idx_(character|group)_tag_sort_/);
                    }
                } finally {
                    db.close();
                }
            }
        }
    });

    test('an excluded tag is checked per row: the right entities, and no list of the tag\'s rows read first', async () => {
        await seed();
        await metadataDb.buildEntitySortIndexesIfNeeded(directories);
        for (const fill of [false, true]) {
            if (fill) await metadataDb.fillTagSortTablesIfNeeded(directories);
            for (const tags of [{ exclude: ['T3'] }, { include: ['T1'], exclude: ['T3'] }]) {
                calls.length = 0;
                const rows = await listed({ sortField: 'name', sortOrder: 'asc', tags: { mode: 'and', ...tags } });
                const want = [...CHARACTERS.map(c => ({ ...c, type: 'character' })), ...GROUPS.map(g => ({ ...g, type: 'group' }))]
                    .filter(e => !e.tags.includes('T3') && (tags.include ?? []).every(t => e.tags.includes(t)))
                    .map(e => `${e.type}:${e.id}`);
                expect(new Set(rows)).toEqual(new Set(want));
                const reads = calls.filter(c => /\bAS k\b/.test(c.sql));
                expect(reads.length).toBeGreaterThan(0);
                // Before the fill, an included tag is still read as a list (step 5's fallback); only the exclude is checked then.
                if (!fill && tags.include) continue;
                const db = new Database(dbPath(), { readonly: true });
                try {
                    for (const read of reads) {
                        const plan = db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.params).map(r => r.detail).join(' | ');
                        // A list built from the tag table's rows is the whole-tag read; the json list of excluded ids is fine.
                        expect({ fill, tags, plan }).toEqual({ fill, tags, plan: expect.not.stringMatching(/LIST SUBQUERY \d+ \| (SEARCH|SCAN) (character_tags|group_tags)/) });
                        expect(plan).toMatch(/CORRELATED SCALAR SUBQUERY/);
                    }
                } finally {
                    db.close();
                }
            }
        }
    });

    test('the fill resumes after a stop and is idempotent', async () => {
        await seed();
        withDb(db => db.prepare('DELETE FROM character_tag_sort').run());
        withDb(db => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('tag_sort_fill_upto_character', 'b.png'));
        await metadataDb.fillTagSortTablesIfNeeded(directories);
        withDb(db => {
            // Only ids after b.png were copied by the resumed fill.
            const ids = db.prepare('SELECT DISTINCT entity_id FROM character_tag_sort ORDER BY entity_id').all().map(r => r.entity_id);
            expect(ids).toEqual(['c.png', 'm.png', 'z.png']);
        });
        const again = await metadataDb.fillTagSortTablesIfNeeded(directories);
        expect(again.batches).toBe(0);
    });
});
