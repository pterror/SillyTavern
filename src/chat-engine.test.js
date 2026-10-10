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
const ivy = { id: 2n, name: 'Ivy', avatar: 'ivy.png' };
const ivyPeople = {
    speakers: async ids => new Map(ids.filter(id => id === ivy.id).map(id => [id, ivy])),
    byAvatar: async avatars => new Map(avatars.filter(a => a === ivy.avatar).map(a => [a, ivy])),
};

const greeting = { name: 'Cara', is_user: false, is_system: false, send_date: '2025-10-10T10:00:00.000Z', mes: 'Hello!', extra: {} };
const user1 = { name: 'You', is_user: true, is_system: false, send_date: '2025-10-10T10:01:00.000Z', mes: 'Hi Cara.', extra: { isSmallSys: false } };
const bot1 = { name: 'Cara', is_user: false, mes: 'How are you?', extra: { api: 'openai', model: 'm' }, send_date: '2025-10-10T10:02:00.000Z' };
const bot1b = { name: 'Cara', is_user: false, mes: 'What brings you here?', extra: {}, send_date: '2025-10-10T10:03:00.000Z' };
const user2 = { name: 'You', is_user: true, is_system: false, send_date: '2025-10-10T10:04:00.000Z', mes: 'Just visiting.', extra: {} };
const inserted = { name: 'You', is_user: true, is_system: false, send_date: '2025-10-10T10:05:00.000Z', mes: '(an aside)', extra: {} };

/**
 * A loaded path with every message's ids replaced by the name it was made under.
 */
function normalized(messages, names) {
    return messages.map(m => {
        const out = structuredClone(m);
        out.node_id = names.get(m.node_id) ?? m.node_id;
        for (const i of Array.isArray(out.swipe_info) ? out.swipe_info : []) i.node_id = names.get(i.node_id) ?? i.node_id;
        return out;
    });
}

/**
 * What the old store's answer means for `branches` now: the old store listed, at a fork, the labels anywhere below
 * it; a message's `branches` are now the bookmarks made at it, so a labeled message lists its own label.
 */
