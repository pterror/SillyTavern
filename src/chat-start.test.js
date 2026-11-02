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

test('a new chat keeps the conversation it leaves as a chat of its own, under its name and where it was', async () => {
    const { chats, t, actor, greeting, reply, before, list } = await chatWithReply();
    const started = await chats.startChat({ tree: t, actor, node_id: greeting });
    assert.ok(started.ok);
    assert.equal(started.kept, before);
    assert.notEqual(started.name, before);
    const rows = await list();
    const kept = rows.find(r => r.name === before);
    assert.ok(kept, `listed: ${JSON.stringify(rows.map(r => r.name ?? r.session))}`);
    assert.equal(kept.last_mes, 'How are you?');
    assert.equal(kept.at, reply);
    assert.equal(await chats.compatChatId(actor.session, actor.session, t), started.name);
    const found = await chats.resolveChatName({ tree: t, name: before });
    assert.ok(found !== null && 'bookmark' in found);
});

test('a new chat that replaces the current one leaves nothing behind', async () => {
    const { chats, t, actor, greeting, before, list } = await chatWithReply();
    const started = await chats.startChat({ tree: t, actor, node_id: greeting, keep: false });
    assert.ok(started.ok);
    assert.equal(started.kept, null);
    assert.equal((await list()).some(r => r.name === before), false);
});

test('a new chat from a conversation still at its opening keeps nothing', async () => {
    const { chats, t, actor, greeting, list } = await chatWithReply();
    const first = await chats.startChat({ tree: t, actor, node_id: greeting });
    assert.ok(first.ok);
    const count = (await list()).length;
    const second = await chats.startChat({ tree: t, actor, node_id: greeting });
    assert.ok(second.ok);
    assert.equal(second.kept, null);
    assert.equal((await list()).length, count);
});
