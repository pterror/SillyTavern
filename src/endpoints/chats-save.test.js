import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// character-metadata-db.js/message-tree-db.js (both imported transitively by chats.js) read
// process-wide config at import time - the config path must be set before that import chain runs,
// same as every other route-level test file in this directory (see e.g. groups.test.js's own comment).
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Route-level Express-integration test for /save's and /group/save's unique-name-minting behavior
// against the real (SQLite-backed) message tree - the only storage path left once chats.js's JSONL
// fallback was removed. Ported from chats-legacy-save.test.js (deleted alongside this file's
// addition), which exercised the same pickUniqueChatFileName()/pickUniqueGroupChatId() collision
// logic but only reachable, before that removal, by mocking getSqliteEngine() to force the
// now-deleted JSONL fallback. Assertions here read back the real tree (loadBranch()/listBranches())
// instead of JSONL files on disk, since a save no longer ever produces one.
const { router: chatsRouter } = await import('./chats.js');
const { loadBranch, listBranches } = await import('../message-tree-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chats-save-test-'));
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

function chatHeader(metadata = {}) {
    return { chat_metadata: metadata, user_name: 'unused', character_name: 'unused' };
}

function userMsg(text) {
    return { name: 'User', is_user: true, is_system: false, mes: text, send_date: 'x', extra: {} };
}

function charMsg(text, extra = {}) {
    return { name: 'Bot', is_user: false, is_system: false, mes: text, send_date: 'x', extra };
}

test('POST /api/chats/save with unique:true keeps a non-colliding name unchanged and mints integrity', async () => {
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

    const result = await loadBranch(directories, 'alice', 'Fresh Chat');
    assert.ok(result, 'branch must exist in the tree');
    // The client no longer fabricates chat_metadata.integrity - the value stored must be the one the
    // server minted and reported back, not something asserted by the caller (there was none here).
    assert.equal(result.metadata.integrity, data.integrity);
});

