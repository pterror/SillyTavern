import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

const { router: chatsRouter } = await import('./chats.js');
const { newSessionKey } = await import('../chat-engine.js');
const { convertedUser, writeLibraryCard, seedMessages, treeOf } = await import('../../tests/converted-user.fixture.js');

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
const owner = { avatar: 'alice.png' };
const [, leafId] = await seedMessages(user.store, owner, null, [
    { name: 'User', is_user: true, is_system: false, mes: 'hi', send_date: 'x', extra: {} },
    { name: 'Bot', is_user: false, is_system: false, mes: 'hello', send_date: 'x', extra: {} },
], { session: tab });
const bookmark = await user.store.chats.createBookmark({ tree: await treeOf(user.store, owner), node_id: leafId, name: 'Main Chat', actor: { user: 'u', session: tab } });
assert.equal(bookmark.ok, true);

test('POST /api/chats/ancestry: a message\'s bookmark_link is the bookmark made at it', async () => {
    const { status, data } = await postJson(app, '/api/chats/ancestry', { node_id: leafId });

    assert.equal(status, 200);
    assert.deepEqual(data.messages.map(m => m.mes), ['hi', 'hello']);
    assert.equal(data.messages[0].extra?.bookmark_link, undefined);
    assert.equal(data.messages[1].extra?.bookmark_link, 'Main Chat');
});

test('POST /api/chats/ancestry answers the same with a chat_name', async () => {
    const without = await postJson(app, '/api/chats/ancestry', { node_id: leafId });
    const withName = await postJson(app, '/api/chats/ancestry', { node_id: leafId, chat_name: 'Main Chat' });

    assert.equal(withName.status, 200);
    assert.deepEqual(withName.data, without.data);
});

test.after(() => user.close());
