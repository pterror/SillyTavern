import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock, test } from 'node:test';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// character-metadata-db.js/message-tree-db.js (both imported transitively by chats.js) read
// process-wide config at import time - the config path must be set before that import chain runs,
// same as every other route-level test file in this directory (see e.g. groups.test.js's own comment).
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// This session's own fixes to bookmarks.js's legacy JSONL branch/bookmark-creation paths (identifier
// fabrication cleanup: server-minted branch/bookmark names, integrity slugs, and group-conversion
// gen_ids instead of client-fabricated ones) only run their new logic when a save actually falls
// through to the JSONL branch in chats.js's /save and /group/save routes - which only happens when
// message-tree-db.js's getEntry() finds no usable SQLite backend (see its own "falling back to JSONL"
// log). This session's own scoping found that's the LIVE path for every legacy/group save in at least
// one real deployment. Forcing getSqliteEngine() to resolve null here reproduces that condition
// deterministically, instead of depending on whether this sandbox happens to have a native/wasm SQLite
// engine available.
const canMockSqliteEngine = typeof mock.module === 'function';
if (canMockSqliteEngine) {
    mock.module('../endpoints/sqlite-engine.js', {
        namedExports: { getSqliteEngine: async () => null },
    });
} else {
    console.log('chats-legacy-save.test.js: node:test mock.module() is unavailable (run with --experimental-test-module-mocks) - skipping all legacy-JSONL-path route tests, which need it to force the SQLite-backed message tree unavailable');
}

const { router: chatsRouter } = await import('./chats.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chats-legacy-save-test-'));
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

function readJsonl(filePath) {
    return fs.readFileSync(filePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

function chatHeader(metadata = {}) {
    return { chat_metadata: metadata, user_name: 'unused', character_name: 'unused' };
}

function userMsg(text) {
    return { name: 'User', is_user: true, is_system: false, mes: text, send_date: 'x', extra: {} };
}

function charMsg(text, extra = {}) {
    return { name: 'Bot', is_user: false, is_system: false, mes: text, send_date: 'x', extra };
}

test('POST /api/chats/save with unique:true keeps a non-colliding name unchanged and mints integrity', { skip: !canMockSqliteEngine }, async () => {
    const app = buildTestApp();
    const { status, data } = await postJson(app, '/api/chats/save', {
        ch_name: 'Alice',
        file_name: 'Fresh Chat',
        avatar_url: 'alice.png',
        chat: [chatHeader(), userMsg('hi'), charMsg('hello')],
        unique: true,
    });

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.file_name, 'Fresh Chat');
    assert.equal(typeof data.integrity, 'string');
    assert.ok(data.integrity.length > 0);

    const filePath = path.join(chatsDir, 'alice', 'Fresh Chat.jsonl');
    assert.ok(fs.existsSync(filePath));
    const [header] = readJsonl(filePath);
    // The client no longer fabricates chat_metadata.integrity - the value on disk must be the one the
    // server minted and reported back, not something asserted by the caller (there was none here).
    assert.equal(header.chat_metadata.integrity, data.integrity);
});

test('POST /api/chats/save with unique:true mints "<name> - Branch #N" on a real collision, without touching the original file', { skip: !canMockSqliteEngine }, async () => {
    const app = buildTestApp();
    const dir = path.join(chatsDir, 'bob');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Main Chat.jsonl'), `${JSON.stringify(chatHeader({ integrity: 'original-integrity' }))}\n${JSON.stringify(userMsg('untouched'))}\n`);

    const { status, data } = await postJson(app, '/api/chats/save', {
        ch_name: 'Bob',
        file_name: 'Main Chat',
        avatar_url: 'bob.png',
        chat: [chatHeader(), userMsg('branch point'), charMsg('branch reply')],
        unique: true,
    });

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.file_name, 'Main Chat - Branch #1');

    const originalLines = readJsonl(path.join(dir, 'Main Chat.jsonl'));
    assert.equal(originalLines[0].chat_metadata.integrity, 'original-integrity');
    assert.equal(originalLines.length, 2);

    const branchLines = readJsonl(path.join(dir, 'Main Chat - Branch #1.jsonl'));
    assert.equal(branchLines[0].chat_metadata.integrity, data.integrity);
    assert.equal(branchLines.length, 3);

    // A second collision (both "Main Chat" and "Main Chat - Branch #1" now taken) advances to #2.
    const second = await postJson(app, '/api/chats/save', {
        ch_name: 'Bob',
        file_name: 'Main Chat',
        avatar_url: 'bob.png',
        chat: [chatHeader(), userMsg('another branch')],
        unique: true,
    });
    assert.equal(second.data.file_name, 'Main Chat - Branch #2');
});

