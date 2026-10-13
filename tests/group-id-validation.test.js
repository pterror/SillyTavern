import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { groupDigestContentHash } from '../public/scripts/hash-utils.js';

// A new group id is all digits; a legacy group file stores it as a number. Legacy files can also hold numeric
// chat_id/chats entries, which read as their string form.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groupsModule;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    fixture = await import('./converted-user.fixture.js');
    groupsModule = await import('../src/endpoints/groups.js');
    const { router: chatsRouter } = await import('../src/endpoints/chats.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/groups', groupsModule.router);
    app.use('/api/chats', chatsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-group-id-validation-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/** @returns {Promise<{ status: number, body: any }>} */
async function post(urlPath, body, headers = {}) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed };
}

/** A group as stored, or null. @param {string | number} id */
async function stored(id) {
    return (await user.store.lib.groups([String(id)]))[0];
}

/** Every stored group's id, in name order. */
async function storedIds() {
    const all = await post('/api/groups/all', {});
    return all.body.map(g => g.id).sort();
}

/** A legacy group: id, chat_id and chats given as numbers. */
async function writeLegacyGroup(id = 777, extra = {}) {
    const group = { id, name: `Legacy ${id}`, members: [], disabled_members: [], chat_id: 5, chats: [5, 'Named chat'], fav: false, ...extra };
    await user.store.lib.writeGroup(group);
    return group;
}

/** A group created the current way. */
async function createGroup() {
    const { status, body } = await post('/api/groups/create', { name: 'Group', members: [] });
    expect(status).toBe(200);
    return body;
}

// Can't name any group: not a string or an integer, or a string that could escape the groups directory.
const UNUSABLE_IDS = [
    ['an empty string', ''],
    ['a string with a slash', 'a/b'],
    ['a string with a NUL', 'a\u0000b'],
    ['a non-integer number', 1.5],
    ['a negative integer', -1],
    ['an unsafe integer', 2 ** 60],
    ['an array', ['1']],
    ['an object', { id: '1' }],
    ['a boolean', true],
];

// Name a group that may exist, but aren't valid ids for creating one.
const NON_DIGIT_IDS = [
    ['a non-digit string', 'g1'],
    ['a character avatar name', 'Alice.png'],
    ['a digit string with a suffix', '12a'],
    ['a decimal string', '1.5'],
    ['a digit string with whitespace', ' 1'],
    ['a negative number string', '-1'],
];

/** A group stored under a non-digit id, as older data can hold. */
async function writeExistingNonDigitGroup(id = 'legacy-group') {
    const group = { id, name: 'Existing', members: [] };
    await user.store.lib.writeGroup(group);
    return group;
}

describe('a group route answers 400 for an id that can\'t name a group', () => {
    for (const route of ['/api/groups/edit', '/api/groups/save-partial', '/api/groups/new-chat', '/api/groups/delete']) {
        test.each(UNUSABLE_IDS)(`${route} rejects %s`, async (_label, id) => {
            const created = await createGroup();
            const before = await stored(created.id);
            const { status } = await post(route, { ...before, id, props: { name: 'Changed' } });
            expect(status).toBe(400);
            expect(await stored(created.id)).toEqual(before);
            expect(await storedIds()).toEqual([created.id]);
        });
    }
});

describe('creating a group through /api/groups/edit needs a digit id', () => {
    test.each(NON_DIGIT_IDS)('rejects %s when no group has it', async (_label, id) => {
        const { status } = await post('/api/groups/edit', { id, name: 'New', members: [], chats: [] });
        expect(status).toBe(400);
        expect(await storedIds()).toEqual([]);
        expect(await stored(id)).toBeNull();
    });
});

describe('an existing group keeps working whatever its id', () => {
    test('/api/groups/edit, /save-partial, /new-chat, /batch and /delete on a non-digit group', async () => {
        await writeExistingNonDigitGroup('legacy-group');
        const tab = (await import('../src/chat-engine.js')).newSessionKey();
        const withTab = { 'X-ST-Session': tab };

        expect((await post('/api/groups/edit', { ...await stored('legacy-group'), name: 'Edited' })).status).toBe(200);
        expect((await stored('legacy-group')).name).toBe('Edited');

        expect((await post('/api/groups/save-partial', { id: 'legacy-group', props: { name: 'Renamed' } })).status).toBe(200);
        expect((await stored('legacy-group')).name).toBe('Renamed');

        const newChat = await post('/api/groups/new-chat', { id: 'legacy-group' }, withTab);
        expect(newChat.status).toBe(200);
        const listed = await post('/api/groups/batch', { ids: ['legacy-group'] }, withTab);
        expect(listed.body[0].chats).toContain(newChat.body.chat_id);

        const batch = await post('/api/groups/batch', { ids: ['legacy-group'] });
        expect(batch.status).toBe(200);
        expect(batch.body.map(g => g.id)).toEqual(['legacy-group']);

        expect((await post('/api/groups/delete', { id: 'legacy-group' })).status).toBe(200);
        expect(await stored('legacy-group')).toBeNull();
    });
});

