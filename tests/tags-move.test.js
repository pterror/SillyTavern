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

/** @type {string[]} The SQL of every write made through the store's handle. */
let runSql = [];
/** @type {{ sql: string, params: any }[]} Every read made through the store's handle while recording. */
let reads = [];
let recording = false;

/** @param {any} handle */
function instrumentedHandle(handle) {
    const wrapped = { ...handle };
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-move-test-'));
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
    runSql = [];
    reads = [];
    recording = false;
});

/** @type {import('better-sqlite3').Database | null} A second connection for setting up and reading rows. */
let liveDb = null;
function live() {
    liveDb ??= new Database(path.join(directories.root, 'character-metadata.sqlite'));
    return liveDb;
}

afterEach(() => {
    metadataDb.characterChangeEmitter.removeAllListeners(metadataDb.TAG_MOVE_FAILED_EVENT);
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

/** @param {string} id */
function markDeleted(id) {
    live().prepare('INSERT INTO tag_deletions (tag_id, merge_into) VALUES (?, NULL)').run(id);
}

/**
 * Opens the store with its tag query columns ready, on an empty table.
 * @param {{ filled?: boolean }} [options] filled: false leaves the sort_order fill unfinished, so moves are queued.
 */
async function openStore({ filled = true } = {}) {
    await metadataDb.ensureSchemaMigrated(directories);
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
    await metadataDb.migrateTagsJsonIfNeeded(directories);
    expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(true);
    if (filled) await metadataDb.fillTagSortOrdersIfNeeded(directories);
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

/** Ids whose row differs between two rows() snapshots. */
function changedIds(before, after) {
    return [...after.keys()].filter(id => JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))).sort();
}

/**
 * Moves and checks that nothing was written.
 * @param {string} id
 * @param {{ before?: string, after?: string }} placement
 */
async function moveWritingNothing(id, placement) {
    const before = rows();
    const hash = await metadataDb.getTagsHash(directories);
    runSql = [];
    const result = await metadataDb.moveTagDefinition(directories, id, placement);
    expect(runSql).toEqual([]);
    expect(rows()).toEqual(before);
    expect(await metadataDb.getTagsHash(directories)).toBe(hash);
    return result;
}

/** @param {string} id @param {{ before?: string, after?: string }} placement */
async function move(id, placement) {
    const hash = await metadataDb.getTagsHash(directories);
    const result = await metadataDb.moveTagDefinition(directories, id, placement);
    expect(result).toEqual({ refused: [] });
    expect(columnMismatches()).toEqual([]);
    expect(await metadataDb.getTagsHash(directories)).not.toBe(hash);
    return result;
}

/** @param {jest.SpiedFunction<any>} spy */
const warnings = spy => spy.mock.calls.map(args => String(args[0])).join('\n');

describe('moveTagDefinition: refusals write nothing', () => {
    test('a tag as its own anchor is refused as same, and nothing else is checked', async () => {
        await openStore();
        expect(await moveWritingNothing('ghost', { before: 'ghost' })).toEqual({ refused: [{ id: 'ghost', reason: 'same' }] });
    });

    test('a missing tag and a missing anchor are both listed', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        expect(await moveWritingNothing('x', { after: 'y' })).toEqual({ refused: [{ id: 'x', reason: 'missing' }, { id: 'y', reason: 'missing' }] });
        expect(await moveWritingNothing('x', { after: 'a' })).toEqual({ refused: [{ id: 'x', reason: 'missing' }] });
        expect(await moveWritingNothing('a', { before: 'y' })).toEqual({ refused: [{ id: 'y', reason: 'missing' }] });
    });

    test('a deleted tag and a deleted anchor are both listed and logged as stale; a marked id with no row is only deleted', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('b', { sort_order: 2 });
        insertTag('c', { sort_order: 3 });
        markDeleted('a');
        markDeleted('b');
        markDeleted('gone');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await moveWritingNothing('a', { before: 'b' })).toEqual({ refused: [{ id: 'a', reason: 'deleted' }, { id: 'b', reason: 'deleted' }] });
        expect(warnings(warn)).toContain('a, b');
        expect(await moveWritingNothing('gone', { after: 'c' })).toEqual({ refused: [{ id: 'gone', reason: 'deleted' }] });
        expect(await moveWritingNothing('c', { after: 'gone' })).toEqual({ refused: [{ id: 'gone', reason: 'deleted' }] });
    });

    test('a marked tag whose data isn\'t an object is only deleted', async () => {
        await openStore();
        insertTag('bad', '[1]');
        insertTag('a', { sort_order: 1 });
        markDeleted('bad');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await moveWritingNothing('bad', { before: 'a' })).toEqual({ refused: [{ id: 'bad', reason: 'deleted' }] });
    });

    test('a tag whose data isn\'t an object is unreadable, and the anchor is still checked', async () => {
        await openStore();
        insertTag('bad', '{not json');
        insertTag('arr', '[1]');
        insertTag('a', { sort_order: 1 });
        expect(await moveWritingNothing('bad', { before: 'a' })).toEqual({ refused: [{ id: 'bad', reason: 'unreadable' }] });
        expect(await moveWritingNothing('bad', { before: 'y' })).toEqual({ refused: [{ id: 'bad', reason: 'unreadable' }, { id: 'y', reason: 'missing' }] });
        expect(await moveWritingNothing('bad', { after: 'arr' })).toEqual({ refused: [{ id: 'bad', reason: 'unreadable' }, { id: 'arr', reason: 'unreadable' }] });
    });

    test('an anchor without a sort_order whose data isn\'t an object is unreadable', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('arr', '[1]');
        expect(await moveWritingNothing('a', { after: 'arr' })).toEqual({ refused: [{ id: 'arr', reason: 'unreadable' }] });
    });

    test('an anchor in the tail past the work cap is unordered', async () => {
        await openStore();
        const cap = metadataDb.TAG_QUERY_WORK_CAP;
        live().transaction(() => {
            insertTag('x', { sort_order: 1 });
            for (let i = 0; i < cap; i++) insertTag(`t${String(i).padStart(6, '0')}`, { name: `T ${String(i).padStart(6, '0')}` });
            insertTag('last', { name: 'Zzz' });
            insertTag('first', { name: 'Aaa' });
        })();
        expect(await moveWritingNothing('x', { before: 'last' })).toEqual({ refused: [{ id: 'last', reason: 'unordered' }] });
        // 'first' and t000000..t019998 are the cap's rows, numbered 2.. after x's 1.
        expect(await moveWritingNothing('x', { after: `t${String(cap - 1).padStart(6, '0')}` })).toEqual({ refused: [{ id: `t${String(cap - 1).padStart(6, '0')}`, reason: 'unordered' }] });
        await move('x', { after: `t${String(cap - 2).padStart(6, '0')}` });
        expect(dataOrder('first')).toBe(2);
        expect(dataOrder(`t${String(cap - 2).padStart(6, '0')}`)).toBe(cap + 1);
        expect(dataOrder('x')).toBe(cap + 2);
        expect(rows().get(`t${String(cap - 1).padStart(6, '0')}`).sort_order).toBeNull();
    });

    test('with no finite value left after the max, numbering the tail is refused as no-room, naming both tags', async () => {
        await openStore();
        insertTag('inf', '{"id":"inf","name":"inf","sort_order":1e999}');
        insertTag('x', { sort_order: 1 });
        insertTag('b', { name: 'B' });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await moveWritingNothing('x', { before: 'b' })).toEqual({ refused: [{ id: 'x', reason: 'no-room' }] });
        expect(warnings(warn)).toContain('x (x) before b (B)');
    });
});

