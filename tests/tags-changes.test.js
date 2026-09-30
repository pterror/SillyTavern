import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The tag definition change log: every write that changes what a reader gets as a tag's definition logs the tag, and
// /api/tags/changes answers a cursor with what each changed tag is now.

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
/** @type {import('node:http').Server} */
let server;
let baseUrl = '';
/** @type {string[]} The root of every TAG_CHANGES_EVENT emitted during the test. */
let reported = [];
/** @param {string} root */
const onReported = (root) => { reported.push(root); };

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');

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

beforeEach(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-changes-test-'));
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
    // The store with its tag query columns ready and its sort_order fill finished, so moves apply at once.
    await metadataDb.ensureSchemaMigrated(directories);
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    await metadataDb.fillTagDerivedColumnsIfNeeded(directories);
    await metadataDb.migrateTagsJsonIfNeeded(directories);
    await metadataDb.fillTagSortOrdersIfNeeded(directories);
    reported = [];
    metadataDb.characterChangeEmitter.on(metadataDb.TAG_CHANGES_EVENT, onReported);
});

afterEach(() => {
    metadataDb.characterChangeEmitter.off(metadataDb.TAG_CHANGES_EVENT, onReported);
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

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
        expect(reported).toEqual([directories.root]);
    });

    test('a refused create logs nothing', async () => {
        await create('a');
        const seq = await cursor();
        reported = [];
        const { body } = await post('/api/tags/create', { tag: { id: 'a', name: 'again' } });
        expect(body.refused).toEqual([{ id: 'a', reason: 'exists' }]);
        expect(await cursor()).toBe(seq);
        expect(reported).toEqual([]);
    });

    test('an edit lists the tag as it is now; one that changes nothing logs nothing', async () => {
        await create('a');
        const seq = await cursor();
        await post('/api/tags/edit', { id: 'a', patch: { name: 'renamed' } });
        const page = await changes(seq);
        expect(page.tags).toEqual([expect.objectContaining({ id: 'a', name: 'renamed' })]);

        reported = [];
        await post('/api/tags/edit', { id: 'a', patch: { name: 'renamed' } });
        expect(await cursor()).toBe(page.seq);
        expect(reported).toEqual([]);
    });

    test('a tag changed several times is listed once', async () => {
        const seq = await cursor();
        await create('a');
        await post('/api/tags/edit', { id: 'a', patch: { name: 'one' } });
        await post('/api/tags/edit', { id: 'a', patch: { name: 'two' } });
        const page = await changes(seq);
        expect(page.tags).toEqual([expect.objectContaining({ id: 'a', name: 'two' })]);
        expect(page.seq).toBe(seq + 3);
    });

    test('a deleted tag is listed as removed, with the tag it was merged into', async () => {
        await create('gone');
        await create('merged');
        await create('target');
        const seq = await cursor();
        await metadataDb.deleteTagDefinition(directories, 'gone');
        await metadataDb.deleteTagDefinition(directories, 'merged', 'target');
        const page = await changes(seq);
        expect(page.tags).toEqual([]);
        expect(page.removed).toEqual([{ id: 'gone', mergedInto: null }, { id: 'merged', mergedInto: 'target' }]);
    });

    test('a refused delete logs nothing', async () => {
        await create('a');
        const seq = await cursor();
        const { refused } = await metadataDb.deleteTagDefinition(directories, 'a', 'nowhere');
        expect(refused).toEqual([{ id: 'nowhere', reason: 'missing' }]);
        expect(await cursor()).toBe(seq);
    });

    test('a created then deleted tag is listed as removed only', async () => {
        const seq = await cursor();
        await create('a');
        await metadataDb.deleteTagDefinition(directories, 'a');
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

describe('what a reader can\'t be told one by one', () => {
    test('a whole-set write is one batch row, answered with reset and the log\'s end', async () => {
        await create('a');
        const seq = await cursor();
        await metadataDb.saveTagDefinitions(directories, [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }]);
        await create('c');
        const end = await cursor();
        expect(end).toBe(seq + 2);
        expect(await changes(seq)).toEqual({ seq: end, reset: true, tags: [], removed: [], hasMore: false });
        // Past the batch row the reader is told one by one again.
        expect(ids(await changes(seq + 1))).toEqual(['c']);
    });

    test('a reorder pass is one batch row once it has ended, however many tags it wrote', async () => {
        await create('a');
        await create('b');
        await create('c');
        const queued = await metadataDb.reorderTagDefinitions(directories, 'c', { before: 'a' }, 'alphabetical');
        expect(queued).toEqual({ refused: [], queued: true });
        const seq = await cursor();
        await metadataDb.runTagReorderPassIfNeeded(directories);
        const page = await changes(seq);
        expect(page.reset).toBe(true);
        expect(page.seq).toBe(await cursor());
        expect(page.seq).toBeGreaterThan(seq);
    });
});

describe('paging', () => {
    test('at most `limit` log rows per page; hasMore until the last', async () => {
        const seq = await cursor();
        await create('a');
        await create('b');
        await create('c');
        const first = await metadataDb.getTagChangesSince(directories, seq, { limit: 2 });
        expect(first).toEqual(expect.objectContaining({ seq: seq + 2, reset: false, hasMore: true }));
        expect(first.tags.map(tag => /** @type {any} */ (tag).id).sort()).toEqual(['a', 'b']);
        const second = await metadataDb.getTagChangesSince(directories, first.seq, { limit: 2 });
        expect(second).toEqual(expect.objectContaining({ seq: seq + 3, reset: false, hasMore: false }));
        expect(second.tags.map(tag => /** @type {any} */ (tag).id)).toEqual(['c']);
    });

    test('a limit that is not a positive integer throws', async () => {
        await expect(metadataDb.getTagChangesSince(directories, 0, { limit: 0 })).rejects.toThrow(TypeError);
    });
});
