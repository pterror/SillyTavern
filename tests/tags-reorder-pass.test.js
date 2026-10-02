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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-reorder-pass-test-'));
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

/**
 * Inserts a tags row as the store writes one: data plus its derived columns.
 * @param {string} id
 * @param {Record<string, unknown> | string} tagOrData A tag (its id is set) or raw data.
 * @param {number} [usage] usage_count.
 */
function insertTag(id, tagOrData, usage = 0) {
    const data = typeof tagOrData === 'string' ? tagOrData : JSON.stringify({ id, name: id, ...tagOrData });
    let parsed = null;
    try {
        parsed = JSON.parse(data);
    } catch {
        // Derived as data with no fields.
    }
    const { sortOrder, folderType, isFolder } = metadataDb.tagDerivedColumns(parsed);
    const name = parsed !== null && typeof parsed === 'object' && typeof parsed.name === 'string' ? parsed.name.toLowerCase() : '';
    live().prepare('INSERT INTO tags (id, data, name_key, sort_order, folder_type, is_folder, usage_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, data, name, sortOrder, folderType, isFolder, usage);
}

/**
 * Opens the store with its tag query columns ready, on an empty table.
 * @param {{ filled?: boolean }} [options] filled: false leaves the sort_order fill unfinished.
 */
async function openStore({ filled = true } = {}) {
    await metadataDb.ensureSchemaMigrated(directories);
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
    await metadataDb.migrateTagsJsonIfNeeded(directories);
    expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(true);
    if (filled) await metadataDb.fillTagSortOrdersIfNeeded(directories);
}

/** @param {string} key @returns {string | undefined} */
const meta = key => live().prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key);

/** The recorded reorder pass, or undefined. */
function pass() {
    const value = meta('tag_reorder_pass');
    return value === undefined ? undefined : JSON.parse(value);
}

/**
 * Records a reorder pass as reorderTagDefinitions() does.
 * @param {number} id
 * @param {'alphabetical' | 'by_entries'} mode
 * @param {unknown} [at]
 */
function record(id, mode, at = null) {
    const upsert = live().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    upsert.run('tag_reorder_pass', JSON.stringify({ id, mode, at }));
    upsert.run('tag_reorder_pass_last_id', String(id));
}

/** @param {string} tagId @param {'before' | 'after'} side @param {string} anchorId */
const queueMove = (tagId, side, anchorId) => live().prepare('INSERT INTO tag_pending_moves (tag_id, side, anchor_id) VALUES (?, ?, ?)').run(tagId, side, anchorId);
/** @param {string} tagId @param {unknown} value */
const queueValue = (tagId, value) => live().prepare('INSERT INTO tag_pending_moves (tag_id, value) VALUES (?, ?)').run(tagId, JSON.stringify(value));

/** @param {string} id */
const data = id => JSON.parse(live().prepare('SELECT data FROM tags WHERE id = ?').pluck().get(id));
/** @param {string} id @returns {number | null} */
const column = id => live().prepare('SELECT sort_order FROM tags WHERE id = ?').pluck().get(id);
/** @param {string} id @returns {number | null} */
const stamp = id => live().prepare('SELECT reorder_pass FROM tags WHERE id = ?').pluck().get(id);
/** Every tag's id, in the stored manual order. */
const manualOrder = () => [...live().prepare('SELECT id FROM tags WHERE sort_order IS NOT NULL ORDER BY sort_order, rowid').pluck().iterate()];
const pendingCount = () => live().prepare('SELECT COUNT(*) FROM tag_pending_moves').pluck().get();

const warnings = spy => spy.mock.calls.map(args => String(args[0])).join('\n');
const pad = i => String(i).padStart(4, '0');

