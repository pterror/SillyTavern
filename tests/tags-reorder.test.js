import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
/** @type {import('node:http').Server} */
let server;
let baseUrl = '';

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    Database = (await import('better-sqlite3')).default;

    const { router } = await import('../src/endpoints/tags.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories };
        next();
    });
    app.use('/api/tags', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-reorder-test-'));
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
});

/** @type {import('better-sqlite3').Database | null} A second connection for setting up and reading rows. */
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

/**
 * Opens the store with its tag query columns ready and the sort_order fill finished, on an empty table.
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

/** @returns {Map<string, { data: string, sort_order: number | null }>} */
function rows() {
    return new Map([...live().prepare('SELECT id, data, sort_order FROM tags').iterate()].map(r => [r.id, { data: r.data, sort_order: r.sort_order }]));
}

/** @param {string} id */
const data = id => JSON.parse(live().prepare('SELECT data FROM tags WHERE id = ?').pluck().get(id));

/** @param {string} id @returns {number | null} */
const column = id => live().prepare('SELECT sort_order FROM tags WHERE id = ?').pluck().get(id);

/** @returns {{ tag_id: string, side: string | null, anchor_id: string | null, value: string | null }[]} */
function pending() {
    return [...live().prepare('SELECT tag_id, side, anchor_id, value FROM tag_pending_moves ORDER BY seq').iterate()];
}

/** @param {string} key @returns {string | undefined} */
const meta = key => live().prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key);

/** The recorded reorder pass, or undefined. */
function pass() {
    const value = meta('tag_reorder_pass');
    return value === undefined ? undefined : JSON.parse(value);
}

/**
 * @param {string} route
 * @param {object} body
 * @returns {Promise<{ status: number, body: any }>}
 */
