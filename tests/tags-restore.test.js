import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Restoring a tag backup: the server creates or updates the backup's tag definitions, then adds its assignments to
// what each character or group already has.

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

beforeEach(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-restore-test-'));
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

/** @param {object[]} tags Stored as they are. */
async function seedTags(tags) {
    for (const tag of tags) {
        expect((await metadataDb.createTagDefinition(directories, { ...tag })).refused).toEqual([]);
    }
}

/**
 * @param {{ tags?: unknown[], tag_map?: Record<string, unknown>, overwrite?: boolean }} backup
 */
async function restore({ tags = [], tag_map = {}, overwrite = false }) {
    const { status, body } = await post('/api/tags/restore', { tags, tagMap: tag_map, overwrite });
    expect(status).toBe(200);
    return body;
}

/** @param {string[]} ids */
async function tagsFor(ids) {
    return (await post('/api/tags/for', { ids })).body;
}

/** @param {string} id @returns {Promise<any>} The stored definition, or undefined. */
async function storedTag(id) {
    return (await post('/api/tags/by-ids', { ids: [id] })).body.tags.find(tag => tag.id === id);
}

/** @returns {Promise<string[]>} Every stored tag's id. */
async function storedTagIds() {
    const ids = [];
    for await (const batch of await metadataDb.streamTagDefinitionBatches(directories)) {
        for (const tag of batch) ids.push(tag.id);
    }
    return ids.sort();
}

const NOTHING_LEFT_OUT = {
    createdTagIds: [], updatedTagIds: [], invalidTags: [], keptTags: [], namesTaken: [], unreadableTags: [],
    invalidKeys: [], missingKeys: [], undefinedTagIds: [], deletedTagIds: [], failedKeys: [],
};

describe('/api/tags/restore: assignments', () => {
    beforeEach(async () => {
        await seedTags([{ id: 'a', name: 'Alpha', sort_order: 1 }, { id: 'b', name: 'Beta', sort_order: 2 }]);
    });

    test('a character keeps the tags it has and gains the backup\'s', async () => {
        await seedCharacter('Bob.png');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'a');

        expect(await restore({ tag_map: { 'Bob.png': ['b'] } })).toEqual(NOTHING_LEFT_OUT);

        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['a', 'b'] });
        const listRows = /** @type {any} */ (await metadataDb.getShallowByIds(directories, ['Bob.png']));
        expect(listRows['Bob.png'].tag_ids).toEqual(['a', 'b']);
    });

    test('a group keeps the tags it has and gains the backup\'s', async () => {
        await seedGroup('1001');
        await metadataDb.assignEntityTag(directories, '1001', 'a');

        expect(await restore({ tag_map: { 1001: ['b'] } })).toEqual(NOTHING_LEFT_OUT);

        expect(await tagsFor(['1001'])).toEqual({ 1001: ['a', 'b'] });
    });

    test('an entity the backup does not name is left as it is', async () => {
        await seedCharacter('Bob.png');
        await seedCharacter('Carol.png');
        await metadataDb.assignEntityTag(directories, 'Carol.png', 'a');

        await restore({ tag_map: { 'Bob.png': ['b'] } });

        expect(await tagsFor(['Carol.png'])).toEqual({ 'Carol.png': ['a'] });
    });

    test('a character that already has every tag listed is not written', async () => {
        await seedCharacter('Bob.png');
        await metadataDb.assignEntityTag(directories, 'Bob.png', 'a');
        const before = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');

        expect(await restore({ tag_map: { 'Bob.png': ['a'] } })).toEqual(NOTHING_LEFT_OUT);

        const after = await metadataDb.getCharacterMetadataRow(directories, 'Bob.png');
        expect(after.version).toBe(before.version);
    });

    test('keys that are neither a character nor a group are listed, and the rest is written', async () => {
        await seedCharacter('Bob.png');

        const result = await restore({ tag_map: { 'Gone.png': ['a'], 'no-such-group': ['a'], 'Bob.png': ['a'] } });

        expect(result.missingKeys.sort()).toEqual(['Gone.png', 'no-such-group']);
        expect(await tagsFor(['Bob.png', 'Gone.png', 'no-such-group'])).toEqual({ 'Bob.png': ['a'], 'Gone.png': [], 'no-such-group': [] });
    });

    test('ids no tag has, values that are not ids, and a value that is not a list are listed and not assigned', async () => {
        await seedCharacter('Bob.png');
        await seedCharacter('Carol.png');

        const result = await restore({ tag_map: { 'Bob.png': ['a', 'nope', 7, ''], 'Carol.png': 'a' } });

        expect(result).toEqual({
            ...NOTHING_LEFT_OUT,
            undefinedTagIds: [{ key: 'Bob.png', tagIds: ['nope', 7, ''] }],
            invalidKeys: [{ key: 'Carol.png', value: '"a"' }],
        });
        expect(await tagsFor(['Bob.png', 'Carol.png'])).toEqual({ 'Bob.png': ['a'], 'Carol.png': [] });
    });

    test('a deleted tag the backup has no definition for goes to its merge target, or is listed when it has none', async () => {
        await seedTags([{ id: 'merged', name: 'Merged' }, { id: 'gone', name: 'Gone' }]);
        await metadataDb.deleteTagDefinition(directories, 'merged', 'a');
        await metadataDb.deleteTagDefinition(directories, 'gone');
        await seedCharacter('Bob.png');

        const result = await restore({ tag_map: { 'Bob.png': ['merged', 'gone'] } });

        expect(result).toEqual({ ...NOTHING_LEFT_OUT, deletedTagIds: [{ key: 'Bob.png', tagIds: ['gone'] }] });
        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['a'] });
    });

    test('a character still in the batch-import buffer is found and written', async () => {
        await metadataDb.beginBatchImport(directories);
        await metadataDb.upsertCharacterFromWrite(directories, 'Bob.png', cardJson('Bob.png'), null, null, { fromImport: true });
        expect(await metadataDb.getCharacterMetadataRow(directories, 'Bob.png')).toBeUndefined();

        expect(await restore({ tag_map: { 'Bob.png': ['a'] } })).toEqual(NOTHING_LEFT_OUT);

        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['a'] });
        await metadataDb.endBatchImport(directories);
        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['a'] });
    });
});

