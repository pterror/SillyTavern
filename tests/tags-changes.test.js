import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';
import { storedTagDefinitions } from './tag-store-reads.js';

// The tag definition change log: every write that changes what a reader gets as a tag's definition logs the tag, and
// /api/tags/changes answers a cursor with what each changed tag is now.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl = '';

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
    user = await fixture.emptyUser('st-tags-changes-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/** @returns {Promise<{ status: number, body: any }>} */
async function post(urlPath, body = {}) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = text;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Not JSON: a bare status.
    }
    return { status: response.status, body: parsed };
}

/** @param {string} id @param {Record<string, unknown>} [fields] */
async function create(id, fields = {}) {
    const { status, body } = await post('/api/tags/create', { tag: { id, name: id, ...fields } });
    expect(status).toBe(200);
    expect(body.refused).toEqual([]);
}

/** @returns {Promise<number>} The cursor a client that has just read the tags asks from. */
async function cursor() {
    const { body } = await post('/api/tags/manifest');
    expect(typeof body.changesSeq).toBe('number');
    return body.changesSeq;
}

/** @param {unknown} sinceSeq */
async function changes(sinceSeq) {
    const { status, body } = await post('/api/tags/changes', { sinceSeq });
    expect(status).toBe(200);
    return body;
}

/** @param {{ tags: { id: string }[] }} page */
const ids = page => page.tags.map(tag => tag.id).sort();

describe('the cursor', () => {
    test('the manifest gives the log\'s end, and asking from it answers nothing changed', async () => {
        await create('a');
        const seq = await cursor();
        expect(await changes(seq)).toEqual({ seq, reset: false, tags: [], removed: [], hasMore: false });
    });

    test.each([undefined, null, -1, 1.5, '3'])('a sinceSeq of %p is answered with reset and the log\'s end', async (sinceSeq) => {
        await create('a');
        const seq = await cursor();
        expect(await changes(sinceSeq)).toEqual({ seq, reset: true, tags: [], removed: [], hasMore: false });
    });

    test('a cursor past the log\'s end is answered with reset', async () => {
        await create('a');
        const seq = await cursor();
        expect(await changes(seq + 5)).toEqual({ seq, reset: true, tags: [], removed: [], hasMore: false });
    });
});

