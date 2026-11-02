import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../../engine/load.js';
import { fakeOwners } from '../chat-test-people.js';

const { ChatEngine } = await import('../chat-engine.js');
const { findOrphans, recoverOrphans } = await import('./new-chat-orphans.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'new-chat-orphans-test-'));
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
const USER = 'tester';
let n = 0;

/**
 * @param {any} chats
 * @param {{ tree: bigint, actor: any, node_id?: string | null }} p
 */
async function oldStartChat(chats, { tree, actor, node_id = null }) {
    if (node_id !== null) await chats.goTo({ tree, node_id, actor });
    else await chats.chooseCardGreeting({ tree, index: 0, actor });
    await chats.setCurrentChat({ tree, bookmark: null, actor });
    return chats.nameConversation({ tree, name: null, actor });
}

async function chatWithReply() {
    const store = await engine.Store.open(path.join(root, String(n++)));
    stores.push(store);
    const chats = await ChatEngine.open(store, people);
    const t = cara.id;
    const actor = { user: USER, session: `0190a1b2-0000-7000-8000-0000000000${String(n).padStart(2, '0')}` };
    const [greeting] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: null, contents: [msg(false, 'Hello there!')], actor: { user: actor.user } })).node_ids;
    await chats.select({ tree: t, node_id: greeting, actor });
    const [, reply] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: greeting, contents: [msg(true, 'Hi Cara.'), msg(false, 'How are you?')], actor })).node_ids;
    const list = async () => (await chats.chatList({ tree: t, session: actor.session, limit: 50 })).rows;
    return { store, chats, t, actor, greeting, reply, list };
}

const quiet = () => {};

test('a chat a new chat left (to the opening message) comes back as a bookmark with all its messages; a second run adds nothing', async () => {
    const { chats, t, actor, greeting, reply, list } = await chatWithReply();
    await oldStartChat(chats, { tree: t, actor, node_id: greeting });
    await chats.appendMessages({ tree: t, treeSpeaker: cara, after: greeting, contents: [msg(true, 'A new start.')], actor });
    const before = await list();
    assert.equal(before.some(r => r.at === reply), false);

    const dry = await recoverOrphans({ chats, user: USER, apply: false, log: quiet });
    assert.deepEqual(dry, { trees: 1, bookmarks: 1 });
    assert.deepEqual((await list()).map(r => r.name), before.map(r => r.name));

    const done = await recoverOrphans({ chats, user: USER, apply: true, log: quiet });
    assert.deepEqual(done, { trees: 1, bookmarks: 1 });
    const back = (await list()).find(r => r.at === reply);
    assert.ok(back, `listed: ${JSON.stringify((await list()).map(r => [r.name, r.at]))}`);
    assert.equal(back.last_mes, 'How are you?');
    assert.match(back.name, /^Cara - /);
    const found = await chats.resolveChatName({ tree: t, name: back.name });
    assert.ok(found !== null && 'bookmark' in found);
    assert.deepEqual((await chats.pathIds(t, reply))?.length, 3);

    assert.deepEqual(await recoverOrphans({ chats, user: USER, apply: true, log: quiet }), { trees: 0, bookmarks: 0 });
});

test('a chat a new chat left by moving to the root comes back too', async () => {
    const { chats, t, actor, reply, list } = await chatWithReply();
    await oldStartChat(chats, { tree: t, actor });
    await recoverOrphans({ chats, user: USER, apply: true, log: quiet });
    assert.ok((await list()).some(r => r.at === reply));
});

test('an abandoned alternative is never brought back', async () => {
    const { chats, t, actor, reply, list } = await chatWithReply();
    const [, userId] = /** @type {bigint[]} */ (await chats.pathIds(t, reply));
    const [userNode] = await chats.externalIds([userId]);
    const [other] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: userNode, contents: [msg(false, 'Something else.')], actor })).node_ids;
    await chats.select({ tree: t, node_id: other, actor });
    assert.deepEqual(await findOrphans(chats), new Map());
    assert.deepEqual(await recoverOrphans({ chats, user: USER, apply: true, log: quiet }), { trees: 0, bookmarks: 0 });
    assert.equal((await list()).some(r => r.at === reply), false);
});

test('a new chat since 81e775e8e already kept its chat: nothing to bring back', async () => {
    const { chats, t, actor, greeting } = await chatWithReply();
    const started = await chats.startChat({ tree: t, actor, node_id: greeting });
    assert.ok(started.ok && started.kept !== null);
    assert.deepEqual(await recoverOrphans({ chats, user: USER, apply: false, log: quiet }), { trees: 0, bookmarks: 0 });
});

test('choosing the greeting lands at the end of its branch, so it leaves nothing behind', async () => {
    const { chats, t, actor, greeting } = await chatWithReply();
    await chats.select({ tree: t, node_id: greeting, actor });
    assert.deepEqual(await findOrphans(chats), new Map());
});

test('opening a chat that sits at its opening leaves the conversation the same way, and it is found', async () => {
    const { chats, t, actor, greeting, reply } = await chatWithReply();
    await chats.goTo({ tree: t, node_id: greeting, actor });
    const found = await findOrphans(chats);
    assert.deepEqual([...found.values()].flat().map(c => c.at), await chats.messageIds([reply]));
});

test('the dry run writes nothing', async () => {
    const { store, chats, t, actor, greeting } = await chatWithReply();
    await oldStartChat(chats, { tree: t, actor, node_id: greeting });
    const statsBefore = JSON.stringify(await store.chatRead('nextIds', {}), (_, v) => typeof v === 'bigint' ? String(v) : v);
    await recoverOrphans({ chats, user: USER, apply: false, log: quiet });
    const statsAfter = JSON.stringify(await store.chatRead('nextIds', {}), (_, v) => typeof v === 'bigint' ? String(v) : v);
    assert.equal(statsAfter, statsBefore);
    assert.equal((await findOrphans(chats)).size, 1);
});
