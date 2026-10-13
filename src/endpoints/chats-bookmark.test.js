import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// chats.js's import chain reads process-wide config at import time, so the config path is set first.
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// A bookmark is one request: the message is named (stored first when it's a greeting with no row), it carries the
// chat's metadata, a group lists it among its chats, and a branch or fork is opened in the same answer.
const { router: chatsRouter } = await import('./chats.js');
const { newSessionKey } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, writeLibraryCard, sessionPath, treeOf } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chats-bookmark-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.user = { directories, profile: { handle: 'u' } };
    next();
});
app.use('/api/chats', chatsRouter);

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
 * A tree's bookmark labelled `name` (or with that compat id, `b<id>`), with the message it is at and the state there;
 * undefined when it has none.
 * @param {{ avatar?: string, group?: string }} owner
 * @param {string} name
 */
async function bookmarkNamed(owner, name) {
    const tree = await treeOf(user.store, owner);
    /** @type {string | undefined} */
    let after;
    for (;;) {
        const page = await user.store.chats.bookmarks({ tree, after, limit: 500 });
        const found = page.rows.find(b => b.name === name || `b${b.id}` === name);
        if (found) return { ...found, metadata: (await user.store.chats.load({ tree, at: found.at }))?.metadata ?? {} };
        if (!page.more) return undefined;
        after = page.rows[page.rows.length - 1].id;
    }
}

/** The bookmark of the tree at a message, with the state there; undefined when none is. */
async function bookmarkAt(owner, nodeId, name) {
    const found = await bookmarkNamed(owner, name);
    return found?.at === nodeId ? found : undefined;
}

/** A character's chat named `name`, with metadata on its first message. */
async function chatWith(avatar, name) {
    const tab = newSessionKey();
    await postJson('/api/chats/save', {
        avatar_url: avatar, file_name: name,
        chat: [
            { chat_metadata: { note_prompt: 'Keep it short.' } },
            { name: 'Dee', is_user: false, mes: 'One.', send_date: 'x', extra: {} },
            { name: 'User', is_user: true, mes: 'Two.', send_date: 'x', extra: {} },
            { name: 'Dee', is_user: false, mes: 'Three.', send_date: 'x', extra: {} },
        ],
    }, { [SESSION_HEADER]: tab });
    return Object.assign(await sessionPath(user.store, { avatar }, tab), { tab });
}

test('a bookmark names the message and carries the chat\'s metadata', async () => {
    const avatar = 'dee.png';
    await writeCharacter(avatar, 'Dee');
    const messages = await chatWith(avatar, 'Main');
    const { status, data } = await postJson('/api/chats/bookmark', {
        avatar_url: avatar, node_id: messages[2].node_id, label: 'Before the storm', from: 'Main',
    });
    assert.equal(status, 200);
    assert.equal(data.label, 'Before the storm');
    const bookmark = await bookmarkAt({ avatar }, messages[2].node_id, 'Before the storm');
    assert.ok(bookmark, 'the bookmark is at the message');
    assert.equal(bookmark.metadata.note_prompt, 'Keep it short.');
});

test('a branch gets a free name and is opened in the same answer; a fork at an alternative names the shown message too', async () => {
    const avatar = 'eve.png';
    await writeCharacter(avatar, 'Eve');
    const messages = await chatWith(avatar, 'Story');
    const first = await postJson('/api/chats/bookmark', {
        avatar_url: avatar, node_id: messages[1].node_id, label: 'Story', unique: true, from: 'Story', open: true,
    }, { [SESSION_HEADER]: messages.tab });
    assert.equal(first.status, 200);
    // Always a new bookmark, labelled as asked (labels may repeat).
    assert.equal(first.data.label, 'Story');
    assert.match(first.data.id, /^b\d+$/);
    assert.ok(await bookmarkAt({ avatar }, messages[1].node_id, first.data.id));
    // The tab's session moves there, and the branch is its current chat.
    assert.equal(first.data.opened.chat, first.data.id);
    assert.equal(first.data.opened.label_base, 'Story');
    // Root down to the bookmarked message, nothing below it.
    assert.deepEqual(first.data.opened.messages.map(m => m.mes), ['One.', 'Two.']);
    // The state there: the save set the note at its last message, below this one.
    assert.equal(first.data.opened.chat_metadata.note_prompt, undefined);

    const forked = await postJson('/api/chats/bookmark', {
        avatar_url: avatar, node_id: messages[2].node_id, label: 'Story', unique: true, from: 'Story', also_node_id: messages[0].node_id,
    }, { [SESSION_HEADER]: messages.tab });
    assert.equal(forked.data.label, 'Story');
    assert.notEqual(forked.data.id, first.data.id);
    // `also_node_id` is accepted and ignored: one bookmark, at `node_id`.
    assert.equal((await bookmarkAt({ avatar }, messages[2].node_id, forked.data.id))?.name, 'Story');
});

