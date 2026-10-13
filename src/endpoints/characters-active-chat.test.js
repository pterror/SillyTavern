import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// characters.js's import chain reads process-wide config at import time - the config path must be set before that
// import chain runs, same as every other route-level test file in this directory (see e.g. groups.test.js's own comment).
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Route-level test for POST /api/characters/chat: a character's current chat must be clearable to "no chat" (a new
// one) - a real, valid state, not a malformed request. The write is the requesting tab's session moving to the chat
// the name names, or to a new chat.
const { router: charactersRouter } = await import('./characters.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, writeLibraryCard, saveBranch, sessionPath } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-characters-active-chat-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;
const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: 'u' } };
        next();
    });
    app.use('/api/characters', charactersRouter);
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

/** Stores a character in the user's library. */
async function seedCharacter(avatar, name) {
    const card = { name, spec: 'chara_card_v2', data: { name } };
    const cardJson = JSON.stringify(card);
    await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
}

/**
 * Two chats of a character, each a session of its own (the second chat's session is the "tab").
 * @param {string} avatar
 */
async function seedChats(avatar) {
    const owner = { avatar };
    const other = await saveBranch(user.store, owner, `${avatar} other`, [{}, { name: 'User', is_user: true, mes: 'other one', send_date: 'x', extra: {} }]);
    const tab = await saveBranch(user.store, owner, `${avatar} tab`, [{}, { name: 'User', is_user: true, mes: 'tab one', send_date: 'x', extra: {} }]);
    return { owner, other, tab };
}

test('POST /api/characters/chat sets a real current chat', async () => {
    const app = buildTestApp();
    await seedCharacter('alice.png', 'Alice');
    const { owner, other, tab } = await seedChats('alice.png');
    assert.deepEqual((await sessionPath(user.store, owner, tab)).map(m => m.mes), ['tab one']);

    const { status } = await postJson(app, '/api/characters/chat', { avatar: 'alice.png', chat: 'alice.png other' }, { [SESSION_HEADER]: tab });
    assert.equal(status, 200);

    assert.deepEqual((await sessionPath(user.store, owner, tab)).map(m => m.mes), ['other one'], 'the tab\'s session is at the chat the name names');
    assert.deepEqual((await sessionPath(user.store, owner, other)).map(m => m.mes), ['other one']);
});

test('POST /api/characters/chat accepts an empty string to clear the current chat - "no chat yet" is a valid state', async () => {
    const app = buildTestApp();
    await seedCharacter('bob.png', 'Bob');
    const { owner, tab } = await seedChats('bob.png');

    // Mirrors replaceCurrentChat()/doNewChat() clearing the current chat before rebuilding opening state with no
    // name to mint.
    const res = await postJson(app, '/api/characters/chat', { avatar: 'bob.png', chat: '' }, { [SESSION_HEADER]: tab });
    assert.equal(res.status, 200);

    assert.deepEqual(await sessionPath(user.store, owner, tab), [], 'the tab\'s session is at its tree\'s root: a new chat');
});

test('POST /api/characters/chat accepts an explicit null to clear the current chat', async () => {
    const app = buildTestApp();
    await seedCharacter('carol.png', 'Carol');
    const { owner, tab } = await seedChats('carol.png');

    const res = await postJson(app, '/api/characters/chat', { avatar: 'carol.png', chat: null }, { [SESSION_HEADER]: tab });
    assert.equal(res.status, 200);

    assert.deepEqual(await sessionPath(user.store, owner, tab), []);
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

test.after(() => user.close());
