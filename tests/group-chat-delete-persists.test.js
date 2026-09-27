import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Deleting a group chat must take its id out of the group file's `chats`: the client never saves that list after a
// delete, and /api/groups/new-chat appends to whatever list is on disk.

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/message-tree-db.js')} */
let treeDb;
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
    treeDb = await import('../src/message-tree-db.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    const { router: groupsRouter } = await import('../src/endpoints/groups.js');
    const { router: chatsRouter } = await import('../src/endpoints/chats.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/groups', groupsRouter);
    app.use('/api/chats', chatsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-group-chat-delete-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
        backups: path.join(tempDir, 'backups'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.backups]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(async () => {
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    treeDb.disposeMessageTreeStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

async function post(urlPath, body) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    const isJson = response.headers.get('content-type')?.includes('application/json');
    return { status: response.status, body: isJson ? JSON.parse(text) : text };
}

async function postOk(urlPath, body) {
    const result = await post(urlPath, body);
    expect(result.status).toBe(200);
    return result.body;
}

/** @param {string} id */
function readGroupFile(id) {
    return JSON.parse(fs.readFileSync(path.join(directories.groups, `${id}.json`), 'utf8'));
}

/** A group whose only chat is the one /create minted, with one message saved to it. */
async function createGroupWithChat() {
    const created = await postOk('/api/groups/create', { name: 'Group', members: ['a.png'] });
    await saveChat(created.id, created.chat_id);
    return created;
}

/** @param {string} groupId @param {string} chatId */
async function saveChat(groupId, chatId) {
    await postOk('/api/chats/group/save', {
        id: chatId,
        group_id: groupId,
        chat: [
            { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
            { name: 'User', is_user: true, is_system: false, mes: `hi from ${chatId}`, send_date: 'x', extra: {} },
        ],
    });
}

/** The request deleteGroupChat() / deleteGroupChatByName() make. @param {string} groupId @param {string} chatId */
function deleteChat(groupId, chatId) {
    return post('/api/chats/group/delete', { id: chatId, group_id: groupId });
}

describe('/api/chats/group/delete removes the id from the group file', () => {
    test('past-chats delete of the last chat, then new-chat: the id is gone from the file and the response', async () => {
        const group = await createGroupWithChat();
        const deletedId = group.chat_id;

        expect((await deleteChat(group.id, deletedId)).status).toBe(200);
        expect(readGroupFile(group.id).chats).not.toContain(deletedId);

        // No chats left, so the client asks for a new one (createNewGroupChat()).
        const newChat = await postOk('/api/groups/new-chat', { id: group.id });
        expect(newChat.chats).toEqual([newChat.chat_id]);
        expect(readGroupFile(group.id).chats).toEqual([newChat.chat_id]);
        expect(readGroupFile(group.id).chat_id).toBe(newChat.chat_id);
    });

    test('past-chats delete of a chat that is not the current one keeps every other chat', async () => {
        const group = await createGroupWithChat();
        const other = 'Other chat';
        await saveChat(group.id, other);
        expect(readGroupFile(group.id).chats).toEqual([group.chat_id, other]);

        expect((await deleteChat(group.id, other)).status).toBe(200);
        expect(readGroupFile(group.id)).toMatchObject({ chats: [group.chat_id], chat_id: group.chat_id });

        const newChat = await postOk('/api/groups/new-chat', { id: group.id });
        expect(newChat.chats).toEqual([group.chat_id, newChat.chat_id]);
        expect(readGroupFile(group.id).chats).toEqual([group.chat_id, newChat.chat_id]);
    });

    test('delete of the current chat, then opening the remaining one leaves the id out', async () => {
        const group = await createGroupWithChat();
        const current = 'Current chat';
        await saveChat(group.id, current);
        await postOk('/api/groups/save-partial', { id: group.id, props: { chat_id: current } });

        expect((await deleteChat(group.id, current)).status).toBe(200);
        expect(readGroupFile(group.id).chats).toEqual([group.chat_id]);

        // openGroupChat() on the remaining chat saves only these two fields.
        await postOk('/api/groups/save-partial', { id: group.id, props: { chat_id: group.chat_id, date_last_chat: Date.now() } });
        expect(readGroupFile(group.id)).toMatchObject({ chats: [group.chat_id], chat_id: group.chat_id });
    });

    test('a delete racing group saves and a new-chat loses neither side', async () => {
        const group = await createGroupWithChat();
        const other = 'Other chat';
        await saveChat(group.id, other);

        const [deleted, partial, newChat] = await Promise.all([
            deleteChat(group.id, other),
            post('/api/groups/save-partial', { id: group.id, props: { fav: true } }),
            post('/api/groups/new-chat', { id: group.id }),
        ]);
        expect([deleted.status, partial.status, newChat.status]).toEqual([200, 200, 200]);

        const file = readGroupFile(group.id);
        expect(file.fav).toBe(true);
        expect(file.chats).toEqual([group.chat_id, newChat.body.chat_id]);
    });

    test('deleting an id the group does not have leaves the group file untouched', async () => {
        const group = await createGroupWithChat();
        const filePath = path.join(directories.groups, `${group.id}.json`);
        const before = fs.readFileSync(filePath, 'utf8');
        const mtimeBefore = fs.statSync(filePath).mtimeMs;

        const result = await deleteChat(group.id, 'No such chat');
        expect(result.status).toBe(400);
        expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
        expect(fs.statSync(filePath).mtimeMs).toBe(mtimeBefore);
    });
});
