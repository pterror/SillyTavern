import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/** While armed, the transaction call with this 1-based number throws instead of running. */
let crashAtTransaction = 0;
let transactionCalls = 0;
/** @type {string[]} The SQL of every write made through the store's handle. */
let runSql = [];
/** @type {{ sql: string, params: any }[]} Every read made through the store's handle while recording. */
let reads = [];
let recording = false;
/** @type {(() => void) | null} Called after each transaction of the store's handle commits. */
let afterCommit = null;

/** @param {any} handle */
function instrumentedHandle(handle) {
    const wrapped = { ...handle };
    wrapped.transaction = (fn) => {
        transactionCalls++;
        if (crashAtTransaction && transactionCalls === crashAtTransaction) throw new Error('simulated stop');
        const result = handle.transaction(fn);
        afterCommit?.();
        return result;
    };
    wrapped.run = (sql, params) => {
        runSql.push(sql);
        return handle.run(sql, params);
    };
    wrapped.get = (sql, params) => {
        if (recording) reads.push({ sql, params });
        return handle.get(sql, params);
    };
    wrapped.iterate = function* (sql, params) {
        if (recording) reads.push({ sql, params });
        yield* handle.iterate(sql, params);
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tag-sort-order-fill-test-'));
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
    reads = [];
    recording = false;
    afterCommit = null;
});

/** @type {import('better-sqlite3').Database | null} A second connection standing in for the server's live writes. */
let liveDb = null;
function live() {
    liveDb ??= new Database(path.join(directories.root, 'character-metadata.sqlite'));
    return liveDb;
}

