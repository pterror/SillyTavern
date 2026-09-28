import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

const FLAG = 'orphan_tag_rows_removed_v1';
const PROGRESS_KEY = `${FLAG}_progress`;

/** While armed, the transaction call with this 1-based number throws instead of running. */
let crashAtTransaction = 0;
let transactionCalls = 0;
/** @type {string[]} The SQL of every write made through the store's handle. */
let runSql = [];
/** @type {((handle: any) => void) | null} Called before each transaction runs. */
let beforeTransaction = null;

/** @param {any} handle */
function instrumentedHandle(handle) {
    const wrapped = { ...handle };
    wrapped.transaction = (fn) => {
        transactionCalls++;
        if (crashAtTransaction && transactionCalls === crashAtTransaction) {
            throw new Error('simulated stop');
        }
        beforeTransaction?.(handle);
        return handle.transaction(fn);
    };
    wrapped.run = (sql, params) => {
        runSql.push(sql);
        return handle.run(sql, params);
    };
    return wrapped;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    const sqliteEngine = await import('../src/endpoints/sqlite-engine.js');
    const engine = await sqliteEngine.getSqliteEngine();
    const openDatabase = engine.openDatabase;
    engine.openDatabase = (dbPath, options) => instrumentedHandle(openDatabase(dbPath, options));

    metadataDb = await import('../src/character-metadata-db.js');
    Database = (await import('better-sqlite3')).default;
});

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-orphan-sweep-test-'));
    directories = /** @type {any} */ ({
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    crashAtTransaction = 0;
    transactionCalls = 0;
    runSql = [];
    beforeTransaction = null;
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @template T @param {(db: import('better-sqlite3').Database) => T} fn @returns {T} */
function withRawDb(fn) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** @param {string} name */
function card(name) {
    return JSON.stringify({ name, spec: 'chara_card_v2', spec_version: '2.0', data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
}

async function seedCharacter(id) {
    await metadataDb.upsertCharacterFromWrite(directories, id, card(id.replace(/\.png$/, '')));
}

async function seedGroup(id) {
    const group = { id, name: id, members: [], chats: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, id, { fav: false, group });
}

/** @param {string[]} ids */
async function saveTags(ids) {
    expect(await metadataDb.saveTagDefinitions(directories, ids.map(id => ({ id, name: `name-${id}` })))).toBe('ok');
}

async function assign(id, tagId) {
    expect(await metadataDb.assignEntityTag(directories, id, tagId)).toBe('ok');
}

/** @param {'character_tags' | 'group_tags'} table @param {[string, string][]} rows */
function insertRaw(table, rows) {
    const column = table === 'character_tags' ? 'character_id' : 'group_id';
    withRawDb(db => {
        const insert = db.prepare(`INSERT INTO ${table} (${column}, tag_id) VALUES (?, ?)`);
        db.transaction(() => { for (const [id, tagId] of rows) insert.run(id, tagId); })();
    });
}

/** Every tag_usage row next to the counts the tag rows give, for rows whose counts differ. */
function tagUsageMismatches(db) {
    return db.prepare(`
        WITH actual AS (
            SELECT tag_id, COUNT(*) AS n FROM (SELECT tag_id FROM character_tags UNION ALL SELECT tag_id FROM group_tags) GROUP BY tag_id
        )
        SELECT u.tag_id, u.count, COALESCE(a.n, 0) AS actual FROM tag_usage u LEFT JOIN actual a ON a.tag_id = u.tag_id WHERE u.count <> COALESCE(a.n, 0)
        UNION ALL
        SELECT a.tag_id, NULL, a.n FROM actual a WHERE a.tag_id NOT IN (SELECT tag_id FROM tag_usage)
    `).all();
}

function allRows(table) {
    const column = table === 'character_tags' ? 'character_id' : 'group_id';
    return withRawDb(db => db.prepare(`SELECT ${column} AS id, tag_id FROM ${table} ORDER BY ${column}, tag_id`).all().map(r => `${r.id}:${r.tag_id}`));
}

function metaOf(key) {
    return withRawDb(db => db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key));
}

/** Warning lines of the form `  id: name`, in the order they were logged. */
function warnedRows(warn) {
    return warn.mock.calls.map(args => String(args[0])).join('\n').split('\n').filter(line => /^ {2}\S/.test(line)).map(line => line.trim());
}

describe('removeOrphanTagRowsIfNeeded', () => {
    test('with no orphans it writes only its done key, and once done it writes nothing and runs no transaction', async () => {
        await saveTags(['x']);
        await seedCharacter('c1.png');
        await seedGroup('g1');
        await assign('c1.png', 'x');
        await assign('g1', 'x');
        const before = [allRows('character_tags'), allRows('group_tags')];
        runSql = [];
        transactionCalls = 0;
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(await metadataDb.removeOrphanTagRowsIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });

        expect([allRows('character_tags'), allRows('group_tags')]).toEqual(before);
        expect(metaOf(FLAG)).toBeDefined();
        expect(metaOf(PROGRESS_KEY)).toBeUndefined();
        expect(runSql.filter(sql => !/INTO meta/.test(sql))).toEqual([]);
        expect(runSql.filter(sql => /INTO meta/.test(sql))).toHaveLength(1);
        expect(warn).not.toHaveBeenCalled();

        runSql = [];
        transactionCalls = 0;
        expect(await metadataDb.removeOrphanTagRowsIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
        expect(runSql).toEqual([]);
        expect(transactionCalls).toBe(0);
    });

    test('removes every row whose entity row is missing, whatever its id looks like, and lists each one', async () => {
        await saveTags(['x', 'y']);
        await seedCharacter('c1.png');
        await seedGroup('g1');
        await assign('c1.png', 'x');
        await assign('g1', 'y');
        insertRaw('character_tags', [['ghost.png', 'x'], ['ghost.png', 'y'], ['noext', 'x'], ['ghost2.png', 'gone']]);
        insertRaw('group_tags', [['ghostgroup', 'x'], ['legacy.png', 'y'], ['c1.png', 'x']]);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await metadataDb.removeOrphanTagRowsIfNeeded(directories);

        expect(allRows('character_tags')).toEqual(['c1.png:x']);
        expect(allRows('group_tags')).toEqual(['g1:y']);
        expect(warnedRows(warn).sort()).toEqual([
            'c1.png: name-x',
            'ghost.png: name-x',
            'ghost.png: name-y',
            // A tag with no tags row is listed by its id.
            'ghost2.png: gone',
            'ghostgroup: name-x',
            'legacy.png: name-y',
            'noext: name-x',
        ]);
        const warned = warn.mock.calls.map(args => String(args[0])).join('\n');
        expect(warned).toMatch(/character_tags/);
        expect(warned).toMatch(/group_tags/);
        expect(result).toEqual({ batches: 2, rowsChanged: 7 });
        expect(withRawDb(db => tagUsageMismatches(db))).toEqual([]);
        expect(metaOf(FLAG)).toBeDefined();
        expect(metaOf(PROGRESS_KEY)).toBeUndefined();
    });

    test('a group_tags row ending in .png whose groups row exists is kept', async () => {
        await saveTags(['x']);
        await seedGroup('legacy.png');
        insertRaw('group_tags', [['legacy.png', 'x']]);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(await metadataDb.removeOrphanTagRowsIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });

        expect(allRows('group_tags')).toEqual(['legacy.png:x']);
        expect(warn).not.toHaveBeenCalled();
    });

    test('a row whose entity appears between the read and the write is kept and not listed', async () => {
        await saveTags(['x']);
        await seedCharacter('seed.png');
        insertRaw('character_tags', [['late.png', 'x'], ['ghost.png', 'x']]);
        beforeTransaction = () => {
            beforeTransaction = null;
            withRawDb(db => {
                const columns = db.prepare('SELECT name FROM pragma_table_info(\'characters\')').pluck().all().filter(c => c !== 'id');
                db.prepare(`INSERT INTO characters (id, ${columns.join(', ')}) SELECT 'late.png', ${columns.join(', ')} FROM characters WHERE id = 'seed.png'`).run();
            });
        };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(await metadataDb.removeOrphanTagRowsIfNeeded(directories)).toEqual({ batches: 1, rowsChanged: 1 });

        expect(allRows('character_tags')).toEqual(['late.png:x']);
        expect(warnedRows(warn)).toEqual(['ghost.png: name-x']);
    });

    test('runs before finishDeletedTags in MIGRATION_PASSES', async () => {
        const { MIGRATION_PASSES } = await import('../src/metadata-migration-coordinator.js');
        const at = MIGRATION_PASSES.indexOf(/** @type {any} */ ('removeOrphanTagRowsIfNeeded'));
        expect(at).toBeGreaterThan(-1);
        expect(MIGRATION_PASSES.indexOf('finishDeletedTags')).toBeGreaterThan(at);
    });
});

/** Writes 'seed.png' through the store, then `count` raw copies c00000.png, c00001.png, ... with no tags. */
async function seedCharacterCopies(count) {
    await seedCharacter('seed.png');
    withRawDb(db => {
        const columns = db.prepare('SELECT name FROM pragma_table_info(\'characters\')').pluck().all().filter(c => c !== 'id');
        db.prepare(`
            WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
            INSERT INTO characters (id, ${columns.join(', ')})
            SELECT printf('c%05d.png', n.i), ${columns.map(c => `s.${c}`).join(', ')} FROM n, characters s WHERE s.id = 'seed.png'
        `).run(count);
    });
}

describe('removeOrphanTagRowsIfNeeded over many batches', () => {
    const COUNT = 2500;
    const idOf = (/** @type {number} */ i) => `c${String(i).padStart(5, '0')}.png`;

    test('a page with no orphans writes nothing: only the batch that removes rows and the done key write', async () => {
        await saveTags(['x']);
        await seedCharacterCopies(COUNT);
        const rows = /** @type {[string, string][]} */ ([]);
        for (let i = 0; i < COUNT; i++) rows.push([idOf(i), 'x']);
        insertRaw('character_tags', [...rows, ['zz-ghost.png', 'x']]);
        runSql = [];
        transactionCalls = 0;
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(await metadataDb.removeOrphanTagRowsIfNeeded(directories)).toEqual({ batches: 1, rowsChanged: 1 });

        expect(transactionCalls).toBe(2);
        expect(runSql.filter(sql => /INTO meta/.test(sql))).toHaveLength(2);
        expect(warnedRows(warn)).toEqual(['zz-ghost.png: name-x']);
        expect(withRawDb(db => db.prepare('SELECT COUNT(*) FROM character_tags').pluck().get())).toBe(COUNT);
        expect(withRawDb(db => tagUsageMismatches(db))).toEqual([]);
    }, 60000);

    test('a pass stopped mid-way resumes after the last batch that removed rows, and lists every orphan', async () => {
        await saveTags(['x']);
        // Orphans only: every page removes rows, so every page saves its position.
        const rows = /** @type {[string, string][]} */ ([]);
        for (let i = 0; i < COUNT; i++) rows.push([idOf(i), 'x']);
        insertRaw('character_tags', rows);
        insertRaw('group_tags', [['ghostgroup', 'x']]);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});

        transactionCalls = 0;
        crashAtTransaction = 2;
        await expect(metadataDb.removeOrphanTagRowsIfNeeded(directories)).rejects.toThrow('simulated stop');
        crashAtTransaction = 0;

        expect(withRawDb(db => db.prepare('SELECT COUNT(*) FROM character_tags').pluck().get())).toBe(COUNT - 1000);
        expect(metaOf(PROGRESS_KEY)).toBeDefined();
        expect(metaOf(FLAG)).toBeUndefined();
        expect(withRawDb(db => tagUsageMismatches(db))).toEqual([]);

        metadataDb.disposeMetadataStores();
        const result = await metadataDb.removeOrphanTagRowsIfNeeded(directories);

        expect(log.mock.calls.map(args => String(args[0])).join('\n')).toMatch(/resuming after/);
        expect(result).toEqual({ batches: 3, rowsChanged: COUNT - 1000 + 1 });
        expect(allRows('character_tags')).toEqual([]);
        expect(allRows('group_tags')).toEqual([]);
        const listed = warnedRows(warn);
        expect(listed).toHaveLength(COUNT + 1);
        expect(new Set(listed).size).toBe(COUNT + 1);
        expect(listed).toContain('ghostgroup: name-x');
        expect(withRawDb(db => tagUsageMismatches(db))).toEqual([]);
        expect(metaOf(FLAG)).toBeDefined();
        expect(metaOf(PROGRESS_KEY)).toBeUndefined();
    }, 60000);
});
