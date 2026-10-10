// Chats on the engine answer as the old tree store does (build path 5b), where an old answer exists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';

const tree = await import('./message-tree-db.js');
const { ChatEngine, MODE } = await import('./chat-engine.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-engine-test-'));
const directories = { root };
after(() => {
    tree.disposeMessageTreeStores();
    fs.rmSync(root, { recursive: true, force: true });
});

const cara = { id: 1n, name: 'Cara', avatar: 'cara.png' };
const people = {
    speakers: async ids => new Map(ids.filter(id => id === cara.id).map(id => [id, cara])),
    byAvatar: async avatars => new Map(avatars.filter(a => a === cara.avatar).map(a => [a, cara])),
};
const actor = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000aa' };

const greeting = { name: 'Cara', is_user: false, is_system: false, send_date: '2025-10-10T10:00:00.000Z', mes: 'Hello!', extra: {} };
const user1 = { name: 'You', is_user: true, is_system: false, send_date: '2025-10-10T10:01:00.000Z', mes: 'Hi Cara.', extra: { isSmallSys: false } };
const bot1 = { name: 'Cara', is_user: false, mes: 'How are you?', extra: { api: 'openai', model: 'm' }, send_date: '2025-10-10T10:02:00.000Z' };
const bot1b = { name: 'Cara', is_user: false, mes: 'What brings you here?', extra: {}, send_date: '2025-10-10T10:03:00.000Z' };
const user2 = { name: 'You', is_user: true, is_system: false, send_date: '2025-10-10T10:04:00.000Z', mes: 'Just visiting.', extra: {} };
const inserted = { name: 'You', is_user: true, is_system: false, send_date: '2025-10-10T10:05:00.000Z', mes: '(an aside)', extra: {} };

/**
 * A loaded path with every message's ids replaced by the name it was made under, `branches` left out (their
 * meaning changed: the bookmarks made at a message, not the labels below a fork).
 */