describe('moveTagDefinition: already in place writes nothing', () => {
    test('in the order', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('b', { sort_order: 2 });
        insertTag('c', { sort_order: 2 });
        expect(await moveWritingNothing('a', { before: 'b' })).toEqual({ refused: [] });
        expect(await moveWritingNothing('b', { after: 'a' })).toEqual({ refused: [] });
        expect(await moveWritingNothing('c', { after: 'b' })).toEqual({ refused: [] });
    });

    test('in the tail, before the anchor', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('b', { name: 'B' });
        insertTag('c', { name: 'C' });
        expect(await moveWritingNothing('b', { before: 'c' })).toEqual({ refused: [] });
    });
});

describe('moveTagDefinition: midpoint and ends', () => {
    test('before and after an anchor, only the moved tag changes, data and column together', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('b', { sort_order: '2' });
        insertTag('c', { sort_order: 3 });
        insertTag('x', { sort_order: 10, color: 'red' });
        let snapshot = rows();
        await move('x', { before: 'b' });
        expect(changedIds(snapshot, rows())).toEqual(['x']);
        expect(dataOrder('x')).toBe(1.5);
        expect(JSON.parse(rows().get('x').data).color).toBe('red');
        expect(displayOrder()).toEqual(['a', 'x', 'b', 'c']);

        snapshot = rows();
        await move('x', { after: 'b' });
        expect(changedIds(snapshot, rows())).toEqual(['x']);
        expect(dataOrder('x')).toBe(2.5);
        expect(displayOrder()).toEqual(['a', 'b', 'x', 'c']);
    });

    test('before the first tag and after the last', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('b', { sort_order: 2.5 });
        insertTag('x', { sort_order: 2 });
        await move('x', { before: 'a' });
        expect(dataOrder('x')).toBe(0);
        await move('x', { after: 'b' });
        expect(dataOrder('x')).toBe(3.5);
        expect(displayOrder()).toEqual(['a', 'b', 'x']);
    });

    test('a tag without a sort_order moves into the order', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('b', { sort_order: 2 });
        insertTag('x', { name: 'X' });
        await move('x', { before: 'b' });
        expect(dataOrder('x')).toBe(1.5);
    });
});