describe('runTagReorderPassIfNeeded', () => {
    test('does nothing with no pass recorded, and builds no index', async () => {
        await openStore();
        insertTag('a', { sort_order: 3 });
        expect(await metadataDb.runTagReorderPassIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
        expect(column('a')).toBe(3);
        expect([...live().prepare('SELECT name FROM sqlite_master WHERE name LIKE \'tags_reorder_pass%\'').pluck().iterate()]).toEqual([]);
    });

    test('waits for the sort_order fill to finish, writing nothing', async () => {
        await openStore({ filled: false });
        insertTag('b', { sort_order: 3 });
        insertTag('a', { sort_order: 4 });
        queueMove('a', 'before', 'b');
        record(1, 'alphabetical');
        expect(await metadataDb.runTagReorderPassIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
        expect([column('a'), column('b'), stamp('a')]).toEqual([4, 3, null]);
        expect(pass()).toEqual({ id: 1, mode: 'alphabetical', at: null });
        expect(pendingCount()).toBe(1);
    });

    test('alphabetical: numbers every tag 0, 1, 2, ... in (name_key, rowid) order, stamps it, then applies the queue and clears the pass', async () => {
        await openStore();
        insertTag('c', { name: 'C', sort_order: 1 });
        insertTag('a', { name: 'A', sort_order: 9 });
        insertTag('b2', { name: 'B', sort_order: 7 });
        insertTag('b1', { name: 'B', sort_order: 5 });
        queueMove('c', 'after', 'a');
        record(1, 'alphabetical');
        await metadataDb.runTagReorderPassIfNeeded(directories);
        expect([data('a').sort_order, data('b2').sort_order, data('b1').sort_order]).toEqual([0, 1, 2]);
        expect([column('a'), column('b2'), column('b1')]).toEqual([0, 1, 2]);
        expect(manualOrder()).toEqual(['a', 'c', 'b2', 'b1']);
        expect(['a', 'b1', 'b2', 'c'].map(stamp)).toEqual([1, 1, 1, 1]);
        expect(pass()).toBeUndefined();
        expect(pendingCount()).toBe(0);
        expect(meta('tag_reorder_pass_last_id')).toBe('1');
    });

    test('says the order is settled once, when the pass clears its record, even if its one queued move was dropped', async () => {
        await openStore();
        insertTag('b', { name: 'B', sort_order: 1 });
        insertTag('a', { name: 'A', sort_order: 2 });
        queueMove('gone', 'after', 'a');
        record(1, 'alphabetical');
        /** @type {{ root: string, passRecorded: boolean }[]} */
        const settled = [];
        const onSettled = root => settled.push({ root, passRecorded: pass() !== undefined });
        metadataDb.characterChangeEmitter.on(metadataDb.TAG_ORDER_SETTLED_EVENT, onSettled);
        try {
            await metadataDb.runTagReorderPassIfNeeded(directories);
        } finally {
            metadataDb.characterChangeEmitter.off(metadataDb.TAG_ORDER_SETTLED_EVENT, onSettled);
        }
        expect(manualOrder()).toEqual(['a', 'b']);
        expect(settled).toEqual([{ root: directories.root, passRecorded: false }]);
    });

    test('by_entries: numbers in (usage_count DESC, name_key, rowid) order', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 }, 1);
        insertTag('c', { sort_order: 2 }, 5);
        insertTag('b', { sort_order: 3 }, 5);
        insertTag('d', { sort_order: 4 }, 0);
        record(3, 'by_entries');
        await metadataDb.runTagReorderPassIfNeeded(directories);
        expect(manualOrder()).toEqual(['b', 'c', 'a', 'd']);
        expect(['b', 'c', 'a', 'd'].map(column)).toEqual([0, 1, 2, 3]);
        expect(['a', 'b', 'c', 'd'].map(stamp)).toEqual([3, 3, 3, 3]);
        expect(pass()).toBeUndefined();
    });

    test('a tag already holding its number only gets the stamp; one holding another number takes the pass\'s', async () => {
        await openStore();
        insertTag('a', { sort_order: 0 });
        record(1, 'alphabetical');
        const before = live().prepare('SELECT data FROM tags WHERE id = ?').pluck().get('a');
        await metadataDb.runTagReorderPassIfNeeded(directories);
        expect(live().prepare('SELECT data FROM tags WHERE id = ?').pluck().get('a')).toBe(before);
        expect(stamp('a')).toBe(1);

        insertTag('b', { sort_order: 1 });
        record(2, 'alphabetical');
        await metadataDb.runTagReorderPassIfNeeded(directories);
        live().prepare('UPDATE tags SET data = json_set(data, \'$.sort_order\', 7), sort_order = 7 WHERE id = ?').run('b');
        record(3, 'alphabetical');
        await metadataDb.runTagReorderPassIfNeeded(directories);
        expect(column('b')).toBe(1);
    });

    test('a tag whose data isn\'t an object is stamped without a sort_order and still takes its number; a replaced orderless value is logged', async () => {
        await openStore();
        insertTag('bad', '{not json');
        insertTag('b', { name: 'B', sort_order: 'abc' });
        insertTag('c', { name: 'C', sort_order: 4 });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        record(1, 'alphabetical');
        await metadataDb.runTagReorderPassIfNeeded(directories);
        expect([column('bad'), stamp('bad')]).toEqual([null, 1]);
        expect(live().prepare('SELECT data FROM tags WHERE id = ?').pluck().get('bad')).toBe('{not json');
        expect([data('b').sort_order, data('c').sort_order]).toEqual([1, 2]);
        expect(warnings(warn)).toMatch(/isn't a JSON object[^]*\n {2}bad/);
        expect(warnings(warn)).toMatch(/had no order[^]*\n {2}b \(B\): "abc"/);
    });

    test('works in batches and resumes from its place after a stop', async () => {
        await openStore();
        for (let i = 0; i < 2500; i++) insertTag(`t${pad(i)}`, { sort_order: 2500 - i });
        record(1, 'alphabetical');
        transactionCalls = 0;
        crashAtTransaction = 2;
        await expect(metadataDb.runTagReorderPassIfNeeded(directories)).rejects.toThrow('simulated stop');
        expect(pass()).toEqual({ id: 1, mode: 'alphabetical', at: { phase: 'walk', n: 1000, c: 0, k: 't0999', r: 1000 } });
        expect([column('t0999'), column('t1000')]).toEqual([999, 1500]);
        crashAtTransaction = 0;
        metadataDb.disposeMetadataStores();

        const totals = await metadataDb.runTagReorderPassIfNeeded(directories);
        expect(totals.batches).toBe(4);
        const values = [...live().prepare('SELECT sort_order FROM tags ORDER BY name_key').pluck().iterate()];
        expect(values).toEqual(Array.from({ length: 2500 }, (_, i) => i));
        expect(live().prepare('SELECT COUNT(*) FROM tags WHERE reorder_pass = 1').pluck().get()).toBe(2500);
        expect(pass()).toBeUndefined();
    });

    test('tags the walk missed (count moved) and tags created meanwhile get max+1 in the live order, and old stamps are cleared', async () => {
        await openStore();
        for (let i = 0; i < 1500; i++) insertTag(`t${pad(i)}`, { sort_order: i }, 1);
        live().prepare('UPDATE tags SET reorder_pass = 1').run();
        record(2, 'by_entries');
        let batches = 0;
        afterCommit = () => {
            if (++batches !== 1) return;
            live().prepare('UPDATE tags SET usage_count = 3 WHERE id = ?').run('t1200');
            insertTag('new', { name: 'new' }, 5);
        };
        await metadataDb.runTagReorderPassIfNeeded(directories);
        afterCommit = null;
        expect(column('t0000')).toBe(0);
        expect(column('t1499')).toBe(1498);
        expect([column('new'), column('t1200')]).toEqual([1499, 1500]);
        expect(data('t1200').sort_order).toBe(1500);
        expect(live().prepare('SELECT COUNT(*) FROM tags WHERE reorder_pass IS NOT 2').pluck().get()).toBe(0);
        expect(pass()).toBeUndefined();
    });

    test('a tag the sweep finds no finite value for is stamped, left as it is and logged', async () => {
        await openStore();
        insertTag('w', { sort_order: 0 });
        insertTag('inf', { name: 'inf', sort_order: 'Infinity' });
        insertTag('u', { name: 'u' });
        live().prepare('UPDATE tags SET reorder_pass = 1 WHERE id = ?').run('w');
        record(1, 'alphabetical', { phase: 'sweep' });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        await metadataDb.runTagReorderPassIfNeeded(directories);
        expect([column('inf'), column('u'), data('u').sort_order]).toEqual([Infinity, null, undefined]);
        expect([stamp('inf'), stamp('u')]).toEqual([1, 1]);
        expect(warnings(warn)).toMatch(/no finite value is left[^]*\n {2}inf \(inf\)\n {2}u \(u\)/);
        expect(pass()).toBeUndefined();
    });

    test('a pass recorded meanwhile restarts the walk under its id and mode', async () => {
        await openStore();
        for (let i = 0; i < 1500; i++) insertTag(`t${pad(i)}`, { sort_order: i }, i % 2);
        record(1, 'alphabetical');
        queueMove('t0000', 'after', 't1499');
        let batches = 0;
        afterCommit = () => {
            if (++batches === 1) record(2, 'by_entries');
        };
        await metadataDb.runTagReorderPassIfNeeded(directories);
        afterCommit = null;
        expect(live().prepare('SELECT COUNT(*) FROM tags WHERE reorder_pass IS NOT 2').pluck().get()).toBe(0);
        // by_entries: the odd tags (usage 1) first, then the even ones, each by name; t0000 moved after t1499.
        const expected = [...Array.from({ length: 750 }, (_, i) => `t${pad(2 * i + 1)}`), ...Array.from({ length: 749 }, (_, i) => `t${pad(2 * i + 2)}`)];
        expected.splice(expected.indexOf('t1499') + 1, 0, 't0000');
        expect(manualOrder()).toEqual(expected);
        expect(pass()).toBeUndefined();
    });

    test('a pass recorded while the queue drains restarts the walk; the queue is applied after it', async () => {
        await openStore();
        insertTag('a', { sort_order: 0 }, 1);
        insertTag('b', { sort_order: 1 }, 2);
        insertTag('c', { sort_order: 2 }, 3);
        live().prepare('UPDATE tags SET reorder_pass = 1').run();
        queueMove('a', 'before', 'b');
        queueMove('c', 'before', 'a');
        record(1, 'alphabetical', { phase: 'drain' });
        let drained = 0;
        afterCommit = () => {
            if (pendingCount() === 1 && drained++ === 0) record(2, 'by_entries');
        };
        await metadataDb.runTagReorderPassIfNeeded(directories);
        afterCommit = null;
        expect(['a', 'b', 'c'].map(stamp)).toEqual([2, 2, 2]);
        // by_entries c, b, a; then the rest of the queue: c before a.
        expect(manualOrder()).toEqual(['b', 'c', 'a']);
        expect(pass()).toBeUndefined();
        expect(pendingCount()).toBe(0);
    });

    test('the queue applies in arrival order over the final values, the last value entry for a tag wins, and a deleted anchor is warned about', async () => {
        await openStore();
        insertTag('a', { name: 'A', sort_order: 9 });
        insertTag('b', { name: 'B', sort_order: 8 });
        insertTag('c', { name: 'C', sort_order: 7 });
        insertTag('d', { name: 'D', sort_order: 6 });
        queueMove('c', 'before', 'a');
        queueValue('b', 50);
        queueValue('b', 'x');
        queueMove('a', 'after', 'd');
        record(1, 'alphabetical');
        live().prepare('INSERT INTO tag_deletions (tag_id, merge_into) VALUES (?, NULL)').run('d');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        await metadataDb.runTagReorderPassIfNeeded(directories);
        expect([data('b').sort_order, column('b')]).toEqual(['x', null]);
        expect(manualOrder()).toEqual(['c', 'a', 'd']);
        expect(warnings(warn)).toContain('Couldn\'t move tag "A" next to "D": "D" was deleted.');
        expect(pass()).toBeUndefined();
        expect(pendingCount()).toBe(0);

        expect(await metadataDb.moveTagDefinition(directories, 'c', { after: 'a' })).toEqual({ refused: [], written: [{ id: 'c', sort_order: expect.any(Number) }] });
        expect(manualOrder()).toEqual(['a', 'c', 'd']);
    });

    test('reads tags only through an index, never a table scan or a sort', async () => {
        await openStore();
        for (let i = 0; i < 1200; i++) insertTag(`t${pad(i)}`, { sort_order: i }, i % 3);
        live().prepare('UPDATE tags SET reorder_pass = 1 WHERE rowid % 2 = 0').run();
        for (const [id, mode] of [[2, 'alphabetical'], [3, 'by_entries']]) {
            record(id, mode);
            let batches = 0;
            afterCommit = () => {
                if (++batches === 1) live().prepare('UPDATE tags SET usage_count = 9 WHERE id = ?').run('t1100');
            };
            recording = true;
            await metadataDb.runTagReorderPassIfNeeded(directories);
            recording = false;
            afterCommit = null;
        }
        const plans = reads
            .filter(({ sql }) => /\bFROM tags\b/.test(sql) && !/ORDER BY id\b/.test(sql))
            .map(({ sql, params }) => {
                const explain = live().prepare(`EXPLAIN QUERY PLAN ${sql}`);
                return [...(params === undefined ? explain.iterate() : explain.iterate(params))].map(row => row.detail).join(' | ');
            });
        expect(plans.length).toBeGreaterThan(0);
        expect(plans.filter(plan => /\bSCAN tags\b(?! USING)/.test(plan) || /TEMP B-TREE/.test(plan))).toEqual([]);
    });

    test('runs after the sort_order fill and before fillEntityCountsIfNeeded', async () => {
        const { MIGRATION_PASSES } = await import('../src/metadata-migration-coordinator.js');
        const at = MIGRATION_PASSES.indexOf('runTagReorderPassIfNeeded');
        expect(at).toBeGreaterThan(MIGRATION_PASSES.indexOf('fillTagSortOrdersIfNeeded'));
        expect(MIGRATION_PASSES[MIGRATION_PASSES.length - 1]).toBe('fillEntityCountsIfNeeded');
    });
});
