import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

// Which group a group chat route acts on: `group_id` when given, else the group whose chat the id names (the stock API
// shape: `/group/get` and `/group/save` are handed `group.chat_id` and nothing else). Labels are free text and may
// repeat, so with no `group_id` a bare label names no chat.

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
 * Groups, each with chats (bookmarks) labelled as given, each chat one message naming it.
 * @returns {Promise<Record<string, string>>} Each chat's compat id, by `<group>/<label>`.
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

/** The messages `/group/get` answers. */
async function messagesOf(body) {
    const { status, body: chat } = await post('/api/chats/group/get', body);
    expect(status).toBe(200);
    return chat.filter(m => m.mes !== undefined).map(m => m.mes);
}

describe('the group a group chat route acts on', () => {
    test('with no group id, the group whose chat the id names; a bare label names none', async () => {
        const ids = await seedGroups({ 'grp-a': ['chat-1', 'chat-2'], 'grp-b': ['chat-3'] });
        expect(await messagesOf({ id: ids['grp-b/chat-3'] })).toEqual(['grp-b/chat-3']);
        expect(await messagesOf({ id: ids['grp-a/chat-2'] })).toEqual(['grp-a/chat-2']);
        expect(await messagesOf({ id: 'chat-3' })).toEqual([]);
    });

    test('a chat no group has is no group\'s: an empty chat, nothing guessed', async () => {
        await seedGroups({ 'grp-a': ['chat-1'] });
        expect(await messagesOf({ id: 'chat-orphan' })).toEqual([]);
        expect((await post('/api/chats/group/save', { id: 'chat-orphan', chat: [{ chat_metadata: {} }] })).status).toBe(400);
    });

    test('a group id names the group: no other group is looked in', async () => {
        await seedGroups({ 'grp-a': ['chat-a'], 'grp-b': ['chat-b'] });
        expect(await messagesOf({ id: 'chat-b', group_id: 'grp-b' })).toEqual(['grp-b/chat-b']);
        expect(await messagesOf({ id: 'chat-a', group_id: 'grp-b' })).toEqual([]);
    });

    test('a label may repeat across groups: each chat is named by its id, or by its label with its group', async () => {
        const ids = await seedGroups({ 'grp-a': ['shared'], 'grp-b': [] });
        const saved = await post('/api/chats/group/save', { id: 'shared', group_id: 'grp-b', chat: [{ chat_metadata: {} }, { name: 'Rex', is_user: false, mes: 'b', send_date: 'x', extra: {} }] });
        expect(saved.status).toBe(200);
        expect(saved.body.chat_id).toMatch(/^b\d+$/);
        expect(saved.body.chat_id).not.toBe(ids['grp-a/shared']);
        expect(await messagesOf({ id: ids['grp-a/shared'] })).toEqual(['grp-a/shared']);
        expect(await messagesOf({ id: saved.body.chat_id })).toEqual(['b']);
        expect(await messagesOf({ id: 'shared', group_id: 'grp-a' })).toEqual(['grp-a/shared']);
        expect(await messagesOf({ id: 'shared', group_id: 'grp-b' })).toEqual(['b']);
    });

    test('a group id that names no group is not found, even when a group has a chat of that name', async () => {
        const ids = await seedGroups({ 'grp-a': ['chat-1'] });
        expect(await messagesOf({ id: 'chat-1', group_id: 'grp-gone' })).toEqual([]);
        const saved = await post('/api/chats/group/save', { id: 'chat-1', group_id: 'grp-gone', chat: [{ chat_metadata: {} }, { name: 'Rex', is_user: false, mes: 'x', send_date: 'x', extra: {} }] });
        expect(saved.status).toBe(400);
        expect(await messagesOf({ id: ids['grp-a/chat-1'] })).toEqual(['grp-a/chat-1']);
    });

    test('a group id is accepted for a chat it doesn\'t have yet: the first save of a new chat', async () => {
        await seedGroups({ 'grp-a': [] });
        const saved = await post('/api/chats/group/save', { id: 'brand-new-chat', group_id: 'grp-a', chat: [{ chat_metadata: {} }, { name: 'Rex', is_user: false, mes: 'first', send_date: 'x', extra: {} }] });
        expect(saved.status).toBe(200);
        expect(await messagesOf({ id: 'brand-new-chat', group_id: 'grp-a' })).toEqual(['first']);
    });
});