describe('moveTagDefinition: the renumbering window', () => {
    /** @param {string} prefix @param {number} count @param {(i: number) => number} value */
    function insertRun(prefix, count, value) {
        for (let i = 0; i < count; i++) insertTag(`${prefix}${String(i).padStart(2, '0')}`, { sort_order: value(i) });
    }

    test('a tie spreads 16 rows (8 each side of the gap) between the rows just outside, the moved tag in the gap', async () => {
        await openStore();
        live().transaction(() => {
            insertRun('p', 12, i => i + 1);
            insertRun('t', 4, () => 20);
            insertRun('q', 12, i => 30 + i);
            insertTag('x', { sort_order: 100 });
        })();
        const snapshot = rows();
        await move('x', { before: 't02' });
        const window = ['p06', 'p07', 'p08', 'p09', 'p10', 'p11', 't00', 't01', 'x', 't02', 't03', 'q00', 'q01', 'q02', 'q03', 'q04', 'q05'];
        const order = displayOrder();
        expect(order.slice(order.indexOf('p06'), order.indexOf('q05') + 1)).toEqual(window);
        window.forEach((id, i) => expect(dataOrder(id)).toBe(6 + (36 - 6) * (i + 1) / 18));
        expect(changedIds(snapshot, rows())).toEqual([...window].sort());
    });

    test('doubles when 16 rows have no room, and rows already at their value aren\'t written', async () => {
        await openStore();
        live().transaction(() => {
            insertRun('a', 10, i => i + 1);
            insertRun('t', 20, () => 20);
            insertRun('b', 10, i => 30 + i);
            insertTag('x', { sort_order: 1000 });
        })();
        const snapshot = rows();
        await move('x', { before: 't10' });
        const window = [
            'a04', 'a05', 'a06', 'a07', 'a08', 'a09',
            ...Array.from({ length: 10 }, (_, i) => `t${String(i).padStart(2, '0')}`), 'x',
            ...Array.from({ length: 10 }, (_, i) => `t${String(i + 10).padStart(2, '0')}`),
            'b00', 'b01', 'b02', 'b03', 'b04', 'b05',
        ];
        const order = displayOrder();
        expect(order.slice(order.indexOf('a04'), order.indexOf('b05') + 1)).toEqual(window);
        const values = window.map((_, i) => 4 + (36 - 4) * (i + 1) / 34);
        window.forEach((id, i) => expect(dataOrder(id)).toBe(values[i]));
        expect(changedIds(snapshot, rows())).toEqual(window.filter((id, i) => snapshot.get(id).sort_order !== values[i]).sort());
    });

    test('a window reaching the end of the order continues after the bound on the other side', async () => {
        await openStore();
        live().transaction(() => {
            insertRun('a', 20, i => i + 1);
            insertRun('t', 4, () => 30);
            insertTag('x', { sort_order: 0 });
        })();
        await move('x', { after: 't01' });
        const window = ['a14', 'a15', 'a16', 'a17', 'a18', 'a19', 't00', 't01', 'x', 't02', 't03'];
        expect(displayOrder().slice(-11)).toEqual(window);
        window.forEach((id, i) => expect(dataOrder(id)).toBe(15 + i));
        expect(dataOrder('a13')).toBe(14);
    });

    test('an infinite anchor at the end is spread to finite values', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('inf', '{"id":"inf","name":"inf","sort_order":1e999}');
        insertTag('x', { sort_order: 0 });
        await move('x', { after: 'inf' });
        expect(displayOrder()).toEqual(['a', 'inf', 'x']);
        expect([dataOrder('a'), dataOrder('inf'), dataOrder('x')]).toEqual([1, 2, 3]);
    });
});