async function post(route, body) {
    const response = await fetch(`${baseUrl}/api/tags/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

/** Records a pass through /reorder, x after a. */
async function recordPass() {
    insertTag('a', { sort_order: 1 });
    insertTag('x', { sort_order: 5 });
    expect(await post('reorder', { id: 'x', after: 'a', mode: 'alphabetical' })).toEqual({ status: 200, body: { result: 'ok', refused: [], queued: true } });
}

describe('schema', () => {
    test('a tag_pending_moves with a sort_order column is rebuilt with value, keeping every entry and its seq', async () => {
        await metadataDb.ensureSchemaMigrated(directories);
        live().exec(`DROP TABLE tag_pending_moves;
            CREATE TABLE tag_pending_moves (
                seq        INTEGER PRIMARY KEY AUTOINCREMENT,
                tag_id     TEXT NOT NULL,
                side       TEXT CHECK (side IN ('before', 'after')),
                anchor_id  TEXT,
                sort_order REAL,
                CHECK ((side IS NOT NULL AND anchor_id IS NOT NULL AND sort_order IS NULL)
                    OR (side IS NULL AND anchor_id IS NULL AND sort_order IS NOT NULL))
            );
            INSERT INTO tag_pending_moves (seq, tag_id, side, anchor_id, sort_order) VALUES
                (3, 'x', 'before', 'a', NULL), (7, 'y', NULL, NULL, 7.5), (9, 'z', NULL, NULL, 2), (12, 'w', NULL, NULL, 9e999);`);
        liveDb.close();
        liveDb = null;
        metadataDb.disposeMetadataStores();

        await metadataDb.ensureSchemaMigrated(directories);
        const columns = [...live().prepare('PRAGMA table_info(tag_pending_moves)').iterate()].map(c => c.name);
        expect(columns).toEqual(['seq', 'tag_id', 'side', 'anchor_id', 'value']);
        const entries = [...live().prepare('SELECT seq, tag_id, side, anchor_id, value FROM tag_pending_moves ORDER BY seq').iterate()];
        expect(entries.map(e => ({ ...e, value: e.value === null ? null : JSON.parse(e.value) }))).toEqual([
            { seq: 3, tag_id: 'x', side: 'before', anchor_id: 'a', value: null },
            { seq: 7, tag_id: 'y', side: null, anchor_id: null, value: 7.5 },
            { seq: 9, tag_id: 'z', side: null, anchor_id: null, value: 2 },
            { seq: 12, tag_id: 'w', side: null, anchor_id: null, value: Infinity },
        ]);
        live().prepare('INSERT INTO tag_pending_moves (tag_id, value) VALUES (?, ?)').run('v', '"abc"');
        expect(live().prepare('SELECT seq FROM tag_pending_moves WHERE tag_id = ?').pluck().get('v')).toBeGreaterThan(12);
        expect(() => live().prepare('INSERT INTO tag_pending_moves (tag_id, side, anchor_id, value) VALUES (?, ?, ?, ?)').run('v', 'before', 'a', '1'))
            .toThrow(/CHECK constraint failed/);
    });

    test('tags gets a reorder_pass column, NULL on every row', async () => {
        await metadataDb.ensureSchemaMigrated(directories);
        insertTag('a', { sort_order: 1 });
        expect(live().prepare('SELECT reorder_pass FROM tags WHERE id = ?').pluck().get('a')).toBeNull();
    });
});

describe('POST /api/tags/reorder', () => {
    test('400s unless id, exactly one of before/after, and mode alphabetical or by_entries are given', async () => {
        await openStore();
        for (const body of [
            { before: 'a', mode: 'alphabetical' }, { id: '', before: 'a', mode: 'alphabetical' },
            { id: 'x', mode: 'alphabetical' }, { id: 'x', before: 'a', after: 'b', mode: 'alphabetical' },
            { id: 'x', before: '', mode: 'alphabetical' }, { id: 'x', after: 5, mode: 'by_entries' },
            { id: 'x', before: 'a' }, { id: 'x', before: 'a', mode: 'manual' }, { id: 'x', before: 'a', mode: 'Alphabetical' },
            { id: 'x', before: 'a', mode: null }, { id: 'x', before: 'a', mode: ['alphabetical'] },
        ]) {
            expect({ body, status: (await post('reorder', body)).status }).toEqual({ body, status: 400 });
        }
        expect(pass()).toBeUndefined();
        expect(pending()).toEqual([]);
    });

    test('records a pass with a new id, the mode and no place yet, and queues the move; no tag is written', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('x', { sort_order: 5 });
        const before = rows();
        const hash = await metadataDb.getTagsHash(directories);
        expect(await post('reorder', { id: 'x', before: 'a', mode: 'by_entries' })).toEqual({ status: 200, body: { result: 'ok', refused: [], queued: true } });
        expect(pass()).toEqual({ id: 1, mode: 'by_entries', at: null });
        expect(meta('tag_reorder_pass_last_id')).toBe('1');
        expect(pending()).toEqual([{ tag_id: 'x', side: 'before', anchor_id: 'a', value: null }]);
        expect(rows()).toEqual(before);
        expect(await metadataDb.getTagsHash(directories)).toBe(hash);
    });

    test('is recorded before the sort_order fill has finished too, after the moves already queued', async () => {
        await openStore({ filled: false });
        insertTag('a', { sort_order: 1 });
        insertTag('x', { sort_order: 5 });
        expect(await metadataDb.moveTagDefinition(directories, 'a', { after: 'x' })).toEqual({ refused: [], queued: true });
        expect(await post('reorder', { id: 'x', before: 'a', mode: 'alphabetical' })).toEqual({ status: 200, body: { result: 'ok', refused: [], queued: true } });
        expect(pass()).toEqual({ id: 1, mode: 'alphabetical', at: null });
        expect(pending()).toEqual([
            { tag_id: 'a', side: 'after', anchor_id: 'x', value: null },
            { tag_id: 'x', side: 'before', anchor_id: 'a', value: null },
        ]);
    });

    test('a second reorder replaces the pass: a greater id, its mode, its place reset; the queue carries over, its move last', async () => {
        await openStore();
        await recordPass();
        live().prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify({ id: 1, mode: 'alphabetical', at: { walked: 'somewhere' } }), 'tag_reorder_pass');
        expect(await metadataDb.moveTagDefinition(directories, 'a', { after: 'x' })).toEqual({ refused: [], queued: true });
        expect(await post('reorder', { id: 'a', before: 'x', mode: 'by_entries' })).toEqual({ status: 200, body: { result: 'ok', refused: [], queued: true } });
        expect(pass()).toEqual({ id: 2, mode: 'by_entries', at: null });
        expect(pending()).toEqual([
            { tag_id: 'x', side: 'after', anchor_id: 'a', value: null },
            { tag_id: 'a', side: 'after', anchor_id: 'x', value: null },
            { tag_id: 'a', side: 'before', anchor_id: 'x', value: null },
        ]);
    });

    test('pass ids keep growing after the record is gone', async () => {
        await openStore();
        await recordPass();
        live().prepare('DELETE FROM meta WHERE key = ?').run('tag_reorder_pass');
        live().prepare('DELETE FROM tag_pending_moves').run();
        expect((await post('reorder', { id: 'x', before: 'a', mode: 'alphabetical' })).body.queued).toBe(true);
        expect(pass()).toEqual({ id: 2, mode: 'alphabetical', at: null });
    });

    test('a refused reorder records no pass, replaces none and queues nothing', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('d', { sort_order: 2 });
        insertTag('bad', '{not json');
        insertTag('arr', '[1]');
        live().prepare('INSERT INTO tag_deletions (tag_id, merge_into) VALUES (?, NULL)').run('d');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const refusals = [
            [{ id: 'a', before: 'a' }, [{ id: 'a', reason: 'same' }]],
            [{ id: 'd', before: 'a' }, [{ id: 'd', reason: 'deleted' }]],
            [{ id: 'a', after: 'd' }, [{ id: 'd', reason: 'deleted' }]],
            [{ id: 'nope', after: 'a' }, [{ id: 'nope', reason: 'missing' }]],
            [{ id: 'a', after: 'nope' }, [{ id: 'nope', reason: 'missing' }]],
            [{ id: 'bad', after: 'a' }, [{ id: 'bad', reason: 'unreadable' }]],
        ];
        for (const [body, refused] of refusals) {
            expect(await post('reorder', { ...body, mode: 'alphabetical' })).toEqual({ status: 200, body: { result: 'ok', refused, queued: false } });
        }
        expect(pass()).toBeUndefined();
        expect(meta('tag_reorder_pass_last_id')).toBeUndefined();
        expect(pending()).toEqual([]);

        expect((await post('reorder', { id: 'a', after: 'arr', mode: 'by_entries' })).body.queued).toBe(true);
        expect(await post('reorder', { id: 'nope', after: 'a', mode: 'alphabetical' })).toEqual({ status: 200, body: { result: 'ok', refused: [{ id: 'nope', reason: 'missing' }], queued: false } });
        expect(pass()).toEqual({ id: 1, mode: 'by_entries', at: null });
        expect(pending()).toHaveLength(1);
    });
});

describe('while a reorder pass is recorded', () => {
    test('a move is queued even with the fill finished and nothing else queued', async () => {
        await openStore();
        await recordPass();
        live().prepare('DELETE FROM tag_pending_moves').run();
        const before = rows();
        expect(await post('move', { id: 'a', after: 'x' })).toEqual({ status: 200, body: { result: 'ok', refused: [], queued: true } });
        expect(pending()).toEqual([{ tag_id: 'a', side: 'after', anchor_id: 'x', value: null }]);
        expect(rows()).toEqual(before);
    });

    test('the sort_order fill applies nothing queued, finished or finishing', async () => {
        await openStore({ filled: false });
        insertTag('a', { sort_order: 1 });
        insertTag('x', { sort_order: 5 });
        insertTag('n', { name: 'N' });
        expect(await metadataDb.moveTagDefinition(directories, 'x', { before: 'a' })).toEqual({ refused: [], queued: true });
        expect((await post('reorder', { id: 'a', before: 'x', mode: 'alphabetical' })).body.queued).toBe(true);
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(column('n')).toBe(6);
        expect([column('a'), column('x')]).toEqual([1, 5]);
        expect(pending()).toHaveLength(2);
        expect(await metadataDb.fillTagSortOrdersIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
        expect(pending()).toHaveLength(2);
        expect(pass()).toEqual({ id: 1, mode: 'alphabetical', at: null });
    });

    test('an edit writes its other fields at once and queues its sort_order as given', async () => {
        await openStore();
        await recordPass();
        const hash = await metadataDb.getTagsHash(directories);
        expect(await post('edit', { id: 'a', patch: { name: 'Alpha', sort_order: 'abc' } })).toEqual({ status: 200, body: { result: 'ok', refused: [] } });
        expect(data('a')).toEqual({ id: 'a', name: 'Alpha', sort_order: 1 });
        expect(column('a')).toBe(1);
        expect(await metadataDb.getTagsHash(directories)).not.toBe(hash);
        expect(pending().slice(1)).toEqual([{ tag_id: 'a', side: null, anchor_id: null, value: '"abc"' }]);
    });

    test('an edit of only the sort_order, even to the stored value, writes no tag and queues it', async () => {
        await openStore();
        await recordPass();
        const before = rows();
        const hash = await metadataDb.getTagsHash(directories);
        expect((await post('edit', { id: 'x', patch: { sort_order: 5 } })).body.refused).toEqual([]);
        expect((await post('edit', { id: 'x', patch: { sort_order: null } })).body.refused).toEqual([]);
        expect(rows()).toEqual(before);
        expect(await metadataDb.getTagsHash(directories)).toBe(hash);
        expect(pending().slice(1)).toEqual([
            { tag_id: 'x', side: null, anchor_id: null, value: '5' },
            { tag_id: 'x', side: null, anchor_id: null, value: 'null' },
        ]);
    });

    test('a refused edit queues nothing', async () => {
        await openStore();
        await recordPass();
        insertTag('bad', '{not json');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect((await post('edit', { id: 'nope', patch: { sort_order: 3 } })).body.refused).toEqual([{ id: 'nope', reason: 'missing' }]);
        expect((await post('edit', { id: 'bad', patch: { sort_order: 3 } })).body.refused).toEqual([{ id: 'bad', reason: 'unreadable' }]);
        expect(pending()).toHaveLength(1);
    });

    test('a create with its own sort_order writes it and queues it too; one without gets max+1 and queues nothing', async () => {
        await openStore();
        await recordPass();
        expect(await post('create', { tag: { id: 'n', name: 'N', sort_order: 3 } })).toEqual({ status: 200, body: { result: 'ok', refused: [] } });
        expect([data('n').sort_order, column('n')]).toEqual([3, 3]);
        expect(await post('create', { tag: { id: 'm', name: 'M', sort_order: null } })).toEqual({ status: 200, body: { result: 'ok', refused: [] } });
        expect(await post('create', { tag: { id: 'o', name: 'O' } })).toEqual({ status: 200, body: { result: 'ok', refused: [] } });
        expect(data('o').sort_order).toBe(6);
        expect(pending().slice(1)).toEqual([
            { tag_id: 'n', side: null, anchor_id: null, value: '3' },
            { tag_id: 'm', side: null, anchor_id: null, value: 'null' },
        ]);
    });
});

describe('with no reorder pass recorded', () => {
    test('an edit and a create write their sort_order and queue nothing', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        expect((await post('edit', { id: 'a', patch: { sort_order: 4 } })).body.refused).toEqual([]);
        expect((await post('create', { tag: { id: 'n', name: 'N', sort_order: 3 } })).body.refused).toEqual([]);
        expect([column('a'), column('n')]).toEqual([4, 3]);
        expect(pending()).toEqual([]);
    });

    test('the drain writes a value entry\'s raw value into data and its coerced value into the column', async () => {
        await openStore();
        insertTag('s', { sort_order: 1 });
        insertTag('t', { sort_order: 5 });
        insertTag('u', { sort_order: 2 });
        insertTag('v', { sort_order: 3 });
        const insert = live().prepare('INSERT INTO tag_pending_moves (tag_id, value) VALUES (?, ?)');
        insert.run('s', '"abc"');
        insert.run('t', '"5"');
        insert.run('u', 'null');
        insert.run('v', '{"x":1}');
        const totals = await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(totals).toEqual({ batches: 4, rowsChanged: 4 });
        expect(pending()).toEqual([]);
        expect([data('s').sort_order, column('s')]).toEqual(['abc', null]);
        expect([data('t').sort_order, column('t')]).toEqual(['5', 5]);
        expect([data('u').sort_order, column('u')]).toEqual([null, 0]);
        expect([data('v').sort_order, column('v')]).toEqual([{ x: 1 }, null]);
    });

    test('a value entry equal to the stored raw value writes nothing', async () => {
        await openStore();
        insertTag('s', { sort_order: 'abc' });
        live().prepare('INSERT INTO tag_pending_moves (tag_id, value) VALUES (?, ?)').run('s', '"abc"');
        const before = rows();
        expect(await metadataDb.fillTagSortOrdersIfNeeded(directories)).toEqual({ batches: 1, rowsChanged: 0 });
        expect(rows()).toEqual(before);
    });
});
