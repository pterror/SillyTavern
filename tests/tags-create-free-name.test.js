import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// /api/tags/create with freeName: the server names the new tag, since only it knows which names are taken.

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
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

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-create-free-name-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

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

/** Runs the boot pass that makes tag names look-up-able, as a started server has. */
async function indexTagNames() {
    await metadataDb.fillTagNameKeysIfNeeded(directories);
}

/** @param {string} id @returns {Promise<string>} the name the server stores for the tag */
async function storedName(id) {
    const { body } = await post('/api/tags/by-ids', { ids: [id] });
    return body.tags[0]?.name;
}

describe('POST /api/tags/create with freeName', () => {
    test('keeps the base name while no tag has it, then numbers it as getFreeName() does', async () => {
        await indexTagNames();
        const names = [];
        for (const id of ['a', 'b', 'c']) {
            const { status, body } = await post('/api/tags/create', { tag: { id, name: 'New Tag' }, freeName: true });
            expect(status).toBe(200);
            expect(body.refused).toEqual([]);
            expect(body.tag.id).toBe(id);
            names.push(body.tag.name);
            expect(await storedName(id)).toBe(body.tag.name);
        }
        expect(names).toEqual(['New Tag', 'New Tag #1', 'New Tag #2']);
    });

    test('takes the first free number, and a name differing only in case or accents counts as taken', async () => {
        expect((await post('/api/tags/create', { tag: { id: 'x', name: 'néw TAG' } })).status).toBe(200);
        expect((await post('/api/tags/create', { tag: { id: 'y', name: 'New Tag #2' } })).status).toBe(200);
        await indexTagNames();

        expect((await post('/api/tags/create', { tag: { id: 'a', name: 'New Tag' }, freeName: true })).body.tag.name).toBe('New Tag #1');
        expect((await post('/api/tags/create', { tag: { id: 'b', name: 'New Tag' }, freeName: true })).body.tag.name).toBe('New Tag #3');
    });

    test('a deleted tag\'s name is free again', async () => {
        expect((await post('/api/tags/create', { tag: { id: 'x', name: 'New Tag' } })).status).toBe(200);
        expect((await post('/api/tags/delete', { id: 'x', mergeInto: null })).status).toBe(200);
        await indexTagNames();

        expect((await post('/api/tags/create', { tag: { id: 'a', name: 'New Tag' }, freeName: true })).body.tag.name).toBe('New Tag');
    });

    test('the answer carries the place in the manual order the server gave the tag', async () => {
        expect((await post('/api/tags/create', { tag: { id: 'x', name: 'X', sort_order: 41 } })).status).toBe(200);
        await indexTagNames();

        const { body } = await post('/api/tags/create', { tag: { id: 'a', name: 'New Tag', color: '#112233' }, freeName: true });
        expect(body.tag).toEqual({ id: 'a', name: 'New Tag', color: '#112233', sort_order: 42 });
    });

    test('without freeName the name is stored as given, taken or not, and the answer carries no tag', async () => {
        expect((await post('/api/tags/create', { tag: { id: 'x', name: 'New Tag' } })).body).toEqual({ result: 'ok', refused: [] });
        expect((await post('/api/tags/create', { tag: { id: 'y', name: 'New Tag' } })).body).toEqual({ result: 'ok', refused: [] });
        expect((await post('/api/tags/create', { tag: { id: 'z', name: 'New Tag' }, freeName: false })).body).toEqual({ result: 'ok', refused: [] });
        expect(await storedName('z')).toBe('New Tag');
    });

    test('until tag names can be looked up, a freeName create is a 503 and nothing is created', async () => {
        const { status, body } = await post('/api/tags/create', { tag: { id: 'a', name: 'New Tag' }, freeName: true });
        expect(status).toBe(503);
        expect(body.reason).toBe('tag-names-not-indexed');
        expect((await post('/api/tags/by-ids', { ids: ['a'] })).body.tags).toEqual([]);

        await indexTagNames();
        expect((await post('/api/tags/create', { tag: { id: 'a', name: 'New Tag' }, freeName: true })).body.tag.name).toBe('New Tag');
    });

    test('a refused create names nothing and carries no tag', async () => {
        expect((await post('/api/tags/create', { tag: { id: 'x', name: 'New Tag' } })).status).toBe(200);

        const { body } = await post('/api/tags/create', { tag: { id: 'x', name: 'Other' }, freeName: true });
        expect(body).toEqual({ result: 'ok', refused: [{ id: 'x', reason: 'exists' }] });
        expect(await storedName('x')).toBe('New Tag');
    });

    test('a freeName that is not a boolean, or has no name to start from, is a 400 and nothing is created', async () => {
        for (const body of [
            { tag: { id: 'a', name: 'New Tag' }, freeName: 'yes' },
            { tag: { id: 'a' }, freeName: true },
            { tag: { id: 'a', name: '' }, freeName: true },
            { tag: { id: 'a', name: 5 }, freeName: true },
        ]) {
            expect((await post('/api/tags/create', body)).status).toBe(400);
        }
        expect((await post('/api/tags/by-ids', { ids: ['a'] })).body.tags).toEqual([]);
    });
});