describe('moveTagDefinition: an anchor without a sort_order', () => {
    test('numbers the tail from its start through the anchor after the max, then places the tag', async () => {
        await openStore();
        insertTag('o1', { sort_order: 1 });
        insertTag('o2', { sort_order: 2 });
        insertTag('b', { name: 'B' });
        insertTag('c', { name: 'C', sort_order: 'abc' });
        insertTag('d', { name: 'D' });
        insertTag('e', { name: 'E' });
        insertTag('bad', '{not json');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await move('o1', { before: 'd' });
        expect([dataOrder('b'), dataOrder('c'), dataOrder('d'), dataOrder('o1')]).toEqual([3, 4, 5, 4.5]);
        expect(rows().get('e').sort_order).toBeNull();
        expect(rows().get('bad')).toEqual({ data: '{not json', sort_order: null });
        expect(displayOrder()).toEqual(['o2', 'b', 'c', 'o1', 'd', 'bad', 'e']);
        expect(warn.mock.calls.flatMap(args => String(args[0]).split('\n').filter(line => line.startsWith('  ')))).toEqual(['  c (C): "abc"', '  bad']);
    });

    test('a tail tag moved after a later tail anchor is skipped by the numbering and placed after it', async () => {
        await openStore();
        insertTag('b', { name: 'B' });
        insertTag('c', { name: 'C' });
        insertTag('d', { name: 'D' });
        await move('b', { after: 'c' });
        expect([dataOrder('c'), dataOrder('b')]).toEqual([1, 2]);
        expect(displayOrder()).toEqual(['c', 'b', 'd']);
    });
});