afterEach(() => {
    jest.restoreAllMocks();
    liveDb?.close();
    liveDb = null;
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

const FLAG = 'tag_sort_orders_filled_v1';
const AT = `${FLAG}_at`;

/** @param {string} key */
function metaValue(key) {
    return live().prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key);
}

/**
 * Inserts a tags row as the store writes one: data plus its derived columns.
 * @param {string} id
 * @param {Record<string, unknown> | string} tagOrData A tag (its id is set) or raw data.
 */
function insertTag(id, tagOrData) {
    const data = typeof tagOrData === 'string' ? tagOrData : JSON.stringify({ id, name: id, ...tagOrData });
    let parsed = null;
    try {
        parsed = JSON.parse(data);
    } catch {
        // Derived as data with no fields.
    }
    const { sortOrder, folderType, isFolder } = metadataDb.tagDerivedColumns(parsed);
    const name = parsed !== null && typeof parsed === 'object' && typeof parsed.name === 'string' ? parsed.name.toLowerCase() : '';
    live().prepare('INSERT INTO tags (id, data, name_key, sort_order, folder_type, is_folder, usage_count) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(id, data, name, sortOrder, folderType, isFolder);
}

/** Opens the store and runs what the pass waits for, on an empty table. */
async function openStore() {
    await metadataDb.ensureSchemaMigrated(directories);
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
    await metadataDb.migrateTagsJsonIfNeeded(directories);
    expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(true);
}

/** Tag ids in the order Manual shows them: by (sort_order, rowid), then those without one by (name_key, rowid). */
function displayOrder() {
    return [
        ...live().prepare('SELECT id FROM tags WHERE sort_order IS NOT NULL ORDER BY sort_order, rowid').pluck().iterate(),
        ...live().prepare('SELECT id FROM tags WHERE sort_order IS NULL ORDER BY name_key, rowid').pluck().iterate(),
    ];
}

/** @returns {Map<string, { data: string, sort_order: number | null }>} */
function rows() {
    return new Map([...live().prepare('SELECT id, data, sort_order FROM tags').iterate()].map(r => [r.id, { data: r.data, sort_order: r.sort_order }]));
}

/** @param {string} id @returns {unknown} */
function dataOrder(id) {
    return JSON.parse(live().prepare('SELECT data FROM tags WHERE id = ?').pluck().get(id)).sort_order;
}

/** Every row whose sort_order column isn't tagDerivedColumns() of its data. */
function columnMismatches() {
    const out = [];
    for (const row of live().prepare('SELECT id, data, sort_order FROM tags').iterate()) {
        let tag = null;
        try {
            tag = JSON.parse(row.data);
        } catch {
            // Derived as data with no fields.
        }
        if (metadataDb.tagDerivedColumns(tag).sortOrder !== row.sort_order) out.push(row.id);
    }
    return out;
}

/** sort_order values held by more than one tag. */
function tiedValues() {
    return [...live().prepare('SELECT sort_order FROM tags WHERE sort_order IS NOT NULL GROUP BY sort_order HAVING COUNT(*) > 1').pluck().iterate()];
}

/** @param {jest.SpiedFunction<any>} spy */
const loggedLines = spy => spy.mock.calls.flatMap(args => String(args[0]).split('\n').filter(line => line.startsWith('  ')));

describe('fillTagSortOrdersIfNeeded: tags without a sort_order', () => {
    test('get max+1 onward in the order they display, and the order stays as it was', async () => {
        await openStore();
        insertTag('neg', { sort_order: -3 });
        insertTag('zed', { name: 'Zed' });
        insertTag('a', { sort_order: 2 });
        insertTag('alpha', { name: 'alpha' });
        insertTag('b', { sort_order: 5.5 });
        insertTag('mid', { name: 'Mid' });
        const before = displayOrder();
        const ordered = ['neg', 'a', 'b'].map(id => rows().get(id));

        expect(await metadataDb.fillTagSortOrdersIfNeeded(directories)).toEqual({ batches: 2, rowsChanged: 3 });

        expect(displayOrder()).toEqual(before);
        expect([dataOrder('alpha'), dataOrder('mid'), dataOrder('zed')]).toEqual([6.5, 7.5, 8.5]);
        expect(['neg', 'a', 'b'].map(id => rows().get(id))).toEqual(ordered);
        expect(columnMismatches()).toEqual([]);
        expect(metaValue(FLAG)).toBeDefined();
        expect(metaValue(AT)).toBeUndefined();
    });

    test('with no ordered tag, or only negative ones, start at 1', async () => {
        await openStore();
        insertTag('n', { sort_order: -1 });
        insertTag('c', { name: 'C' });
        insertTag('b', { name: 'B' });
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect([dataOrder('b'), dataOrder('c')]).toEqual([1, 2]);
    });

    test('a sort_order that has no order is replaced, and its old value logged; data that isn\'t an object is left and logged', async () => {
        await openStore();
        insertTag('abc', { name: 'Abc', sort_order: 'abc' });
        insertTag('obj', { name: 'Obj', sort_order: { at: 1 } });
        insertTag('bad', '{not json');
        insertTag('arr', '[1,2]');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect([dataOrder('abc'), dataOrder('obj')]).toEqual([1, 2]);
        expect(rows().get('bad')).toEqual({ data: '{not json', sort_order: null });
        expect(rows().get('arr')).toEqual({ data: '[1,2]', sort_order: null });
        expect(loggedLines(warn).sort()).toEqual(['  abc (Abc): "abc"', '  arr', '  bad', '  obj (Obj): {"at":1}']);
        expect(columnMismatches()).toEqual([]);
    });

    test('across batches, and a restart resumes where the last commit left it', async () => {
        await openStore();
        const insert = live().transaction(() => {
            for (let i = 0; i < 2500; i++) insertTag(`t${String(i).padStart(4, '0')}`, { name: `Tag ${String(2499 - i).padStart(4, '0')}` });
        });
        insert();
        const before = displayOrder();
        transactionCalls = 0;
        crashAtTransaction = 2;
        await expect(metadataDb.fillTagSortOrdersIfNeeded(directories)).rejects.toThrow('simulated stop');
        crashAtTransaction = 0;
        expect(JSON.parse(metaValue(AT))).toMatchObject({ phase: 'unordered' });
        expect(displayOrder()).toEqual(before);

        metadataDb.disposeMetadataStores();
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(log.mock.calls.map(args => String(args[0])).join('\n')).toContain('resuming at');
        expect(displayOrder()).toEqual(before);
        const values = [...live().prepare('SELECT sort_order FROM tags ORDER BY sort_order').pluck().iterate()];
        expect(values).toEqual([...Array(2500).keys()].map(i => i + 1));
        expect(columnMismatches()).toEqual([]);
    });
});

describe('fillTagSortOrdersIfNeeded: ties', () => {
    test('are spread in rowid order up to the next value, the first keeping its value and its data', async () => {
        await openStore();
        insertTag('p', { sort_order: '1' });
        insertTag('q', { sort_order: null });
        insertTag('r', { sort_order: 1 });
        insertTag('s', { sort_order: 0 });
        insertTag('t', { sort_order: true });
        insertTag('u', { sort_order: 2 });
        insertTag('v', { sort_order: 9 });
        insertTag('w', { sort_order: 9 });
        insertTag('x', { sort_order: 9 });
        const before = displayOrder();
        const keep = ['p', 'q', 'u', 'v'].map(id => rows().get(id));

        await metadataDb.fillTagSortOrdersIfNeeded(directories);

        expect(displayOrder()).toEqual(before);
        expect(['p', 'q', 'u', 'v'].map(id => rows().get(id))).toEqual(keep);
        expect(dataOrder('s')).toBe(0.5);
        expect(dataOrder('r')).toBe(1 + 1 / 3);
        expect(dataOrder('t')).toBe(1 + 2 / 3);
        expect([dataOrder('w'), dataOrder('x')]).toEqual([10, 11]);
        expect(tiedValues()).toEqual([]);
        expect(columnMismatches()).toEqual([]);
    });

    test('a tie with no room before the next value is left tied and logged, and the pass still finishes', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('b', { sort_order: 1 });
        insertTag('c', { sort_order: 1 });
        insertTag('d', { sort_order: 1 + Number.EPSILON });
        insertTag('e', { sort_order: 4 });
        insertTag('f', { sort_order: 4 });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(tiedValues()).toEqual([1]);
        expect(dataOrder('f')).toBe(5);
        expect(loggedLines(warn)).toEqual(['  a (a)', '  b (b)', '  c (c)']);
        expect(metaValue(FLAG)).toBeDefined();
    });

    test('a tie larger than a batch is spread across batches, and every commit shows the same order', async () => {
        await openStore();
        const insert = live().transaction(() => {
            insertTag('first', { sort_order: -1 });
            for (let i = 0; i < 2500; i++) insertTag(`z${String(i).padStart(4, '0')}`, { sort_order: 0 });
            insertTag('next', { sort_order: 1 });
            for (let i = 0; i < 1200; i++) insertTag(`top${String(i).padStart(4, '0')}`, { sort_order: 3 });
            insertTag('none', { name: 'None' });
        });
        insert();
        const before = displayOrder();
        let commits = 0;
        afterCommit = () => {
            commits++;
            expect(displayOrder()).toEqual(before);
        };
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        afterCommit = null;
        expect(commits).toBeGreaterThan(6);
        expect(displayOrder()).toEqual(before);
        expect(tiedValues()).toEqual([]);
        expect(dataOrder('z0000')).toBe(0);
        expect(dataOrder('next')).toBe(1);
        expect(dataOrder('none')).toBe(4);
        expect(dataOrder('top0000')).toBe(3);
        // 'none' took 4, so the top tie spreads up to it.
        expect(dataOrder('top1199')).toBe(3 + 1199 / 1200);
        expect(columnMismatches()).toEqual([]);
    });

    test('tags written live between batches keep their place, and none are left without an order or tied', async () => {
        await openStore();
        const insert = live().transaction(() => {
            for (let i = 0; i < 1500; i++) insertTag(`u${String(i).padStart(4, '0')}`, { name: `U ${i}` });
            for (let i = 0; i < 1500; i++) insertTag(`o${String(i).padStart(4, '0')}`, { sort_order: i % 700 });
        });
        insert();
        let round = 0;
        afterCommit = () => {
            round++;
            const max = live().prepare('SELECT MAX(sort_order) FROM tags').pluck().get() ?? 0;
            insertTag(`live${round}`, { sort_order: Math.max(0, max) + 1 });
        };
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        afterCommit = null;
        expect(round).toBeGreaterThanOrEqual(4);
        expect(live().prepare('SELECT COUNT(*) FROM tags WHERE sort_order IS NULL').pluck().get()).toBe(0);
        expect(tiedValues()).toEqual([]);
        expect(columnMismatches()).toEqual([]);
    });
});

describe('fillTagSortOrdersIfNeeded', () => {
    test('writes nothing when every tag has its own sort_order, and a finished store runs no transaction', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('b', { sort_order: 2 });
        runSql = [];
        expect(await metadataDb.fillTagSortOrdersIfNeeded(directories)).toEqual({ batches: 2, rowsChanged: 0 });
        expect(runSql.filter(sql => /UPDATE tags/.test(sql))).toEqual([]);
        runSql = [];
        transactionCalls = 0;
        expect(await metadataDb.fillTagSortOrdersIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
        expect(runSql).toEqual([]);
        expect(transactionCalls).toBe(0);
    });

    test('an empty table is marked done', async () => {
        await openStore();
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(metaValue(FLAG)).toBeDefined();
    });

    test('waits, writing nothing, until the derived columns are filled and tags.json is migrated', async () => {
        await metadataDb.ensureSchemaMigrated(directories);
        insertTag('a', { name: 'A' });
        jest.spyOn(console, 'log').mockImplementation(() => {});
        runSql = [];
        expect(await metadataDb.fillTagSortOrdersIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
        runSql = [];
        expect(await metadataDb.fillTagSortOrdersIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
        expect(runSql).toEqual([]);
        expect(metaValue(FLAG)).toBeUndefined();
        await metadataDb.migrateTagsJsonIfNeeded(directories);
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(dataOrder('a')).toBe(1);
    });

    test('tells the main process after each batch that wrote, and updates tags_hash once done', async () => {
        await openStore();
        insertTag('a', { name: 'A' });
        insertTag('b', { sort_order: 3 });
        insertTag('c', { sort_order: 3 });
        const hashBefore = await metadataDb.getTagsHash(directories);
        let events = 0;
        const onChanged = () => { events++; };
        metadataDb.characterChangeEmitter.on(metadataDb.TAG_DEFINITIONS_CHANGED_EVENT, onChanged);
        try {
            await metadataDb.fillTagSortOrdersIfNeeded(directories);
        } finally {
            metadataDb.characterChangeEmitter.off(metadataDb.TAG_DEFINITIONS_CHANGED_EVENT, onChanged);
        }
        expect(events).toBe(2);
        expect(await metadataDb.getTagsHash(directories)).not.toBe(hashBefore);
    });

    test('reads tags only through an index, never a table scan or a sort', async () => {
        await openStore();
        insertTag('a', { name: 'A' });
        for (let i = 0; i < 1500; i++) insertTag(`t${i}`, { sort_order: i < 1200 ? 0 : i });
        insertTag('e', { sort_order: 1 });
        insertTag('f', { sort_order: 1 });
        insertTag('d', { sort_order: 1 + Number.EPSILON });
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        recording = true;
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        recording = false;
        const plans = reads
            .filter(({ sql }) => /\bFROM tags\b/.test(sql) && !/ORDER BY id\b/.test(sql))
            .map(({ sql, params }) => {
                const explain = live().prepare(`EXPLAIN QUERY PLAN ${sql}`);
                return [...(params === undefined ? explain.iterate() : explain.iterate(params))].map(row => row.detail).join(' | ');
            });
        expect(plans.length).toBeGreaterThan(0);
        expect(plans.filter(plan => /\bSCAN tags\b(?! USING)/.test(plan) || /TEMP B-TREE/.test(plan))).toEqual([]);
    });

    test('runs after every pass that writes tags rows, and before fillEntityCountsIfNeeded', async () => {
        const { MIGRATION_PASSES } = await import('../src/metadata-migration-coordinator.js');
        const at = MIGRATION_PASSES.indexOf('fillTagSortOrdersIfNeeded');
        for (const pass of ['fillTagNameKeysIfNeeded', 'fillTagDerivedColumnsIfNeeded', 'migrateTagsJsonIfNeeded', 'backfillCardTagsIfNeeded', 'finishDeletedTags']) {
            expect(MIGRATION_PASSES.indexOf(pass)).toBeLessThan(at);
        }
        expect(MIGRATION_PASSES[at + 1]).toBe('fillEntityCountsIfNeeded');
    });
});