describe('what each write logs', () => {
    test('a created tag is listed with its stored definition, and its store is reported', async () => {
        const seq = await cursor();
        await create('a', { color: '#112233' });
        const page = await changes(seq);
        expect(page.reset).toBe(false);
        expect(page.removed).toEqual([]);
        expect(page.tags).toEqual([expect.objectContaining({ id: 'a', name: 'a', color: '#112233' })]);
        expect(page.seq).toBe(await cursor());
    });

    test('a refused create logs nothing', async () => {
        await create('a');
        const seq = await cursor();
        const { body } = await post('/api/tags/create', { tag: { id: 'a', name: 'again' } });
        expect(body.refused).toEqual([{ id: 'a', reason: 'exists' }]);
        expect(await cursor()).toBe(seq);
    });

    test('an edit lists the tag as it is now; one that changes nothing logs nothing', async () => {
        await create('a');
        const seq = await cursor();
        await post('/api/tags/edit', { id: 'a', patch: { name: 'renamed' } });
        const page = await changes(seq);
        expect(page.tags).toEqual([expect.objectContaining({ id: 'a', name: 'renamed' })]);

        await post('/api/tags/edit', { id: 'a', patch: { name: 'renamed' } });
        expect(await cursor()).toBe(page.seq);
    });

    test('a tag changed several times is listed once', async () => {
        const seq = await cursor();
        await create('a');
        await post('/api/tags/edit', { id: 'a', patch: { name: 'one' } });
        await post('/api/tags/edit', { id: 'a', patch: { name: 'two' } });
        const page = await changes(seq);
        expect(page.tags).toEqual([expect.objectContaining({ id: 'a', name: 'two' })]);
        // A position in the feed: its end, read through.
        expect(page.seq).toBe(await cursor());
    });

    test('a deleted tag is listed as removed, with the tag it was merged into', async () => {
        await create('gone');
        await create('merged');
        await create('target');
        const seq = await cursor();
        await user.store.lib.tags.delete('gone');
        await user.store.lib.tags.delete('merged', 'target');
        const page = await changes(seq);
        expect(page.tags).toEqual([]);
        expect(page.removed).toEqual([{ id: 'gone', mergedInto: null }, { id: 'merged', mergedInto: 'target' }]);
    });

    test('a refused delete logs nothing', async () => {
        await create('a');
        const seq = await cursor();
        const { refused } = await user.store.lib.tags.delete('a', 'nowhere');
        expect(refused).toEqual([{ id: 'nowhere', reason: 'missing' }]);
        expect(await cursor()).toBe(seq);
    });

    test('a created then deleted tag is listed as removed only', async () => {
        const seq = await cursor();
        await create('a');
        await user.store.lib.tags.delete('a');
        const page = await changes(seq);
        expect(page.tags).toEqual([]);
        expect(page.removed).toEqual([{ id: 'a', mergedInto: null }]);
    });

    test('pruned tags are listed as removed', async () => {
        await create('a');
        await create('b');
        const seq = await cursor();
        const { body } = await post('/api/tags/prune', { limit: 500 });
        expect(body.deleted.sort()).toEqual(['a', 'b']);
        const page = await changes(seq);
        expect(page.removed.map(r => r.id).sort()).toEqual(['a', 'b']);
        expect(page.removed.every(r => r.mergedInto === null)).toBe(true);
    });

    test('a move lists every tag it wrote, with the sort_order now stored', async () => {
        await create('a');
        await create('b');
        await create('c');
        const seq = await cursor();
        const { body } = await post('/api/tags/move', { id: 'c', before: 'a' });
        expect(body.refused).toEqual([]);
        expect(body.written.length).toBeGreaterThan(0);
        const page = await changes(seq);
        expect(ids(page)).toEqual(body.written.map(w => w.id).sort());
        for (const { id, sort_order } of body.written) {
            expect(page.tags.find(tag => tag.id === id).sort_order).toBe(sort_order);
        }
    });

    test('a move that changes nothing logs nothing', async () => {
        await create('a');
        await create('b');
        const seq = await cursor();
        const { body } = await post('/api/tags/move', { id: 'a', before: 'b' });
        expect(body.written).toEqual([]);
        expect(await cursor()).toBe(seq);
    });

    test('a restore lists the tags it created and the ones it overwrote', async () => {
        await create('kept', { color: 'red' });
        const seq = await cursor();
        const { status } = await post('/api/tags/restore', {
            tags: [{ id: 'kept', name: 'kept', color: 'blue' }, { id: 'new', name: 'new' }],
            tagMap: {},
            overwrite: true,
        });
        expect(status).toBe(200);
        const page = await changes(seq);
        expect(ids(page)).toEqual(['kept', 'new']);
        expect(page.tags.find(tag => tag.id === 'kept').color).toBe('blue');
    });

    test('assigning a tag logs nothing: the log is of definitions', async () => {
        await create('a');
        const seq = await cursor();
        await post('/api/tags/assign', { id: 'nobody.png', tagId: 'a' });
        expect(await cursor()).toBe(seq);
    });
});

describe('a reorder pass', () => {
    test('lists each tag it wrote once, as it is after the pass', async () => {
        await create('a');
        await create('b');
        await create('c');
        const queued = await user.store.lib.tags.reorderDefinitions('c', { before: 'a' }, 'alphabetical');
        expect(queued).toEqual({ refused: [], queued: true });
        const seq = await cursor();
        while (await user.store.lib.tags.passStep());
        const page = await changes(seq);
        // The feed holds one entry per tag, so a pass needs no reset.
        expect(page.reset).toBe(false);
        const ids = page.tags.map(tag => tag.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain('c');
        const stored = new Map((await storedTagDefinitions(user.store.lib)).map(tag => [tag.id, tag]));
        for (const tag of page.tags) expect(tag).toEqual(stored.get(tag.id));
        expect(page.seq).toBe(await cursor());
        expect(page.seq).toBeGreaterThan(seq);
    });
});

describe('paging', () => {
    test('at most `limit` tags per page; hasMore until the last', async () => {
        const seq = await cursor();
        await create('a');
        await create('b');
        await create('c');
        const first = await user.store.lib.tags.changes(seq, { limit: 2 });
        expect(first).toEqual(expect.objectContaining({ reset: false, hasMore: true }));
        expect(first.seq).toBeGreaterThan(seq);
        expect(first.tags.map(tag => /** @type {any} */ (tag).id).sort()).toEqual(['a', 'b']);
        const second = await user.store.lib.tags.changes(first.seq, { limit: 2 });
        expect(second).toEqual(expect.objectContaining({ seq: await cursor(), reset: false, hasMore: false }));
        expect(second.tags.map(tag => /** @type {any} */ (tag).id)).toEqual(['c']);
    });

    test('a limit of 0 answers no entries, the cursor unchanged', async () => {
        const seq = await cursor();
        await create('a');
        const page = await user.store.lib.tags.changes(seq, { limit: 0 });
        expect(page).toEqual(expect.objectContaining({ seq, reset: false, tags: [], removed: [] }));
    });
});
