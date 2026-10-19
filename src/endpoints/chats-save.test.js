import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Modules imported transitively by chats.js read
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
const { router: groupsRouter } = await import('./groups.js');
const { newSessionKey } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, writeLibraryCard, treeOf } = await import('../../tests/converted-user.fixture.js');
const { write: writeCard } = await import('../character-card-parser.js');

const user = await convertedUser('st-chats-save-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));
for (const [avatar, name] of [['alice.png', 'Alice'], ['bob.png', 'Bob']]) {
    const cardJson = JSON.stringify({ name, spec: 'chara_card_v2', data: { name } });
    await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
}

/**
 * A chat of a tree by its name, as the tab that saved it shows it: its messages and the state there.
 * @param {{ avatar?: string, group?: string }} owner
 * @param {string} name
 * @param {string} tab
 */
async function chatNamed(owner, name, tab) {
    const tree = await treeOf(user.store, owner);
    const found = await user.store.chats.resolveChatName({ tree, name });
    if (found === null) return null;
    const [b] = 'bookmark' in found ? await user.store.chats.store.chatRead('bookmarks', { ids: [found.bookmark] }) : [null];
    const at = b ? (b.at === null ? null : (await user.store.chats.externalIds([b.at]))[0]) : undefined;
    return at === undefined ? null : await user.store.chats.load({ tree, at, session: tab });
}

/** The names of a tree's bookmarks. */
async function bookmarkNames(owner) {
    const tree = await treeOf(user.store, owner);
    return (await user.store.chats.bookmarks({ tree, limit: 500 })).rows.map(b => b.name);
}

function buildTestApp() {
    const app = express();
    app.use(express.json({ limit: '200mb' }));
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: 'u' } };
        next();
    });
    app.use('/api/chats', chatsRouter);
    app.use('/api/groups', groupsRouter);
    return app;
}

/** @returns {Promise<{status: number, data: any}>} */
async function postJson(app, urlPath, body, tab) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(tab ? { [SESSION_HEADER]: tab } : {}) },
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

test('POST /api/chats/save with unique:true makes a bookmark labelled as asked, answered by its compat id, and mints integrity', async () => {
    const app = buildTestApp();
    const tab = newSessionKey();
    const { status, data } = await postJson(app, '/api/chats/save', {
        ch_name: 'Alice',
        file_name: 'Fresh Chat',
        avatar_url: 'alice.png',
        chat: [chatHeader(), userMsg('hi'), charMsg('hello')],
        unique: true,
    }, tab);

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.match(data.file_name, /^b\d+$/);
    assert.equal(typeof data.integrity, 'string');
    assert.ok(data.integrity.length > 0);
    assert.ok((await bookmarkNames({ avatar: 'alice.png' })).includes('Fresh Chat'));

    const result = await chatNamed({ avatar: 'alice.png' }, data.file_name, tab);
    assert.ok(result, 'branch must exist in the tree');
    // The client no longer fabricates chat_metadata.integrity - the value stored must be the one the
    // server minted and reported back, not something asserted by the caller (there was none here).
    assert.equal(result.metadata.integrity, data.integrity);
});

test('POST /api/chats/save with unique:true makes a new bookmark when a chat has the label, without touching that one', async () => {
    const app = buildTestApp();
    const tab1 = newSessionKey();
    const tab2 = newSessionKey();
    const first = await postJson(app, '/api/chats/save', {
        ch_name: 'Bob',
        file_name: 'Main Chat',
        avatar_url: 'bob.png',
        chat: [chatHeader({ integrity: 'ignored' }), userMsg('untouched')],
    }, tab1);
    assert.match(first.data.file_name, /^b\d+$/);

    const { status, data } = await postJson(app, '/api/chats/save', {
        ch_name: 'Bob',
        file_name: 'Main Chat',
        avatar_url: 'bob.png',
        chat: [chatHeader(), userMsg('branch point'), charMsg('branch reply')],
        unique: true,
    }, tab2);

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.match(data.file_name, /^b\d+$/);
    assert.notEqual(data.file_name, first.data.file_name);

    const original = await chatNamed({ avatar: 'bob.png' }, first.data.file_name, tab1);
    assert.equal(original.messages.length, 1, 'the original branch must be untouched by the collision save');
    // Two chats share the label now, so it names neither.
    assert.equal(await chatNamed({ avatar: 'bob.png' }, 'Main Chat', tab1), null);

    const branch = await chatNamed({ avatar: 'bob.png' }, data.file_name, tab2);
    assert.ok(branch);
    assert.equal(branch.metadata.integrity, data.integrity);
    assert.equal(branch.messages.length, 2);

    // Again: a third bookmark, labelled the same.
    const second = await postJson(app, '/api/chats/save', {
        ch_name: 'Bob',
        file_name: 'Main Chat',
        avatar_url: 'bob.png',
        chat: [chatHeader(), userMsg('another branch')],
        unique: true,
    }, newSessionKey());
    assert.ok(![first.data.file_name, data.file_name].includes(second.data.file_name));
    assert.deepEqual(await bookmarkNames({ avatar: 'bob.png' }), ['Main Chat', 'Main Chat', 'Main Chat']);
});

