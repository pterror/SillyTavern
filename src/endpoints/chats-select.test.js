import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// chats.js's import chain reads process-wide config at import time, so the config path is set first.
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Selecting a message is one request: a greeting shown without a row is stored and selected in it, and a jump to a
// message off the loaded path gets the path down to it in the same answer.
const { router: chatsRouter } = await import('./chats.js');
const { loadBranch, getAncestorPath } = await import('../message-tree-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chats-select-test-'));
const directories = { root };
for (const dir of ['chats', 'groupChats', 'groups', 'backups', 'characters']) {
    directories[dir] = path.join(root, dir);
    fs.mkdirSync(directories[dir], { recursive: true });
}

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

test('a greeting shown without a row is stored and selected in one request', async () => {
    const { status, data } = await postJson('/api/chats/message/select', {
        avatar_url: 'bob.png', activate: true,
        opening: { refs: ['g'], messages: [{ name: 'Bob', is_user: false, mes: 'Welcome aboard.', extra: {} }] },
    });
    assert.equal(status, 200);
    const stored = data.stored.find(s => s.ref === 'g');
    assert.ok(stored?.node_id);
    const path = await getAncestorPath(directories, stored.node_id);
    assert.deepEqual(path.map(m => m.mes), ['Welcome aboard.']);

    // The same greeting again lands on the same row.
    const again = await postJson('/api/chats/message/select', {
        avatar_url: 'bob.png', activate: true,
        opening: { refs: ['g2'], messages: [{ name: 'Bob', is_user: false, mes: 'Welcome aboard.', extra: {} }] },
    });
    assert.equal(again.data.stored.find(s => s.ref === 'g2').node_id, stored.node_id);
});

test('a group chat\'s greetings are stored in a row under the chat\'s name, with the metadata\'s new integrity', async () => {
    const groupId = String(Date.now());
    fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify({ id: groupId, name: 'Crew', members: [], chat_id: 'Crew chat', chats: ['Crew chat'] }));
    const { status, data } = await postJson('/api/chats/message/select', {
        group_id: groupId,
        opening: { refs: ['a', 'b'], messages: [{ name: 'Rex', is_user: false, mes: 'Ahoy.' }, { name: 'Ana', is_user: false, mes: 'Welcome.' }] },
        page_metadata: { ref: 'm', target: null, set: {}, unset: [] },
    });
    assert.equal(status, 200);
    assert.deepEqual(data.stored.map(s => s.ref), ['a', 'b', 'm']);
    assert.equal(typeof data.stored[2].integrity, 'string');
    const branch = await loadBranch(directories, groupId, 'Crew chat');
    assert.deepEqual(branch.messages.map(m => m.mes), ['Ahoy.', 'Welcome.']);
});

test('with_ancestry answers the path down to the selected message and the conversation below it', async () => {
    const saved = await postJson('/api/chats/save', {
        avatar_url: 'cara.png', file_name: 'Main',
        chat: [
            { chat_metadata: {} },
            { name: 'Cara', is_user: false, mes: 'One.', send_date: 'x', extra: {} },
            { name: 'User', is_user: true, mes: 'Two.', send_date: 'x', extra: {} },
            { name: 'Cara', is_user: false, mes: 'Three.', send_date: 'x', extra: {} },
        ],
    });
    assert.equal(saved.status, 200);
    const messages = (await loadBranch(directories, 'cara', 'Main')).messages;
    const { status, data } = await postJson('/api/chats/message/select', {
        avatar_url: 'cara.png', node_id: messages[1].node_id, activate: true, with_ancestry: true,
    });
    assert.equal(status, 200);
    assert.deepEqual(data.ancestry.map(m => m.mes), ['One.', 'Two.']);
    assert.deepEqual(data.messages.map(m => m.mes), ['Three.']);
});
