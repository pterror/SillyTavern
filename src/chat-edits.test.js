// A tree's edits on the engine (build path 5b addendum): the deletes and the two cuts, each removing only what
// belongs to the path alone; swiping; a new chat's greeting; bookmark names unique in a tree and a route's chat name.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';

const { ChatEngine, MODE } = await import('./chat-engine.js');

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
        assert.deepEqual(await chats.cutFromPath({ tree: t, first: id.b1, last: id.u2, actor: a }), { ok: true });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b2', 'u3']);
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

    test(`${kind}: a whole chat saved without some shown messages cuts them from this path, listing what that drops`, async () => {
        const { store, chats, t, id, send, shown, replies } = await fresh(engine);
        await send(null, ['g']);
        await send('g', ['u1', 'b1', 'u2', 'b2']);
        await chats.createBookmark({ tree: t, node_id: id.b2, name: 'end', mode: MODE.pinned, actor: a });
        const loaded = async () => (await chats.load({ tree: t, at: (await chats.pointer(a.session))?.at ?? null })).messages;
        // A middle message gone (upstream's deleteMessage(1)): cut from the path; the rest follows the message before.
        const whole = await loaded();
        const middle = await chats.saveChat({ tree: t, treeSpeaker: cara, chat: [{ chat_metadata: {} }, ...whole.filter(m => m.mes !== 'u1')], actor: a });
        assert.equal(middle.ok, true);
        assert.equal(middle.dropped, undefined);
        assert.deepEqual(await shown(a), ['g', 'b1', 'u2', 'b2']);
        assert.deepEqual(await replies('g'), ['b1']);
        // The tail gone (`/del 2`): the pinned bookmark at b2 goes with it, and the answer names it.
        const now = await loaded();
        const tail = await chats.saveChat({ tree: t, treeSpeaker: cara, chat: [{ chat_metadata: {} }, ...now.slice(0, 2)], actor: a });
        assert.deepEqual(tail.dropped?.bookmarks.map(x => x.name), ['end']);
        assert.deepEqual(await shown(a), ['g', 'b1']);
        assert.deepEqual(await replies('b1'), []);
        // Another chat's array (not holding this path's opening) cuts nothing.
        await chats.saveChat({ tree: t, treeSpeaker: cara, chat: [{ chat_metadata: {} }, msg('other')], actor: b });
        assert.deepEqual(await shown(a), ['g', 'b1']);
        await store.close();
    });

    test(`${kind}: bookmark names are unique in a tree and a route's chat name finds them`, async () => {
        const { store, chats, t, id, send } = await fresh(engine);
        assert.equal((await chats.openingAlternatives({ tree: t, actor: a })).has_saved_chats, false);
        await send(null, ['g']);
        await send('g', ['u1']);
        assert.equal((await chats.openingAlternatives({ tree: t, actor: a })).has_saved_chats, true);
        const first = await chats.createBookmark({ tree: t, node_id: id.g, name: 'Morning', actor: a });
        const second = await chats.createBookmark({ tree: t, node_id: id.u1, name: 'Morning', actor: a });
        assert.equal(/** @type {any} */ (second).name, 'Morning (1)');
        const firstId = String(/** @type {any} */ (first).bookmark);
        assert.deepEqual(await chats.changeBookmark({ tree: t, bookmark: String(/** @type {any} */ (second).bookmark), change: { name: 'Morning' } }), { ok: true, name: 'Morning (1)' });
        assert.deepEqual(await chats.changeBookmark({ tree: t, bookmark: firstId, change: { name: 'Morning' } }), { ok: true, name: 'Morning' });
        // A route's chat name: a bookmark of the tree, else a session's name in the store, else nothing.
        await chats.nameSession({ session: b.session, name: 'Evening', actor: b });
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: 'Morning (1)' }), { bookmark: /** @type {any} */ (second).bookmark });
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: 'Evening' }), { session: b.session });
        assert.equal(await chats.resolveChatName({ tree: t, name: 'Noon' }), null);
        // The engine refuses a name another bookmark of the tree holds.
        await assert.rejects(store.commit([{ kind: 'positionName', id: BigInt(firstId), name: 'Morning (1)' }]));
        await store.close();
    });
}