/**
 * A group, with a chat of each name in `chats` (a tab of its own saved it).
 * @param {string} id
 * @param {string[]} chats
 */
async function writeGroupFixture(id, chats) {
    await user.store.lib.writeGroup({ id, name: `Group ${id}`, members: [] });
    const app = buildTestApp();
    /** @type {string[]} */
    const tabs = [];
    for (const name of chats) {
        tabs.push(newSessionKey());
        await postJson(app, '/api/chats/group/save', { id: name, group_id: id, chat: [chatHeader(), userMsg('seed')] }, tabs[tabs.length - 1]);
    }
    return tabs;
}

/** A group as /api/groups/batch answers it. */
async function groupOf(app, id, tab) {
    return (await postJson(app, '/api/groups/batch', { ids: [id] }, tab)).data[0];
}

test('POST /api/chats/group/save with unique:true makes a new bookmark of the group\'s, listed among its chats', async () => {
    const app = buildTestApp();
    await user.store.lib.writeGroup({ id: 'group-1', name: 'Group group-1', members: [] });
    const tab1 = newSessionKey();
    const tab2 = newSessionKey();
    const first = await postJson(app, '/api/chats/group/save', {
        id: 'Team Chat',
        group_id: 'group-1',
        chat: [chatHeader(), userMsg('hi')],
    }, tab1);

    const { status, data } = await postJson(app, '/api/chats/group/save', {
        id: 'Team Chat',
        group_id: 'group-1',
        chat: [chatHeader(), userMsg('branch point'), charMsg('reply')],
        unique: true,
    }, tab2);

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.match(data.chat_id, /^b\d+$/);
    assert.notEqual(data.chat_id, first.data.chat_id);
    const branch = await chatNamed({ group: 'group-1' }, data.chat_id, tab2);
    assert.ok(branch);
    const original = await chatNamed({ group: 'group-1' }, first.data.chat_id, tab1);
    assert.equal(original.messages.length, 1, 'the original branch must be untouched by the collision save');

    // The new id must already be registered in the group's own persisted `chats` list from this single
    // request - a caller that used to need a second /api/groups/save-partial round trip just to append
    // one string here (createBranch()'s/createNewBookmark()'s group case, "one action, one request")
    // should have nothing left to do but update its own in-memory mirror.
    const groupOnDisk = await groupOf(app, 'group-1', tab2);
    // Newest first; the save made the bookmark without opening it or moving the tab, which has no conversation of its own.
    assert.deepEqual(groupOnDisk.chats, [data.chat_id, first.data.chat_id]);
    // Every other field on the descriptor must survive untouched - registration re-reads and rewrites
    // the FULL descriptor (not the shallow {id, chats} view resolveGroupOwner() hands the route), or it
    // would silently wipe the rest of the group's config.
    assert.equal(groupOnDisk.name, 'Group group-1');
});

