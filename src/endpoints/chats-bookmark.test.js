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

// A bookmark is one request: the message is named (stored first when it's a greeting with no row), it carries the
// chat's metadata, a group lists it among its chats, and a branch or fork is opened in the same answer.
const { router: chatsRouter } = await import('./chats.js');
const { loadBranch, loadAtNode, labelNode } = await import('../message-tree-db.js');
const { upsertCharacterFromWrite } = await import('../character-metadata-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chats-bookmark-test-'));
const directories = { root };
for (const dir of ['chats', 'groupChats', 'groups', 'backups', 'characters']) {
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

/** A character's chat named `name`, with metadata on its first message. */
async function chatWith(avatar, name) {
    await postJson('/api/chats/save', {
        avatar_url: avatar, file_name: name,
        chat: [
            { chat_metadata: { note_prompt: 'Keep it short.' } },
            { name: 'Dee', is_user: false, mes: 'One.', send_date: 'x', extra: {} },
            { name: 'User', is_user: true, mes: 'Two.', send_date: 'x', extra: {} },
            { name: 'Dee', is_user: false, mes: 'Three.', send_date: 'x', extra: {} },
        ],
    });
    const branch = await loadBranch(directories, avatar.replace('.png', ''), name);
    return branch.messages;
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
    const bookmark = await loadAtNode(directories, 'dee', messages[2].node_id);
    assert.equal(bookmark.label, 'Before the storm');
    assert.equal(bookmark.metadata.note_prompt, 'Keep it short.');
});

test('a branch gets a free name and is opened in the same answer; a fork at an alternative names the shown message too', async () => {
    const avatar = 'eve.png';
    await writeCharacter(avatar, 'Eve');
    const messages = await chatWith(avatar, 'Story');
    const first = await postJson('/api/chats/bookmark', {
        avatar_url: avatar, node_id: messages[1].node_id, label: 'Story', unique: true, from: 'Story', open: true,
    });
    assert.equal(first.status, 200);
    assert.equal(first.data.label, 'Story - Branch #1');
    assert.equal(first.data.opened.chat, 'Story - Branch #1');
    assert.deepEqual(first.data.opened.messages.map(m => m.mes), ['One.', 'Two.', 'Three.']);
    assert.equal(first.data.opened.chat_metadata.note_prompt, 'Keep it short.');

    const forked = await postJson('/api/chats/bookmark', {
        avatar_url: avatar, node_id: messages[2].node_id, label: 'Story', unique: true, from: 'Story', also_node_id: messages[0].node_id,
    });
    assert.equal(forked.data.label, 'Story - Branch #2');
    assert.equal((await loadAtNode(directories, 'eve', messages[0].node_id)).label, 'Story - Branch #2');
});

test('a message that already carries metadata keeps its own', async () => {
    const avatar = 'fay.png';
    await writeCharacter(avatar, 'Fay');
    const messages = await chatWith(avatar, 'Main');
    await postJson('/api/chats/bookmark', { avatar_url: avatar, node_id: messages[2].node_id, label: 'Mine', from: 'Main' });
    await postJson('/api/chats/node/metadata', { avatar_url: avatar, node_id: messages[2].node_id, metadata: { note_prompt: 'Its own.' } });
    await postJson('/api/chats/bookmark', { avatar_url: avatar, node_id: messages[2].node_id, label: 'Renamed', from: 'Main' });
    assert.equal((await loadAtNode(directories, 'fay', messages[2].node_id)).metadata.note_prompt, 'Its own.');
});

test('a group\'s bookmark is among its chats', async () => {
    const groupId = String(Date.now());
    fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify({ id: groupId, name: 'Crew', members: [], chat_id: 'Crew chat', chats: ['Crew chat'] }));
    await postJson('/api/chats/group/save', {
        id: 'Crew chat', group_id: groupId,
        chat: [{ chat_metadata: { note_prompt: 'Aye.' } }, { name: 'Rex', is_user: false, mes: 'Ahoy.', send_date: 'x', extra: {} }],
    });
    const node = (await loadBranch(directories, groupId, 'Crew chat')).messages[0].node_id;
    await labelNode(directories, node, 'Crew chat', { ownerId: groupId });
    const { status, data } = await postJson('/api/chats/bookmark', { group_id: groupId, node_id: node, label: 'Crew chat', unique: true, from: 'Crew chat' });
    assert.equal(status, 200);
    assert.equal(data.label, 'Crew chat - Branch #1');
    assert.ok(data.chats.includes('Crew chat - Branch #1'));
});

test('a greeting shown without a row is stored and bookmarked in one request', async () => {
    const avatar = 'gus.png';
    await writeCharacter(avatar, 'Gus');
    const { status, data } = await postJson('/api/chats/bookmark', {
        avatar_url: avatar, label: 'Start', opening: { refs: ['o'], messages: [{ name: 'Gus', is_user: false, mes: 'Hi.', extra: {} }] },
    });
    assert.equal(status, 200);
    assert.equal(data.stored[0].ref, 'o');
    assert.equal((await loadAtNode(directories, 'gus', data.node_id)).label, 'Start');
});

// Opening a chat records it in the settings, whose throttled autosave timer would hold the process open.
after(() => setImmediate(() => process.exit(0)));
