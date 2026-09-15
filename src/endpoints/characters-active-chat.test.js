import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// character-metadata-db.js (imported transitively by characters.js) reads process-wide config at
// import time - the config path must be set before that import chain runs, same as every other
// route-level test file in this directory (see e.g. groups.test.js's own comment).
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Route-level test for POST /api/characters/chat, touched by this task's naming-fabrication removal
// (Workstream 6 / doNewChat, replaceCurrentChat, deleteCharacterChatByName): a character's active-chat
// pointer must now be clearable to "no active chat" - a real, valid state (an ongoing conversation
// with no name yet, or one that was never labeled) - not rejected as a malformed request the way an
// empty/missing name used to be treated before this task.
const { router: charactersRouter } = await import('./characters.js');
const { upsertCharacterFromWrite, getCharacterActiveChatsByIds } = await import('../character-metadata-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-active-chat-test-'));
const charactersDir = path.join(root, 'characters');
const chatsDir = path.join(root, 'chats');
for (const dir of [charactersDir, chatsDir]) {
    fs.mkdirSync(dir, { recursive: true });
}
const directories = { root, characters: charactersDir, chats: chatsDir, groups: path.join(root, 'groups'), groupChats: path.join(root, 'groupChats') };

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: 'tester' } };
        next();
    });
    app.use('/api/characters', charactersRouter);
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

/** Seeds a tracked metadata-store row for `avatar` without needing a real PNG card on disk. */
async function seedCharacter(avatar, name) {
    const card = { name, spec: 'chara_card_v2', data: { name } };
    await upsertCharacterFromWrite(directories, avatar, JSON.stringify(card), Date.now());
}

test('POST /api/characters/chat sets a real active-chat pointer', async () => {
    const app = buildTestApp();
    await seedCharacter('alice.png', 'Alice');

    const { status } = await postJson(app, '/api/characters/chat', { avatar: 'alice.png', chat: 'some-node-id' });
    assert.equal(status, 204);

    const byId = await getCharacterActiveChatsByIds(directories, ['alice.png']);
    assert.equal(byId['alice.png'], 'some-node-id');
});

test('POST /api/characters/chat accepts an empty string to clear the pointer - "no active chat" is a valid state', async () => {
    const app = buildTestApp();
    await seedCharacter('bob.png', 'Bob');

    // First set a real pointer, then clear it - mirrors replaceCurrentChat()/doNewChat() clearing a
    // stale pointer before rebuilding opening state with no name to mint.
    let res = await postJson(app, '/api/characters/chat', { avatar: 'bob.png', chat: 'old-node-id' });
    assert.equal(res.status, 204);

    res = await postJson(app, '/api/characters/chat', { avatar: 'bob.png', chat: '' });
    assert.equal(res.status, 204);

    // getCharacterActiveChatsByIds only returns owners with a non-NULL active_chat (see its own
    // "AND active_chat IS NOT NULL" query) - clearing must actually reach NULL, not merely store "".
    const byId = await getCharacterActiveChatsByIds(directories, ['bob.png']);
    assert.equal(Object.prototype.hasOwnProperty.call(byId, 'bob.png'), false);
});

test('POST /api/characters/chat accepts an explicit null to clear the pointer', async () => {
    const app = buildTestApp();
    await seedCharacter('carol.png', 'Carol');

    let res = await postJson(app, '/api/characters/chat', { avatar: 'carol.png', chat: 'a-node-id' });
    assert.equal(res.status, 204);

    res = await postJson(app, '/api/characters/chat', { avatar: 'carol.png', chat: null });
    assert.equal(res.status, 204);

    const byId = await getCharacterActiveChatsByIds(directories, ['carol.png']);
    assert.equal(Object.prototype.hasOwnProperty.call(byId, 'carol.png'), false);
});

test('POST /api/characters/chat still 400s when chat is missing entirely or the wrong type', async () => {
    const app = buildTestApp();
    await seedCharacter('dave.png', 'Dave');

    let res = await postJson(app, '/api/characters/chat', { avatar: 'dave.png' });
    assert.equal(res.status, 400);
    assert.equal(res.data.reason, 'chat-required');

    res = await postJson(app, '/api/characters/chat', { avatar: 'dave.png', chat: 12345 });
    assert.equal(res.status, 400);
    assert.equal(res.data.reason, 'chat-required');
});

test('POST /api/characters/chat 400s without an avatar', async () => {
    const app = buildTestApp();
    const { status, data } = await postJson(app, '/api/characters/chat', { chat: 'x' });
    assert.equal(status, 400);
    assert.equal(data.reason, 'avatar-required');
});

test('POST /api/characters/chat 404s for an avatar that was never tracked', async () => {
    const app = buildTestApp();
    const { status, data } = await postJson(app, '/api/characters/chat', { avatar: 'ghost.png', chat: 'x' });
    assert.equal(status, 404);
    assert.equal(data.reason, 'not-tracked');
});
