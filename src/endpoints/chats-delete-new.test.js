import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// chats.js's import chain reads process-wide config at import time, so the config path is set first.
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Deleting a chat moves its character to the most recently active remaining one when it was the current one, and
// starting a new chat moves the character (or makes the group's new chat) and deletes the replaced one, in one request.
const { router: chatsRouter } = await import('./chats.js');
const { router: charactersRouter } = await import('./characters.js');
const { loadBranch, listBranches } = await import('../message-tree-db.js');
const { upsertCharacterFromWrite, getCharacterActiveChatsByIds, setCharacterActiveChat } = await import('../character-metadata-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chats-delete-new-test-'));
const directories = { root };
for (const dir of ['chats', 'groupChats', 'groups', 'backups', 'characters', 'thumbnailsAvatar']) {
    directories[dir] = path.join(root, dir);
    fs.mkdirSync(directories[dir], { recursive: true });
}
globalThis.DATA_ROOT = root;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.user = { directories, profile: { handle: 'tester' } };
    next();
});
app.use('/api/chats', chatsRouter);
app.use('/api/characters', charactersRouter);

/** @returns {Promise<{status: number, data: any}>} */
async function postJson(urlPath, body) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: res.status, data: await res.json().catch(() => ({})) };
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));

async function writeCharacter(avatar, name) {
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0', name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', avatar,
        data: { name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '', alternate_greetings: [], extensions: {} },
    };
    const cardJson = JSON.stringify(card);
    fs.writeFileSync(path.join(directories.characters, avatar), writeCard(baseImage, cardJson));
    await upsertCharacterFromWrite(directories, avatar, cardJson);
}

/** Two chats of a character, "Old" and "Newer" (spoken in later). */
async function twoChats(avatar) {
    for (const [name, mes] of [['Old', 'A.'], ['Newer', 'B.']]) {
        await postJson('/api/chats/save', {
            avatar_url: avatar, file_name: name,
            chat: [{ chat_metadata: {} }, { name: 'Ida', is_user: false, mes, send_date: 'x', extra: {} }],
        });
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

const activeOf = async avatar => (await getCharacterActiveChatsByIds(directories, [avatar]))[avatar] ?? null;

test('deleting the current chat moves the character to its most recent remaining chat, and can open it', async () => {
    const avatar = 'ida.png';
    await writeCharacter(avatar, 'Ida');
    await twoChats(avatar);
    await setCharacterActiveChat(directories, avatar, 'Old');

    const { status, data } = await postJson('/api/chats/delete', { avatar_url: avatar, chatfile: 'Old.jsonl', open: true });
    assert.equal(status, 200);
    assert.equal(data.activeChat, (await listBranches(directories, 'ida')).find(b => b.name === 'Newer').id);
    assert.equal(await activeOf(avatar), data.activeChat);
    assert.deepEqual(data.opened.messages.map(m => m.mes), ['B.']);
});

test('the current chat named by the message it is at counts as current too', async () => {
    const avatar = 'jo.png';
    await writeCharacter(avatar, 'Jo');
    await twoChats(avatar);
    const old = (await loadBranch(directories, 'jo', 'Old')).messages[0].node_id;
    await setCharacterActiveChat(directories, avatar, old);
    const { data } = await postJson('/api/chats/delete', { avatar_url: avatar, chatfile: 'Old.jsonl' });
    assert.notEqual(await activeOf(avatar), old);
    assert.equal(typeof data.activeChat, 'string');
});

test('deleting another chat leaves the current one', async () => {
    const avatar = 'kai.png';
    await writeCharacter(avatar, 'Kai');
    await twoChats(avatar);
    await setCharacterActiveChat(directories, avatar, 'Newer');
    const { data } = await postJson('/api/chats/delete', { avatar_url: avatar, chatfile: 'Old.jsonl' });
    assert.equal(data.activeChat, undefined);
    assert.equal(await activeOf(avatar), 'Newer');
});

test('a new character chat moves the character and deletes the one it replaces, in one request', async () => {
    const avatar = 'lea.png';
    await writeCharacter(avatar, 'Lea');
    await twoChats(avatar);
    await setCharacterActiveChat(directories, avatar, 'Newer');
    const { status, data } = await postJson('/api/chats/new', { avatar_url: avatar, chat: '', replace: 'Newer' });
    assert.equal(status, 200);
    assert.deepEqual(data.deleted, ['Newer']);
    assert.equal(await activeOf(avatar), null);
    assert.deepEqual((await listBranches(directories, 'lea')).map(b => b.name), ['Old']);
});

test('a new group chat is made current and opened, and the replaced one is deleted', async () => {
    const groupId = String(Date.now());
    fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify({ id: groupId, name: 'Crew', members: [], chat_id: 'Crew chat', chats: ['Crew chat'] }));
    const { status, data } = await postJson('/api/chats/new', { group_id: groupId, replace: 'Crew chat' });
    assert.equal(status, 200);
    assert.deepEqual(data.chats, [data.chat_id]);
    assert.equal(data.opened.chat, data.chat_id);
    assert.deepEqual(data.opened.messages, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directories.groups, `${groupId}.json`), 'utf8')).chat_id, data.chat_id);
});

test('deleting a group\'s current chat moves the group to its last remaining one', async () => {
    const groupId = String(Date.now() + 1);
    fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify({ id: groupId, name: 'Duo', members: [], chat_id: 'b', chats: ['a', 'b'] }));
    const { status, data } = await postJson('/api/chats/group/delete', { id: 'b', group_id: groupId });
    assert.equal(status, 200);
    assert.deepEqual({ chats: data.chats, chat_id: data.chat_id }, { chats: ['a'], chat_id: 'a' });
});

test('deleting characters with their chats names the chats deleted', async () => {
    const avatar = 'max.png';
    await writeCharacter(avatar, 'Max');
    await twoChats(avatar);
    const { status, data } = await postJson('/api/characters/delete', { avatar_urls: [avatar], delete_chats: true });
    assert.equal(status, 200);
    assert.deepEqual(data.results[0].chats.sort(), ['Newer', 'Old']);
});

// Opening a chat records it in the settings, whose throttled autosave timer would hold the process open.
after(() => setImmediate(() => process.exit(0)));
