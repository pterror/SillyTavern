import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// chats.js's import chain reads process-wide config at import time, so the config path is set first.
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Selecting a message is one request: a greeting shown without a row is stored and selected in it, and a jump to a
// message off the loaded path gets the path down to it in the same answer.
const { router: chatsRouter } = await import('./chats.js');
const { newSessionKey } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { write: writeCard } = await import('../character-card-parser.js');
const { convertedUser, writeLibraryCard, sessionPath } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chats-select-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));
for (const [avatar, name] of [['bob.png', 'Bob'], ['cara.png', 'Cara']]) {
    const cardJson = JSON.stringify({ name, spec: 'chara_card_v2', data: { name } });
    await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
}

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

test('a greeting shown without a row is stored and selected in one request', async () => {
    const tab = newSessionKey();
    const { status, data } = await postJson('/api/chats/message/select', {
        avatar_url: 'bob.png', activate: true,
        opening: { refs: ['g'], messages: [{ name: 'Bob', is_user: false, mes: 'Welcome aboard.', extra: {} }] },
    }, tab);
    assert.equal(status, 200);
    const stored = data.stored.find(s => s.ref === 'g');
    assert.ok(stored?.node_id);
    const path = await sessionPath(user.store, { avatar: 'bob.png' }, tab);
    assert.deepEqual(path.map(m => m.mes), ['Welcome aboard.']);

    // The same greeting again lands on the same row.
    const again = await postJson('/api/chats/message/select', {
        avatar_url: 'bob.png', activate: true,
        opening: { refs: ['g2'], messages: [{ name: 'Bob', is_user: false, mes: 'Welcome aboard.', extra: {} }] },
    }, tab);
    assert.equal(again.data.stored.find(s => s.ref === 'g2').node_id, stored.node_id);
});

test('a group chat\'s greetings are stored in a row under the chat\'s name, with the metadata\'s new integrity', async () => {
    const groupId = String(Date.now());
    await user.store.lib.writeGroup({ id: groupId, name: 'Crew', members: [] });
    const tab = newSessionKey();
    const { status, data } = await postJson('/api/chats/message/select', {
        group_id: groupId,
        opening: { refs: ['a', 'b'], messages: [{ name: 'Rex', is_user: false, mes: 'Ahoy.' }, { name: 'Ana', is_user: false, mes: 'Welcome.' }] },
        page_metadata: { ref: 'm', target: null, set: {}, unset: [] },
    }, tab);
    assert.equal(status, 200);
    assert.deepEqual(data.stored.map(s => s.ref), ['a', 'b', 'm']);
    assert.equal(typeof data.stored[2].integrity, 'string');
    const branch = { messages: await sessionPath(user.store, { group: groupId }, tab) };
    assert.deepEqual(branch.messages.map(m => m.mes), ['Ahoy.', 'Welcome.']);
});

test('with_ancestry answers the path down to the selected message and the conversation below it', async () => {
    const tab = newSessionKey();
    const saved = await postJson('/api/chats/save', {
        avatar_url: 'cara.png', file_name: 'Main',
        chat: [
            { chat_metadata: {} },
            { name: 'Cara', is_user: false, mes: 'One.', send_date: 'x', extra: {} },
            { name: 'User', is_user: true, mes: 'Two.', send_date: 'x', extra: {} },
            { name: 'Cara', is_user: false, mes: 'Three.', send_date: 'x', extra: {} },
        ],
    }, tab);
    assert.equal(saved.status, 200);
    const messages = await sessionPath(user.store, { avatar: 'cara.png' }, tab);
    const { status, data } = await postJson('/api/chats/message/select', {
        avatar_url: 'cara.png', node_id: messages[1].node_id, activate: true, with_ancestry: true,
    }, tab);
    assert.equal(status, 200);
    assert.deepEqual(data.ancestry.map(m => m.mes), ['One.', 'Two.']);
    assert.deepEqual(data.messages.map(m => m.mes), ['Three.']);
});

after(() => user.close());
