import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

// /api/characters/find: findChar()'s answer over the whole library, for findCharAsync().

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
let TYPE;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ TYPE } = await import('../src/library-codes.js'));
    const { router } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await (await import('./converted-user.fixture.js')).emptyUser('st-characters-find-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/** @returns {Promise<{ status: number, body: any }>} */
async function find(body) {
    const response = await fetch(`${baseUrl}/api/characters/find`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed };
}

/** @param {string} avatar @param {string} name */
async function seedCharacter(avatar, name) {
    const cardJson = JSON.stringify({
        name,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    });
    await user.store.lib.writeCard(directories, avatar, cardJson);
}

/** @param {string} id @param {string} name */
async function seedTag(id, name) {
    await user.store.lib.writeTag({ id, name });
}

describe('POST /api/characters/find', () => {
    test('an avatar key wins, with or without .png', async () => {
        await seedCharacter('alice.png', 'Bob');
        await seedCharacter('bob.png', 'Alice');

        expect((await find({ name: 'alice.png' })).body).toEqual({ ids: ['alice.png'], capped: false });
        expect((await find({ name: 'alice' })).body).toEqual({ ids: ['alice.png'], capped: false });
        expect((await find({ name: 'alice', allowAvatar: false })).body).toEqual({ ids: ['bob.png'], capped: false });
    });

    test('a name ignoring case and accents, or exactly; in avatar order, two at most', async () => {
        await seedCharacter('c.png', 'Zoé');
        await seedCharacter('a.png', 'zoe');
        await seedCharacter('b.png', 'ZOE');
        await seedCharacter('d.png', 'Zoey');

        expect((await find({ name: 'Zoe' })).body).toEqual({ ids: ['a.png', 'b.png'], capped: false });
        expect((await find({ name: 'Zoé', insensitive: false })).body).toEqual({ ids: ['c.png'], capped: false });
        expect((await find({ name: 'Nobody' })).body).toEqual({ ids: [], capped: false });
    });

    test('tags narrow by exact tag name, and every named tag is needed', async () => {
        await seedCharacter('a.png', 'Sam');
        await seedCharacter('b.png', 'Sam');
        await seedTag('t1', 'Hero');
        await seedTag('t2', 'Tall');
        await seedTag('t3', 'hero');
        await user.store.lib.assignTag(TYPE.character, 'a.png', 't3', true);
        await user.store.lib.assignTag(TYPE.character, 'b.png', 't1', true);
        await user.store.lib.assignTag(TYPE.character, 'b.png', 't2', true);

        expect((await find({ name: 'Sam', tags: ['Hero'] })).body).toEqual({ ids: ['b.png'], capped: false });
        expect((await find({ name: 'Sam', tags: ['Hero', 'Tall'] })).body).toEqual({ ids: ['b.png'], capped: false });
        expect((await find({ name: 'Sam', tags: ['hero', 'Tall'] })).body).toEqual({ ids: [], capped: false });
        expect((await find({ tags: ['Tall'] })).body).toEqual({ ids: ['b.png'], capped: false });
        expect((await find({ name: 'a', tags: ['Hero'] })).body).toEqual({ ids: [], capped: false });
    });

    test('a tag merged into a wanted tag counts as it', async () => {
        await seedCharacter('a.png', 'Sam');
        await seedTag('old', 'Old');
        await seedTag('new', 'New');
        await user.store.lib.assignTag(TYPE.character, 'a.png', 'old', true);
        await user.store.lib.deleteTag('old', 'new');

        expect((await find({ tags: ['New'] })).body).toEqual({ ids: ['a.png'], capped: false });
    });

    test('no name and no tags is the first character', async () => {
        await seedCharacter('b.png', 'B');
        await seedCharacter('a.png', 'A');
        expect((await find({})).body).toEqual({ ids: ['a.png', 'b.png'], capped: false });
    });

    test('groups by name', async () => {
        await user.store.lib.writeGroup({ id: 'g2', name: 'Party' });
        await user.store.lib.writeGroup({ id: 'g1', name: 'party' });
        await user.store.lib.writeGroup({ id: 'g3', name: 'Other' });
        expect((await find({ type: 'group', name: 'PARTY' })).body).toEqual({ ids: ['g1', 'g2'] });
        expect((await find({ type: 'group', name: 'none' })).body).toEqual({ ids: [] });
    });

    test('bad requests', async () => {
        expect((await find({ name: 5 })).status).toBe(400);
        expect((await find({ tags: 'Hero' })).status).toBe(400);
        expect((await find({ tags: [1] })).status).toBe(400);
        expect((await find({ type: 'group' })).status).toBe(400);
        expect((await find({ type: 'persona', name: 'x' })).status).toBe(400);
    });
});
