import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

const { router: chatsRouter } = await import('./chats.js');
const { router: charactersRouter } = await import('./characters.js');
const { router: groupsRouter } = await import('./groups.js');
const { newSessionKey, chatNameAt, sessionTime } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, writeLibraryCard, sessionPath, treeOf, namedChat } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chats-delete-new-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.user = { directories, profile: { handle: 'u' } };
    next();
});
app.use('/api/chats', chatsRouter);
app.use('/api/characters', charactersRouter);
app.use('/api/groups', groupsRouter);

/** @returns {Promise<{status: number, data: any}>} */
async function postJson(urlPath, body, headers = {}) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
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
    await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
}

/**
 * @param {string} avatar
 * @returns {Promise<{ Old: string, Newer: string }>}
 */
async function twoChats(avatar) {
    /** @type {any} */
    const tabs = {};
    for (const [name, mes] of [['Old', 'A.'], ['Newer', 'B.']]) {
        tabs[name] = newSessionKey();
        await namedChat(user.store, { avatar }, name, [{ name: 'Ida', is_user: false, mes, send_date: 'x', extra: {} }], { session: tabs[name] });
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    return tabs;
}

const ownId = (/** @type {string | null} */ character, /** @type {string} */ tab) => chatNameAt({ group: character === null, name: character ?? '' }, /** @type {number} */ (sessionTime(tab)));

const activeOf = async (avatar, tab) => (await postJson('/api/characters/get', { avatar_url: avatar }, { [SESSION_HEADER]: tab })).data.chat ?? null;

async function chatNames(owner, tab) {
    const rows = [];
    for (let after; ;) {
        const page = await user.store.chats.chatList({ tree: await treeOf(user.store, owner), session: tab, after, limit: 500 });
        rows.push(...page.rows);
        if (!page.more || page.rows.length === 0) break;
        after = page.rows[page.rows.length - 1].position;
    }
    return rows.map(r => String(r.name ?? r.session ?? r.bookmark));
}

test('deleting the current chat (the tab\'s session) lands the tab where the user last was, and can open it', async () => {
    const avatar = 'ida.png';
    await writeCharacter(avatar, 'Ida');
    const tabs = await twoChats(avatar);
    assert.equal(await activeOf(avatar, tabs.Old), ownId('Ida', tabs.Old));

    const { status, data } = await postJson('/api/chats/delete', { avatar_url: avatar, chatfile: `${ownId('Ida', tabs.Old)}.jsonl`, open: true }, { [SESSION_HEADER]: tabs.Old });
    assert.equal(status, 200);
    assert.deepEqual(data.opened.messages.map(m => m.mes), ['B.']);
    assert.deepEqual(await user.store.chats.store.chatRead('keyStates', { space: 1, keys: [tabs.Old] }), ['gone']);
});

test('deleting the bookmark the tab is at deletes only the bookmark: the tab stays where it is', async () => {
    const avatar = 'jo.png';
    await writeCharacter(avatar, 'Jo');
    const tabs = await twoChats(avatar);
    const { status, data } = await postJson('/api/chats/delete', { avatar_url: avatar, chatfile: 'Old.jsonl' }, { [SESSION_HEADER]: tabs.Old });
    assert.equal(status, 200);
    assert.equal(data.activeChat, undefined);
    assert.equal(await activeOf(avatar, tabs.Old), ownId('Jo', tabs.Old));
    assert.deepEqual((await sessionPath(user.store, { avatar }, tabs.Old)).map(m => m.mes), ['A.']);
    assert.ok(!(await chatNames({ avatar }, tabs.Old)).includes('Old'));
});

test('deleting another chat leaves the current one', async () => {
    const avatar = 'kai.png';
    await writeCharacter(avatar, 'Kai');
    const tabs = await twoChats(avatar);
    const { data } = await postJson('/api/chats/delete', { avatar_url: avatar, chatfile: 'Old.jsonl' }, { [SESSION_HEADER]: tabs.Newer });
    assert.equal(data.activeChat, undefined);
    assert.equal(await activeOf(avatar, tabs.Newer), ownId('Kai', tabs.Newer));
});

test('a new character chat moves the tab\'s session and deletes the one it replaces, in one request', async () => {
    const avatar = 'lea.png';
    await writeCharacter(avatar, 'Lea');
    const tabs = await twoChats(avatar);
    const { status, data } = await postJson('/api/chats/new', { avatar_url: avatar, chat: '', replace: 'Newer' }, { [SESSION_HEADER]: tabs.Newer });
    assert.equal(status, 200);
    assert.deepEqual(data.deleted, ['Newer']);
    assert.match(data.chat, /^Lea - \d{4}-/);
    assert.notEqual(data.chat, ownId('Lea', tabs.Newer));
    assert.equal(await activeOf(avatar, tabs.Newer), data.chat);
    assert.deepEqual(await sessionPath(user.store, { avatar }, tabs.Newer), []);
    assert.deepEqual(await chatNames({ avatar }, tabs.Newer), [tabs.Newer, 'Old']);
});

test('a new group chat is made current and opened, and the replaced one is deleted', async () => {
    const groupId = String(Date.now());
    await user.store.lib.writeGroup({ id: groupId, name: 'Crew', members: [] });
    const tab = newSessionKey();
    await postJson('/api/chats/group/save', {
        id: 'Crew chat', group_id: groupId, chat: [{ chat_metadata: {} }, { name: 'Rex', is_user: false, mes: 'Ahoy.', send_date: 'x', extra: {} }],
    }, { [SESSION_HEADER]: tab });
    const { status, data } = await postJson('/api/chats/new', { group_id: groupId, replace: 'Crew chat' }, { [SESSION_HEADER]: tab });
    assert.equal(status, 200);
    assert.deepEqual(data.chats, [data.chat_id]);
    assert.equal(data.opened.chat, data.chat_id);
    assert.deepEqual(data.opened.messages, []);
    const group = (await postJson('/api/groups/batch', { ids: [groupId] }, { [SESSION_HEADER]: tab })).data;
    assert.equal(group[0].chat_id, data.chat_id);
});

test('deleting the bookmark a group\'s tab is at leaves the tab there, listed as its session', async () => {
    const groupId = String(Date.now() + 1);
    await user.store.lib.writeGroup({ id: groupId, name: 'Duo', members: [] });
    /** @type {Record<string, string>} */
    const tabs = {};
    /** @type {Record<string, string>} */
    const ids = {};
    for (const id of ['a', 'b']) {
        tabs[id] = newSessionKey();
        ids[id] = (await postJson('/api/chats/group/save', {
            id, group_id: groupId, chat: [{ chat_metadata: {} }, { name: 'Rex', is_user: false, mes: id, send_date: 'x', extra: {} }],
        }, { [SESSION_HEADER]: tabs[id] })).data.chat_id;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    const { status, data } = await postJson('/api/chats/group/delete', { id: 'b', group_id: groupId }, { [SESSION_HEADER]: tabs.b });
    assert.equal(status, 200);
    assert.equal(ids.a, 'a');
    const own = ownId(null, tabs.b);
    assert.deepEqual({ chats: data.chats, chat_id: data.chat_id }, { chats: [own, ids.a], chat_id: own });
});

test('deleting characters with their chats names the chats deleted', async () => {
    const avatar = 'max.png';
    await writeCharacter(avatar, 'Max');
    await twoChats(avatar);
    const { status, data } = await postJson('/api/characters/delete', { avatar_urls: [avatar], delete_chats: true });
    assert.equal(status, 200);
    assert.deepEqual(data.results[0].chats.sort(), ['Newer', 'Old']);
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
