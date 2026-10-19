// A tree's edits on the engine (build path 5b addendum): the deletes and the two cuts, each removing only what
// belongs to the path alone; swiping; a new chat's greeting; bookmark names unique in a tree and a route's chat name.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';

const { ChatEngine, MODE, bookmarkCompatId } = await import('./chat-engine.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-edits-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cara = { id: 1n, name: 'Cara', avatar: 'cara.png' };
const people = {
    speakers: async (/** @type {bigint[]} */ ids) => new Map(ids.filter(id => id === cara.id).map(id => [id, cara])),
    byAvatar: async (/** @type {string[]} */ avatars) => new Map(avatars.filter(a => a === cara.avatar).map(a => [a, cara])),
};
const a = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000b1' };
const b = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000b2' };
const msg = (/** @type {string} */ mes) => ({ name: mes.startsWith('u') ? 'You' : 'Cara', is_user: mes.startsWith('u'), is_system: false, mes, extra: {} });

let n = 0;
/**
 * A fresh store and tree. `build` adds messages: `send(after, texts, actor)` appends through the actor's session
 * (null after: openings) and answers the ids by text.
 * @param {any} engine
 */
async function fresh(engine) {
    const store = await engine.Store.open(path.join(root, `s${n++}`));
    const chats = await ChatEngine.open(store, people);
    let clock = 1_760_090_000_000;
    chats.now = () => (clock += 1000);
    const t = cara.id;
    /** @type {Record<string, string>} */
    const id = {};
    const send = async (/** @type {string | null} */ after, /** @type {string[]} */ texts, actor = a) => {
        const ids = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: after === null ? null : id[after], contents: texts.map(msg), actor })).node_ids;
        texts.forEach((x, i) => (id[x] = ids[i]));
    };
    const shown = async (/** @type {any} */ actor) => {
        const at = (await chats.pointer(actor.session))?.at ?? null;
        const loaded = await chats.load({ tree: t, at });
        return loaded.messages.map(m => m.mes);
    };
    const replies = async (/** @type {string | null} */ of) => {
        const s = of === null ? null : (await chats.stored((await chats.messageIds([id[of]])).filter(x => x !== null))).values().next().value;
        const kids = await chats.children(t, of === null ? null : s.id);
        const stored = await chats.stored(kids);
        return (await chats.decoded(kids.map(k => stored.get(k)))).map(m => m.mes);
    };
    return { store, chats, t, id, send, shown, replies };
}

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: the deletes remove only what belongs to the path`, async () => {
        // g - u1 - b1 - u2 - b2 (a), and b's branch b1x - u2x under u1.
        const { store, chats, t, id, send, shown, replies } = await fresh(engine);
        await send(null, ['g']);
        await send('g', ['u1', 'b1', 'u2', 'b2']);
        await send('u1', ['b1x', 'u2x'], b);

        // Delete this path from u2: u2 and b2 go, a moves to b1.
        assert.deepEqual(await chats.deletePath({ tree: t, node_id: id.u2, actor: a }), { ok: true });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1']);
        assert.deepEqual(await replies('b1'), []);
        // From g, only what is the path's alone: b1 (u1 has b's branch under it too).
        assert.deepEqual(await chats.deletePath({ tree: t, node_id: id.g, actor: a }), { ok: true });
        assert.deepEqual(await shown(a), ['g', 'u1']);
        assert.deepEqual(await replies('u1'), ['b1x']);
        assert.deepEqual(await shown(b), ['g', 'u1', 'b1x', 'u2x']);
        // A message not on the session's path is refused.
        assert.deepEqual(await chats.deletePath({ tree: t, node_id: id.u2x, actor: a }), { ok: false, reason: 'not on the path' });
        // Its path ends at u1, which has b's branch below: nothing is its alone.
        assert.deepEqual(await chats.deletePath({ tree: t, node_id: id.u1, actor: a }), { ok: true });
        assert.deepEqual(await replies('u1'), ['b1x']);

        // Delete all descendants but keep the message: b's branch goes, b moves up to u1.
        await send('u1', ['b1y']);
        assert.deepEqual(await chats.deleteBelow({ tree: t, node_id: id.u1, actor: a }), { ok: true });
        assert.deepEqual(await replies('u1'), []);
        assert.deepEqual(await shown(b), ['g', 'u1']);
        assert.deepEqual(await shown(a), ['g', 'u1']);

        // Delete this swipe and below, and every swipe at a position and below.
        await send('u1', ['c1', 'c2']);
        await send('u1', ['d1', 'd2'], b);
        assert.deepEqual(await chats.deleteSubtree({ tree: t, node_id: id.c1, actor: a }), { ok: true });
        assert.deepEqual(await replies('u1'), ['d1']);
        assert.deepEqual(await shown(a), ['g', 'u1'], 'the session moves to the nearest message left above');
        assert.deepEqual(await chats.deleteAlternatives({ tree: t, node_id: id.d1, actor: a }), { ok: true });
        assert.deepEqual(await replies('u1'), []);
        // Every opening: the whole tree; the sessions are at its root, and nothing is saved.
        assert.deepEqual(await chats.deleteAlternatives({ tree: t, node_id: id.g, actor: a }), { ok: true });
        assert.deepEqual(await replies(null), []);
        assert.deepEqual(await chats.pointer(a.session), { tree: t, at: null });
        assert.equal((await chats.openingAlternatives({ tree: t, actor: a })).has_saved_chats, false);
        await store.close();
    });

    test(`${kind}: what a delete drops besides messages is named first`, async () => {
        const { store, chats, t, id, send, shown, replies } = await fresh(engine);
        await send(null, ['g']);
        await send('g', ['u1', 'b1', 'u2']);
        const pinned = await chats.createBookmark({ tree: t, node_id: id.b1, name: 'Pinned', mode: MODE.pinned, actor: a });
        await chats.createBookmark({ tree: t, node_id: id.u2, name: 'Following', actor: a });
        const change = await chats.changeState({ tree: t, at: id.b1, ops: [{ key: 'hp', variable: true, value: 3 }], actor: a });
        const preview = await chats.deleteSubtree({ tree: t, node_id: id.b1, actor: a, preview: true });
        const drops = {
            bookmarks: [{ id: String(/** @type {any} */ (pinned).bookmark), name: 'Pinned', node_id: id.b1 }],
            changes: [{ id: change.ok ? change.changes[0] : '', key: 'hp', variable: true, node_id: id.b1 }],
        };
        assert.deepEqual(preview, { ok: true, preview: true, drops });
        // Not confirmed, or confirmed in part: refused, nothing written.
        assert.deepEqual(await chats.deleteSubtree({ tree: t, node_id: id.b1, actor: a }), { ok: false, reason: 'confirm', drops });
        assert.deepEqual(await chats.deleteSubtree({ tree: t, node_id: id.b1, actor: a, confirm: { bookmarks: [drops.bookmarks[0].id] } }), { ok: false, reason: 'confirm', drops });
        assert.deepEqual(await replies('u1'), ['b1']);
        const confirm = { bookmarks: [drops.bookmarks[0].id], changes: [drops.changes[0].id] };
        assert.deepEqual(await chats.deleteSubtree({ tree: t, node_id: id.b1, actor: a, confirm }), { ok: true });
        assert.deepEqual(await replies('u1'), []);
        // The following bookmark moved to the nearest message left above; the pinned one went.
        assert.deepEqual((await chats.bookmarks({ tree: t, limit: 10 })).rows.map(r => [r.name, r.at]), [['Following', id.u1]]);
        assert.deepEqual(await shown(a), ['g', 'u1']);
        await store.close();
    });

    test(`${kind}: a cut from this path forks it; a cut everywhere closes the gap`, async () => {
        const { store, chats, t, id, send, shown, replies } = await fresh(engine);
        // g - u1 - b1 - u2 - b2 - u3 (a); b's branch u3x under b2.
        await send(null, ['g']);
        await send('g', ['u1', 'b1', 'u2', 'b2', 'u3']);
        await chats.select({ tree: t, node_id: id.b2, actor: b });
        await send('b2', ['u3x'], b);
        await chats.changeState({ tree: t, at: id.b2, ops: [{ key: 'hp', variable: true, value: 5 }], actor: a });
        const gone = await chats.changeState({ tree: t, at: id.b2, ops: [{ key: 'mood', value: 'calm' }], actor: a });
        await chats.revertChange({ change: gone.ok ? gone.changes[0] : '', actor: a });
        const stateBefore = (await chats.stateAt({ tree: t, at: id.u3 }))?.state;

        // Cut b1 .. u2 from a's path: b2 is shared (b's branch passes it), so a gets its own copy; u3 is a's alone
        // and moves under the copy. b1 and u2 stay: b's path passes through them.
        const cut = /** @type {any} */ (await chats.cutFromPath({ tree: t, first: id.b1, last: id.u2, actor: a }));
        assert.equal(cut.ok, true);
        assert.deepEqual(Object.keys(cut.copied), [id.b2]);
        assert.deepEqual(await shown(a), ['g', 'u1', 'b2', 'u3']);
        assert.equal((await chats.load({ tree: t, at: (await chats.pointer(a.session)).at }))?.messages[2].node_id, cut.copied[id.b2]);
        assert.deepEqual(await shown(b), ['g', 'u1', 'b1', 'u2', 'b2', 'u3x']);
        assert.deepEqual(await replies('u1'), ['b1', 'b2']);
        assert.deepEqual(await replies('b2'), ['u3x']);
        // The copy holds the state changes in effect on b2, so the state down the new branch is the same.
        const at = (await chats.pointer(a.session)).at;
        assert.deepEqual((await chats.stateAt({ tree: t, at }))?.state, stateBefore);
        assert.equal(at, id.u3, 'u3 moved, it is the same message');

        // A cut whose tail is the path's alone: the tail moves up and the cut messages go.
        const c = await fresh(engine);
        await c.send(null, ['g']);
        await c.send('g', ['u1', 'b1', 'u2', 'b2']);
        assert.deepEqual(await c.chats.cutFromPath({ tree: c.t, first: c.id.u1, last: c.id.b1, actor: a }), { ok: true });
        assert.deepEqual(await c.shown(a), ['g', 'u2', 'b2']);
        assert.deepEqual(await c.replies('g'), ['u2']);
        // A cut at the path's end: the path ends before it.
        assert.deepEqual(await c.chats.cutFromPath({ tree: c.t, first: c.id.b2, last: c.id.b2, actor: a }), { ok: true });
        assert.deepEqual(await c.shown(a), ['g', 'u2']);
        assert.deepEqual(await c.replies('u2'), []);

        // Cut everywhere: every path through the cut closes the gap.
        const e = await fresh(engine);
        await e.send(null, ['g']);
        await e.send('g', ['u1', 'b1', 'u2', 'b2']);
        await e.chats.select({ tree: e.t, node_id: e.id.b1, actor: b });
        await e.send('b1', ['u2x'], b);
        assert.deepEqual(await e.chats.cutEverywhere({ tree: e.t, first: e.id.u1, last: e.id.b1, actor: a }), { ok: true });
        assert.deepEqual(await e.shown(a), ['g', 'u2', 'b2']);
        assert.deepEqual(await e.shown(b), ['g', 'u2x']);
        assert.deepEqual(await e.replies('g'), ['u2', 'u2x']);
        // The messages below keep their depths right (the chat list's counts).
        assert.equal((await e.chats.chatList({ tree: e.t, session: a.session, limit: 5 })).rows[0].message_count, 3);
        await Promise.all([store.close(), c.store.close(), e.store.close()]);
    });

    test(`${kind}: a swipe follows the fork choices down its branch, wherever it is`, async () => {
        const { store, chats, t, id, send, shown } = await fresh(engine);
        await send(null, ['g']);
        await send('g', ['u1', 'b1', 'u2', 'b2']);
        await send('u1', ['b1x'], b);
        await send('u2', ['b2x', 'u3x'], b);
        await chats.select({ tree: t, node_id: id.b2, actor: a });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1', 'u2', 'b2']);
        // The last message swiped: the alternative and the branch below it.
        await chats.select({ tree: t, node_id: id.b2x, actor: a });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1', 'u2', 'b2x', 'u3x']);
        await chats.select({ tree: t, node_id: id.b2, actor: a });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1', 'u2', 'b2']);
        // Mid-chat to an alternative nothing continues, and back: the choices below are still remembered.
        await chats.select({ tree: t, node_id: id.b1x, actor: a });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1x']);
        await chats.select({ tree: t, node_id: id.b1, actor: a });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1', 'u2', 'b2']);

        // After a new chat, swiping the greetings is the same rule.
        await send(null, ['g2']);
        await send('g2', ['u9'], b);
        await chats.newChat({ tree: t, actor: a });
        assert.deepEqual(await shown(a), []);
        // A group's new chat is its root with no card greeting chosen.
        await chats.select({ tree: t, node_id: id.g2, actor: a });
        await chats.newChat({ tree: t, actor: a, group: true });
        assert.deepEqual(await shown(a), []);
        const [sid] = await chats.store.chatRead('ids', { space: 1, keys: [a.session] });
        assert.equal(await chats.store.chatRead('openingChoice', { session: sid, tree: t }), null);
        await chats.select({ tree: t, node_id: id.g2, actor: a });
        assert.deepEqual(await shown(a), ['g2', 'u9']);
        await chats.select({ tree: t, node_id: id.g, actor: a });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1', 'u2', 'b2']);
        await store.close();
    });

    test(`${kind}: an edit by patch sets only the fields it names, by the message's own id; one changing nothing writes nothing`, async () => {
        const { store, chats, t, id, send, replies } = await fresh(engine);
        await send(null, ['g']);
        await send('g', ['u1', 'b1']);
        await send('u1', ['b1x'], b);
        const [stored] = await chats.decoded([(await chats.stored([(await chats.messageIds([id.b1x]))[0]])).values().next().value]);
        // The other alternative's text and extra, by its own id; its other fields as stored.
        const patched = await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: id.b1x, patch: { mes: 'b1x edited', extra: { note: 1 } } }], actor: a });
        assert.deepEqual(patched, { ok: true, applied: 1, refused: [] });
        assert.deepEqual((await replies('u1')).sort(), ['b1', 'b1x edited']);
        const [after] = await chats.decoded([(await chats.stored([(await chats.messageIds([id.b1x]))[0]])).values().next().value]);
        assert.deepEqual(after, { ...stored, mes: 'b1x edited', extra: { note: 1 } });
        // A field unset goes; a patch changing nothing writes nothing.
        await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: id.b1x, unset: ['extra'] }], actor: a });
        const [unset] = await chats.decoded([(await chats.stored([(await chats.messageIds([id.b1x]))[0]])).values().next().value]);
        assert.equal(unset.extra, undefined);
        const before = await store.chatRead('nextIds', {});
        const same = await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: id.b1x, patch: { mes: 'b1x edited' } }], actor: a });
        assert.deepEqual(same, { ok: true, applied: 1, refused: [] });
        assert.deepEqual(await store.chatRead('nextIds', {}), before);
        // Blanking stored text, an unknown id, or an edit stating nothing is refused.
        const refused = await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [
            { node_id: id.b1, patch: { mes: '' } }, { node_id: 'no-such-message', patch: { mes: 'x' } }, { node_id: id.b1 },
        ], actor: a });
        assert.deepEqual(refused.refused.map((/** @type {any} */ r) => r.reason), ['refused to blank stored text', 'unknown node', 'no content']);
        await store.close();
    });

    test(`${kind}: bookmark labels may repeat; a route's chat id names a bookmark by b<id>, a session by its UUID, a label only when one has it`, async () => {
        const { store, chats, t, id, send } = await fresh(engine);
        assert.equal((await chats.openingAlternatives({ tree: t, actor: a })).has_saved_chats, false);
        await send(null, ['g']);
        await send('g', ['u1']);
        assert.equal((await chats.openingAlternatives({ tree: t, actor: a })).has_saved_chats, true);
        const first = /** @type {any} */ (await chats.createBookmark({ tree: t, node_id: id.g, name: 'Morning', actor: a }));
        const second = /** @type {any} */ (await chats.createBookmark({ tree: t, node_id: id.u1, name: 'Morning', actor: a }));
        assert.equal(second.name, 'Morning');
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: 'Morning' }), null);
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: bookmarkCompatId(first.bookmark) }), { bookmark: first.bookmark });
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: bookmarkCompatId(second.bookmark) }), { bookmark: second.bookmark });
        // A bare decimal is a label: neither a bookmark's number nor a message's id names anything.
        assert.equal(await chats.resolveChatName({ tree: t, name: String(first.bookmark) }), null);
        assert.equal(await chats.resolveChatName({ tree: t, name: id.u1 }), null);
        assert.deepEqual(await chats.changeBookmark({ tree: t, bookmark: String(second.bookmark), change: { name: 'Noon' } }), { ok: true, name: 'Noon' });
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: 'Morning' }), { bookmark: first.bookmark });
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: 'Noon' }), { bookmark: second.bookmark });
        // A session: by its UUID, or by a label one session has.
        await chats.goTo({ tree: t, node_id: id.u1, actor: b });
        await chats.nameSession({ session: b.session, name: 'Evening', actor: b });
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: b.session }), { session: b.session });
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: 'Evening' }), { session: b.session });
        assert.equal(await chats.resolveChatName({ tree: t, name: 'Dusk' }), null);
        assert.equal(await chats.treeOfChatId(bookmarkCompatId(first.bookmark)), t);
        assert.equal(await chats.treeOfChatId(String(first.bookmark)), null);
        // A label another bookmark holds is stored as given.
        await store.commit([{ kind: 'positionName', id: first.bookmark, name: 'Noon' }]);
        assert.equal(await chats.resolveChatName({ tree: t, name: 'Noon' }), null);
        await store.close();
    });

    test(`${kind}: an imported chat kept as where the user lands moves no session`, async () => {
        const { store, chats, t } = await fresh(engine);
        const imported = /** @type {any} */ (await chats.importChat({ tree: t, treeSpeaker: cara, name: 'Imported', messages: [msg('g'), msg('u1')], metadata: {}, actor: a }));
        await chats.importChat({ tree: t, treeSpeaker: cara, name: 'Second', messages: [msg('h')], metadata: {}, actor: a });
        const end = imported.node_ids[1];
        assert.deepEqual(await chats.rememberUserPosition({ tree: t, at: end, user: a.user }), { ok: true });
        // A tab with no session of its own, and a caller with no tab, land there; no session was moved.
        assert.equal(await chats.landingOf(t, { user: a.user, session: null }), end);
        assert.equal(await chats.pointer(a.session), null);
        const v5 = (await chats.resolveSession({ tree: t, user: a.user, header: 'none' })).identifier;
        assert.deepEqual(await chats.resolveSession({ tree: t, user: a.user, header: undefined }), { session: v5, identifier: v5 });
        assert.deepEqual(await chats.rememberUserPosition({ tree: t, at: 'no-such-message', user: a.user }), { ok: false, reason: 'unknown node' });
        // A session's own move replaces it.
        await chats.goTo({ tree: t, node_id: imported.node_ids[0], actor: b });
        assert.equal(await chats.landingOf(t, { user: a.user, session: null }), imported.node_ids[0]);
        await store.close();
    });

    test(`${kind}: an imported chat keeps every message's swipes, the shown one chosen`, async () => {
        const { store, chats, t } = await fresh(engine);
        const swiped = { ...msg('r1'), swipes: ['r0', 'r1', 'r2'], swipe_id: 1, swipe_info: [{ send_date: 'a', extra: { model: 'm0' } }, { send_date: 'b', extra: {} }, { send_date: 'c', extra: {} }] };
        const imported = /** @type {any} */ (await chats.importChat({ tree: t, treeSpeaker: cara, name: 'Imported', messages: [msg('g'), msg('u1'), swiped, msg('u2')], metadata: {}, actor: a }));
        assert.equal(imported.ok, true);
        const loaded = (await chats.load({ tree: t, at: imported.node_ids[3], full: true })).messages;
        assert.deepEqual(loaded.map((/** @type {any} */ m) => m.mes), ['g', 'u1', 'r1', 'u2'], 'the chat follows each message\'s shown swipe');
        assert.deepEqual(loaded[2].swipes, ['r0', 'r1', 'r2'], 'the other swipes are its alternatives');
        assert.equal(loaded[2].swipe_id, 1);
        assert.equal(loaded[2].swipe_info[0].extra.model, 'm0', 'a swipe keeps its own info');
        const at = await chats.alternatives({ node_id: imported.node_ids[2], offset: 0, limit: 10 });
        assert.deepEqual([at?.total, at?.selected, at?.alternatives.map((/** @type {any} */ x) => x.mes)], [3, 1, ['r0', 'r1', 'r2']], 'each swipe is an alternative of its own in the tree');
        await store.close();
    });

    test(`${kind}: a load sends the text of the alternatives near the shown one`, async () => {
        const { store, chats, t, id, send } = await fresh(engine);
        await send(null, ['g']);
        const texts = Array.from({ length: 20 }, (_, i) => `r${i}`);
        for (const text of texts) await send('g', [text]);
        await chats.goTo({ tree: t, node_id: id.r12, actor: a });
        const loaded = (await chats.load({ tree: t, at: id.r12 })).messages;
        const reply = loaded[1];
        // Five on each side of the shown one, the others holes, at full length.
        assert.equal(reply.swipe_id, 12);
        assert.deepEqual(reply.swipes, texts.map((x, i) => (i >= 7 && i <= 17 ? x : null)));
        assert.deepEqual(reply.swipe_info.map((/** @type {any} */ x) => x?.node_id ?? null), texts.map((x, i) => (i >= 7 && i <= 17 ? id[x] : null)));
        assert.deepEqual((await chats.load({ tree: t, at: id.r12, full: true })).messages[1].swipes, texts);

        await store.close();
    });
}
