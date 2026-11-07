import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
    const { router } = await import('../src/endpoints/chats.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/chats', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-group-owner-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

async function post(urlPath, body) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * @returns {Promise<Record<string, string>>}
 */
async function seedGroups(groups) {
    /** @type {Record<string, string>} */
    const ids = {};
    for (const [id, chats] of Object.entries(groups)) {
        await user.store.lib.writeGroup({ id, name: id, members: [] });
        for (const chat of chats) {
            const saved = await post('/api/chats/group/save', { id: chat, group_id: id, chat: [{ chat_metadata: {} }, { name: 'Rex', is_user: false, mes: `${id}/${chat}`, send_date: 'x', extra: {} }] });
            expect(saved.status).toBe(200);
            ids[`${id}/${chat}`] = saved.body.chat_id;
        }
    }
    return ids;
}

/**
 * @param {string} group
 * @param {string} name
 * @returns {Promise<string[]>}
 */
async function messagesOf(group, name) {
    const [tree] = await user.store.people.trees([{ group }]);
    if (tree === null || tree === undefined) return [];
    const { newSessionKey } = await import('../src/chat-engine.js');
    const messages = await fixture.chatNamed(user.store, { group }, name, newSessionKey());
    return (messages ?? []).filter(m => m.mes !== undefined).map(m => m.mes);
}

describe('the group a group chat route acts on', () => {
    test('is the one its group id names; with none, a route acts on no group', async () => {
        await seedGroups({ 'grp-a': ['chat-1'] });
        const chat = [{ chat_metadata: {} }, { name: 'Rex', is_user: false, mes: 'x', send_date: 'x', extra: {} }];
        expect((await post('/api/chats/group/save', { id: 'chat-1', chat })).status).toBe(400);
        expect((await post('/api/chats/group/save', { id: 'chat-orphan', chat })).status).toBe(400);
        expect((await post('/api/chats/group/delete', { id: 'chat-1' })).status).toBe(400);
        expect(await messagesOf('grp-a', 'chat-1')).toEqual(['grp-a/chat-1']);
    });

    test('a group id names the group: no other group is looked in', async () => {
        await seedGroups({ 'grp-a': ['chat-a'], 'grp-b': ['chat-b'] });
        expect(await messagesOf('grp-b', 'chat-b')).toEqual(['grp-b/chat-b']);
        expect(await messagesOf('grp-b', 'chat-a')).toEqual([]);
    });

    test('a label is unique across all groups: the same label saved in another group is given the next free name', async () => {
        const ids = await seedGroups({ 'grp-a': ['shared'], 'grp-b': [] });
        const saved = await post('/api/chats/group/save', { id: 'shared', group_id: 'grp-b', chat: [{ chat_metadata: {} }, { name: 'Rex', is_user: false, mes: 'b', send_date: 'x', extra: {} }] });
        expect(saved.status).toBe(200);
        expect(ids['grp-a/shared']).toBe('shared');
        expect(saved.body.chat_id).toBe('shared (2)');
        expect(await messagesOf('grp-a', 'shared')).toEqual(['grp-a/shared']);
        expect(await messagesOf('grp-b', 'shared (2)')).toEqual(['b']);
    });

    test('a group id that names no group is not found, even when a group has a chat of that name', async () => {
        await seedGroups({ 'grp-a': ['chat-1'] });
        const saved = await post('/api/chats/group/save', { id: 'chat-1', group_id: 'grp-gone', chat: [{ chat_metadata: {} }, { name: 'Rex', is_user: false, mes: 'x', send_date: 'x', extra: {} }] });
        expect(saved.status).toBe(400);
        expect(await messagesOf('grp-gone', 'chat-1')).toEqual([]);
        expect(await messagesOf('grp-a', 'chat-1')).toEqual(['grp-a/chat-1']);
    });

    test('a group id is accepted for a chat it doesn\'t have yet: the first save of a new chat', async () => {
        await seedGroups({ 'grp-a': [] });
        const saved = await post('/api/chats/group/save', { id: 'brand-new-chat', group_id: 'grp-a', chat: [{ chat_metadata: {} }, { name: 'Rex', is_user: false, mes: 'first', send_date: 'x', extra: {} }] });
        expect(saved.status).toBe(200);
        expect(await messagesOf('grp-a', 'brand-new-chat')).toEqual(['first']);
    });
});