test('moveTagDefinition reads tags only through an index, never a table scan or a sort', async () => {
    await openStore();
    live().transaction(() => {
        for (let i = 0; i < 30; i++) insertTag(`o${i}`, { sort_order: i < 20 ? 5 : i });
        insertTag('x', { sort_order: 100 });
        insertTag('b', { name: 'B' });
        insertTag('c', { name: 'C' });
    })();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    recording = true;
    await metadataDb.moveTagDefinition(directories, 'x', { before: 'o10' });
    await metadataDb.moveTagDefinition(directories, 'x', { after: 'o25' });
    await metadataDb.moveTagDefinition(directories, 'o0', { before: 'c' });
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

describe('POST /api/tags/move', () => {
    async function post(body) {
        const response = await fetch(`${baseUrl}/api/tags/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    }

    test('400s unless id is a non-empty string and exactly one of before/after is a non-empty string', async () => {
        await openStore();
        for (const body of [
            {}, { before: 'a' }, { id: '', before: 'a' }, { id: 5, before: 'a' },
            { id: 'x' }, { id: 'x', before: 'a', after: 'b' }, { id: 'x', before: 'a', after: null },
            { id: 'x', before: null }, { id: 'x', before: '' }, { id: 'x', after: 5 }, { id: 'x', after: ['a'] },
        ]) {
            expect({ body, status: (await post(body)).status }).toEqual({ body, status: 400 });
        }
    });

    test('answers ok with what it refused and queued false', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('x', { sort_order: 5 });
        expect(await post({ id: 'x', before: 'a' })).toEqual({ status: 200, body: { result: 'ok', refused: [], queued: false } });
        expect(dataOrder('x')).toBe(0);
        expect(await post({ id: 'x', after: 'nope' })).toEqual({ status: 200, body: { result: 'ok', refused: [{ id: 'nope', reason: 'missing' }], queued: false } });
    });
});

/** @returns {{ tag_id: string, side: string | null, anchor_id: string | null, sort_order: number | null }[]} */
function pending() {
    return [...live().prepare('SELECT tag_id, side, anchor_id, sort_order FROM tag_pending_moves ORDER BY seq').iterate()];
}

/** @param {string} tagId @param {'before' | 'after'} side @param {string} anchorId */
function insertPending(tagId, side, anchorId) {
    live().prepare('INSERT INTO tag_pending_moves (tag_id, side, anchor_id) VALUES (?, ?, ?)').run(tagId, side, anchorId);
}

/** @param {string} tagId @param {number} sortOrder */
function insertPendingValue(tagId, sortOrder) {
    live().prepare('INSERT INTO tag_pending_moves (tag_id, sort_order) VALUES (?, ?)').run(tagId, sortOrder);
}

/** @param {string} id @param {{ before?: string, after?: string }} placement */
async function queue(id, placement) {
    expect(await metadataDb.moveTagDefinition(directories, id, placement)).toEqual({ refused: [], queued: true });
}

/**
 * Collects TAG_MOVE_FAILED_EVENT emissions.
 * @param {boolean} deliver Whether the listener acks them.
 */
function listenForMoveFailures(deliver) {
    /** @type {{ root: string, payload: any }[]} */
    const reports = [];
    metadataDb.characterChangeEmitter.on(metadataDb.TAG_MOVE_FAILED_EVENT, (root, payload, ack) => {
        reports.push({ root, payload });
        if (deliver) ack.delivered = true;
    });
    return reports;
}

describe('moveTagDefinition before the sort_order fill has finished: queued', () => {
    test('while the fill\'s flag is missing, the move is queued and nothing else is written', async () => {
        await openStore({ filled: false });
        insertTag('a', { sort_order: 1 });
        insertTag('x', { sort_order: 5 });
        const before = rows();
        const hash = await metadataDb.getTagsHash(directories);
        runSql = [];
        await queue('x', { before: 'a' });
        expect(runSql).toHaveLength(1);
        expect(runSql[0]).toMatch(/^INSERT INTO tag_pending_moves\b/);
        expect(pending()).toEqual([{ tag_id: 'x', side: 'before', anchor_id: 'a', sort_order: null }]);
        expect(rows()).toEqual(before);
        expect(await metadataDb.getTagsHash(directories)).toBe(hash);
    });

    test('while the flag is set but a queued move is left, the move is queued after it', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('b', { sort_order: 2 });
        insertTag('x', { sort_order: 5 });
        insertPending('x', 'after', 'b');
        const before = rows();
        await queue('x', { before: 'a' });
        expect(pending()).toEqual([
            { tag_id: 'x', side: 'after', anchor_id: 'b', sort_order: null },
            { tag_id: 'x', side: 'before', anchor_id: 'a', sort_order: null },
        ]);
        expect(rows()).toEqual(before);
    });

    test('same, deleted, missing and an unreadable tag are still refused, queueing nothing; the anchor\'s order isn\'t checked', async () => {
        await openStore({ filled: false });
        insertTag('a', { sort_order: 1 });
        insertTag('d', { sort_order: 2 });
        insertTag('bad', '{not json');
        insertTag('arr', '[1]');
        markDeleted('d');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await moveWritingNothing('a', { before: 'a' })).toEqual({ refused: [{ id: 'a', reason: 'same' }] });
        expect(await moveWritingNothing('d', { before: 'a' })).toEqual({ refused: [{ id: 'd', reason: 'deleted' }] });
        expect(await moveWritingNothing('a', { after: 'd' })).toEqual({ refused: [{ id: 'd', reason: 'deleted' }] });
        expect(await moveWritingNothing('nope', { after: 'a' })).toEqual({ refused: [{ id: 'nope', reason: 'missing' }] });
        expect(await moveWritingNothing('a', { after: 'nope' })).toEqual({ refused: [{ id: 'nope', reason: 'missing' }] });
        expect(await moveWritingNothing('bad', { after: 'a' })).toEqual({ refused: [{ id: 'bad', reason: 'unreadable' }] });
        expect(pending()).toEqual([]);
        await queue('a', { after: 'arr' });
        expect(pending()).toEqual([{ tag_id: 'a', side: 'after', anchor_id: 'arr', sort_order: null }]);
    });

    test('POST /api/tags/move answers queued true until the fill ends, then applies the move and answers queued false', async () => {
        await openStore({ filled: false });
        insertTag('a', { sort_order: 1 });
        insertTag('b', { sort_order: 2 });
        insertTag('x', { sort_order: 5 });
        const post = async body => (await fetch(`${baseUrl}/api/tags/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })).json();
        expect(await post({ id: 'x', before: 'a' })).toEqual({ result: 'ok', refused: [], queued: true });
        expect(dataOrder('x')).toBe(5);
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(pending()).toEqual([]);
        expect(dataOrder('x')).toBe(0);
        expect(await post({ id: 'x', after: 'a' })).toEqual({ result: 'ok', refused: [], queued: false });
        expect(dataOrder('x')).toBe(1.5);
    });
});