function normalized(messages, names) {
    return messages.map(m => {
        const out = structuredClone(m);
        out.node_id = names.get(m.node_id) ?? m.node_id;
        if (out.extra) delete out.extra.branches;
        if (Array.isArray(out.swipe_info)) {
            for (const i of out.swipe_info) {
                i.node_id = names.get(i.node_id) ?? i.node_id;
                if (i.extra) delete i.extra.branches;
            }
        }
        return out;
    });
}

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: a conversation built both ways loads the same`, async () => {
        const owner = `cara-${kind}`;
        const store = await engine.Store.open(path.join(root, `engine-${kind}`));
        const chats = await ChatEngine.open(store, people);
        let clock = 1_760_090_000_000;
        chats.now = () => (clock += 1000);
        const oldNames = new Map();
        const newNames = new Map();
        const name = (oldId, newId, n) => {
            oldNames.set(oldId, n);
            newNames.set(newId, n);
        };
        const t = cara.id;

        // The greeting opens the tree; the user and the reply are sent through the session.
        const [og] = (await tree.addOpeningAlternatives(directories, owner, [greeting])).node_ids;
        const ng = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: null, contents: [greeting], actor: { user: actor.user } })).node_ids[0];
        name(og, ng, 'greeting');
        // The old store follows the greeting as the anchor's default; the session chooses it here.
        await chats.select({ tree: t, node_id: ng, actor });
        const old1 = await tree.appendMessages(directories, owner, og, [user1, bot1], { sendKeys: ['k1', null] });
        const new1 = await chats.appendMessages({ tree: t, treeSpeaker: cara, after: ng, contents: [user1, bot1], sendKeys: ['k1', null], actor });
        name(old1.node_ids[0], new1.node_ids[0], 'user1');
        name(old1.node_ids[1], new1.node_ids[1], 'bot1');
        // A retried send is answered with what was stored; the same reply again is that reply.
        const retryOld = await tree.appendMessages(directories, owner, og, [user1], { sendKeys: ['k1'] });
        const retryNew = await chats.appendMessages({ tree: t, treeSpeaker: cara, after: ng, contents: [user1], sendKeys: ['k1'], actor });
        assert.deepEqual(retryNew.already_stored, [new1.node_ids[0]]);
        assert.deepEqual(retryOld.already_stored, [old1.node_ids[0]]);
        const twinNew = await chats.appendMessages({ tree: t, treeSpeaker: cara, after: new1.node_ids[0], contents: [bot1], actor });
        assert.deepEqual(twinNew.node_ids, [new1.node_ids[1]]);

        // An alternative reply, added and then chosen.
        const [ob] = (await tree.addAlternatives(directories, owner, old1.node_ids[1], [bot1b])).node_ids;
        const nb = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: new1.node_ids[0], contents: [bot1b], actor: { user: actor.user } })).node_ids[0];
        name(ob, nb, 'bot1b');
        await tree.selectDefaultChild(directories, ob);
        await chats.select({ tree: t, node_id: nb, actor });
        const old2 = await tree.appendMessages(directories, owner, ob, [user2]);
        const new2 = await chats.appendMessages({ tree: t, treeSpeaker: cara, after: nb, contents: [user2], actor });
        name(old2.node_ids[0], new2.node_ids[0], 'user2');

        const compare = async (label) => {
            const o = await tree.loadAtNode(directories, owner, og);
            const n = await chats.load({ tree: t, at: ng, session: actor.session, user: actor.user });
            assert.deepEqual(normalized(n.messages, newNames), normalized(o.messages, oldNames), label);
        };
        await compare('after sends, a retry, an alternative and a choice');

        // An edit of the reply's text and of an extra key.
        const edited = { ...bot1b, mes: 'What brings you here, traveler?', extra: { api: 'x' } };
        await tree.editMessage(directories, owner, ob, edited);
        assert.deepEqual((await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: nb, content: edited }], actor })).refused, []);
        await compare('after an edit');
        // Blanking stored text and matching a sibling are refused.
        const refused = await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: nb, content: { ...edited, mes: '' } }, { node_id: nb, content: bot1 }], actor });
        assert.deepEqual(refused.refused.map(r => r.reason), ['refused to blank stored text', 'an alternative with this text already exists']);

        // The stats count as the old store's (chat size aside: its meaning changed; and before any move, which the
        // old store's swap doesn't count).
        const oldStats = (await tree.readMessageStats(directories, [owner])).owners.get(owner);
        const { owners: [newStats] } = await store.chatRead('stats', { owners: [t] });
        assert.deepEqual(
            { user: newStats.userMsgs, char: newStats.charMsgs, userWords: newStats.userWords, charWords: newStats.charWords, swipes: newStats.swipes },
            { user: oldStats.user_msgs, char: oldStats.char_msgs, userWords: oldStats.user_words, charWords: oldStats.char_words, swipes: oldStats.swipes },
        );
        // A message grafted between the reply and the user's answer, then taken out again, then the two swapped.
        const og2 = await tree.graftMessage(directories, owner, ob, old2.node_ids[0], inserted);
        const ng2 = await chats.graftMessage({ tree: t, treeSpeaker: cara, after: nb, before: new2.node_ids[0], content: inserted, actor });
        name(og2.node_id, ng2.node_id, 'inserted');
        await compare('after a graft');
        assert.deepEqual(await chats.degraftRange({ tree: t, first: ng2.node_id, last: ng2.node_id, actor }), { ok: true });
        await tree.degraftMessage(directories, owner, og2.node_id);
        await compare('after a degraft');
        await tree.swapAdjacent(directories, owner, ob, old2.node_ids[0]);
        assert.deepEqual(await chats.swapAdjacent({ tree: t, upper: nb, lower: new2.node_ids[0], actor }), { ok: true });

        // A bookmark at the first reply: its name is the message's bookmark_link, and in `branches` there.
        await tree.labelNode(directories, old1.node_ids[1], 'Checkpoint', { ownerId: owner });
        await chats.createBookmark({ tree: t, node_id: new1.node_ids[1], name: 'Checkpoint', mode: MODE.pinned, actor });
        const atFirst = await chats.load({ tree: t, at: new1.node_ids[1], session: actor.session, user: actor.user });
        const reply = atFirst.messages.find(m => m.node_id === new1.node_ids[1]);
        assert.equal(reply.extra.bookmark_link, 'Checkpoint');
        assert.deepEqual(reply.extra.branches, ['Checkpoint']);
        const oldAtFirst = await tree.loadAtNode(directories, owner, old1.node_ids[1]);
        assert.deepEqual(normalized(atFirst.messages, newNames).map(m => { delete m.extra?.bookmark_link; return m; }),
            normalized(oldAtFirst.messages, oldNames).map(m => { delete m.extra?.bookmark_link; return m; }));

        // An alternative nothing continues goes; the one shown, or one with replies, doesn't.
        assert.deepEqual(await chats.deleteAlternative({ tree: t, node_id: nb, actor }), { ok: false, reason: 'is default' });
        assert.deepEqual(await chats.deleteAlternative({ tree: t, node_id: new1.node_ids[1], actor }), { ok: false, reason: 'labeled' });

        // Metadata keys set and removed at a position, variables each their own.
        await chats.mergeMetadata({ tree: t, at: new1.node_ids[1], set: { note_prompt: 'A', variables: { hp: 3 } }, unset: [], actor });
        await chats.mergeMetadata({ tree: t, at: nb, set: { note_prompt: 'B', variables: { hp: 2, mp: 1 } }, unset: [], actor });
        assert.deepEqual(await chats.metadata(t, (await chats.messageIds([nb]))[0]), { note_prompt: 'B', variables: { hp: 2, mp: 1 } });
        assert.deepEqual(await chats.metadata(t, (await chats.messageIds([new1.node_ids[1]]))[0]), { note_prompt: 'A', variables: { hp: 3 } });
        await chats.mergeMetadata({ tree: t, at: nb, set: {}, unset: ['note_prompt', 'variables'], actor });
        assert.deepEqual(await chats.metadata(t, (await chats.messageIds([nb]))[0]), {});

        await store.close();
    });
}