test('POST /api/chats/save without unique overwrites a same-named file (baseline, unchanged behavior)', { skip: !canMockSqliteEngine }, async () => {
    const app = buildTestApp();
    const dir = path.join(chatsDir, 'carol');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Solo.jsonl'), `${JSON.stringify(chatHeader())}\n${JSON.stringify(userMsg('old'))}\n`);

    const { status, data } = await postJson(app, '/api/chats/save', {
        ch_name: 'Carol',
        file_name: 'Solo',
        avatar_url: 'carol.png',
        chat: [chatHeader(), userMsg('new')],
    });

    assert.equal(status, 200);
    assert.equal(data.file_name, 'Solo');
    const lines = readJsonl(path.join(dir, 'Solo.jsonl'));
    assert.equal(lines[1].mes, 'new');
});

function writeGroupFixture(id, chats) {
    fs.writeFileSync(path.join(groupsDir, `${id}.json`), JSON.stringify({
        id,
        name: `Group ${id}`,
        members: [],
        chat_id: chats[0] ?? id,
        chats,
    }));
}

test('POST /api/chats/group/save with unique:true mints "<id> - Branch #N" against the group\'s own chats list', { skip: !canMockSqliteEngine }, async () => {
    const app = buildTestApp();
    writeGroupFixture('group-1', ['Team Chat']);

    const { status, data } = await postJson(app, '/api/chats/group/save', {
        id: 'Team Chat',
        group_id: 'group-1',
        chat: [chatHeader(), userMsg('branch point'), charMsg('reply')],
        unique: true,
    });

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.chat_id, 'Team Chat - Branch #1');
    assert.ok(fs.existsSync(path.join(groupChatsDir, 'Team Chat - Branch #1.jsonl')));
    assert.ok(!fs.existsSync(path.join(groupChatsDir, 'Team Chat.jsonl')));
});

test('POST /api/chats/group/save mints gen_id only for character messages missing one, leaving existing values and user messages untouched', { skip: !canMockSqliteEngine }, async () => {
    const app = buildTestApp();
    writeGroupFixture('group-2', []);

    const { status, data } = await postJson(app, '/api/chats/group/save', {
        id: 'group-2-chat',
        group_id: 'group-2',
        chat: [
            chatHeader(),
            charMsg('no gen_id yet', {}),
            charMsg('already has one', { gen_id: 424242 }),
            userMsg('user message, never gets a gen_id'),
        ],
    });

    assert.equal(status, 200);
    assert.equal(data.ok, true);

    const lines = readJsonl(path.join(groupChatsDir, 'group-2-chat.jsonl'));
    assert.equal(typeof lines[1].extra.gen_id, 'number');
    assert.equal(lines[2].extra.gen_id, 424242, 'a message\'s real prior gen_id must not be clobbered');
    assert.equal(lines[3].extra?.gen_id, undefined, 'user messages never get a fabricated gen_id');
});

test('POST /api/chats/group/save without unique still rejects an id no group claims', { skip: !canMockSqliteEngine }, async () => {
    const app = buildTestApp();
    const { status, data } = await postJson(app, '/api/chats/group/save', {
        id: 'orphan-chat',
        chat: [chatHeader(), userMsg('hi')],
    });

    assert.equal(status, 400);
    assert.equal(data.error, 'unknown_group');
});
