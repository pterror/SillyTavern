import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// /api/characters/find: findChar()'s answer over the whole library, for findCharAsync().

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
    const { router } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-find-test-'));
    directories = /** @type {any} */ ({
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

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
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson);
}

/** @param {string} id @param {string} name */
async function seedTag(id, name) {
    await metadataDb.createTagDefinition(directories, { id, name });
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
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        await metadataDb.assignEntityTag(directories, 'a.png', 't3');
        await metadataDb.assignEntityTag(directories, 'b.png', 't1');
        await metadataDb.assignEntityTag(directories, 'b.png', 't2');

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
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        await metadataDb.assignEntityTag(directories, 'a.png', 'old');
        await metadataDb.deleteTagDefinition(directories, 'old', 'new');

        expect((await find({ tags: ['New'] })).body).toEqual({ ids: ['a.png'], capped: false });
    });

    test('no name and no tags is the first character', async () => {
        await seedCharacter('b.png', 'B');
        await seedCharacter('a.png', 'A');
        expect((await find({})).body).toEqual({ ids: ['a.png', 'b.png'], capped: false });
    });

    test('groups by name', async () => {
        await metadataDb.upsertGroupRow(directories, 'g2', 'Party');
        await metadataDb.upsertGroupRow(directories, 'g1', 'party');
        await metadataDb.upsertGroupRow(directories, 'g3', 'Other');
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
