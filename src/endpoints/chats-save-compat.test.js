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

// Upstream's whole-chat save (/api/chats/save), for code that still posts a chat array: it stores only what the
// array names by id (a message, an alternative) and the chat's metadata; what it can't address (no id, an ambiguous
// one) is answered as not saved, never guessed. A chat that holds nothing takes the array whole, as a new file.
const { router: chatsRouter } = await import('./chats.js');
const { newSessionKey } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, writeLibraryCard, sessionPath, treeOf } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chats-save-compat-test-');
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
async function postJson(urlPath, body, tab) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(tab ? { [SESSION_HEADER]: tab } : {}) },
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

const header = metadata => ({ chat_metadata: metadata, user_name: 'User', character_name: 'Pia' });

test('an edited message is stored on its id; a message added without an id is answered as not saved, not guessed', async () => {
    await writeCharacter('pia.png', 'Pia');
    const tab = newSessionKey();
    const saved = await postJson('/api/chats/save', {
        avatar_url: 'pia.png', file_name: 'Talk',
        chat: [header({ note_prompt: 'x' }), { name: 'Pia', is_user: false, mes: 'One.', send_date: 'x', extra: {} }],
    }, tab);
    const before = { messages: await sessionPath(user.store, { avatar: 'pia.png' }, tab) };
    const first = before.messages[0];
    const integrity = saved.data.integrity;

    const { status, data } = await postJson('/api/chats/save', {
        avatar_url: 'pia.png', file_name: 'Talk',
        chat: [header({ note_prompt: 'x', integrity }), { ...first, mes: 'One, edited.' }, { name: 'Narrator', is_user: false, mes: 'Added.', send_date: 'x', extra: {} }],
    }, tab);
    assert.equal(status, 200);
    assert.equal(data.integrity, integrity);
    assert.deepEqual(data.not_saved, [{ index: 1, reason: 'no id' }]);
    const after = { messages: await sessionPath(user.store, { avatar: 'pia.png' }, tab) };
    assert.deepEqual(after.messages.map(m => m.mes), ['One, edited.']);
    assert.equal(after.messages[0].node_id, first.node_id, 'the edit landed on the same message');
});

test('an alternative is edited by its own id; one whose shown slot names another message, or with no id, is not saved', async () => {
    await writeCharacter('rho.png', 'Rho');
    const tab = newSessionKey();
    await postJson('/api/chats/save', {
        avatar_url: 'rho.png', file_name: '',
        chat: [header({}), { name: 'Rho', is_user: false, mes: 'A.', send_date: 'x', extra: {}, swipes: ['A.', 'B.'], swipe_id: 0, swipe_info: [{}, {}] }],
    }, tab);
    const [loaded] = await sessionPath(user.store, { avatar: 'rho.png' }, tab);
    assert.deepEqual(loaded.swipes, ['A.', 'B.']);
    const otherId = loaded.swipe_info[1].node_id;

    // The other alternative's text and extra, by its id; the shown one untouched; a third slot without an id left out.
    const edited = await postJson('/api/chats/save', {
        avatar_url: 'rho.png', file_name: '',
        chat: [header({}), {
            ...loaded, swipes: ['A.', 'B, edited.', 'C.'],
            swipe_info: [loaded.swipe_info[0], { ...loaded.swipe_info[1], extra: { note: 1 } }, { send_date: 'x', extra: {} }],
        }],
    }, tab);
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.data.not_saved, [{ index: 0, swipe: 2, reason: 'no id' }]);
    const alternatives = await user.store.chats.alternatives({ node_id: otherId });
    assert.deepEqual(alternatives.alternatives.map(a => a.mes), ['A.', 'B, edited.']);
    assert.equal(alternatives.alternatives[1].extra.note, 1);

    // The shown slot names the other alternative while `node_id` names the first: which one is meant can't be told.
    const ambiguous = await postJson('/api/chats/save', {
        avatar_url: 'rho.png', file_name: '',
        chat: [header({}), { ...loaded, mes: 'Which?', swipe_id: 1 }],
    }, tab);
    assert.deepEqual(ambiguous.data.not_saved, [{ index: 0, reason: 'the shown swipe names another message' }]);
    assert.deepEqual((await user.store.chats.alternatives({ node_id: otherId })).alternatives.map(a => a.mes), ['A.', 'B, edited.']);
});

test('an unnamed save is the tab\'s session; a save named by a message id makes a bookmark of that name there', async () => {
    await writeCharacter('qin.png', 'Qin');
    const tab = newSessionKey();
    const saved = await postJson('/api/chats/save', {
        avatar_url: 'qin.png', file_name: '',
        chat: [header({}), { name: 'Qin', is_user: false, mes: 'Hi.', send_date: 'x', extra: {} }],
    }, tab);
    const nodeId = saved.data.assigned_node_ids[0].node_id;
    const qinTree = await treeOf(user.store, { avatar: 'qin.png' });
    assert.equal(saved.data.file_name, `s${tab}.${qinTree}`, 'an unnamed chat is answered by the tab\'s own conversation');
    assert.equal((await sessionPath(user.store, { avatar: 'qin.png' }, tab))[0]?.node_id, nodeId, 'the character is on it');

    const again = await postJson('/api/chats/save', {
        avatar_url: 'qin.png', file_name: nodeId,
        chat: [header({ note_prompt: 'kept' }), { name: 'Qin', is_user: false, mes: 'Hi.', send_date: 'x', extra: {}, node_id: nodeId }],
    }, tab);
    assert.equal(again.status, 200);
    const tree = await treeOf(user.store, { avatar: 'qin.png' });
    const atNode = await user.store.chats.load({ tree, at: nodeId });
    assert.equal(atNode?.metadata.note_prompt, 'kept');
    // A message id names no chat, so the save made a bookmark of that name at its last message.
    const named = (await user.store.chats.bookmarks({ tree, limit: 500 })).rows.filter(b => b.at === nodeId);
    assert.deepEqual(named.map(b => b.name), [nodeId]);
    assert.equal((await sessionPath(user.store, { avatar: 'qin.png' }, tab)).length, 1);
});

after(async () => {
    await user.close();
    setImmediate(() => process.exit(0));
});
