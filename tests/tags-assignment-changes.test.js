import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Buffer } from 'node:buffer';

// Which characters and groups may have had their tags changed past a client's cursors (/api/tags/assignment-changes),
// what /api/tags/assign answers, and the event a groups version row raises.

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
let groupChangeEvents = 0;
const onGroupChange = () => { groupChangeEvents++; };

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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-assignment-changes-test-'));
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
    await metadataDb.fillTagNameKeysIfNeeded(directories);
    groupChangeEvents = 0;
    metadataDb.characterChangeEmitter.on(metadataDb.GROUP_CHANGES_EVENT, onGroupChange);
});

afterEach(async () => {
    metadataDb.characterChangeEmitter.off(metadataDb.GROUP_CHANGES_EVENT, onGroupChange);
    jest.restoreAllMocks();
    await searchCoordinator.disposeSearchWorkers();
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

/** @param {string[]} ids */
async function createTags(ids) {
    for (const id of ids) {
        expect((await metadataDb.createTagDefinition(directories, { id, name: id })).refused).toEqual([]);
    }
}

/** @returns {Promise<{ sinceSeq: number, sinceGroupsVersion: number }>} The cursors a client that is about to read its entities asks from. */
async function cursors() {
    const { status, body } = await post('/api/tags/manifest');
    expect(status).toBe(200);
    expect(typeof body.assignmentChanges.seq).toBe('number');
    expect(typeof body.assignmentChanges.groupsVersion).toBe('number');
    return { sinceSeq: body.assignmentChanges.seq, sinceGroupsVersion: body.assignmentChanges.groupsVersion };
}

/** @param {unknown} since */
async function changes(since) {
    const { status, body } = await post('/api/tags/assignment-changes', since);
    expect(status).toBe(200);
    return body;
}

/** @param {{ seq: number, groupsVersion: number }} page */
const next = page => ({ sinceSeq: page.seq, sinceGroupsVersion: page.groupsVersion });

describe('POST /api/tags/assignment-changes', () => {
    test('lists the characters and groups whose tags were assigned or unassigned past the cursors, each once', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await seedGroup('1001');
        await seedGroup('1002');
        const since = await cursors();

        expect((await post('/api/tags/assign', { id: 'Alice.png', tagId: 'a' })).status).toBe(200);
        expect((await post('/api/tags/assign', { id: 'Alice.png', tagId: 'b' })).status).toBe(200);
        expect((await post('/api/tags/assign', { id: '1001', tagId: 'a' })).status).toBe(200);
        expect((await post('/api/tags/unassign', { id: 'Alice.png', tagId: 'b' })).status).toBe(200);

        const page = await changes(since);
        expect(page.reset).toBe(false);
        expect(page.hasMore).toBe(false);
        expect(page.ids.sort()).toEqual(['1001', 'Alice.png']);
        expect(page.seq).toBe(page.endSeq);
        expect(page.groupsVersion).toBe(page.endGroupsVersion);

        const after = await changes(next(page));
        expect(after).toMatchObject({ reset: false, ids: [], hasMore: false, seq: page.seq, groupsVersion: page.groupsVersion });
    });

    test('a group tag write raises the groups event; an assign that changes nothing does not', async () => {
        await seedGroup('1001');
        groupChangeEvents = 0;
        expect((await post('/api/tags/assign', { id: '1001', tagId: 'a' })).status).toBe(200);
        expect(groupChangeEvents).toBe(1);
        expect((await post('/api/tags/assign', { id: '1001', tagId: 'a' })).status).toBe(200);
        expect(groupChangeEvents).toBe(1);
        expect((await post('/api/tags/unassign', { id: '1001', tagId: 'a' })).status).toBe(200);
        expect(groupChangeEvents).toBe(2);
    });

    test('a character change that did not write its tags is not listed; a deleted character is not listed', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        const since = await cursors();

        await metadataDb.setCharacterFav(directories, 'Alice.png', true);
        expect((await post('/api/tags/assign', { id: 'Bob.png', tagId: 'a' })).status).toBe(200);
        await metadataDb.deleteCharacterRow(directories, 'Bob.png');

        const page = await changes(since);
        expect(page.reset).toBe(false);
        expect(page.ids).toEqual([]);
        expect(page.seq).toBe(page.endSeq);
    });

    test('restore, copy and rename-key list the characters and groups they wrote', async () => {
        await createTags(['a', 'b']);
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await seedCharacter('Cara.png');
        await seedGroup('1001');
        await seedGroup('1002');
        await seedGroup('1003');

        let since = await cursors();
        const restore = await post('/api/tags/restore', { tags: [], tagMap: { 'Alice.png': ['a'], 1001: ['b'] }, overwrite: false });
        expect(restore.status).toBe(200);
        let page = await changes(since);
        expect(page.ids.sort()).toEqual(['1001', 'Alice.png']);

        since = next(page);
        expect((await post('/api/tags/copy', { from: 'Alice.png', to: 'Bob.png' })).status).toBe(200);
        expect((await post('/api/tags/copy', { from: '1001', to: '1002' })).status).toBe(200);
        page = await changes(since);
        expect(page.ids.sort()).toEqual(['1002', 'Bob.png']);

        since = next(page);
        expect((await post('/api/tags/rename-key', { from: 'Bob.png', to: 'Cara.png' })).status).toBe(200);
        expect((await post('/api/tags/rename-key', { from: '1002', to: '1003' })).status).toBe(200);
        page = await changes(since);
        expect(page.ids.sort()).toEqual(['1002', '1003', 'Bob.png', 'Cara.png']);
    });

    test('pages at 500 log rows across both logs, and the cursors reach the end', async () => {
        // The characters log keeps one field row per character, so its 300 rows are 300 characters' assignments.
        const characters = Array.from({ length: 300 }, (_, i) => `C${String(i).padStart(3, '0')}.png`);
        for (const id of characters) await seedCharacter(id);
        await seedGroup('1001');
        const since = await cursors();

        // 300 rows in each log: 600 in all, so two pages.
        for (const id of characters) expect(await metadataDb.assignEntityTag(directories, id, 't')).toBe('ok');
        for (let i = 0; i < 150; i++) {
            expect(await metadataDb.assignEntityTag(directories, '1001', 't')).toBe('ok');
            expect(await metadataDb.unassignEntityTag(directories, '1001', 't')).toBe('ok');
        }

        const first = await changes(since);
        expect(first.reset).toBe(false);
        expect(first.hasMore).toBe(true);
        expect((first.seq - since.sinceSeq) + (first.groupsVersion - since.sinceGroupsVersion)).toBe(500);
        expect((first.endSeq - first.seq) + (first.endGroupsVersion - first.groupsVersion)).toBe(100);
        expect(first.ids.sort()).toEqual(['1001', ...characters]);

        const second = await changes(next(first));
        expect(second.hasMore).toBe(false);
        expect(second.ids).toEqual(['1001']);
        expect(second.seq).toBe(second.endSeq);
        expect(second.groupsVersion).toBe(second.endGroupsVersion);
    });

    test.each([
        [{}],
        [{ sinceSeq: 0 }],
        [{ sinceSeq: null, sinceGroupsVersion: 0 }],
        [{ sinceSeq: -1, sinceGroupsVersion: 0 }],
        [{ sinceSeq: 1.5, sinceGroupsVersion: 0 }],
        [{ sinceSeq: '3', sinceGroupsVersion: 0 }],
        [{ sinceSeq: 0, sinceGroupsVersion: 999999 }],
        [{ sinceSeq: 999999, sinceGroupsVersion: 0 }],
    ])('cursors the logs cannot answer (%j) are answered with a reset and the logs\' ends', async (since) => {
        await seedCharacter('Alice.png');
        await seedGroup('1001');
        expect((await post('/api/tags/assign', { id: 'Alice.png', tagId: 'a' })).status).toBe(200);
        expect((await post('/api/tags/assign', { id: '1001', tagId: 'a' })).status).toBe(200);
        const end = await cursors();

        const page = await changes(since);
        expect(page).toEqual({
            seq: end.sinceSeq, groupsVersion: end.sinceGroupsVersion, endSeq: end.sinceSeq, endGroupsVersion: end.sinceGroupsVersion,
            reset: true, ids: [], hasMore: false,
        });
    });
});