test('a branch with no label is named from what the user sees, never an id: the current chat\'s label, the session\'s, else the character\'s name', async () => {
    const avatar = 'eli.png';
    await writeCharacter(avatar, 'Eli');
    const messages = await chatWith(avatar, 'Saga');
    const headers = { [SESSION_HEADER]: messages.tab };
    // No current chat, an unnamed session: the character's name.
    const first = await postJson('/api/chats/bookmark', { avatar_url: avatar, node_id: messages[1].node_id, open: true }, headers);
    assert.equal(first.status, 200);
    assert.equal(first.data.label, 'Eli - Branch #1');
    assert.equal(first.data.opened.label_base, 'Eli - Branch #1');
    // The branch is now the current chat: its label, its suffix replaced by the next free one.
    const second = await postJson('/api/chats/bookmark', { avatar_url: avatar, node_id: messages[2].node_id }, headers);
    assert.equal(second.data.label, 'Eli - Branch #2');
    // A new chat (none current) in a named session: the session's label.
    await postJson('/api/chats/new', { avatar_url: avatar, chat: '' }, headers);
    await user.store.chats.nameSession({ session: messages.tab, name: 'My tab', actor: { user: 'u', session: messages.tab } });
    const third = await postJson('/api/chats/bookmark', { avatar_url: avatar, node_id: messages[0].node_id }, headers);
    assert.equal(third.data.label, 'My tab - Branch #1');
    for (const label of [first.data.label, second.data.label, third.data.label]) assert.doesNotMatch(label, /[0-9a-f]{8}-[0-9a-f]{4}-/);
});

test('a message that already carries metadata keeps its own', async () => {
    const avatar = 'fay.png';
    await writeCharacter(avatar, 'Fay');
    const messages = await chatWith(avatar, 'Main');
    await postJson('/api/chats/bookmark', { avatar_url: avatar, node_id: messages[2].node_id, label: 'Mine', from: 'Main' });
    // The tab goes to the message and changes the chat's state there.
    await user.store.chats.goTo({ tree: await treeOf(user.store, { avatar }), node_id: messages[2].node_id, actor: { user: 'u', session: messages.tab } });
    await postJson('/api/chats/metadata', { avatar_url: avatar, set: { note_prompt: 'Its own.' } }, { [SESSION_HEADER]: messages.tab });
    await postJson('/api/chats/bookmark', { avatar_url: avatar, node_id: messages[2].node_id, label: 'Renamed', from: 'Main' });
    assert.equal((await bookmarkAt({ avatar }, messages[2].node_id, 'Renamed'))?.metadata.note_prompt, 'Its own.');
});

test('a group\'s bookmark is among its chats', async () => {
    const groupId = String(Date.now());
    await user.store.lib.writeGroup({ id: groupId, name: 'Crew', members: [] });
    const tab = newSessionKey();
    await postJson('/api/chats/group/save', {
        id: 'Crew chat', group_id: groupId,
        chat: [{ chat_metadata: { note_prompt: 'Aye.' } }, { name: 'Rex', is_user: false, mes: 'Ahoy.', send_date: 'x', extra: {} }],
    }, { [SESSION_HEADER]: tab });
    const node = (await sessionPath(user.store, { group: groupId }, tab))[0].node_id;
    const { status, data } = await postJson('/api/chats/bookmark', { group_id: groupId, node_id: node, label: 'Crew chat', unique: true, from: 'Crew chat' }, { [SESSION_HEADER]: tab });
    assert.equal(status, 200);
    assert.equal(data.label, 'Crew chat');
    assert.match(data.id, /^b\d+$/);
    assert.ok(data.chats.includes(data.id));
});

test('a chat is named by its compat id; a label only while one chat has it; a message id names nothing', async () => {
    const avatar = 'hal.png';
    await writeCharacter(avatar, 'Hal');
    const messages = await chatWith(avatar, 'Main');
    const get = name => postJson('/api/chats/get', { avatar_url: avatar, file_name: `${name}.jsonl` });
    const one = (await postJson('/api/chats/bookmark', { avatar_url: avatar, node_id: messages[1].node_id, label: 'Twice' })).data;
    const two = (await postJson('/api/chats/bookmark', { avatar_url: avatar, node_id: messages[2].node_id, label: 'Twice' })).data;
    assert.deepEqual([one.label, two.label], ['Twice', 'Twice']);
    assert.notEqual(one.id, two.id);
    assert.deepEqual((await get(one.id)).data.slice(1).map(m => m.mes), ['One.', 'Two.']);
    assert.deepEqual((await get(two.id)).data.slice(1).map(m => m.mes), ['One.', 'Two.', 'Three.']);
    // A label two chats have is the route's miss; so is a message's id, or a bookmark's number without its `b`.
    assert.equal((await get('Twice')).status, 404);
    assert.equal((await get(messages[1].node_id)).status, 404);
    assert.equal((await get(one.id.slice(1))).status, 404);

    // A rename relabels the chat and keeps its id; the label then names it again while it is the only one.
    const renamed = await postJson('/api/chats/rename', { avatar_url: avatar, original_file: `${two.id}.jsonl`, renamed_file: 'Once.jsonl' });
    assert.deepEqual(renamed.data, { ok: true, sanitizedFileName: two.id, label: 'Once' });
    assert.deepEqual((await get('Once')).data.slice(1).map(m => m.mes), ['One.', 'Two.', 'Three.']);
    assert.deepEqual((await get('Twice')).data.slice(1).map(m => m.mes), ['One.', 'Two.']);
});

test('a greeting shown without a row is stored and bookmarked in one request', async () => {
    const avatar = 'gus.png';
    await writeCharacter(avatar, 'Gus');
    const { status, data } = await postJson('/api/chats/bookmark', {
        avatar_url: avatar, label: 'Start', opening: { refs: ['o'], messages: [{ name: 'Gus', is_user: false, mes: 'Hi.', extra: {} }] },
    });
    assert.equal(status, 200);
    assert.equal(data.stored[0].ref, 'o');
    assert.equal((await bookmarkAt({ avatar }, data.node_id, 'Start'))?.name, 'Start');
});

// Opening a chat records it in the settings, whose throttled autosave timer would hold the process open.
after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
