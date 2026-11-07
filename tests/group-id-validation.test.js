import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

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

/** @param {string | number} id */
async function stored(id) {
    return (await user.store.lib.groups([String(id)]))[0];
}

async function storedIds() {
    const page = await user.store.lib.query({ sortField: 'name', limit: 100, wantRows: false, wantTotal: false, wantHashes: true, groupsOnly: true });
    return /** @type {{ id: string }[]} */ (page.hashRows).map(row => row.id).sort();
}

async function writeLegacyGroup(id = 777, extra = {}) {
    const group = { id, name: `Legacy ${id}`, members: [], disabled_members: [], chat_id: 5, chats: [5, 'Named chat'], fav: false, ...extra };
    await user.store.lib.writeGroup(group);
    return group;
}

async function createGroup() {
    const { status, body } = await post('/api/groups/create', { name: 'Group', members: [] });
    expect(status).toBe(200);
    return body;
}

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

async function writeExistingNonDigitGroup(id = 'legacy-group') {
    const group = { id, name: 'Existing', members: [] };
    await user.store.lib.writeGroup(group);
    return group;
}

describe('a group route answers 400 for an id that can\'t name a group', () => {
    for (const route of ['/api/groups/save-partial', '/api/groups/delete']) {
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

describe('an existing group keeps working whatever its id', () => {
    test('/api/groups/save-partial, /api/chats/new, /batch and /delete on a non-digit group', async () => {
        await writeExistingNonDigitGroup('legacy-group');
        const tab = (await import('../src/chat-engine.js')).newSessionKey();
        const withTab = { 'X-ST-Session': tab };

        expect((await post('/api/groups/save-partial', { id: 'legacy-group', props: { name: 'Renamed' } })).status).toBe(200);
        expect((await stored('legacy-group')).name).toBe('Renamed');

        const newChat = await post('/api/chats/new', { group_id: 'legacy-group' }, withTab);
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
    test.each([['a digit string', String], ['an integer number', Number]])('/api/groups/save-partial, /api/chats/new, /batch and /delete with %s', async (_label, as) => {
        const created = await createGroup();
        const id = as(created.id);
        const tab = (await import('../src/chat-engine.js')).newSessionKey();
        const withTab = { 'X-ST-Session': tab };

        expect((await post('/api/groups/save-partial', { id, props: { name: 'Renamed' } })).status).toBe(200);
        expect(await stored(created.id)).toMatchObject({ id: created.id, name: 'Renamed' });

        const newChat = await post('/api/chats/new', { group_id: created.id }, withTab);
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
    test('/api/groups/batch and the stored group have the id as a string', async () => {
        await writeLegacyGroup(777);
        expect((await stored(777)).id).toBe('777');
        const { status, body } = await post('/api/groups/batch', { ids: ['777'] });
        expect(status).toBe(200);
        expect(body).toEqual([expect.objectContaining({ id: '777', name: 'Legacy 777' })]);
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
