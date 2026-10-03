import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Buffer } from 'node:buffer';

// The tag backup file is made by the server: every tag and every character's and group's tags, whatever a page holds.

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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-backup-test-'));
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

describe('POST /api/tags/backup', () => {
    test('holds every tag and every character\'s and group\'s tags', async () => {
        for (const id of ['a', 'b', 'c']) {
            expect((await metadataDb.createTagDefinition(directories, { id, name: `Tag ${id}` })).refused).toEqual([]);
        }
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await seedCharacter('Carol.png');
        await seedGroup('1001');
        await assign('Alice.png', ['a', 'b']);
        await assign('Bob.png', ['c']);
        await assign('1001', ['a']);

        const { status, body } = await post('/api/tags/backup', {});
        expect(status).toBe(200);
        expect(body.tags.map(tag => tag.id).sort()).toEqual(['a', 'b', 'c']);
        expect(body.tag_map).toEqual({ 'Alice.png': ['a', 'b'], 'Bob.png': ['c'], 1001: ['a'] });
    });

    test('an entity whose rows span more than one batch is one entry', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        const many = Array.from({ length: 1500 }, (_, i) => `t${String(i).padStart(4, '0')}`);
        // One restore for all 1500 rows: assigning them one by one took most of jest's 5 s timeout under load.
        const restored = await metadataDb.restoreTagBackup(directories, { tags: many.map(id => ({ id, name: id })), tagMap: { 'Alice.png': many }, overwrite: false });
        expect(restored?.undefinedTagIds).toEqual([]);
        await assign('Bob.png', ['t0001']);

        const { status, body } = await post('/api/tags/backup', {});
        expect(status).toBe(200);
        expect(body.tag_map['Alice.png']).toEqual(many);
        expect(body.tag_map['Bob.png']).toEqual(['t0001']);
        expect(Object.keys(body.tag_map).sort()).toEqual(['Alice.png', 'Bob.png']);
    });

    test('a tag being deleted is left out, and its assignments read as its merge target', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        for (const id of ['x', 'y', 'd']) {
            expect((await metadataDb.createTagDefinition(directories, { id, name: id })).refused).toEqual([]);
        }
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await assign('Alice.png', ['x']);
        await assign('Bob.png', ['d', 'y']);
        await metadataDb.deleteTagDefinition(directories, 'x', 'y');
        await metadataDb.deleteTagDefinition(directories, 'd', null);

        const { body } = await post('/api/tags/backup', {});
        expect(body.tags.map(tag => tag.id)).toEqual(['y']);
        expect(body.tag_map).toEqual({ 'Alice.png': ['y'], 'Bob.png': ['y'] });
    });

    test('an empty store is an empty backup', async () => {
        const { status, body } = await post('/api/tags/backup', {});
        expect(status).toBe(200);
        expect(body.tag_map).toEqual({});
    });
});