describe('the sort_order fill applies the queued moves when it ends', () => {
    test('in arrival order: a chain lands in order and a later entry for the same tag wins', async () => {
        await openStore({ filled: false });
        insertTag('a', { sort_order: 1 });
        insertTag('b', { sort_order: 2 });
        insertTag('c', { sort_order: 3 });
        insertTag('x', { sort_order: 10 });
        insertTag('y', { sort_order: 20 });
        insertTag('z', { sort_order: 30 });
        await queue('x', { after: 'b' });
        await queue('z', { after: 'x' });
        await queue('y', { before: 'a' });
        await queue('y', { after: 'c' });
        const hash = await metadataDb.getTagsHash(directories);
        let changedEvents = 0;
        const onChanged = () => changedEvents++;
        metadataDb.characterChangeEmitter.on(metadataDb.TAG_DEFINITIONS_CHANGED_EVENT, onChanged);
        try {
            const totals = await metadataDb.fillTagSortOrdersIfNeeded(directories);
            expect(totals.rowsChanged).toBe(4);
        } finally {
            metadataDb.characterChangeEmitter.off(metadataDb.TAG_DEFINITIONS_CHANGED_EVENT, onChanged);
        }
        expect(changedEvents).toBe(4);
        expect(pending()).toEqual([]);
        expect(displayOrder()).toEqual(['a', 'b', 'x', 'z', 'c', 'y']);
        expect([dataOrder('x'), dataOrder('z'), dataOrder('y')]).toEqual([2.5, 2.75, 4]);
        expect(columnMismatches()).toEqual([]);
        expect(await metadataDb.getTagsHash(directories)).not.toBe(hash);
    });

    test('a move whose tag was deleted or is gone is dropped with no warning', async () => {
        await openStore({ filled: false });
        insertTag('a', { sort_order: 1 });
        insertTag('x', { sort_order: 5 });
        insertTag('y', { sort_order: 6 });
        await queue('x', { before: 'a' });
        await queue('y', { before: 'a' });
        markDeleted('x');
        live().prepare('DELETE FROM tags WHERE id = ?').run('y');
        const before = rows();
        const reports = listenForMoveFailures(false);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(pending()).toEqual([]);
        expect(rows()).toEqual(before);
        expect(reports).toEqual([]);
        expect(warnings(warn)).not.toMatch(/Couldn't move/);
    });

    test('a deleted anchor leaves the tag where it is and reports it; logged when nothing takes the report', async () => {
        await openStore({ filled: false });
        insertTag('a', { name: 'Alpha', sort_order: 1 });
        insertTag('b', { sort_order: 2 });
        insertTag('x', { name: 'Ex', sort_order: 5 });
        await queue('x', { before: 'a' });
        await queue('x', { after: 'b' });
        markDeleted('a');
        live().prepare('DELETE FROM tags WHERE id = ?').run('b');
        const reports = listenForMoveFailures(false);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(pending()).toEqual([]);
        expect(dataOrder('x')).toBe(5);
        expect(reports).toEqual([
            { root: directories.root, payload: { tagId: 'x', tagName: 'Ex', anchorId: 'a', anchorName: 'Alpha', refusedId: 'a', reason: 'deleted' } },
            { root: directories.root, payload: { tagId: 'x', tagName: 'Ex', anchorId: 'b', anchorName: null, refusedId: 'b', reason: 'deleted' } },
        ]);
        expect(warnings(warn)).toContain('[character-metadata] Couldn\'t move tag "Ex" next to "Alpha": "Alpha" was deleted.');
        expect(warnings(warn)).toContain('[character-metadata] Couldn\'t move tag "Ex" next to "b": "b" was deleted.');
    });

    test('a report a listener takes isn\'t logged', async () => {
        await openStore({ filled: false });
        insertTag('a', { sort_order: 1 });
        insertTag('x', { sort_order: 5 });
        await queue('x', { before: 'a' });
        markDeleted('a');
        const reports = listenForMoveFailures(true);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(reports).toHaveLength(1);
        expect(warnings(warn)).not.toMatch(/Couldn't move/);
    });

    test('a run that finds the fill finished applies what is left, and a restart finds nothing more', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('b', { sort_order: 2 });
        insertTag('x', { sort_order: 5 });
        insertPending('x', 'after', 'a');
        expect(await metadataDb.fillTagSortOrdersIfNeeded(directories)).toEqual({ batches: 1, rowsChanged: 1 });
        expect(pending()).toEqual([]);
        expect(dataOrder('x')).toBe(1.5);
        expect(await metadataDb.fillTagSortOrdersIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
    });

    test('an anchor in the tail past the work cap and an unreadable anchor are reported', async () => {
        await openStore();
        const cap = metadataDb.TAG_QUERY_WORK_CAP;
        live().transaction(() => {
            insertTag('x', { name: 'Ex', sort_order: 1 });
            for (let i = 0; i < cap; i++) insertTag(`t${String(i).padStart(6, '0')}`, { name: `T ${String(i).padStart(6, '0')}` });
            insertTag('last', { name: 'Zzz' });
            insertTag('arr', '[1]');
        })();
        insertPending('x', 'before', 'last');
        insertPending('x', 'after', 'arr');
        const before = rows();
        const reports = listenForMoveFailures(false);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(pending()).toEqual([]);
        expect(rows()).toEqual(before);
        expect(reports.map(r => r.payload)).toEqual([
            { tagId: 'x', tagName: 'Ex', anchorId: 'last', anchorName: 'Zzz', refusedId: 'last', reason: 'unordered' },
            { tagId: 'x', tagName: 'Ex', anchorId: 'arr', anchorName: null, refusedId: 'arr', reason: 'unreadable' },
        ]);
        expect(warnings(warn)).toContain('Couldn\'t move tag "Ex" next to "Zzz": "Zzz" is too far into the tags with no order.');
        expect(warnings(warn)).toContain('Couldn\'t move tag "Ex" next to "arr": the stored data of "arr" couldn\'t be read.');
    });

    test('a move refused for two reasons reports each, in order', async () => {
        await openStore();
        insertTag('bad', '{not json');
        insertTag('a', { name: 'Alpha', sort_order: 1 });
        markDeleted('a');
        insertPending('bad', 'before', 'a');
        const reports = listenForMoveFailures(true);
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(pending()).toEqual([]);
        expect(reports.map(r => r.payload)).toEqual([
            { tagId: 'bad', tagName: null, anchorId: 'a', anchorName: 'Alpha', refusedId: 'bad', reason: 'unreadable' },
            { tagId: 'bad', tagName: null, anchorId: 'a', anchorName: 'Alpha', refusedId: 'a', reason: 'deleted' },
        ]);
    });

    test('a move refused after numbering the tail rolls the numbering back and still drops the entry', async () => {
        await openStore();
        insertTag('inf', '{"id":"inf","name":"inf","sort_order":1e999}');
        insertTag('x', { sort_order: 1 });
        insertTag('b', { name: 'B' });
        insertPending('x', 'before', 'b');
        const before = rows();
        const reports = listenForMoveFailures(true);
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(pending()).toEqual([]);
        expect(rows()).toEqual(before);
        expect(reports.map(r => r.payload)).toEqual([
            { tagId: 'x', tagName: 'x', anchorId: 'b', anchorName: 'B', refusedId: 'x', reason: 'no-room' },
        ]);
    });

    test('a sort_order entry is written, one for a gone tag is dropped, and one for unreadable data is reported', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertTag('x', { sort_order: 5 });
        insertTag('bad', '{not json');
        insertPendingValue('x', 7.5);
        insertPendingValue('gone', 3);
        insertPendingValue('bad', 2);
        const reports = listenForMoveFailures(false);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const hash = await metadataDb.getTagsHash(directories);
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(pending()).toEqual([]);
        expect(dataOrder('x')).toBe(7.5);
        expect(columnMismatches()).toEqual([]);
        expect(rows().get('bad')).toEqual({ data: '{not json', sort_order: null });
        expect(reports.map(r => r.payload)).toEqual([
            { tagId: 'bad', tagName: null, anchorId: null, anchorName: null, refusedId: 'bad', reason: 'unreadable' },
        ]);
        expect(warnings(warn)).toContain('[character-metadata] Couldn\'t set the order of tag "bad": its stored data couldn\'t be read.');
        expect(await metadataDb.getTagsHash(directories)).not.toBe(hash);
    });

    test('a sort_order entry equal to the tag\'s writes nothing but its own removal', async () => {
        await openStore();
        insertTag('a', { sort_order: 1 });
        insertPendingValue('a', 1);
        const before = rows();
        const hash = await metadataDb.getTagsHash(directories);
        runSql = [];
        await metadataDb.fillTagSortOrdersIfNeeded(directories);
        expect(runSql).toEqual([expect.stringMatching(/^DELETE FROM tag_pending_moves\b/)]);
        expect(rows()).toEqual(before);
        expect(await metadataDb.getTagsHash(directories)).toBe(hash);
    });
});

test('tag_pending_moves refuses an entry that isn\'t exactly anchored or exactly a value', async () => {
    await openStore();
    const insert = (side, anchorId, sortOrder) => live().prepare('INSERT INTO tag_pending_moves (tag_id, side, anchor_id, sort_order) VALUES (?, ?, ?, ?)').run('x', side, anchorId, sortOrder);
    for (const [side, anchorId, sortOrder] of [
        ['before', 'a', 1], [null, null, null], ['before', null, null], [null, 'a', null], ['middle', 'a', null], [null, 'a', 1], ['after', null, 1],
    ]) {
        expect(() => insert(side, anchorId, sortOrder)).toThrow(/CHECK constraint failed/);
    }
    insert('before', 'a', null);
    insert(null, null, 1);
    expect(pending()).toHaveLength(2);
});
