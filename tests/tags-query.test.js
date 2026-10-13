import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import path from 'node:path';

// Seeding a few hundred tags takes a moment on a loaded machine.
jest.setTimeout(60000);

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/library-codes.js').TYPE} */
let TYPE;
/** @type {(name: string) => string} */
let tagNameKey;
/** @type {typeof import('../src/tag-order.js').tagDerivedColumns} */
let tagDerivedColumns;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
    ({ TYPE } = await import('../src/library-codes.js'));
    ({ tagNameKey } = await import('../public/scripts/hash-utils.js'));
    ({ tagDerivedColumns } = await import('../src/tag-order.js'));

    const { router } = await import('../src/endpoints/tags.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/tags', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-tags-query-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
    model = [];
});

afterEach(async () => {
    jest.restoreAllMocks();
    await user.close();
});

/** The tags seeded and still there, in creation order, each with the count of characters carrying it. @type {{ tag: any, count: number }[]} */
let model = [];

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
 * removed, leaving it at count 0.
 * @param {object[]} tags
 */
async function seed(tags) {
    // Written as given: the stored order forms the coercion covers must come back as they went in.
    for (let i = 0; i < tags.length; i += 200) {
        await Promise.all(tags.slice(i, i + 200).map(tag => user.store.lib.writeTag(/** @type {any} */ (tag))));
    }
    for (const name of ['c0.png', 'c1.png', 'c2.png', 'gone.png']) {
        await user.store.lib.writeCard(directories, name, JSON.stringify({ name, data: { name, tags: [], extensions: {} } }));
    }
    const lib = user.store.lib;
    for (const [i, tag] of tags.entries()) {
        for (let n = 0; n < i % 4; n++) await lib.assignTag(TYPE.character, `c${n}.png`, /** @type {any} */ (tag).id, true);
        if (i % 9 === 0) {
            await lib.assignTag(TYPE.character, 'gone.png', /** @type {any} */ (tag).id, true);
            await lib.assignTag(TYPE.character, 'gone.png', /** @type {any} */ (tag).id, false);
        }
    }
    model = tags.map((tag, i) => ({ tag, count: i % 4 }));
}

/** @param {string} a @param {string} b */
const bytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * The expected ids, computed from the tags seeded: upstream's compareTagsForSort, with ties by creation order and
 * names compared byte by byte.
 * @param {string} sort
 * @param {{ used?: boolean, folders?: boolean, search?: string, name?: string, contains?: string, ids?: string[] }} filter
 */