test('POST /api/chats/group/save with a fresh (non-unique) id also registers it in the group\'s chats list', async () => {
    const app = buildTestApp();
    await writeGroupFixture('group-3', []);
    const tab = newSessionKey();

    const { status, data } = await postJson(app, '/api/chats/group/save', {
        id: 'Checkpoint #1',
        group_id: 'group-3',
        chat: [chatHeader(), userMsg('hi')],
    }, tab);

    assert.equal(status, 200);
    assert.match(data.chat_id, /^b\d+$/);
    assert.deepEqual(await bookmarkNames({ group: 'group-3' }), ['Checkpoint #1']);
    const groupOnDisk = await groupOf(app, 'group-3', tab);
    assert.deepEqual(groupOnDisk.chats, [`s${tab}.${await treeOf(user.store, { group: 'group-3' })}`, data.chat_id]);
});

test('POST /api/chats/group/save with an already-registered id does not rewrite the group descriptor', async () => {
    const app = buildTestApp();
    const [tab] = await writeGroupFixture('group-4', ['Ongoing Chat']);
    const stored = async () => JSON.stringify(await user.store.lib.groups(['group-4']));
    const before = await stored();

    const { status } = await postJson(app, '/api/chats/group/save', {
        id: 'Ongoing Chat',
        group_id: 'group-4',
        chat: [chatHeader(), userMsg('another message')],
    }, tab);

    assert.equal(status, 200);
    // A group's `chats` is read from its bookmarks, so a save writes nothing of the group.
    assert.equal(await stored(), before);
});

test('a whole save to a bookmark\'s name edits what it names by id and its metadata; it appends, deletes and moves nothing, and answers what it left out', async () => {
    const app = buildTestApp();
    const [tab] = await writeGroupFixture('group-6', ['Moving Chat']);
    const save = (chat, from) => postJson(app, '/api/chats/group/save', { id: 'Moving Chat', group_id: 'group-6', chat }, from);
    const [seed] = (await chatNamed({ group: 'group-6' }, 'Moving Chat', tab)).messages;

    // The stored message is edited by its id; a message without one isn't stored: the array can't say where it goes.
    const other = newSessionKey();
    const saved = await save([chatHeader({ note_prompt: 'kept' }), { ...seed, mes: 'seed, edited' }, charMsg('more')], other);
    assert.equal(saved.status, 200);
    assert.match(saved.data.chat_id, /^b\d+$/);
    assert.deepEqual(saved.data.not_saved, [{ index: 1, reason: 'no id' }]);
    const shown = await chatNamed({ group: 'group-6' }, 'Moving Chat', tab);
    assert.deepEqual(shown.messages.map(m => m.mes), ['seed, edited']);
    assert.equal(shown.messages[0].node_id, seed.node_id);
    assert.equal(shown.metadata.note_prompt, 'kept');

    // A save leaving the message out doesn't delete it.
    const without = await save([chatHeader({ note_prompt: 'kept' })], other);
    assert.deepEqual(without.data.not_deleted, [seed.node_id]);
    assert.deepEqual((await chatNamed({ group: 'group-6' }, 'Moving Chat', tab)).messages.map(m => m.mes), ['seed, edited']);
    assert.deepEqual(await bookmarkNames({ group: 'group-6' }), ['Moving Chat']);
});

test('POST /api/chats/group/save mints gen_id only for character messages missing one, leaving existing values and user messages untouched', async () => {
    const app = buildTestApp();
    await writeGroupFixture('group-2', []);
    const tab = newSessionKey();

    const { status, data } = await postJson(app, '/api/chats/group/save', {
        id: 'group-2-chat',
        group_id: 'group-2',
        chat: [
            chatHeader(),
            charMsg('no gen_id yet', {}),
            charMsg('already has one', { gen_id: 424242 }),
            userMsg('user message, never gets a gen_id'),
        ],
    }, tab);

    assert.equal(status, 200);
    assert.equal(data.ok, true);

    const branch = await chatNamed({ group: 'group-2' }, 'group-2-chat', tab);
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
    await writeGroupFixture('group-5', []);

    const { status, data } = await postJson(app, '/api/chats/group/save', {
        id: 'empty-chat',
        group_id: 'group-5',
        chat: [],
    });

    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.chat_id, 'empty-chat');
    assert.equal(data.integrity, undefined);
    const branches = await bookmarkNames({ group: 'group-5' });
    assert.equal(branches.length, 0, 'nothing should have been saved to the tree');
});

after(() => user.close());
