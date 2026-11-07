import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

const { router: chatsRouter } = await import('./chats.js');
const { router: groupsRouter } = await import('./groups.js');
const { newSessionKey } = await import('../chat-engine.js');
const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, treeOf } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chats-save-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

/**
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

/**
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
    assert.equal(data.chat_id, 'Team Chat (2)');
    const branch = await chatNamed({ group: 'group-1' }, data.chat_id, tab2);
    assert.ok(branch);
    const original = await chatNamed({ group: 'group-1' }, first.data.chat_id, tab1);
    assert.equal(original.messages.length, 1, 'the original branch must be untouched by the collision save');

    const groupOnDisk = await groupOf(app, 'group-1', tab2);
    assert.deepEqual(groupOnDisk.chats, [data.chat_id, first.data.chat_id]);
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
    assert.equal(data.chat_id, 'Checkpoint #1');
    assert.deepEqual(await bookmarkNames({ group: 'group-3' }), ['Checkpoint #1']);
    const groupOnDisk = await groupOf(app, 'group-3', tab);
    assert.equal(groupOnDisk.chats.length, 2);
    assert.match(groupOnDisk.chats[0], /^\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms$/);
    assert.equal(groupOnDisk.chats[1], data.chat_id);
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
    assert.equal(await stored(), before);
});

test('a whole save to a bookmark\'s name edits what it names by id and its metadata, adds what it names by no id after it; it deletes and moves nothing, and answers what it left out', async () => {
    const app = buildTestApp();
    const [tab] = await writeGroupFixture('group-6', ['Moving Chat']);
    const save = (chat, from) => postJson(app, '/api/chats/group/save', { id: 'Moving Chat', group_id: 'group-6', chat }, from);
    const [seed] = (await chatNamed({ group: 'group-6' }, 'Moving Chat', tab)).messages;

    const other = newSessionKey();
    const saved = await save([chatHeader({ note_prompt: 'kept' }), { ...seed, mes: 'seed, edited' }, charMsg('more')], other);
    assert.equal(saved.status, 200);
    assert.equal(saved.data.chat_id, 'Moving Chat');
    assert.equal(saved.data.not_saved, undefined);
    const shown = await chatNamed({ group: 'group-6' }, 'Moving Chat', tab);
    assert.deepEqual(shown.messages.map(m => m.mes), ['seed, edited', 'more']);
    assert.equal(shown.messages[0].node_id, seed.node_id);
    assert.equal(shown.metadata.note_prompt, 'kept');

    const without = await save([chatHeader({ note_prompt: 'kept' })], other);
    assert.deepEqual(without.data.not_deleted, shown.messages.map(m => m.node_id));
    assert.deepEqual((await chatNamed({ group: 'group-6' }, 'Moving Chat', tab)).messages.map(m => m.mes), ['seed, edited', 'more']);
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