function expected(sort, filter) {
    const items = model.map(({ tag, count }, r) => {
        const { sortOrder, isFolder } = tagDerivedColumns(tag);
        return { id: tag.id, r, s: sortOrder, k: typeof tag.name === 'string' ? tagNameKey(tag.name) : '', c: count, folder: isFolder === 1 };
    }).filter(t => (!filter.used || t.c > 0)
        && (!filter.folders || t.folder)
        && (!filter.search || Buffer.from(t.k).subarray(0, Buffer.byteLength(tagNameKey(filter.search.trim()))).equals(Buffer.from(tagNameKey(filter.search.trim()))))
        && (filter.name === undefined || t.k === tagNameKey(filter.name))
        && (!filter.contains?.trim() || Buffer.from(t.k).includes(Buffer.from(tagNameKey(filter.contains.trim()))))
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
    { contains: 'lph' },
    { contains: ' ETA ' },
    { contains: 'ÁLP', used: true },
    { contains: 'a', folders: true },
    { contains: 'a 1', search: 'al' },
    { contains: '   ' },
    { contains: 'zzz' },
    { ids: ['t005', 't001', 't040', 't033', 't013'], contains: 'a' },
];

describe('POST /api/tags/query', () => {
    test('ifHash: the answer carries its hash, and is only "unchanged" while the page is what the hash was made of', async () => {
        await seed(mixedTags());
        const ask = { sort: { field: 'alphabetical' }, filter: { used: true }, pageSize: 5 };

        const plain = await query(ask);
        expect(plain.body).not.toHaveProperty('hash');

        const first = await query({ ...ask, ifHash: '' });
        expect(first.status).toBe(200);
        expect(first.body.rows).toEqual(plain.body.rows);
        expect(first.body.cursor).toBe(plain.body.cursor);
        expect(typeof first.body.hash).toBe('string');

        expect((await query({ ...ask, ifHash: first.body.hash })).body).toEqual({ unchanged: true, hash: first.body.hash });

        // A rename of a tag on the page changes the page.
        const renamed = first.body.rows[0];
        await user.store.lib.tags.edit(renamed.id, { color: '#123456' });
        const after = await query({ ...ask, ifHash: first.body.hash });
        expect(after.body.unchanged).toBeUndefined();
        expect(after.body.hash).not.toBe(first.body.hash);
        expect(after.body.rows.find(tag => tag.id === renamed.id).color).toBe('#123456');

        // Another page size or cursor is another page.
        expect((await query({ ...ask, pageSize: 6, ifHash: after.body.hash })).body.unchanged).toBeUndefined();
        expect((await query({ ...ask, ifHash: 7 })).status).toBe(400);
    });

    describe('restCount, indexed path', () => {
        test('a full page with more after it answers how many match after it; others answer no rest', async () => {
            await seed(mixedTags());
            for (const sort of SORTS) {
                for (const filter of [{}, { folders: true }, { contains: 'a', folders: true }, { used: true }]) {
                    const want = expected(sort, filter);
                    if (want.length < 4) continue;
                    const page = await query({ sort: { field: sort }, filter, pageSize: 3, restCount: true });
                    expect(page.body.rows.map(t => t.id)).toEqual(want.slice(0, 3));
                    expect({ sort, filter, rest: page.body.rest }).toEqual({ sort, filter, rest: { count: want.length - 3, more: false } });
                    const next = await query({ sort: { field: sort }, filter, pageSize: 3, cursor: page.body.cursor });
                    expect(next.body.rows.map(t => t.id)).toEqual(want.slice(3, 6));

                    const whole = await query({ sort: { field: sort }, filter, pageSize: want.length + 1, restCount: true });
                    expect(whole.body).not.toHaveProperty('rest');
                    expect((await query({ sort: { field: sort }, filter, pageSize: 3 })).body).not.toHaveProperty('rest');
                }
            }
            expect((await query({ restCount: 'yes' })).status).toBe(400);
        });
    });

    describe('indexed path', () => {
        test('every sort and filter pages through exactly the expected order, following cursors', async () => {
            await seed(mixedTags());
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
            await user.store.lib.tags.delete('t002', null);
            await user.store.lib.tags.delete('t014', null);
            model = model.filter(({ tag }) => tag.id !== 't002' && tag.id !== 't014');
            for (const sort of SORTS) {
                const got = await queryAll({ sort: { field: sort }, pageSize: 9 });
                expect(got.ids).not.toContain('t002');
                expect(got.ids).not.toContain('t014');
                expect(got.ids).toEqual(expected(sort, {}));
            }
        });
    });

    describe('counts, indexed path', () => {
        test('counts are given only when asked, for the rows on the page, from tag_usage', async () => {
            await seed(mixedTags());
            const usage = new Map(model.map(({ tag, count }) => [tag.id, count]));
            for (const sort of SORTS) {
                const plain = await query({ sort: { field: sort }, pageSize: 7 });
                expect(plain.body).not.toHaveProperty('counts');
                expect(plain.body).not.toHaveProperty('approximate');

                let cursor = null;
                do {
                    const { body } = await query({ sort: { field: sort }, pageSize: 7, counts: true, cursor });
                    const ids = body.rows.map(t => t.id);
                    expect(body.counts).toEqual(Object.fromEntries(ids.map(id => [id, usage.get(id) ?? 0])));
                    expect(body.approximate).toEqual([]);
                    cursor = body.cursor;
                } while (cursor !== null);
            }
        });

        test('a merged tag\'s carriers count for the tag it merges into, listed as approximate until they have moved', async () => {
            for (const tag of [{ id: 'source', name: 'Source' }, { id: 'target', name: 'Target' }, { id: 'other', name: 'Other' }]) await user.store.lib.writeTag(tag);
            for (const name of ['a.png', 'b.png']) await user.store.lib.writeCard(directories, name, JSON.stringify({ name, data: { name, tags: [], extensions: {} } }));
            await user.store.lib.assignTag(TYPE.character, 'a.png', 'source', true);
            await user.store.lib.assignTag(TYPE.character, 'b.png', 'source', true);
            await user.store.lib.assignTag(TYPE.character, 'a.png', 'target', true);
            await user.store.lib.assignTag(TYPE.character, 'a.png', 'other', true);
            await user.store.lib.tags.delete('source', 'target');

            // The carriers move in steps after the delete; once they have, the count is exact: a.png carried both.
            let body;
            const deadline = Date.now() + 10_000;
            do {
                ({ body } = await query({ sort: { field: 'alphabetical' }, counts: true }));
                expect(body.approximate.filter(id => id !== 'target')).toEqual([]);
            } while (body.approximate.length > 0 && Date.now() < deadline && await new Promise(resolve => setTimeout(resolve, 20, true)));
            expect(body.rows.map(t => t.id)).toEqual(['other', 'target']);
            expect(body.counts).toEqual({ other: 1, target: 2 });
            expect(body.approximate).toEqual([]);
        });

        test('a character written in a batch of imports counts, once, and a count of 0 is a tag prune would delete', async () => {
            for (const tag of [{ id: 'buffered', name: 'Buffered' }, { id: 'both', name: 'Both' }, { id: 'unused', name: 'Unused' }]) await user.store.lib.writeTag(tag);
            const card = name => JSON.stringify({ name, data: { name, tags: [], extensions: {} } });
            const lib = user.store.lib;
            await lib.writeCard(directories, 'Stored.png', card('Stored'));
            expect((await lib.tags.assign('Stored.png', 'both')).result).toBe('ok');

            lib.beginBatch();
            try {
                await lib.writeCard(directories, 'Bob.png', card('Bob'));
                expect((await lib.tags.assign('Bob.png', 'buffered')).result).toBe('ok');
                expect((await lib.tags.assign('Bob.png', 'both')).result).toBe('ok');
                // Written again over its stored card: the stored assignment is the one it has.
                await lib.writeCard(directories, 'Stored.png', card('Stored'));
                expect((await lib.tags.assign('Stored.png', 'both')).result).toBe('ok');

                const { body } = await query({ sort: { field: 'alphabetical' }, counts: true });
                expect(body.counts).toEqual({ both: 2, buffered: 1, unused: 0 });
                expect(body.approximate).toEqual([]);
                const unused = await (await fetch(`${baseUrl}/api/tags/unused-count`, { method: 'POST' })).json();
                expect(unused.count).toBe(1);
            } finally {
                lib.endBatch();
            }
            const after = await query({ sort: { field: 'alphabetical' }, counts: true });
            expect(after.body.counts).toEqual({ both: 2, buffered: 1, unused: 0 });
        });
    });

    test('the sort defaults to manual and the page size to 50, clamped to 500', async () => {
        const tags = Array.from({ length: 620 }, (_, i) => ({ id: `p${String(i).padStart(4, '0')}`, name: `P ${619 - i}`, sort_order: i % 5 === 0 ? undefined : 1000 - i }));
        await seed(tags);
        const first = await query({});
        expect(first.body.rows.map(t => t.id)).toEqual(expected('manual', {}).slice(0, 50));
        expect((await query({ pageSize: 100000 })).body.rows).toHaveLength(500);
        expect((await query({ pageSize: 0 })).body.rows).toHaveLength(50);
        expect((await query({ pageSize: 'x' })).body.rows).toHaveLength(50);
    });

    test('bad input is a 400', async () => {
        await seed(mixedTags());
        const manualCursor = (await query({ pageSize: 2 })).body.cursor;
        const cases = [
            { sort: { field: 'random' } },
            { filter: { search: 3 } },
            { filter: { name: ['a'] } },
            { filter: { contains: 3 } },
            { counts: 'yes' },
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
});
