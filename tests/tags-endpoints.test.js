import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {import('express').Router} */
let router;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
let charactersDir;
let chatsDir;
let groupsDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/**
 * Mounts the real tags.js router behind a fake auth middleware, same shape as characters-manifest.test.js -
 * the phase 3 endpoints (see src/endpoints/tags.js) only need `request.user.directories` and
 * `request.user.directories.root` (the `/save`/`/get`/`/manifest` routes) to run.
 */
beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tags-endpoints-test-'));
    charactersDir = path.join(tempDir, 'characters');
    chatsDir = path.join(tempDir, 'chats');
    groupsDir = path.join(tempDir, 'groups');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, chats: chatsDir, groups: groupsDir };

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    ({ router } = await import('../src/endpoints/tags.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories };
        next();
    });
    app.use('/api/tags', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

afterEach(() => {
    // Each test wants a clean metadata store: disposeMetadataStores() only clears the in-memory entry cache, so
    // the on-disk sqlite file (same tempDir/root across every test in this file) also needs deleting, or the
    // next test would inherit the previous test's rows.
    metadataDb.disposeMetadataStores();
    const dbPath = path.join(tempDir, 'character-metadata.sqlite');
    if (fs.existsSync(dbPath)) {
        fs.rmSync(dbPath);
    }
});

async function postJson(urlPath, body) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function getJson(urlPath) {
    return fetch(`${baseUrl}${urlPath}`);
}

/** Seeds a bare-minimum metadata row for `avatar` directly, without needing a real PNG on disk. */
async function seedCharacter(avatar) {
    const cardJson = JSON.stringify({
        name: avatar.replace(/\.png$/, ''),
        data: { name: avatar.replace(/\.png$/, ''), tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    });
    await metadataDb.upsertCharacterFromWrite(directories, avatar, cardJson, Date.now());
}

/** Seeds a bare-minimum `groups` row directly, without needing a real group JSON file on disk. */
async function seedGroup(id, name = id) {
    await metadataDb.upsertGroupRow(directories, id, name);
}

describe('POST /api/tags/for', () => {
    test('returns {} for an empty ids array', async () => {
        const response = await postJson('/api/tags/for', { ids: [] });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({});
    });

    test('returns [] for an untagged or unknown id, the assigned tag ids otherwise', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await postJson('/api/tags/assign', { id: 'Alice.png', tagId: 'tag1' });

        const response = await postJson('/api/tags/for', { ids: ['Alice.png', 'Bob.png', 'Ghost.png'] });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ 'Alice.png': ['tag1'], 'Bob.png': [], 'Ghost.png': [] });
    });

    test('400s when ids is missing or not an array of strings', async () => {
        expect((await postJson('/api/tags/for', {})).status).toBe(400);
        expect((await postJson('/api/tags/for', { ids: 'nope' })).status).toBe(400);
        expect((await postJson('/api/tags/for', { ids: [123] })).status).toBe(400);
    });

    test('resolves a mix of character and group ids in one call (owner decision: groups share these endpoints)', async () => {
        await seedCharacter('Alice.png');
        await seedGroup('group1');
        await postJson('/api/tags/assign', { id: 'Alice.png', tagId: 'tag1' });
        await postJson('/api/tags/assign', { id: 'group1', tagId: 'tag2' });

        const body = await (await postJson('/api/tags/for', { ids: ['Alice.png', 'group1'] })).json();
        expect(body).toEqual({ 'Alice.png': ['tag1'], group1: ['tag2'] });
    });
});