function withBranchesOfLabels(messages) {
    return messages.map(m => {
        const out = structuredClone(m);
        if (out.extra && typeof out.extra === 'object') {
            delete out.extra.branches;
            if (typeof out.extra.bookmark_link === 'string') {
                const { bookmark_link: link, ...rest } = out.extra;
                const flagged = Object.hasOwn(rest, tree.ITEMIZED_PROMPT_FLAG);
                delete rest[tree.ITEMIZED_PROMPT_FLAG];
                out.extra = { ...rest, bookmark_link: link, branches: [link], ...(flagged ? { [tree.ITEMIZED_PROMPT_FLAG]: true } : {}) };
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

        // The old store shows the default path from the greeting; the session shows the path to its pointer.
        const compare = async (label) => {
            const o = await tree.loadAtNode(directories, owner, og);
            const { at } = await chats.pointer(actor.session);
            const n = await chats.load({ tree: t, at });
            assert.deepEqual(normalized(n.messages, newNames), normalized(withBranchesOfLabels(o.messages), oldNames), label);
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
        await compare('after a swap');
        // A bookmark on the shown path: the old label and the new bookmark name the same message.
        await tree.labelNode(directories, old1.node_ids[0], 'Saved here', { ownerId: owner });
        await chats.createBookmark({ tree: t, node_id: new1.node_ids[0], name: 'Saved here', actor });
        await compare('after a bookmark on the path');

        // A bookmark at the first reply: its name is the message's bookmark_link, and in `branches` there.
        await tree.labelNode(directories, old1.node_ids[1], 'Checkpoint', { ownerId: owner });
        await chats.createBookmark({ tree: t, node_id: new1.node_ids[1], name: 'Checkpoint', mode: MODE.pinned, actor });
        const atFirst = await chats.load({ tree: t, at: new1.node_ids[1] });
        const reply = atFirst.messages.find(m => m.node_id === new1.node_ids[1]);
        assert.equal(reply.extra.bookmark_link, 'Checkpoint');
        assert.deepEqual(reply.extra.branches, ['Checkpoint']);
        // Opened at the bookmark, the path is the same; the old store hid the opened chat's own label there, and a
        // bookmark isn't a chat, so the new one shows it (checked above).
        const oldAtFirst = await tree.loadAtNode(directories, owner, old1.node_ids[1]);
        const withoutLast = ms => ms.map((m, i) => {
            if (i === ms.length - 1) {
                delete m.extra?.bookmark_link;
                delete m.extra?.branches;
            }
            return m;
        });
        assert.deepEqual(withoutLast(normalized(atFirst.messages, newNames)), withoutLast(normalized(withBranchesOfLabels(oldAtFirst.messages), oldNames)));

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
        // An empty `variables` object stays one.
        await chats.mergeMetadata({ tree: t, at: nb, set: { variables: {} }, unset: [], actor });
        assert.deepEqual(await chats.metadata(t, (await chats.messageIds([nb]))[0]), { variables: {} });

        // The session a request acts through: its header's, a new tab's, a stale tab's (deleted), a third party's.
        const handle = actor.user;
        assert.deepEqual(await chats.resolveSession({ tree: t, user: handle, header: actor.session }), { session: actor.session });
        assert.deepEqual(await chats.resolveSession({ tree: t, user: handle, header: undefined }), { session: actor.session });
        const fresh = '0190a1b2-0000-7000-8000-0000000000bb';
        assert.deepEqual(await chats.resolveSession({ tree: t, user: handle, header: fresh }), { session: fresh });
        const v5 = (await chats.resolveSession({ tree: t, user: handle, header: 'none' })).session;
        const [sid] = await store.chatRead('ids', { space: 1, keys: [actor.session] });
        await store.commit([{ kind: 'positionDelete', id: sid }]);
        assert.deepEqual(await chats.resolveSession({ tree: t, user: handle, header: actor.session }), { session: v5, gone: true });

        await store.close();
    });

    test(`${kind}: openings and alternatives answer as the old store's`, async () => {
        const owner = `ivy-${kind}`;
        const store = await engine.Store.open(path.join(root, `engine-openings-${kind}`));
        const chats = await ChatEngine.open(store, ivyPeople);
        let clock = 1_760_090_000_000;
        chats.now = () => (clock += 1000);
        const t = ivy.id;
        const names = new Map();
        const nameAll = (oldIds, newIds, labels) => oldIds.forEach((o, i) => {
            if (o !== null) names.set(o, labels[i]);
            if (newIds[i] !== null) names.set(newIds[i], labels[i]);
        });
        const mapped = value => JSON.parse(JSON.stringify(value), (_, v) => (typeof v === 'string' ? names.get(v) ?? v : v));

        // Openings added (a blank one left out), then again with one already there.
        const g = n => ({ name: 'Ivy', is_user: false, is_system: false, send_date: `2025-10-10T10:0${n}:00.000Z`, mes: `Greeting ${n}`, extra: {} });
        const blank = { ...g(9), mes: '   ' };
        const old1 = await tree.addOpeningAlternatives(directories, owner, [g(1), g(2), blank]);
        const new1 = await chats.addOpenings({ tree: t, treeSpeaker: ivy, contents: [g(1), g(2), blank], actor: { user: actor.user } });
        nameAll(old1.node_ids, new1.node_ids, ['g1', 'g2', null]);
        assert.deepEqual(mapped(new1), mapped(old1));
        const old2 = await tree.addOpeningAlternatives(directories, owner, [g(2), g(3)]);
        const new2 = await chats.addOpenings({ tree: t, treeSpeaker: ivy, contents: [g(2), g(3)], actor: { user: actor.user } });
        nameAll(old2.node_ids, new2.node_ids, ['g2', 'g3']);
        assert.deepEqual(mapped(new2), mapped(old2));
        // Nothing is shown by adding them, and nothing is written for openings already there.
        assert.equal(await chats.pointer(actor.session), null);
        const before = await store.chatRead('nextIds', {});
        await chats.addOpenings({ tree: t, treeSpeaker: ivy, contents: [g(1)], actor: { user: actor.user } });
        assert.deepEqual(await store.chatRead('nextIds', {}), before);

        // The second chosen in both; the card's greetings merged in after the stored ones.
        await tree.selectDefaultChild(directories, old1.node_ids[1]);
        await chats.select({ tree: t, node_id: new1.node_ids[1], actor });
        const card = [g(1), g(4), g(5), g(6)];
        const sameAsOld = async (range, label) => {
            const o = await tree.getOpeningAlternatives(directories, owner, range, card);
            const n = await chats.openingAlternatives({ tree: t, actor, range, cardGreetings: card });
            // A chat is a session with activity in the tree now; the old store's were labels.
            assert.equal(n.has_saved_chats, true);
            assert.deepEqual(mapped({ ...n, has_saved_chats: o.has_saved_chats }), mapped(o), label);
        };
        await sameAsOld({}, 'the default window');
        await sameAsOld({ offset: 2, limit: 3 }, 'a window');
        await sameAsOld({ limit: 2, around: g(3) }, 'around a stored opening');
        await sameAsOld({ limit: 2, around: g(5) }, 'around a card greeting (the default)');

        // A card greeting chosen is stored and shown, as the select action stores it.
        await tree.chooseCardOpening(directories, owner, g(5).mes, 2);
        const [n5] = (await chats.appendMessages({ tree: t, treeSpeaker: ivy, after: null, contents: [g(5)], actor })).node_ids;
        const oChosen = await tree.getOpeningAlternatives(directories, owner, {}, card);
        const nChosen = await chats.openingAlternatives({ tree: t, actor, cardGreetings: card });
        assert.equal(nChosen.default_node_id, n5);
        assert.equal(nChosen.alternatives[nChosen.default_index - nChosen.offset].mes, oChosen.alternatives[oChosen.default_index - oChosen.offset].mes);
        assert.deepEqual((await chats.load({ tree: t, at: (await chats.pointer(actor.session)).at })).messages.map(m => m.mes), [g(5).mes]);
        // Another user, with no session there, is shown where the last choice was made.
        assert.equal((await chats.openingAlternatives({ tree: t, actor: { user: 'someone' }, cardGreetings: card })).default_node_id, n5);

        // Where a chat showing a card greeting lands, with the fifth stored in both.
        names.set((await tree.addOpeningAlternatives(directories, owner, [g(5)])).node_ids[0], 'g5');
        names.set(n5, 'g5');
        const card2 = [g(1), g(4), g(6)];
        for (const request of [
            { shownText: g(3).mes, index: 0, edits: [] },
            { shownText: 'gone', index: 2, edits: [{ from: 'gone', to: g(4).mes }] },
            { shownText: 'gone', index: 1, edits: [{ from: 'gone', to: 'elsewhere', index: 2 }] },
            { shownText: 'gone', index: 40, edits: [] },
        ]) {
            const o = await tree.findOpeningToLandOn(directories, owner, card2, card2.map(c => c.mes), request);
            const n = await chats.openingToLandOn({ tree: t, cardGreetings: card2, cardTexts: card2.map(c => c.mes), request });
            assert.deepEqual(mapped(n), mapped(o), JSON.stringify(request));
        }

        // A reply's alternatives, windowed.
        const r = n => ({ name: 'Ivy', is_user: false, send_date: `2025-10-10T11:0${n}:00.000Z`, mes: `Reply ${n}`, extra: { n } });
        const [o0] = (await tree.appendMessages(directories, owner, old1.node_ids[1], [r(0)])).node_ids;
        // The old store orders replies by the time it stored them, then by their random ids.
        await new Promise(resolve => setTimeout(resolve, 5));
        const oldReplies = await tree.addAlternatives(directories, owner, o0, [r(1), r(2)]);
        const [n0] = (await chats.appendMessages({ tree: t, treeSpeaker: ivy, after: new1.node_ids[1], contents: [r(0)], actor })).node_ids;
        const newReplies = (await chats.appendMessages({ tree: t, treeSpeaker: ivy, after: new1.node_ids[1], contents: [r(1)], actor: { user: actor.user } })).node_ids
            .concat((await chats.appendMessages({ tree: t, treeSpeaker: ivy, after: new1.node_ids[1], contents: [r(2)], actor: { user: actor.user } })).node_ids);
        names.set(o0, 'r0');
        names.set(n0, 'r0');
        nameAll(oldReplies.node_ids, newReplies, ['r1', 'r2']);
        for (const [range, at] of [[{}, 1], [{ offset: 1, limit: 1 }, 2], [{ limit: 0 }, 0]]) {
            const o = await tree.getAlternatives(directories, at === 0 ? o0 : oldReplies.node_ids[at - 1], range);
            const n = await chats.alternatives({ node_id: at === 0 ? n0 : newReplies[at - 1], ...range });
            assert.deepEqual(mapped(n), mapped(o), JSON.stringify(range));
        }
        // An opening's alternatives are the tree's openings.
        assert.deepEqual((await chats.alternatives({ node_id: new1.node_ids[0] })).alternatives.map(a => a.mes), ['Greeting 1', 'Greeting 2', 'Greeting 3', 'Greeting 5']);
        assert.equal(await chats.alternatives({ node_id: 'no such message' }), null);

        await store.close();
    });
}
