import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {(name: string) => string} */
let tagNameKey;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/** Every statement the store's handle streamed, and how many rows each yielded, while recording. */
let recording = false;
/** @type {{ sql: string, params: any, yielded: number }[]} */
let iterated = [];

/** @param {any} handle */
function instrumentedHandle(handle) {
    const wrapped = { ...handle };
    wrapped.iterate = function* (sql, params) {
        const entry = { sql, params, yielded: 0 };
        if (recording) iterated.push(entry);
        for (const row of handle.iterate(sql, params)) {
            entry.yielded++;
            yield row;
        }
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
    ({ tagNameKey } = await import('../public/scripts/hash-utils.js'));
    Database = (await import('better-sqlite3')).default;

    const { router } = await import('../src/endpoints/tags.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json({ limit: '10mb' }));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-query-test-'));
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
    recording = false;
    iterated = [];
});

/** @type {import('better-sqlite3').Database | null} */
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
 * @param {object} body
 * @returns {Promise<{ status: number, body: any }>}
 */
async function query(body) {
    const response = await fetch(`${baseUrl}/api/tags/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

/**
 * Follows cursors from the first page to the end, collecting ids.
 * @param {object} body
 * @returns {Promise<{ ids: string[], requests: number, capped: number }>}
 */
async function queryAll(body) {
    const ids = [];
    let cursor = null;
    let requests = 0;
    let capped = 0;
    for (;;) {
        const { status, body: page } = await query({ ...body, cursor });
        expect(status).toBe(200);
        requests++;
        if (page.more) capped++;
        ids.push(...page.rows.map(t => t.id));
        if (page.cursor === null) {
            expect(page.more).toBe(false);
            return { ids, requests, capped };
        }
        cursor = page.cursor;
        if (requests > 10000) throw new Error('cursor does not advance');
    }
}

/**
 * A mixed set of tags: every sort_order form the coercion covers (ties, missing, null, numeric strings, infinities,
 * no order), folders and not, names with case, accents and duplicates, some assigned, some at count 0.
 */
function mixedTags() {
    const orders = [undefined, 3, 3, null, '7', 'abc', { at: 1 }, 1.5, 'Infinity', '-Infinity', 0, -2, true, 3];
    const folders = [undefined, 'NONE', 'OPEN', 'CLOSED', null];
    const names = ['Alpha', 'alpha', 'Álpha', 'Beta', 'beta two', 'Gamma', 'Zed', 'zeta', 'ćwierć', '😀 smile', 'b', 'ab', 'Abc'];
    const tags = [];
    for (let i = 0; i < 70; i++) {
        const tag = { id: `t${String(i).padStart(3, '0')}`, name: names[i % names.length] + (i % 4 === 0 ? '' : ` ${i % 5}`) };
        const order = orders[i % orders.length];
        if (order !== undefined) tag.sort_order = order;
        const folder = folders[i % folders.length];
        if (folder !== undefined) tag.folder_type = folder;
        tags.push(tag);
    }
    tags.push({ id: 'nameless', sort_order: 3 });
    return tags;
}

/**
 * Writes tags and assignments: tag i gets (i % 4) assignments, and every tag divisible by 9 gets one that is then
 * removed, leaving it a tag_usage row at 0.
 * @param {object[]} tags
 */
async function seed(tags) {
    await metadataDb.ensureSchemaMigrated(directories);
    await metadataDb.saveTagDefinitions(directories, tags);
    const db = live();
    const assign = db.prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)');
    db.transaction(() => {
        tags.forEach((tag, i) => {
            for (let n = 0; n < i % 4; n++) assign.run(`c${n}.png`, tag.id);
            if (i % 9 === 0) {
                assign.run('gone.png', tag.id);
                db.prepare('DELETE FROM character_tags WHERE character_id = ? AND tag_id = ?').run('gone.png', tag.id);
            }
        });
    })();
}

async function makeReady() {
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
    expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(true);
}

/** @param {string} a @param {string} b */
const bytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * The expected ids, computed from the rows directly: upstream's compareTagsForSort, with ties by rowid and names
 * compared as SQLite's BINARY does.
 * @param {string} sort
 * @param {{ used?: boolean, folders?: boolean, search?: string, name?: string, ids?: string[] }} filter
 */
function expected(sort, filter) {
    const rows = [...live().prepare(`SELECT t.rowid AS r, t.id, t.data, COALESCE(u.count, 0) AS count FROM tags t
        LEFT JOIN tag_usage u ON u.tag_id = t.id WHERE t.id NOT IN (SELECT tag_id FROM tag_deletions)`).iterate()];
    const items = rows.map(row => {
        const tag = JSON.parse(row.data);
        const { sortOrder, isFolder } = metadataDb.tagDerivedColumns(tag);
        return { id: row.id, r: row.r, s: sortOrder, k: typeof tag.name === 'string' ? tagNameKey(tag.name) : '', c: row.count, folder: isFolder === 1 };
    }).filter(t => (!filter.used || t.c > 0)
        && (!filter.folders || t.folder)
        && (!filter.search || Buffer.from(t.k).subarray(0, Buffer.byteLength(tagNameKey(filter.search.trim()))).equals(Buffer.from(tagNameKey(filter.search.trim()))))
        && (filter.name === undefined || t.k === tagNameKey(filter.name))
        && (!filter.ids || filter.ids.includes(t.id)));
    items.sort((a, b) => {
        let d = 0;
        if (sort === 'by_entries') d = (b.c - a.c) || bytes(a.k, b.k);
        else if (sort === 'alphabetical') d = bytes(a.k, b.k);
        else if (a.s !== null && b.s !== null) d = a.s < b.s ? -1 : a.s > b.s ? 1 : 0;
        else if (a.s !== null) d = -1;
        else if (b.s !== null) d = 1;
        else d = bytes(a.k, b.k);
        return d || a.r - b.r;
    });
    return items.map(t => t.id);
}

const SORTS = ['manual', 'alphabetical', 'by_entries'];
const FILTERS = [
    {},
    { used: true },
    { folders: true },
    { used: true, folders: true },
    { search: 'al' },
    { search: ' AL ' },
    { search: 'alpha', folders: true },
    { search: 'b', used: true },
    { search: 'zzz' },
    { name: 'ALPHA' },
    { name: 'Alpha', used: true, folders: true },
    { name: 'nope' },
    { ids: ['t005', 't001', 't040', 'missing', 't033', 'nameless'] },
    { ids: ['t005', 't001', 't040', 't033'], search: 'a', folders: true },
];

/** EXPLAIN QUERY PLAN of every statement recorded, as text. */
function recordedPlans() {
    return iterated.map(({ sql, params }) => {
        const bound = Array.isArray(params) ? params : Object.fromEntries(Object.entries(params ?? {}));
        const plan = Array.from(live().prepare(`EXPLAIN QUERY PLAN ${sql}`).iterate(bound), row => row.detail).join(' | ');
        return { sql, plan };
    });
}

describe('POST /api/tags/query', () => {
    describe.each([['indexed path', true], ['today\'s path', false]])('%s', (_, ready) => {
        test('every sort and filter pages through exactly the expected order, following cursors', async () => {
            await seed(mixedTags());
            if (ready) await makeReady();
            expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(ready);
            for (const sort of SORTS) {
                for (const filter of FILTERS) {
                    const want = expected(sort, filter);
                    const got = await queryAll({ sort: { field: sort }, filter, pageSize: 4 });
                    expect({ sort, filter, ids: got.ids }).toEqual({ sort, filter, ids: want });
                    expect(got.capped).toBe(0);
                }
            }
        });

        test('tags marked deleted are left out', async () => {
            await seed(mixedTags());
            await metadataDb.deleteTagDefinition(directories, 't002', null);
            await metadataDb.deleteTagDefinition(directories, 't014', null);
            if (ready) await makeReady();
            for (const sort of SORTS) {
                const got = await queryAll({ sort: { field: sort }, pageSize: 9 });
                expect(got.ids).not.toContain('t002');
                expect(got.ids).not.toContain('t014');
                expect(got.ids).toEqual(expected(sort, {}));
            }
        });
    });

    test('the sort defaults to manual and the page size to 50, clamped to 500', async () => {
        const tags = Array.from({ length: 620 }, (_, i) => ({ id: `p${String(i).padStart(4, '0')}`, name: `P ${619 - i}`, sort_order: i % 5 === 0 ? undefined : 1000 - i }));
        await seed(tags);
        await makeReady();
        const first = await query({});
        expect(first.body.rows.map(t => t.id)).toEqual(expected('manual', {}).slice(0, 50));
        expect((await query({ pageSize: 100000 })).body.rows).toHaveLength(500);
        expect((await query({ pageSize: 0 })).body.rows).toHaveLength(50);
        expect((await query({ pageSize: 'x' })).body.rows).toHaveLength(50);
    });

    test('bad input is a 400', async () => {
        await seed(mixedTags());
        await makeReady();
        const manualCursor = (await query({ pageSize: 2 })).body.cursor;
        const cases = [
            { sort: { field: 'random' } },
            { filter: { search: 3 } },
            { filter: { name: ['a'] } },
            { filter: { used: 'yes' } },
            { filter: { folders: 1 } },
            { filter: { ids: 't001' } },
            { filter: { ids: [1] } },
            { filter: { ids: Array.from({ length: 501 }, (_, i) => `x${i}`) } },
            { cursor: 'not a cursor' },
            { cursor: 12 },
            { sort: { field: 'alphabetical' }, cursor: manualCursor },
        ];
        for (const body of cases) {
            expect({ body, status: (await query(body)).status }).toEqual({ body, status: 400 });
        }
        // 500 distinct ids, repeated, is within the cap.
        const ids = Array.from({ length: 500 }, (_, i) => `x${i}`);
        expect((await query({ filter: { ids: [...ids, ...ids] } })).status).toBe(200);
    });

    for (const sort of SORTS) {
        test(`a ${sort} cursor from today's path carries on on the indexed path once the fill is done`, async () => {
            await seed(mixedTags());
            expect(await metadataDb.areTagQueryColumnsReady(directories)).toBe(false);
            const firstPage = await query({ sort: { field: sort }, pageSize: 23 });
            await makeReady();
            const ids = firstPage.body.rows.map(t => t.id);
            let cursor = firstPage.body.cursor;
            while (cursor !== null) {
                const page = await query({ sort: { field: sort }, pageSize: 23, cursor });
                ids.push(...page.body.rows.map(t => t.id));
                cursor = page.body.cursor;
            }
            expect(ids).toEqual(expected(sort, {}));
        });
    }

    test('every indexed read goes through its index in order, with no sort step and no scan of the table', async () => {
        await seed(mixedTags());
        await makeReady();
        recording = true;
        for (const sort of SORTS) {
            for (const filter of FILTERS) {
                if (filter.ids) continue;
                await queryAll({ sort: { field: sort }, filter, pageSize: 3 });
            }
        }
        recording = false;
        const plans = recordedPlans().filter(p => p.sql.includes('INDEXED BY'));
        expect(plans.length).toBeGreaterThan(0);
        for (const { sql, plan } of plans) {
            const index = /INDEXED BY (\w+)/.exec(sql)[1];
            expect({ sql, plan }).toEqual({ sql, plan: expect.stringContaining(`USING INDEX ${index}`) });
            expect(plan).not.toContain('TEMP B-TREE');
        }
        // by id: through the primary key.
        iterated = [];
        recording = true;
        await query({ filter: { ids: ['t001', 't002'] } });
        recording = false;
        for (const { plan } of recordedPlans()) expect(plan).toContain('sqlite_autoindex_tags_1');
    });

    test('a page after a cursor reads only its own rows, however deep, in every sort', async () => {
        const tags = Array.from({ length: 3000 }, (_, i) => ({ id: `d${String(i).padStart(4, '0')}`, name: `N ${i % 1500}`, sort_order: i < 2000 ? i % 7 : undefined }));
        await seed(tags);
        await makeReady();
        for (const sort of SORTS) {
            let cursor = null;
            for (let page = 0; page < 60; page++) {
                iterated = [];
                recording = true;
                const response = await query({ sort: { field: sort }, pageSize: 50, cursor });
                recording = false;
                expect(response.body.rows).toHaveLength(50);
                // Each row read is on the page: no row before the cursor is walked again.
                expect(iterated.reduce((n, q) => n + q.yielded, 0)).toBe(50);
                cursor = response.body.cursor;
            }
        }
    });

    test('a walk the index doesn\'t cover stops at the work cap with more, and following cursors finds every match once', async () => {
        const cap = metadataDb.TAG_QUERY_WORK_CAP;
        const tags = Array.from({ length: cap + 1500 }, (_, i) => ({ id: `w${String(i).padStart(6, '0')}`, name: `W ${String(i).padStart(6, '0')}`, sort_order: i }));
        // Folders at the end of the most-used order: count 0 and last by name.
        for (let i = 0; i < 5; i++) tags.push({ id: `f${i}`, name: `ZZ folder ${i}`, folder_type: 'OPEN' });
        await metadataDb.ensureSchemaMigrated(directories);
        await metadataDb.saveTagDefinitions(directories, tags);
        live().transaction(() => {
            const assign = live().prepare('INSERT INTO character_tags (character_id, tag_id) VALUES (?, ?)');
            for (let i = 0; i < 100; i++) assign.run('c.png', tags[i].id);
        })();
        await makeReady();

        const first = await query({ sort: { field: 'by_entries' }, filter: { folders: true }, pageSize: 50 });
        expect(first.body).toEqual({ rows: [], cursor: expect.any(String), more: true });
        const got = await queryAll({ sort: { field: 'by_entries' }, filter: { folders: true }, pageSize: 50 });
        expect(got.ids).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
        expect(got.capped).toBe(1);

        // The same for a search under manual phase 1 and under most used.
        for (const sort of ['manual', 'by_entries']) {
            const all = await queryAll({ sort: { field: sort }, filter: { search: 'zz' }, pageSize: 50 });
            expect(all.ids).toEqual(expected(sort, { search: 'zz' }));
            expect(all.capped).toBeGreaterThan(0);
        }
    });
});