describe('POST /api/tags/assign and /api/tags/unassign', () => {
    test('assign then unassign round-trips through /for, single-row semantics (no whole-file rewrite)', async () => {
        await seedCharacter('Alice.png');

        const assignResponse = await postJson('/api/tags/assign', { id: 'Alice.png', tagId: 'tag1' });
        expect(assignResponse.status).toBe(200);
        expect(await assignResponse.json()).toEqual({ result: 'ok' });

        let forResponse = await postJson('/api/tags/for', { ids: ['Alice.png'] });
        expect((await forResponse.json())['Alice.png']).toEqual(['tag1']);

        const unassignResponse = await postJson('/api/tags/unassign', { id: 'Alice.png', tagId: 'tag1' });
        expect(unassignResponse.status).toBe(200);

        forResponse = await postJson('/api/tags/for', { ids: ['Alice.png'] });
        expect((await forResponse.json())['Alice.png']).toEqual([]);
    });

    test('assign is idempotent (no duplicate/second usage-count bump) when called twice', async () => {
        await seedCharacter('Alice.png');
        await postJson('/api/tags/assign', { id: 'Alice.png', tagId: 'tag1' });
        await postJson('/api/tags/assign', { id: 'Alice.png', tagId: 'tag1' });

        const usage = await (await getJson('/api/tags/usage')).json();
        expect(usage.tag1).toBe(1);
    });

    test('assign 404s for an id that is neither a known character nor a known group', async () => {
        const response = await postJson('/api/tags/assign', { id: 'NoSuchCharacter.png', tagId: 'tag1' });
        expect(response.status).toBe(404);
    });

    test('assign works against a group id too, not just characters', async () => {
        await seedGroup('group1');
        const response = await postJson('/api/tags/assign', { id: 'group1', tagId: 'tag1' });
        expect(response.status).toBe(200);
        expect((await (await postJson('/api/tags/for', { ids: ['group1'] })).json()).group1).toEqual(['tag1']);
    });

    test('unassign is a harmless no-op for an unknown character', async () => {
        const response = await postJson('/api/tags/unassign', { id: 'NoSuchCharacter.png', tagId: 'tag1' });
        expect(response.status).toBe(200);
    });

    test('400s on a missing/empty id or tagId', async () => {
        expect((await postJson('/api/tags/assign', { id: '', tagId: 'tag1' })).status).toBe(400);
        expect((await postJson('/api/tags/assign', { id: 'Alice.png' })).status).toBe(400);
        expect((await postJson('/api/tags/unassign', { tagId: 'tag1' })).status).toBe(400);
    });
});

describe('GET /api/tags/usage', () => {
    test('reflects assign/unassign as a live {tagId: count} aggregate', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');

        expect(await (await getJson('/api/tags/usage')).json()).toEqual({});

        await postJson('/api/tags/assign', { id: 'Alice.png', tagId: 'tag1' });
        await postJson('/api/tags/assign', { id: 'Bob.png', tagId: 'tag1' });
        await postJson('/api/tags/assign', { id: 'Bob.png', tagId: 'tag2' });

        expect(await (await getJson('/api/tags/usage')).json()).toEqual({ tag1: 2, tag2: 1 });

        await postJson('/api/tags/unassign', { id: 'Alice.png', tagId: 'tag1' });
        expect(await (await getJson('/api/tags/usage')).json()).toEqual({ tag1: 1, tag2: 1 });
    });
});

describe('POST /api/tags/save and /api/tags/get (tag definitions - tags.json is gone entirely, owner decision)', () => {
    test('save then get round-trips tag definitions through the sqlite store, no tags.json file involved', async () => {
        const response = await postJson('/api/tags/save', { tags: [{ id: 'tag1', name: 'Funny' }] });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ result: 'ok' });

        expect(fs.existsSync(path.join(tempDir, 'tags.json'))).toBe(false);

        const got = await (await postJson('/api/tags/get', {})).json();
        expect(got).toEqual({ tags: [{ id: 'tag1', name: 'Funny' }] });
    });

    test('save is a full replace of definitions, not additive', async () => {
        await postJson('/api/tags/save', { tags: [{ id: 'tag1', name: 'Funny' }] });
        await postJson('/api/tags/save', { tags: [{ id: 'tag2', name: 'Serious' }] });

        const got = await (await postJson('/api/tags/get', {})).json();
        expect(got).toEqual({ tags: [{ id: 'tag2', name: 'Serious' }] });
    });

    test('save 400s when tags is missing or not an array (no more tag_map field accepted at all)', async () => {
        expect((await postJson('/api/tags/save', {})).status).toBe(400);
        expect((await postJson('/api/tags/save', { tags: 'nope' })).status).toBe(400);
    });
});

describe('POST /api/tags/manifest (freshness signature - tags_hash replaces tags.json\'s old mtime)', () => {
    test('advances after a definitions save or an assign/unassign, so the client cache can detect the change', async () => {
        const before = (await (await postJson('/api/tags/manifest', {})).json()).hash;

        await new Promise(resolve => setTimeout(resolve, 2));
        await postJson('/api/tags/save', { tags: [{ id: 'tag1', name: 'Funny' }] });
        const afterSave = (await (await postJson('/api/tags/manifest', {})).json()).hash;
        expect(afterSave).not.toBe(before);

        await seedCharacter('Alice.png');
        await new Promise(resolve => setTimeout(resolve, 2));
        await postJson('/api/tags/assign', { id: 'Alice.png', tagId: 'tag1' });
        const afterAssign = (await (await postJson('/api/tags/manifest', {})).json()).hash;
        expect(afterAssign).not.toBe(afterSave);
    });
});
