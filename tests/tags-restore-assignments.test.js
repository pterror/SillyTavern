import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Restoring a tag backup adds its assignments to what each character or group already has on the server.

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    const { router: tagsRouter } = await import('../src/endpoints/tags.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json({ limit: '10mb' }));
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-restore-assignments-test-'));
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

/** @param {string} avatar */
async function seedCharacter(avatar) {
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson(avatar));
}

/** @param {string} id */
async function seedGroup(id) {
    const group = { id, name: `Group ${id}`, members: [], chats: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, group.name, { fav: false, group });
}

/** @param {Record<string, unknown>} tagMap */
async function restore(tagMap) {
    const { status, body } = await post('/api/tags/restore-assignments', { tagMap });
    expect(status).toBe(200);
    return body;
}

/** @param {string[]} ids */
async function tagsFor(ids) {
    return (await post('/api/tags/for', { ids })).body;
}

const NOTHING_LEFT_OUT = { missingKeys: [], deletedTagIds: [], failedKeys: [] };

describe('/api/tags/restore-assignments', () => {
    test('a character keeps the tags it has and gains the backup\'s', async () => {
        await seedCharacter('Bob.png');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'a');

        expect(await restore({ 'Bob.png': ['b'] })).toEqual(NOTHING_LEFT_OUT);

        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['a', 'b'] });
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(JSON.parse(row.shallow_json).tag_ids).toEqual(['a', 'b']);
    });

    test('a group keeps the tags it has and gains the backup\'s', async () => {
        await seedGroup('1001');
        await metadataDb.assignEntityTag(directories, '1001', 'a');

        expect(await restore({ 1001: ['b'] })).toEqual(NOTHING_LEFT_OUT);

        expect(await tagsFor(['1001'])).toEqual({ 1001: ['a', 'b'] });
    });

    test('an entity the backup does not name is left as it is', async () => {
        await seedCharacter('Bob.png');
        await seedCharacter('Carol.png');
        await metadataDb.assignEntityTag(directories, 'Carol.png', 'a');

        await restore({ 'Bob.png': ['b'] });

        expect(await tagsFor(['Carol.png'])).toEqual({ 'Carol.png': ['a'] });
    });

    test('a character that already has every tag listed is not written', async () => {
        await seedCharacter('Bob.png');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'a');
        const before = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        expect(await restore({ 'Bob.png': ['a'] })).toEqual(NOTHING_LEFT_OUT);

        const after = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(after.change_seq).toBe(before.change_seq);
    });

    test('keys that are neither a character nor a group are listed, and the rest is written', async () => {
        await seedCharacter('Bob.png');

        const result = await restore({ 'Gone.png': ['a'], 'no-such-group': ['a'], 'Bob.png': ['a'] });

        expect(result.missingKeys.sort()).toEqual(['Gone.png', 'no-such-group']);
        expect(await tagsFor(['Bob.png', 'Gone.png', 'no-such-group'])).toEqual({ 'Bob.png': ['a'], 'Gone.png': [], 'no-such-group': [] });
    });

    test('a deleted tag goes to its merge target; one with no target is listed and not assigned', async () => {
        await metadataDb.fillTagNameKeysIfNeeded(directories);
        await metadataDb.saveTagDefinitions(directories, ['merged', 'target', 'gone'].map(id => ({ id, name: id })));
        await metadataDb.deleteTagDefinition(directories, 'merged', 'target');
        await metadataDb.deleteTagDefinition(directories, 'gone');
        await seedCharacter('Bob.png');

        const result = await restore({ 'Bob.png': ['merged', 'gone'] });

        expect(result).toEqual({ ...NOTHING_LEFT_OUT, deletedTagIds: [{ key: 'Bob.png', tagIds: ['gone'] }] });
        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['target'] });
    });

    test('a character still in the batch-import buffer is found and written', async () => {
        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson('Bob.png'), null, null, { fromImport: true });
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeUndefined();

        expect(await restore({ 'Bob.png': ['a'] })).toEqual(NOTHING_LEFT_OUT);

        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['a'] });
        await metadataDb.endBatchImport(directories);
        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['a'] });
    });

    test.each([
        ['no tagMap', {}],
        ['a list', { tagMap: [] }],
        ['a value that is not a list', { tagMap: { 'Bob.png': 'a' } }],
        ['an empty tag id', { tagMap: { 'Bob.png': [''] } }],
        ['an empty key', { tagMap: { '': ['a'] } }],
    ])('%s is a 400', async (_name, body) => {
        expect((await post('/api/tags/restore-assignments', body)).status).toBe(400);
    });
});
