import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Buffer } from 'node:buffer';

// Copying tags: the server adds what one character or group has to what another has, from its own rows.

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {import('../src/character-card-parser.js').write} */
let writeCard;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

// A minimal valid 1x1 transparent PNG, enough for a card to be written into and read back from.
const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    ({ write: writeCard } = await import('../src/character-card-parser.js'));
    const { router: tagsRouter } = await import('../src/endpoints/tags.js');
    const { router: charactersRouter } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/tags', tagsRouter);
    app.use('/api/characters', charactersRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-copy-test-'));
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

afterEach(async () => {
    jest.restoreAllMocks();
    await searchCoordinator.disposeSearchWorkers();
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

/** @param {string} avatar */
function cardJson(avatar) {
    const name = avatar.replace(/\.png$/, '');
    return JSON.stringify({
        name,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    });
}

/** @param {string} avatar Written as a card file and a row, as a created character is. */
async function seedCharacter(avatar) {
    fs.writeFileSync(path.join(directories.characters, avatar), writeCard(BLANK_PNG, cardJson(avatar)));
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson(avatar));
}

/** @param {string} id */
async function seedGroup(id) {
    const group = { id, name: `Group ${id}`, members: [], chats: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, group.name, { fav: false, group });
}

/** @param {string} id @param {string[]} tagIds */
async function assign(id, tagIds) {
    for (const tagId of tagIds) expect(await metadataDb.assignEntityTag(directories, id, tagId)).toBe('ok');
}

/** @param {string[]} ids */
async function tagsFor(ids) {
    return (await post('/api/tags/for', { ids })).body;
}

/** @returns {Promise<number>} */
async function currentSeq() {
    return metadataDb.getCurrentSeq(directories);
}

describe('POST /api/tags/copy', () => {
    test('adds the source character\'s tags to the target and keeps what the target had', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await assign('Alice.png', ['a', 'b']);
        await assign('Bob.png', ['b', 'z']);

        const { status, body } = await post('/api/tags/copy', { from: 'Alice.png', to: 'Bob.png' });
        expect(status).toBe(200);
        expect(body).toEqual({ result: 'ok' });
        expect(await tagsFor(['Alice.png', 'Bob.png'])).toEqual({ 'Alice.png': ['a', 'b'], 'Bob.png': ['a', 'b', 'z'] });
    });

    test('writes nothing when the target already has every tag', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await assign('Alice.png', ['a']);
        await assign('Bob.png', ['a', 'z']);
        const before = await currentSeq();

        expect((await post('/api/tags/copy', { from: 'Alice.png', to: 'Bob.png' })).status).toBe(200);
        expect(await currentSeq()).toBe(before);
        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['a', 'z'] });
    });

    test('a source with no tags is ok and changes nothing', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await assign('Bob.png', ['z']);

        expect((await post('/api/tags/copy', { from: 'Alice.png', to: 'Bob.png' })).status).toBe(200);
        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['z'] });
    });

    test('copies between groups, and between a character and a group', async () => {
        await seedCharacter('Alice.png');
        await seedGroup('1001');
        await seedGroup('1002');
        await assign('1001', ['g']);
        await assign('Alice.png', ['a']);

        expect((await post('/api/tags/copy', { from: '1001', to: '1002' })).status).toBe(200);
        expect((await post('/api/tags/copy', { from: 'Alice.png', to: '1002' })).status).toBe(200);
        expect(await tagsFor(['1001', '1002'])).toEqual({ 1001: ['g'], 1002: ['a', 'g'] });
    });

    test('a tag deleted with a merge target is copied as that target; one with none is not copied', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        for (const id of ['x', 'y', 'd']) {
            expect((await metadataDb.createTagDefinition(directories, { id, name: id })).refused).toEqual([]);
        }
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await assign('Alice.png', ['x', 'd']);
        expect((await metadataDb.deleteTagDefinition(directories, 'x', 'y')).refused).toEqual([]);
        expect((await metadataDb.deleteTagDefinition(directories, 'd')).refused).toEqual([]);

        expect((await post('/api/tags/copy', { from: 'Alice.png', to: 'Bob.png' })).status).toBe(200);
        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['y'] });
    });

    test('an unknown source or target is a 404 and writes nothing', async () => {
        await seedCharacter('Alice.png');
        await assign('Alice.png', ['a']);

        expect((await post('/api/tags/copy', { from: 'Alice.png', to: 'Nobody.png' })).status).toBe(404);
        expect((await post('/api/tags/copy', { from: 'Nobody.png', to: 'Alice.png' })).status).toBe(404);
        expect((await post('/api/tags/copy', { from: 'Alice.png', to: '4242' })).status).toBe(404);
        expect(await tagsFor(['Alice.png', 'Nobody.png'])).toEqual({ 'Alice.png': ['a'], 'Nobody.png': [] });
    });

    test.each([
        [{}],
        [{ from: 'Alice.png' }],
        [{ from: '', to: 'Bob.png' }],
        [{ from: 'Alice.png', to: 7 }],
    ])('%j is a 400', async (body) => {
        expect((await post('/api/tags/copy', body)).status).toBe(400);
    });
});

describe('POST /api/tags/assign-many', () => {
    test('is gone: a whole tag set can\'t be swapped in from a caller\'s list', async () => {
        await seedCharacter('Alice.png');
        await assign('Alice.png', ['a']);

        expect((await post('/api/tags/assign-many', { tagIdsByEntity: { 'Alice.png': ['b'] } })).status).toBe(404);
        expect(await tagsFor(['Alice.png'])).toEqual({ 'Alice.png': ['a'] });
    });
});

describe('POST /api/characters/duplicate', () => {
    beforeEach(() => {
        jest.spyOn(console, 'info').mockImplementation(() => {});
    });

    test('the duplicate gets the tags the server has for the original', async () => {
        await seedCharacter('Alice.png');
        await assign('Alice.png', ['a', 'b']);

        const { status, body } = await post('/api/characters/duplicate', { avatar_url: 'Alice.png' });
        expect(status).toBe(200);
        expect(body.path).toBe('Alice_1.png');
        expect(await tagsFor(['Alice.png', 'Alice_1.png'])).toEqual({ 'Alice.png': ['a', 'b'], 'Alice_1.png': ['a', 'b'] });
    });

    test('bulk duplicates each get their original\'s tags', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await assign('Alice.png', ['a']);
        await assign('Bob.png', ['b']);

        const { body } = await post('/api/characters/duplicate', { avatar_urls: ['Alice.png', 'Bob.png'] });
        expect(body.results.map(r => r.path)).toEqual(['Alice_1.png', 'Bob_1.png']);
        expect(await tagsFor(['Alice_1.png', 'Bob_1.png'])).toEqual({ 'Alice_1.png': ['a'], 'Bob_1.png': ['b'] });
    });
});
