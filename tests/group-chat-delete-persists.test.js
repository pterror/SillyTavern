import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

// Deleting a group chat must take its id out of the group file's `chats`: the client never saves that list after a
// delete, and /api/groups/new-chat appends to whatever list is on disk.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** The tab (session) the requests of a test come from. */
let tab = '';
/** @type {import('node:http').Server} */
let server;
let baseUrl;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    fixture = await import('./converted-user.fixture.js');
    const { router: groupsRouter } = await import('../src/endpoints/groups.js');
    const { router: chatsRouter } = await import('../src/endpoints/chats.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/groups', groupsRouter);
    app.use('/api/chats', chatsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-group-chat-delete-test-');
    globalThis.DATA_ROOT = user.dataRoot;
    tab = (await import('../src/chat-engine.js')).newSessionKey();
});

afterEach(() => user.close());

/**
 * A request from a tab, which takes the session the answer hands it, and makes a new one when told its own is gone,
 * as the page does.
 * @param {string} urlPath
 * @param {object} body
 * @param {{ tab: string }} [from] The tab; the test's own by default.
 */
async function post(urlPath, body, from = undefined) {
    const sender = from ?? { get tab() { return tab; }, set tab(value) { tab = value; } };
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ST-Session': sender.tab },
        body: JSON.stringify(body),
    });
    const moved = response.headers.get('X-ST-Session-Moved');
    if (moved) sender.tab = moved;
    else if (response.headers.get('X-ST-Session-Gone')) sender.tab = (await import('../src/chat-engine.js')).newSessionKey();
    const text = await response.text();
    const isJson = response.headers.get('content-type')?.includes('application/json');
    return { status: response.status, body: isJson ? JSON.parse(text) : text };
}

async function postOk(urlPath, body, from = undefined) {
    const result = await post(urlPath, body, from);
    expect(result.status).toBe(200);
    return result.body;
}

/** A second tab, its own session. */
async function otherTab() {
    return { tab: (await import('../src/chat-engine.js')).newSessionKey() };
}

/** The group as the tab sees it (its chat list and current chat). @param {string} id */
async function readGroupFile(id) {
    return (await postOk('/api/groups/batch', { ids: [id] }))[0];
}

/** A group whose only chat is the one /create minted, with one message saved to it. */
async function createGroupWithChat() {
    const created = await postOk('/api/groups/create', { name: 'Group', members: ['a.png'] });
    await saveChat(created.id, created.chat_id);
    return created;
}

/**
 * @param {string} groupId @param {string} chatId @param {{ tab: string }} [from]
 * @returns {Promise<string>} The compat id of the chat saved.
 */