test('POST /api/chats/save with unique:true mints "<name> - Branch #N" on a real collision, without touching the original branch', async () => {
    const app = buildTestApp();
    const first = await postJson(app, '/api/chats/save', {
        ch_name: 'Bob',
        file_name: 'Main Chat',
        avatar_url: 'bob.png',
        chat: [chatHeader({ integrity: 'ignored' }), userMsg('untouched')],
    });
    assert.equal(first.data.file_name, 'Main Chat');

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

    const original = await loadBranch(directories, 'bob', 'Main Chat');
    assert.equal(original.messages.length, 1, 'the original branch must be untouched by the collision save');

    const branch = await loadBranch(directories, 'bob', 'Main Chat - Branch #1');
    assert.ok(branch);
    assert.equal(branch.metadata.integrity, data.integrity);
    assert.equal(branch.messages.length, 2);

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

function writeGroupFixture(id, chats) {
    fs.writeFileSync(path.join(groupsDir, `${id}.json`), JSON.stringify({
        id,
        name: `Group ${id}`,
        members: [],
        chat_id: chats[0] ?? id,
        chats,
    }));
}

test('POST /api/chats/group/save with unique:true mints "<id> - Branch #N" against the group\'s own chats list', async () => {
    const app = buildTestApp();
    writeGroupFixture('group-1', ['Team Chat']);
    await postJson(app, '/api/chats/group/save', {
        id: 'Team Chat',
        group_id: 'group-1',
        chat: [chatHeader(), userMsg('hi')],
    });

    const { status, data } = await postJson(app, '/api/chats/group/save', {
        id: 'Team Chat',
        group_id: 'group-1',
        chat: [chatHeader(), userMsg('branch point'), charMsg('reply')],
        unique: true,
    });

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.chat_id, 'Team Chat - Branch #1');
    const branch = await loadBranch(directories, 'group-1', 'Team Chat - Branch #1');
    assert.ok(branch);
    const original = await loadBranch(directories, 'group-1', 'Team Chat');
    assert.equal(original.messages.length, 1, 'the original branch must be untouched by the collision save');

    // The new id must already be registered in the group's own persisted `chats` list from this single
    // request - a caller that used to need a second /api/groups/save-partial round trip just to append
    // one string here (createBranch()'s/createNewBookmark()'s group case, "one action, one request")
    // should have nothing left to do but update its own in-memory mirror.
    const groupOnDisk = JSON.parse(fs.readFileSync(path.join(groupsDir, 'group-1.json'), 'utf8'));
    assert.deepEqual(groupOnDisk.chats, ['Team Chat', 'Team Chat - Branch #1']);
    // Every other field on the descriptor must survive untouched - registration re-reads and rewrites
    // the FULL descriptor (not the shallow {id, chats} view resolveGroupOwner() hands the route), or it
    // would silently wipe the rest of the group's config.
    assert.equal(groupOnDisk.name, 'Group group-1');
});

test('POST /api/chats/group/save with a fresh (non-unique) id also registers it in the group\'s chats list', async () => {
    const app = buildTestApp();
    writeGroupFixture('group-3', []);

    const { status, data } = await postJson(app, '/api/chats/group/save', {
        id: 'Checkpoint #1',
        group_id: 'group-3',
        chat: [chatHeader(), userMsg('hi')],
    });

    assert.equal(status, 200);
    assert.equal(data.chat_id, 'Checkpoint #1');
    const groupOnDisk = JSON.parse(fs.readFileSync(path.join(groupsDir, 'group-3.json'), 'utf8'));
    assert.deepEqual(groupOnDisk.chats, ['Checkpoint #1']);
});

test('POST /api/chats/group/save with an already-registered id does not rewrite the group descriptor', async () => {
    const app = buildTestApp();
    writeGroupFixture('group-4', ['Ongoing Chat']);
    const groupFilePath = path.join(groupsDir, 'group-4.json');
    const before = fs.readFileSync(groupFilePath, 'utf8');

    const { status } = await postJson(app, '/api/chats/group/save', {
        id: 'Ongoing Chat',
        group_id: 'group-4',
        chat: [chatHeader(), userMsg('another message')],
    });

    assert.equal(status, 200);
    // The hot path (every message of an ongoing group chat) must not pay for a group-descriptor
    // read+write on every save - only a genuinely new id should trigger one.
    const after = fs.readFileSync(groupFilePath, 'utf8');
    assert.equal(after, before);
});

test('POST /api/chats/group/save mints gen_id only for character messages missing one, leaving existing values and user messages untouched', async () => {
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

    const branch = await loadBranch(directories, 'group-2', 'group-2-chat');
    assert.equal(typeof branch.messages[0].extra.gen_id, 'number');
    assert.equal(branch.messages[1].extra.gen_id, 424242, 'a message\'s real prior gen_id must not be clobbered');
    assert.equal(branch.messages[2].extra?.gen_id, undefined, 'user messages never get a fabricated gen_id');
});

test('POST /api/chats/group/save without unique still rejects an id no group claims', async () => {
    const app = buildTestApp();
    const { status, data } = await postJson(app, '/api/chats/group/save', {
        id: 'orphan-chat',
        chat: [chatHeader(), userMsg('hi')],
    });

    assert.equal(status, 400);
    assert.equal(data.error, 'unknown_group');
});

test('POST /api/chats/group/save with an empty chat array is a no-op success, not a write', async () => {
    const app = buildTestApp();
    writeGroupFixture('group-5', []);

    const { status, data } = await postJson(app, '/api/chats/group/save', {
        id: 'empty-chat',
        group_id: 'group-5',
        chat: [],
    });

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.chat_id, 'empty-chat');
    assert.equal(data.integrity, undefined);
    const branches = await listBranches(directories, 'group-5');
    assert.equal(branches.length, 0, 'nothing should have been saved to the tree');
});
