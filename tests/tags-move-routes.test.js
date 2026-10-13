import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import path from 'node:path';
import { storedTagDefinitions } from './tag-store-reads.js';

// POST /api/tags/move, /api/tags/reorder and the manual order /api/tags/query answers while a reorder pass runs.
// (The route-level part of tags-move, tags-reorder, tags-reorder-pass, tags-query-reorder-pass and
// tags-query-pending-moves, whose other tests were of the old store's queue and pass tables.)

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
    const { router } = await import('../src/endpoints/tags.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
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
    user = await fixture.emptyUser('st-tags-move-routes-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(async () => {
    jest.restoreAllMocks();
    // A reorder pass in the background ends before the store goes.
    while (await user.store.lib.tags.passStep());
    await user.close();
});

/** @param {string} route @param {object} body */
async function post(route, body) {
    const response = await fetch(`${baseUrl}/api/tags/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
}

/** @param {string[]} ids Tags `id` named `id`, ordered as given by their sort_order (1, 2, ...). */
async function seedOrdered(ids) {
    for (const [i, id] of ids.entries()) await user.store.lib.tags.create({ id, name: id, sort_order: i + 1 });
}

/** The ids in the manual order. @param {object} [more] */
async function manual(more = {}) {
    const ids = [];
    let cursor = null;
    for (;;) {
        const { body } = await post('query', { sort: { field: 'manual' }, pageSize: 3, cursor, ...more });
        ids.push(...body.rows.map(t => t.id));
        if (body.cursor === null) return ids;
        cursor = body.cursor;
    }
}

describe('POST /api/tags/move', () => {
    test('400s unless id is a non-empty string and exactly one of before/after is a non-empty string', async () => {
        for (const body of [
            {}, { before: 'a' }, { id: '', before: 'a' }, { id: 5, before: 'a' },
            { id: 'x' }, { id: 'x', before: 'a', after: 'b' }, { id: 'x', before: 'a', after: null },
            { id: 'x', before: null }, { id: 'x', before: '' }, { id: 'x', after: 5 }, { id: 'x', after: ['a'] },
        ]) {
            expect({ body, status: (await post('move', body)).status }).toEqual({ body, status: 400 });
        }
    });

    test('answers ok with what it refused and queued false', async () => {
        await seedOrdered(['a', 'x']);
        const moved = await post('move', { id: 'x', before: 'a' });
        expect(moved.status).toBe(200);
        expect(moved.body).toMatchObject({ result: 'ok', refused: [], queued: false });
        expect(moved.body.written.map(w => w.id)).toContain('x');
        expect(await post('move', { id: 'x', after: 'nope' })).toEqual({ status: 200, body: { result: 'ok', refused: [{ id: 'nope', reason: 'missing' }], written: [], queued: false } });
    });

    test('places the tag before or after an anchor in the manual order, and writes the order it answers', async () => {
        await seedOrdered(['a', 'b', 'c', 'd']);
        const { body } = await post('move', { id: 'd', before: 'b' });
        expect(await manual()).toEqual(['a', 'd', 'b', 'c']);
        const stored = await storedTagDefinitions(user.store.lib);
        for (const { id, sort_order } of body.written) expect(stored.find(t => t.id === id).sort_order).toBe(sort_order);
        await post('move', { id: 'a', after: 'c' });
        expect(await manual()).toEqual(['d', 'b', 'c', 'a']);
        // Already in place: nothing is written.
        expect((await post('move', { id: 'd', before: 'b' })).body.written).toEqual([]);
    });

    test('a tag as its own anchor, a missing tag and a deleted anchor are refused and write nothing', async () => {
        await seedOrdered(['a', 'b']);
        await user.store.lib.tags.delete('b');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const before = (await post('manifest', {})).body.changesSeq;
        expect((await post('move', { id: 'a', before: 'a' })).body.refused).toEqual([{ id: 'a', reason: 'same' }]);
        expect((await post('move', { id: 'nope', after: 'a' })).body.refused).toEqual([{ id: 'nope', reason: 'missing' }]);
        expect((await post('move', { id: 'a', after: 'b' })).body.refused).toEqual([{ id: 'b', reason: 'deleted' }]);
        expect((await post('manifest', {})).body.changesSeq).toBe(before);
    });
});

describe('POST /api/tags/reorder', () => {
    test('400s unless id, exactly one of before/after, and mode alphabetical or by_entries are given', async () => {
        for (const body of [
            { before: 'a', mode: 'alphabetical' }, { id: '', before: 'a', mode: 'alphabetical' },
            { id: 'x', mode: 'alphabetical' }, { id: 'x', before: 'a', after: 'b', mode: 'alphabetical' },
            { id: 'x', before: '', mode: 'alphabetical' }, { id: 'x', after: 5, mode: 'by_entries' },
            { id: 'x', before: 'a' }, { id: 'x', before: 'a', mode: 'manual' }, { id: 'x', before: 'a', mode: 'Alphabetical' },
            { id: 'x', before: 'a', mode: null }, { id: 'x', before: 'a', mode: ['alphabetical'] },
        ]) {
            expect({ body, status: (await post('reorder', body)).status }).toEqual({ body, status: 400 });
        }
    });

    test('answers queued true and writes no tag at once; the pass then orders them', async () => {
        await seedOrdered(['c', 'a', 'b']);
        const before = (await post('manifest', {})).body.changesSeq;
        expect(await post('reorder', { id: 'c', before: 'a', mode: 'alphabetical' })).toEqual({ status: 200, body: { result: 'ok', refused: [], queued: true } });
        expect((await post('manifest', {})).body.changesSeq).toBe(before);
        // While the pass is recorded the order read is the mode's with the move on top; once it ran it is the one it left.
        while (await user.store.lib.tags.passStep());
        expect(await manual()).toEqual(['c', 'a', 'b']);
    });

    test('a refused reorder queues nothing', async () => {
        await seedOrdered(['a']);
        await user.store.lib.tags.create({ id: 'd', name: 'd', sort_order: 2 });
        await user.store.lib.tags.delete('d');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const refusals = [
            [{ id: 'a', before: 'a' }, [{ id: 'a', reason: 'same' }]],
            [{ id: 'd', before: 'a' }, [{ id: 'd', reason: 'deleted' }]],
            [{ id: 'a', after: 'd' }, [{ id: 'd', reason: 'deleted' }]],
            [{ id: 'nope', after: 'a' }, [{ id: 'nope', reason: 'missing' }]],
            [{ id: 'a', after: 'nope' }, [{ id: 'nope', reason: 'missing' }]],
        ];
        for (const [body, refused] of refusals) {
            expect(await post('reorder', { ...body, mode: 'alphabetical' })).toEqual({ status: 200, body: { result: 'ok', refused, queued: false } });
        }
    });
});
