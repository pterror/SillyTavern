import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

// A tag assignment's entity type follows from its id: ending in `.png` is a character, anything else a group.
// A group whose id ends in `.png` can only be legacy data; its tag assignments are never read as a group's.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/library-codes.js').TYPE} */
let TYPE;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    fixture = await import('./converted-user.fixture.js');
    ({ TYPE } = await import('../src/library-codes.js'));
    const { router: tagsRouter } = await import('../src/endpoints/tags.js');
    const { router: groupsRouter } = await import('../src/endpoints/groups.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/tags', tagsRouter);
    app.use('/api/groups', groupsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-tag-entity-typing-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

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
async function seedCharacter(avatar) {
    const name = avatar.replace(/\.png$/, '');
    const cardJson = JSON.stringify({
        name,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    });
    await user.store.lib.writeCard(directories, avatar, cardJson);
}

/** A group. @param {string} id */
async function seedGroup(id) {
    await user.store.lib.writeGroup({ id, name: `Group ${id}`, members: [], fav: false });
}

/** The tags the store holds for a group, whatever its id. @param {string} id */
async function groupTagIds(id) {
    return /** @type {any} */ ((await user.store.lib.groups([id]))[0])?.tag_ids ?? [];
}

/**
 * Legacy data where a group and a character share the id `Alice.png`: the character has tag `char-tag`, and the
 * group holds `group-tag`.
 */
async function seedCollision() {
    await seedCharacter('Alice.png');
    await seedGroup('Alice.png');
    expect((await post('/api/tags/assign', { id: 'Alice.png', tagId: 'char-tag' })).status).toBe(200);
    await user.store.lib.writeTag({ id: 'group-tag', name: 'group-tag' });
    await user.store.lib.assignTag(TYPE.group, 'Alice.png', 'group-tag', true);
}

// Groups and characters are different entities, so a group whose id ends in `.png` has its own tags; the tag routes
// still read a `.png` id as a character's avatar (upstream's keys).
describe('a group whose id ends in .png keeps its own tags', () => {
    test('/api/tags/for reads only the character\'s tags', async () => {
        await seedCollision();
        const { status, body } = await post('/api/tags/for', { ids: ['Alice.png'] });
        expect(status).toBe(200);
        expect(body).toEqual({ 'Alice.png': ['char-tag'] });
    });

    test('/api/groups/batch serves the .png group with its own tags', async () => {
        await seedCollision();
        const { status, body } = await post('/api/groups/batch', { ids: ['Alice.png'] });
        expect(status).toBe(200);
        expect(body.map(g => [g.id, g.tag_ids])).toEqual([['Alice.png', ['group-tag']]]);
    });

    test('a tag filter matches the .png group by its own tag, and the character by its own', async () => {
        await seedCollision();
        const ids = async (tag) => (await user.store.lib.query({ tags: { include: [tag] }, wantTotal: true })).rows.map(r => `${r.type}:${r.id}`);
        expect(await ids('group-tag')).toEqual(['group:Alice.png']);
        expect(await ids('char-tag')).toEqual(['character:Alice.png']);
    });

    test('hash mode gives the .png group the tag hash of its own tags, matching what /api/groups/batch serves', async () => {
        await seedCollision();
        const { groupDigestTagIdsHash } = await import('../public/scripts/hash-utils.js');
        const result = await user.store.lib.query({ wantRows: false, wantTotal: false, wantHashes: true });
        const groupRow = result.hashRows.find(r => r.isGroup && r.id === 'Alice.png');
        expect(groupRow.tagIdsHash).toBe(groupDigestTagIdsHash({ tag_ids: ['group-tag'] }) >>> 0);
    });

    test('/api/tags/unassign on the id leaves the group row\'s assignment in place', async () => {
        await seedCollision();
        expect((await post('/api/tags/unassign', { id: 'Alice.png', tagId: 'group-tag' })).status).toBe(200);
        expect(await groupTagIds('Alice.png')).toEqual(['group-tag']);
    });

    test('/api/tags/assign on a .png id with only a group row is a 404, and writes nothing', async () => {
        await seedGroup('Bob.png');
        const { status } = await post('/api/tags/assign', { id: 'Bob.png', tagId: 'tag1' });
        expect(status).toBe(404);
        expect(await groupTagIds('Bob.png')).toEqual([]);
    });

    test('/api/tags/copy to a .png id with only a group row is a 404, and writes nothing', async () => {
        await seedCharacter('Alice.png');
        await seedGroup('Bob.png');
        expect((await post('/api/tags/assign', { id: 'Alice.png', tagId: 'tag1' })).status).toBe(200);
        expect((await post('/api/tags/copy', { from: 'Alice.png', to: 'Bob.png' })).status).toBe(404);
        expect(await groupTagIds('Bob.png')).toEqual([]);
    });
});

describe('an id not ending in .png is always a group', () => {
    test('assign, read and unassign a legacy non-digit group', async () => {
        await seedGroup('legacy-group');
        expect((await post('/api/tags/assign', { id: 'legacy-group', tagId: 'tag1' })).status).toBe(200);
        expect((await post('/api/tags/for', { ids: ['legacy-group'] })).body).toEqual({ 'legacy-group': ['tag1'] });
        expect((await post('/api/groups/batch', { ids: ['legacy-group'] })).body[0].tag_ids).toEqual(['tag1']);
        expect((await post('/api/tags/unassign', { id: 'legacy-group', tagId: 'tag1' })).status).toBe(200);
        expect((await post('/api/tags/for', { ids: ['legacy-group'] })).body).toEqual({ 'legacy-group': [] });
    });

    test('copy from a legacy non-digit group to a digit group', async () => {
        await seedGroup('legacy-group');
        await seedGroup('1001');
        expect((await post('/api/tags/assign', { id: 'legacy-group', tagId: 'a' })).status).toBe(200);
        expect((await post('/api/tags/copy', { from: 'legacy-group', to: '1001' })).status).toBe(200);
        expect((await post('/api/tags/for', { ids: ['legacy-group', '1001'] })).body).toEqual({ 'legacy-group': ['a'], 1001: ['a'] });
    });

    test('a character row whose id doesn\'t end in .png is not assignable or readable as a character', async () => {
        await seedCharacter('NoExtension');
        expect((await post('/api/tags/assign', { id: 'NoExtension', tagId: 'tag1' })).status).toBe(404);
        await user.store.lib.assignTag(TYPE.character, 'NoExtension', 'tag1', true);
        expect((await post('/api/tags/for', { ids: ['NoExtension'] })).body).toEqual({ NoExtension: [] });
    });
});

describe('the requests that still answer 400', () => {
    test.each(['/api/tags/assign', '/api/tags/unassign'])('%s with an id that isn\'t a non-empty string', async (route) => {
        for (const id of ['', 123, null, ['a.png'], { id: 'a.png' }]) {
            expect((await post(route, { id, tagId: 'tag1' })).status).toBe(400);
        }
    });

    test('/api/tags/for with an id that isn\'t a string', async () => {
        expect((await post('/api/tags/for', { ids: [123] })).status).toBe(400);
        expect((await post('/api/tags/for', { ids: [['a']] })).status).toBe(400);
    });
});

describe('/api/tags/for dedups ids and caps them at 500 distinct', () => {
    test('a repeated id is answered once, with its tags once', async () => {
        await seedCharacter('Alice.png');
        await post('/api/tags/assign', { id: 'Alice.png', tagId: 'tag1' });
        const { status, body } = await post('/api/tags/for', { ids: Array(1200).fill('Alice.png') });
        expect(status).toBe(200);
        expect(body).toEqual({ 'Alice.png': ['tag1'] });
    });

    test('500 distinct ids are answered', async () => {
        const ids = Array.from({ length: 500 }, (_, i) => `c${i}.png`);
        const { status, body } = await post('/api/tags/for', { ids: [...ids, ...ids] });
        expect(status).toBe(200);
        expect(Object.keys(body)).toHaveLength(500);
    });

    test('501 distinct ids are a 400', async () => {
        const ids = Array.from({ length: 501 }, (_, i) => `c${i}.png`);
        expect((await post('/api/tags/for', { ids })).status).toBe(400);
    });
});

describe('/api/groups/batch dedups ids and caps them at 500 distinct', () => {
    test('a repeated id, including its numeric form, returns the group once with its tags once', async () => {
        await seedGroup('1001');
        await post('/api/tags/assign', { id: '1001', tagId: 'tag1' });
        const { status, body } = await post('/api/groups/batch', { ids: [...Array(1200).fill('1001'), 1001] });
        expect(status).toBe(200);
        expect(body.map(g => [g.id, g.tag_ids])).toEqual([['1001', ['tag1']]]);
    });

    test('500 distinct ids are answered', async () => {
        await seedGroup('1001');
        const ids = Array.from({ length: 500 }, (_, i) => String(1001 + i));
        const { status, body } = await post('/api/groups/batch', { ids });
        expect(status).toBe(200);
        expect(body.map(g => g.id)).toEqual(['1001']);
    });

    test('501 distinct ids are a 400', async () => {
        const ids = Array.from({ length: 501 }, (_, i) => String(1001 + i));
        expect((await post('/api/groups/batch', { ids })).status).toBe(400);
    });

    test('ids it skips don\'t count toward the cap', async () => {
        await seedGroup('1001');
        const unusable = Array.from({ length: 600 }, (_, i) => i + 0.5);
        const { status, body } = await post('/api/groups/batch', { ids: ['1001', ...unusable] });
        expect(status).toBe(200);
        expect(body.map(g => g.id)).toEqual(['1001']);
    });
});

describe('the tags of many ids', () => {
    test('a repeated id across more than one lookup chunk gets its tags once', async () => {
        await seedGroup('1001');
        await post('/api/tags/assign', { id: '1001', tagId: 'tag1' });
        const result = await user.store.lib.tags.tagIdsFor(Array(1200).fill('1001'));
        expect(result).toEqual({ 1001: ['tag1'] });
    });
});