describe('/api/groups/batch skips an id it can\'t serve instead of failing the batch', () => {
    test.each([...UNUSABLE_IDS, ['an unknown non-digit id', 'no-such-group'], ['an unknown digit id', '424242']])('skips %s', async (_label, id) => {
        const created = await createGroup();
        await writeExistingNonDigitGroup('legacy-group');
        const { status, body } = await post('/api/groups/batch', { ids: [created.id, id, 'legacy-group'] });
        expect(status).toBe(200);
        expect(body.map(g => g.id)).toEqual([created.id, 'legacy-group']);
    });
});

describe('every group route accepts a digit string and an integer number', () => {
    test.each([['a digit string', '123'], ['an integer number', 123]])('/api/groups/edit with %s writes the group under the string id', async (_label, id) => {
        const { status } = await post('/api/groups/edit', { id, name: 'Edited', members: [], chat_id: 4, chats: [4], fav: false });
        expect(status).toBe(200);
        expect(await stored('123')).toMatchObject({ id: '123', name: 'Edited' });
        expect(groupDigestContentHash(await stored('123')) >>> 0).toBe(groupDigestContentHash((await post('/api/groups/batch', { ids: ['123'] })).body.map(g => ({ ...g, chat_id: undefined, chats: undefined }))[0] ?? {}) >>> 0);
    });

    test.each([['a digit string', String], ['an integer number', Number]])('/api/groups/save-partial, /new-chat, /batch and /delete with %s', async (_label, as) => {
        const created = await createGroup();
        const id = as(created.id);
        const tab = (await import('../src/chat-engine.js')).newSessionKey();
        const withTab = { 'X-ST-Session': tab };

        expect((await post('/api/groups/save-partial', { id, props: { name: 'Renamed' } })).status).toBe(200);
        expect(await stored(created.id)).toMatchObject({ id: created.id, name: 'Renamed' });

        const newChat = await post('/api/groups/new-chat', { id }, withTab);
        expect(newChat.status).toBe(200);
        expect((await post('/api/groups/batch', { ids: [id] }, withTab)).body[0].chats).toContain(newChat.body.chat_id);

        const batch = await post('/api/groups/batch', { ids: [id] });
        expect(batch.status).toBe(200);
        expect(batch.body.map(g => g.id)).toEqual([created.id]);

        expect((await post('/api/groups/delete', { id })).status).toBe(200);
        expect(await stored(created.id)).toBeNull();
    });
});

describe('a group with a numeric id', () => {
    test('/api/groups/all and the stored group have the id as a string', async () => {
        await writeLegacyGroup(777);
        expect((await stored(777)).id).toBe('777');
        const { status, body } = await post('/api/groups/all', {});
        expect(status).toBe(200);
        expect(body.find(g => g.name === 'Legacy 777')).toMatchObject({ id: '777' });
    });

    test('getGroupsByIds()', async () => {
        await writeLegacyGroup(777);
        expect((await groupsModule.getGroupsByIds(directories, ['777']))['777']).toMatchObject({ id: '777' });
    });
});

describe('each existing write of a legacy group file stores chat_id and chats as strings', () => {
    test('migrateGroupChatsMetadataFormat()', async () => {
        const group = { id: 777, name: 'Legacy 777', members: [], disabled_members: [], chat_id: 5, chats: [5, 'Named chat'], fav: false, chat_metadata: {} };
        fs.writeFileSync(path.join(directories.groups, '777.json'), JSON.stringify(group));
        await groupsModule.migrateGroupChatsMetadataFormat([directories]);
        const file = JSON.parse(fs.readFileSync(path.join(directories.groups, '777.json'), 'utf8'));
        expect(file.chat_metadata).toBeUndefined();
        expect(file).toMatchObject({ id: '777', chat_id: '5', chats: ['5', 'Named chat'] });
    });
});
