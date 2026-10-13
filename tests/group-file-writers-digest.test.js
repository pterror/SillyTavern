import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

// A group write the store refuses must fail its request with a message and leave the group as it was: nothing
// reports success for a group that was never stored.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {any} */
let commit = null;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    fixture = await import('./converted-user.fixture.js');
    const groupsModule = await import('../src/endpoints/groups.js');
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
    user = await fixture.emptyUser('st-group-file-writers-digest-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(async () => {
    if (commit !== null) user.store.lib.store.commit = commit;
    commit = null;
    await user.close();
});

async function postRaw(urlPath, body) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}

/** Makes every write to the store fail, as a full disk would. */
function breakWrites() {
    const store = user.store.lib.store;
    commit = store.commit;
    store.commit = async () => { throw new Error('injected write failure'); };
}

/** @param {string} id */
async function stored(id) {
    return (await user.store.lib.groups([id]))[0];
}

describe('a route whose group write fails answers 500 with a message, and the group is unchanged', () => {
    const ROUTES = [
        ['/api/groups/edit', (id, group) => ({ ...group, name: 'Changed' })],
        ['/api/groups/save-partial', (id) => ({ id, props: { name: 'Changed' } })],
        ['/api/groups/new-chat', (id) => ({ id })],
        ['/api/chats/group/save', (id) => ({
            id: 'Brand New Chat',
            group_id: id,
            chat: [
                { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
                { name: 'User', is_user: true, is_system: false, mes: 'hi', send_date: 'x', extra: {} },
            ],
        })],
    ];

    test.each(ROUTES)('%s', async (route, makeBody) => {
        const created = (await postRaw('/api/groups/create', { name: 'Group', members: ['a.png'] })).body;
        const before = await stored(created.id);
        breakWrites();

        const result = await postRaw(route, makeBody(created.id, before));

        expect(result.status).toBe(500);
        expect(typeof result.body?.error).toBe('string');
        expect(await stored(created.id)).toEqual(before);
    }, 30000);

    test('/api/groups/create', async () => {
        breakWrites();
        const result = await postRaw('/api/groups/create', { name: 'New' });
        expect(result.status).toBe(500);
        expect(typeof result.body?.error).toBe('string');
        expect((await user.store.lib.query({ groupsOnly: true, wantTotal: true, wantRows: false })).total).toBe(0);
    });
});
