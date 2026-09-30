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

// A chat's name is stored as the label on its first message, and upstream checkpoint code treats any
// bookmark_link as a checkpoint, so /ancestry must not show the chat the browser has open as one.
const { router: chatsRouter } = await import('./chats.js');
const { loadBranch } = await import('../message-tree-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chats-ancestry-test-'));
const chatsDir = path.join(root, 'chats');
const groupChatsDir = path.join(root, 'groupChats');
const groupsDir = path.join(root, 'groups');
const backupsDir = path.join(root, 'backups');
for (const dir of [chatsDir, groupChatsDir, groupsDir, backupsDir]) {
    fs.mkdirSync(dir, { recursive: true });
}

const directories = { root, chats: chatsDir, groupChats: groupChatsDir, groups: groupsDir, backups: backupsDir };

function buildTestApp() {
    const app = express();
    app.use(express.json({ limit: '200mb' }));
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: 'tester' } };
        next();
    });
    app.use('/api/chats', chatsRouter);
    return app;
}

/** @returns {Promise<{status: number, data: any}>} */
async function postJson(app, urlPath, body) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

const app = buildTestApp();

const saved = await postJson(app, '/api/chats/save', {
    ch_name: 'Alice',
    file_name: 'Main Chat',
    avatar_url: 'alice.png',
    chat: [
        { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
        { name: 'User', is_user: true, is_system: false, mes: 'hi', send_date: 'x', extra: {} },
        { name: 'Bot', is_user: false, is_system: false, mes: 'hello', send_date: 'x', extra: {} },
    ],
});
assert.equal(saved.status, 200);

const loaded = await loadBranch(directories, 'alice', 'Main Chat');
assert.ok(loaded, 'the saved chat must exist in the tree');
const leafId = loaded.messages[loaded.messages.length - 1].node_id;

test('POST /api/chats/ancestry with chat_name does not show that chat\'s own name as bookmark_link', async () => {
    const { status, data } = await postJson(app, '/api/chats/ancestry', { node_id: leafId, chat_name: 'Main Chat' });

    assert.equal(status, 200);
    assert.deepEqual(data.messages.map(m => m.mes), ['hi', 'hello']);
    for (const m of data.messages) {
        assert.equal(m.extra?.bookmark_link, undefined, `message "${m.mes}" must not carry the open chat's own name as bookmark_link`);
    }
});

test('POST /api/chats/ancestry without chat_name hides no label', async () => {
    const { status, data } = await postJson(app, '/api/chats/ancestry', { node_id: leafId });

    assert.equal(status, 200);
    assert.deepEqual(data.messages.map(m => m.mes), ['hi', 'hello']);
    assert.equal(data.messages[0].extra?.bookmark_link, 'Main Chat', 'with no chat given, the first message keeps its label');
});