async function saveChat(groupId, chatId, from = undefined) {
    return (await postOk('/api/chats/group/save', {
        id: chatId,
        group_id: groupId,
        chat: [
            { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
            { name: 'User', is_user: true, is_system: false, mes: `hi from ${chatId}`, send_date: 'x', extra: {} },
        ],
    }, from)).chat_id;
}

/** The request deleteGroupChat() / deleteGroupChatByName() make. @param {string} groupId @param {string} chatId */
function deleteChat(groupId, chatId) {
    return post('/api/chats/group/delete', { id: chatId, group_id: groupId });
}

// The group's chat list is its bookmarks, newest first, and the tab's own session when no bookmark is where it is; a
// tab's current chat (`chat_id`) is a bookmark's `b<id>`, else its own conversation's `s<UUID>.<tree>`.
describe('/api/chats/group/delete removes the id from the group\'s chats', () => {
    test('deleting the tab\'s own chat (its session), then new-chat: the id is gone from the list and the answer', async () => {
        const group = await createGroupWithChat();
        const deletedId = group.chat_id;
        // The save named the tab's own session: it saved onto it and made no bookmark.
        expect((await readGroupFile(group.id)).chats).toEqual([deletedId]);

        expect((await deleteChat(group.id, deletedId)).status).toBe(200);
        expect(tab).not.toBe(deletedId);
        expect((await readGroupFile(group.id)).chats).not.toContain(deletedId);

        // No chats left, so the client asks for a new one (createNewGroupChat()).
        const newChat = await postOk('/api/groups/new-chat', { id: group.id });
        // No current chat: the tab's own conversation in the group's tree, `s<UUID>.<tree>`.
        expect(newChat.chat_id.startsWith(`s${tab}.`)).toBe(true);
        expect(newChat.chats).toEqual([newChat.chat_id]);
        expect((await readGroupFile(group.id)).chats).toEqual([newChat.chat_id]);
        expect((await readGroupFile(group.id)).chat_id).toBe(newChat.chat_id);
    });

    test('deleting a chat that is not the current one keeps every other chat', async () => {
        const group = await createGroupWithChat();
        const other = await saveChat(group.id, 'Other chat', await otherTab());
        expect((await readGroupFile(group.id)).chats).toEqual([other, group.chat_id]);

        expect((await deleteChat(group.id, other)).status).toBe(200);
        expect((await readGroupFile(group.id))).toMatchObject({ chats: [group.chat_id], chat_id: group.chat_id });

        // A new chat is the tab's session at the group's root: the same id, listed once.
        const newChat = await postOk('/api/groups/new-chat', { id: group.id });
        expect(newChat).toEqual({ chat_id: group.chat_id, chats: [group.chat_id] });
        expect((await readGroupFile(group.id)).chats).toEqual([group.chat_id]);
    });

    test('deleting the bookmark the tab is at leaves the tab there, listed as its session', async () => {
        const group = await createGroupWithChat();
        const current = 'Current chat';
        await saveChat(group.id, current, await otherTab());
        await postOk('/api/groups/save-partial', { id: group.id, props: { chat_id: current } });

        expect((await deleteChat(group.id, current)).status).toBe(200);
        expect((await readGroupFile(group.id)).chats).toEqual([group.chat_id]);

        // openGroupChat() on the remaining chat saves only these two fields.
        await postOk('/api/groups/save-partial', { id: group.id, props: { chat_id: group.chat_id, date_last_chat: Date.now() } });
        expect((await readGroupFile(group.id))).toMatchObject({ chats: [group.chat_id], chat_id: group.chat_id });
    });

    test('a delete racing group saves and a new-chat loses neither side', async () => {
        const group = await createGroupWithChat();
        const other = 'Other chat';
        await saveChat(group.id, other, await otherTab());

        const [deleted, partial, newChat] = await Promise.all([
            deleteChat(group.id, other),
            post('/api/groups/save-partial', { id: group.id, props: { fav: true } }),
            post('/api/groups/new-chat', { id: group.id }),
        ]);
        expect([deleted.status, partial.status, newChat.status]).toEqual([200, 200, 200]);

        const file = (await readGroupFile(group.id));
        expect(file.fav).toBe(true);
        expect(file.chats).toEqual([group.chat_id]);
        expect(newChat.body.chat_id).toBe(group.chat_id);
    });

    test('a bookmark with no saved messages is removed from the list, and new-chat does not bring it back', async () => {
        const group = await createGroupWithChat();
        // A bookmark at the group's root.
        const empty = 'Empty chat';
        const tree = await fixture.treeOf(user.store, { group: group.id });
        const made = await user.store.chats.createBookmark({ tree, node_id: null, name: empty, actor: { user: user.user.profile.handle, session: (await otherTab()).tab } });
        expect(made).toMatchObject({ ok: true, name: empty });
        const emptyId = `b${made.bookmark}`;
        expect((await readGroupFile(group.id)).chats).toContain(emptyId);

        const result = await deleteChat(group.id, emptyId);
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ ok: true, chats: [group.chat_id], chat_id: group.chat_id });
        expect((await readGroupFile(group.id)).chats).toEqual([group.chat_id]);

        const newChat = await postOk('/api/groups/new-chat', { id: group.id });
        expect(newChat.chats).not.toContain(emptyId);
        expect((await readGroupFile(group.id)).chats).toEqual([group.chat_id]);
    });

    test('deleting an id the group does not have leaves the group file untouched', async () => {
        const group = await createGroupWithChat();
        const before = JSON.stringify(await readGroupFile(group.id));
        const changesBefore = await user.store.lib.changesEnd();

        const result = await deleteChat(group.id, 'No such chat');
        expect(result.status).toBe(400);
        expect(JSON.stringify(await readGroupFile(group.id))).toBe(before);
        expect(await user.store.lib.changesEnd()).toBe(changesBefore);
    });
});
