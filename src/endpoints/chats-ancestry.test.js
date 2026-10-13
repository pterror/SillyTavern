import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// chats.js's import chain reads process-wide config at import time, so the config path is set first.
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

const { router: chatsRouter } = await import('./chats.js');
const { newSessionKey } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, writeLibraryCard, sessionPath } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chats-ancestry-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;
const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));
{
    const cardJson = JSON.stringify({ name: 'Alice', spec: 'chara_card_v2', data: { name: 'Alice' } });
    await writeLibraryCard(user, 'alice.png', cardJson, writeCard(baseImage, cardJson));
}

function buildTestApp() {
    const app = express();
    app.use(express.json({ limit: '200mb' }));
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: 'u' } };
        next();
    });
    app.use('/api/chats', chatsRouter);
    return app;
}

/** @returns {Promise<{status: number, data: any}>} */
async function postJson(app, urlPath, body, headers = {}) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
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

const tab = newSessionKey();
const saved = await postJson(app, '/api/chats/save', {
    ch_name: 'Alice',
    file_name: 'Main Chat',
    avatar_url: 'alice.png',
    chat: [
        { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
        { name: 'User', is_user: true, is_system: false, mes: 'hi', send_date: 'x', extra: {} },
        { name: 'Bot', is_user: false, is_system: false, mes: 'hello', send_date: 'x', extra: {} },
    ],
}, { [SESSION_HEADER]: tab });
assert.equal(saved.status, 200);

const loaded = { messages: await sessionPath(user.store, { avatar: 'alice.png' }, tab) };
assert.ok(loaded, 'the saved chat must exist in the tree');
const leafId = loaded.messages[loaded.messages.length - 1].node_id;

test('POST /api/chats/ancestry: a message\'s bookmark_link is the bookmark made at it', async () => {
    const { status, data } = await postJson(app, '/api/chats/ancestry', { node_id: leafId });

    assert.equal(status, 200);
    assert.deepEqual(data.messages.map(m => m.mes), ['hi', 'hello']);
    // Saving to a name no chat has made a bookmark labelled so at the chat's last message; the link is its compat id.
    assert.match(saved.data.file_name, /^b\d+$/);
    assert.equal(data.messages[0].extra?.bookmark_link, undefined);
    assert.equal(data.messages[1].extra?.bookmark_link, saved.data.file_name);
});

test('POST /api/chats/ancestry answers the same with a chat_name', async () => {
    const without = await postJson(app, '/api/chats/ancestry', { node_id: leafId });
    const withName = await postJson(app, '/api/chats/ancestry', { node_id: leafId, chat_name: 'Main Chat' });

    assert.equal(withName.status, 200);
    assert.deepEqual(withName.data, without.data);
});

test.after(() => user.close());
