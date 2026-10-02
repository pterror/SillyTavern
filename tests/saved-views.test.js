import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

function makeDirectories() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-saved-views-test-'));
    const dirs = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [dirs.characters, dirs.chats, dirs.groups, dirs.groupChats]) fs.mkdirSync(dir, { recursive: true });
    return dirs;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    const { router } = await import('../src/endpoints/views.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/views', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

/** @type {string[]} */
let made = [];
beforeEach(() => {
    directories = makeDirectories();
    made = [directories.root];
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    for (const root of made) fs.rmSync(root, { recursive: true, force: true });
});

/** @param {string} route @param {object} body */
async function post(route, body) {
    const response = await fetch(`${baseUrl}/api/views/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
}

/** @param {object} [body] */
async function listNames(body = {}) {
    const names = [];
    let cursor = null;
    for (;;) {
        const { body: page } = await post('list', { ...body, cursor });
        names.push(...page.views.map(v => v.name));
        if (!page.cursor) return names;
        cursor = page.cursor;
    }
}

describe('/api/views', () => {
    test('create adds views in order, get and list read them back', async () => {
        const a = await post('create', { name: 'Elves', view: { text: 'elf', tags: { include: [], exclude: [] } } });
        expect(a.status).toBe(200);
        await post('create', { name: 'Favorites', view: { fav: true } });
        expect(await listNames()).toEqual(['Elves', 'Favorites']);
        const got = await post('get', { id: a.body.id });
        expect(got.body).toMatchObject({ name: 'Elves', view: { text: 'elf' } });
    });

    test('list pages with a cursor and finds names holding the text, ignoring case and accents', async () => {
        for (let i = 0; i < 7; i++) await post('create', { name: `View ${i}`, view: {} });
        await post('create', { name: 'Café crowd', view: {} });
        expect(await listNames({ limit: 3 })).toEqual([...Array.from({ length: 7 }, (_, i) => `View ${i}`), 'Café crowd']);
        expect(await listNames({ contains: 'CAFE' })).toEqual(['Café crowd']);
    });

    test('ifVersion answers unchanged until a write, and every action moves the version on', async () => {
        const first = await post('list', {});
        expect((await post('list', { ifVersion: first.body.version })).body.unchanged).toBe(true);
        const { body: made } = await post('create', { name: 'A', view: {} });
        const afterCreate = await post('list', { ifVersion: first.body.version });
        expect(afterCreate.body.unchanged).toBeUndefined();
        await post('change', { id: made.id, name: 'B' });
        expect((await post('list', { ifVersion: afterCreate.body.version })).body.unchanged).toBeUndefined();
    });

    test('change renames or replaces the view; one that changes nothing writes nothing', async () => {
        const { body: made } = await post('create', { name: 'A', view: { fav: true } });
        const { body: before } = await post('list', {});
        expect((await post('change', { id: made.id, name: 'A', view: { fav: true } })).status).toBe(200);
        expect((await post('list', { ifVersion: before.version })).body.unchanged).toBe(true);
        const changed = await post('change', { id: made.id, view: { fav: false } });
        expect(changed.body).toMatchObject({ name: 'A', view: { fav: false } });
        expect((await post('change', { id: 'nope', name: 'x' })).status).toBe(404);
    });

    test('delete removes one view; deleting it again says nothing was deleted', async () => {
        const { body: made } = await post('create', { name: 'Gone', view: {} });
        await post('create', { name: 'Kept', view: {} });
        expect((await post('delete', { id: made.id })).body).toEqual({ deleted: true });
        expect((await post('delete', { id: made.id })).body).toEqual({ deleted: false });
        expect(await listNames()).toEqual(['Kept']);
    });

    test('move puts a view just before or after another, and keeps working when positions crowd', async () => {
        const ids = {};
        for (const name of ['A', 'B', 'C', 'D']) ids[name] = (await post('create', { name, view: {} })).body.id;
        await post('move', { id: ids.D, anchor: ids.A, side: 'before' });
        expect(await listNames()).toEqual(['D', 'A', 'B', 'C']);
        await post('move', { id: ids.D, anchor: ids.B, side: 'after' });
        expect(await listNames()).toEqual(['A', 'B', 'D', 'C']);
        expect((await post('move', { id: ids.D, anchor: ids.B, side: 'after' })).body).toEqual({ result: 'unchanged' });
        // Halving the same gap again and again runs out of room; the order still comes out right.
        for (let i = 0; i < 70; i++) {
            await post('move', { id: i % 2 ? ids.C : ids.D, anchor: ids.A, side: 'after' });
        }
        const names = await listNames();
        expect(names[0]).toBe('A');
        expect(new Set(names)).toEqual(new Set(['A', 'B', 'C', 'D']));
        expect((await post('move', { id: ids.A, anchor: 'nope', side: 'after' })).status).toBe(404);
    });

    test('bad names, views and moves are refused', async () => {
        expect((await post('create', { name: '  ', view: {} })).status).toBe(400);
        expect((await post('create', { name: 'x'.repeat(201), view: {} })).status).toBe(400);
        expect((await post('create', { name: 'A', view: [] })).status).toBe(400);
        expect((await post('create', { name: 'A', view: { text: 'x'.repeat(70000) } })).status).toBe(400);
        expect((await post('move', { id: 'a', anchor: 'b', side: 'middle' })).status).toBe(400);
        expect((await post('list', { cursor: 'not a cursor' })).status).toBe(400);
    });

    test('each user has their own views', async () => {
        await post('create', { name: 'Mine', view: {} });
        const other = makeDirectories();
        made.push(other.root);
        const mine = directories;
        directories = other;
        expect(await listNames()).toEqual([]);
        await post('create', { name: 'Theirs', view: {} });
        directories = mine;
        expect(await listNames()).toEqual(['Mine']);
    });

    test('every write tells the change stream once', async () => {
        const roots = [];
        const listener = root => roots.push(root);
        metadataDb.characterChangeEmitter.on(metadataDb.SAVED_VIEWS_EVENT, listener);
        try {
            const { body: made } = await post('create', { name: 'A', view: {} });
            await post('change', { id: made.id, name: 'A' });
            await post('change', { id: made.id, name: 'B' });
            await post('delete', { id: made.id });
        } finally {
            metadataDb.characterChangeEmitter.off(metadataDb.SAVED_VIEWS_EVENT, listener);
        }
        expect(roots).toEqual([directories.root, directories.root, directories.root]);
    });
});
