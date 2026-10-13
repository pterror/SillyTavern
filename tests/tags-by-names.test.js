import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

// /api/tags/by-names: the page finds a tag by name without holding every tag.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    fixture = await import('./converted-user.fixture.js');
    const { router: tagsRouter } = await import('../src/endpoints/tags.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/tags', tagsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-tags-by-names-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/** @returns {Promise<{ status: number, body: any }>} */
async function post(urlPath, body) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed };
}

/** @param {string} id @param {string} name */
async function create(id, name) {
    expect((await post('/api/tags/create', { tag: { id, name } })).status).toBe(200);
}

describe('POST /api/tags/by-names', () => {
    test('finds a tag ignoring case and accents, null for a name no tag has, one entry per distinct name in order', async () => {
        await create('a', 'Café');
        await create('b', 'Serious');

        const { status, body } = await post('/api/tags/by-names', { names: ['serious', 'CAFE', 'Nope', 'serious'] });
        expect(status).toBe(200);
        expect(body.tags.map(entry => [entry.name, entry.tag?.id ?? null])).toEqual([['serious', 'b'], ['CAFE', 'a'], ['Nope', null]]);
        expect(body.tags[1].tag).toEqual(expect.objectContaining({ id: 'a', name: 'Café' }));
    });

    test('of several tags with the name, the first created', async () => {
        await create('first', 'Same');
        await create('second', 'same');

        const { body } = await post('/api/tags/by-names', { names: ['SAME'] });
        expect(body.tags[0].tag.id).toBe('first');
    });

    test('a tag being deleted with a merge target stands for the target; one with none for nothing', async () => {
        await create('old', 'Old');
        await create('new', 'New');
        await create('gone', 'Gone');
        expect((await post('/api/tags/delete', { id: 'old', mergeInto: 'new' })).status).toBe(200);
        expect((await post('/api/tags/delete', { id: 'gone', mergeInto: null })).status).toBe(200);

        const { body } = await post('/api/tags/by-names', { names: ['Old', 'Gone'] });
        expect(body.tags[0].tag?.id).toBe('new');
        expect(body.tags[1].tag).toBeNull();
    });

    test('a live tag with the name wins over a deleted one\'s target', async () => {
        await create('old', 'Old');
        await create('new', 'New');
        expect((await post('/api/tags/delete', { id: 'old', mergeInto: 'new' })).status).toBe(200);
        await create('again', 'old');

        const { body } = await post('/api/tags/by-names', { names: ['Old'] });
        expect(body.tags[0].tag?.id).toBe('again');
    });

    test('of several deleted tags with the name, the last deleted counts', async () => {
        for (const [id, name] of [['a', 'Dup'], ['b', 'dup'], ['x', 'X'], ['y', 'Y']]) await create(id, name);
        expect((await post('/api/tags/delete', { id: 'a', mergeInto: 'x' })).status).toBe(200);
        expect((await post('/api/tags/delete', { id: 'b', mergeInto: 'y' })).status).toBe(200);
        expect((await post('/api/tags/by-names', { names: ['DUP'] })).body.tags[0].tag?.id).toBe('y');

        await create('c', 'Dup');
        expect((await post('/api/tags/delete', { id: 'c', mergeInto: null })).status).toBe(200);
        expect((await post('/api/tags/by-names', { names: ['dup'] })).body.tags[0].tag).toBeNull();
    });

    test('400s for names that are not an array of strings, or more than 100 distinct names', async () => {
        expect((await post('/api/tags/by-names', {})).status).toBe(400);
        expect((await post('/api/tags/by-names', { names: 'Funny' })).status).toBe(400);
        expect((await post('/api/tags/by-names', { names: [1] })).status).toBe(400);
        const many = Array.from({ length: 101 }, (_, i) => `n${i}`);
        expect((await post('/api/tags/by-names', { names: many })).status).toBe(400);
        expect((await post('/api/tags/by-names', { names: [...many.slice(0, 100), 'n0'] })).status).not.toBe(400);
    });
});

describe('POST /api/tags/create', () => {
    test('answers the stored definition, with the place in the manual order the server gave it', async () => {
        await create('a', 'A');
        const { body } = await post('/api/tags/create', { tag: { id: 'b', name: 'B' } });
        expect(body).toEqual({ result: 'ok', refused: [], tag: { id: 'b', name: 'B', sort_order: 2 } });
    });
});