describe('/api/tags/restore: definitions', () => {
    test('a tag the server does not have is created, and its assignments are stored', async () => {
        await seedCharacter('Bob.png');
        const tag = { id: 'new', name: 'New', color: '#123456', folder_type: 'OPEN', sort_order: 5 };

        const result = await restore({ tags: [tag], tag_map: { 'Bob.png': ['new'] } });

        expect(result).toEqual({ ...NOTHING_LEFT_OUT, createdTagIds: ['new'] });
        expect(await storedTag('new')).toEqual(tag);
        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['new'] });
    });

    test('a created tag with no order of its own is placed after every tag that has one', async () => {
        await seedTags([{ id: 'a', name: 'Alpha', sort_order: 40 }]);

        await restore({ tags: [{ id: 'z', name: 'Zed' }, { id: 'm', name: 'Mid' }, { id: 'o', name: 'Ordered', sort_order: 50 }] });

        expect((await storedTag('m')).sort_order).toBe(51);
        expect((await storedTag('z')).sort_order).toBe(52);
    });

    test('Keep Existing: a tag with the same id is left as it is and listed', async () => {
        await seedTags([{ id: 'a', name: 'Alpha', color: 'red', sort_order: 1 }]);

        const result = await restore({ tags: [{ id: 'a', name: 'Renamed', color: 'blue', sort_order: 9 }] });

        expect(result).toEqual({ ...NOTHING_LEFT_OUT, keptTags: [{ id: 'a', name: 'Renamed', existingId: 'a' }] });
        expect(await storedTag('a')).toEqual({ id: 'a', name: 'Alpha', color: 'red', sort_order: 1 });
    });

    test('Keep Existing: a tag with the same name and another id is left, and takes the backup tag\'s assignments', async () => {
        await seedTags([{ id: 'a', name: 'Fantasy', color: 'red', sort_order: 1 }]);
        await seedCharacter('Bob.png');

        const result = await restore({ tags: [{ id: 'other', name: 'fántasy', color: 'blue' }], tag_map: { 'Bob.png': ['other'] } });

        expect(result).toEqual({ ...NOTHING_LEFT_OUT, keptTags: [{ id: 'other', name: 'fántasy', existingId: 'a' }] });
        expect(await storedTagIds()).toEqual(['a']);
        expect((await storedTag('a')).color).toBe('red');
        expect(await tagsFor(['Bob.png'])).toEqual({ 'Bob.png': ['a'] });
    });

    test('Overwrite: a tag with the same id takes the backup\'s fields and keeps the ones the backup lacks', async () => {
        await seedTags([{ id: 'a', name: 'Alpha', color: 'red', color2: 'white', sort_order: 1 }]);

        const result = await restore({ tags: [{ id: 'a', name: 'Renamed', color: 'blue', sort_order: 1 }], overwrite: true });

        expect(result).toEqual({ ...NOTHING_LEFT_OUT, updatedTagIds: ['a'] });
        expect(await storedTag('a')).toEqual({ id: 'a', name: 'Renamed', color: 'blue', color2: 'white', sort_order: 1 });
    });

    test('Overwrite: a tag with the same name and another id keeps its id, takes the backup\'s fields and its assignments', async () => {
        await seedTags([{ id: 'a', name: 'Fantasy', color: 'red', sort_order: 1 }]);
        await seedCharacter('Bob.png');
        await seedCharacter('Carol.png');
        await metadataDb.assignEntityTag(directories, 'Carol.png', 'a');

        const result = await restore({
            tags: [{ id: 'other', name: 'FANTASY', color: 'blue', sort_order: 1 }],
            tag_map: { 'Bob.png': ['other'] },
            overwrite: true,
        });

        expect(result).toEqual({ ...NOTHING_LEFT_OUT, updatedTagIds: ['a'] });
        expect(await storedTagIds()).toEqual(['a']);
        expect(await storedTag('a')).toEqual({ id: 'a', name: 'FANTASY', color: 'blue', sort_order: 1 });
        expect(await tagsFor(['Bob.png', 'Carol.png'])).toEqual({ 'Bob.png': ['a'], 'Carol.png': ['a'] });
    });

    test('Overwrite: a name another tag already has is not taken; the other fields are', async () => {
        await seedTags([{ id: 'a', name: 'Alpha', color: 'red', sort_order: 1 }, { id: 'b', name: 'Beta', sort_order: 2 }]);

        const result = await restore({ tags: [{ id: 'a', name: 'beta', color: 'blue', sort_order: 1 }], overwrite: true });

        expect(result).toEqual({ ...NOTHING_LEFT_OUT, updatedTagIds: ['a'], namesTaken: [{ id: 'a', name: 'beta' }] });
        expect(await storedTag('a')).toEqual({ id: 'a', name: 'Alpha', color: 'blue', sort_order: 1 });
    });

    test('Overwrite: a tag the backup holds unchanged is not written', async () => {
        const tag = { id: 'a', name: 'Alpha', color: 'red', sort_order: 1 };
        await seedTags([tag]);
        const before = await metadataDb.getTagChangesSeq(directories);

        expect(await restore({ tags: [tag], overwrite: true })).toEqual(NOTHING_LEFT_OUT);

        expect(await metadataDb.getTagChangesSeq(directories)).toBe(before);
    });

    test('a tag being deleted is created again under a new id, with the backup\'s assignments', async () => {
        await seedTags([{ id: 'target', name: 'Target', sort_order: 1 }, { id: 'gone', name: 'Gone', sort_order: 2 }, { id: 'merged', name: 'Merged', sort_order: 3 }]);
        await metadataDb.deleteTagDefinition(directories, 'gone');
        await metadataDb.deleteTagDefinition(directories, 'merged', 'target');
        await seedCharacter('Bob.png');

        const result = await restore({
            tags: [{ id: 'gone', name: 'Gone', color: 'red', sort_order: 2 }, { id: 'merged', name: 'Merged', sort_order: 3 }],
            tag_map: { 'Bob.png': ['gone', 'merged'] },
        });

        expect(result.createdTagIds).toHaveLength(2);
        expect(result.createdTagIds).not.toContain('gone');
        expect(result.createdTagIds).not.toContain('merged');
        expect({ ...result, createdTagIds: [] }).toEqual(NOTHING_LEFT_OUT);
        const [goneId, mergedId] = result.createdTagIds;
        expect(await storedTag(goneId)).toEqual({ id: goneId, name: 'Gone', color: 'red', sort_order: 2 });
        expect((await storedTag(mergedId)).name).toBe('Merged');
        expect((await tagsFor(['Bob.png']))['Bob.png'].sort()).toEqual([goneId, mergedId].sort());
    });

    test('entries that are not a tag with an id and a name are listed, and the rest is restored', async () => {

        const result = await restore({ tags: [null, 'x', { id: 'no-name' }, { name: 'No id' }, { id: 'ok', name: 'Ok', sort_order: 1 }] });

        expect(result).toEqual({
            ...NOTHING_LEFT_OUT,
            createdTagIds: ['ok'],
            invalidTags: ['null', '"x"', '{"id":"no-name"}', '{"name":"No id"}'],
        });
    });

    test.each([
        ['no tags', { tagMap: {}, overwrite: false }],
        ['tags that are not a list', { tags: {}, tagMap: {}, overwrite: false }],
        ['no tagMap', { tags: [], overwrite: false }],
        ['a tagMap that is a list', { tags: [], tagMap: [], overwrite: false }],
        ['no overwrite', { tags: [], tagMap: {} }],
    ])('%s is a 400', async (_name, body) => {
        expect((await post('/api/tags/restore', body)).status).toBe(400);
    });
});