describe('POST /api/tags/assign answers what it assigned', () => {
    test('the tag asked for, and whether a stored tag has that id', async () => {
        await createTags(['a']);
        await seedCharacter('Alice.png');
        await seedGroup('1001');
        expect((await post('/api/tags/assign', { id: 'Alice.png', tagId: 'a' })).body).toEqual({ result: 'ok', assigned: 'a', reason: null, defined: true });
        expect((await post('/api/tags/assign', { id: '1001', tagId: 'a' })).body).toEqual({ result: 'ok', assigned: 'a', reason: null, defined: true });
        // Already assigned: still what the entity has.
        expect((await post('/api/tags/assign', { id: 'Alice.png', tagId: 'a' })).body).toEqual({ result: 'ok', assigned: 'a', reason: null, defined: true });

        // An id no stored tag has is assigned all the same.
        expect((await post('/api/tags/assign', { id: 'Alice.png', tagId: 'nobody' })).body).toEqual({ result: 'ok', assigned: 'nobody', reason: null, defined: false });
        expect((await post('/api/tags/for', { ids: ['Alice.png'] })).body).toEqual({ 'Alice.png': ['a', 'nobody'] });
    });

    test('the merge target of a tag being deleted with one, and null for a tag being deleted with none', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        await createTags(['x', 'y', 'd']);
        await seedCharacter('Alice.png');
        await seedGroup('1001');
        expect((await metadataDb.deleteTagDefinition(directories, 'x', 'y')).refused).toEqual([]);
        expect((await metadataDb.deleteTagDefinition(directories, 'd')).refused).toEqual([]);

        expect((await post('/api/tags/assign', { id: 'Alice.png', tagId: 'x' })).body).toEqual({ result: 'ok', assigned: 'y', reason: 'merged', defined: true });
        expect((await post('/api/tags/assign', { id: '1001', tagId: 'x' })).body).toEqual({ result: 'ok', assigned: 'y', reason: 'merged', defined: true });
        expect((await post('/api/tags/assign', { id: 'Alice.png', tagId: 'd' })).body).toEqual({ result: 'ok', assigned: null, reason: 'deleted', defined: false });
        expect((await post('/api/tags/assign', { id: '1001', tagId: 'd' })).body).toEqual({ result: 'ok', assigned: null, reason: 'deleted', defined: false });
        expect((await post('/api/tags/for', { ids: ['Alice.png', '1001'] })).body).toEqual({ 'Alice.png': ['y'], 1001: ['y'] });
    });

    test('a tag whose delete has finished is assigned as an id no stored tag has', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        await createTags(['x', 'y']);
        await seedCharacter('Alice.png');
        expect((await metadataDb.deleteTagDefinition(directories, 'x', 'y')).refused).toEqual([]);
        await metadataDb.finishDeletedTags(directories);

        expect((await post('/api/tags/assign', { id: 'Alice.png', tagId: 'x' })).body).toEqual({ result: 'ok', assigned: 'x', reason: null, defined: false });
    });

    test('an unknown character or group is still a 404', async () => {
        expect((await post('/api/tags/assign', { id: 'Nobody.png', tagId: 'a' })).status).toBe(404);
        expect((await post('/api/tags/assign', { id: '4242', tagId: 'a' })).status).toBe(404);
    });
});
