import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';
import { fakeOwners } from './chat-test-people.js';

const { ChatEngine } = await import('./chat-engine.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-start-test-'));
/** @type {any[]} */
const stores = [];
after(async () => {
    for (const store of stores) await store.close();
    fs.rmSync(root, { recursive: true, force: true });
});

const cara = { id: 1n, name: 'Cara', avatar: 'cara.png' };
const people = {
    speakers: async (/** @type {bigint[]} */ ids) => new Map(ids.filter(id => id === cara.id).map(id => [id, cara])),
    byAvatar: async (/** @type {string[]} */ avatars) => new Map(avatars.filter(a => a === cara.avatar).map(a => [a, cara])),
};
people.owners = fakeOwners(people);
const msg = (/** @type {boolean} */ isUser, /** @type {string} */ mes) => ({ name: isUser ? 'You' : 'Cara', is_user: isUser, is_system: false, mes, extra: {} });

const engine = loadEngine().binding;
let n = 0;

async function chatWithReply() {
    const store = await engine.Store.open(path.join(root, String(n++)));
    stores.push(store);
    const chats = await ChatEngine.open(store, people);
    const t = cara.id;
    const actor = { user: 'tester', session: `0190a1b2-0000-7000-8000-0000000000${String(n).padStart(2, '0')}` };
    const [greeting] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: null, contents: [msg(false, 'Hello there!')], actor: { user: actor.user } })).node_ids;
    await chats.select({ tree: t, node_id: greeting, actor });
    const [, reply] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: greeting, contents: [msg(true, 'Hi Cara.'), msg(false, 'How are you?')], actor })).node_ids;
    const before = await chats.compatChatId(actor.session, actor.session, t);
    const list = async () => (await chats.chatList({ tree: t, session: actor.session, limit: 10 })).rows;
    return { chats, t, actor, greeting, reply, before, list };
}

test('a new chat creates no bookmark and retains messages', async () => {
    const { chats, t, actor, greeting, reply, before, list } = await chatWithReply();
    const started = await chats.startChat({ tree: t, actor, node_id: greeting });
    assert.ok(started.ok);
    assert.equal((await list()).some(r => r.name === before), false);
    assert.deepEqual((await chats.bookmarks({ tree: t, limit: 10 })).rows, []);
    assert.equal(await chats.compatChatId(actor.session, actor.session, t), started.name);
    assert.equal((await chats.pointer(actor.session)).at, greeting);
    assert.equal((await chats.load({ tree: t, at: reply })).messages.at(-1).mes, 'How are you?');
});

test('a new chat retains a manually saved bookmark', async () => {
    const { chats, t, actor, reply } = await chatWithReply();
    const made = await chats.createBookmark({ tree: t, node_id: reply, name: 'Saved by me', actor });
    assert.ok(made.ok);
    await chats.setCurrentChat({ tree: t, bookmark: String(made.bookmark), actor });
    assert.ok((await chats.startChat({ tree: t, actor })).ok);
    const rows = (await chats.bookmarks({ tree: t, limit: 10 })).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Saved by me');
    assert.equal(rows[0].at, reply);
    assert.equal((await chats.pointer(actor.session)).at, null);
});

test('a new chat from a conversation still at its opening keeps nothing', async () => {
    const { chats, t, actor, greeting, list } = await chatWithReply();
    const first = await chats.startChat({ tree: t, actor, node_id: greeting });
    assert.ok(first.ok);
    const count = (await list()).length;
    const second = await chats.startChat({ tree: t, actor, node_id: greeting });
    assert.ok(second.ok);
    assert.equal((await list()).length, count);
});
