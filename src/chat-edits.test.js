import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';
import { fakeOwners } from './chat-test-people.js';

const { ChatEngine, MODE } = await import('./chat-engine.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-edits-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cara = { id: 1n, name: 'Cara', avatar: 'cara.png' };
const people = {
    speakers: async (/** @type {bigint[]} */ ids) => new Map(ids.filter(id => id === cara.id).map(id => [id, cara])),
    byAvatar: async (/** @type {string[]} */ avatars) => new Map(avatars.filter(a => a === cara.avatar).map(a => [a, cara])),
};
people.owners = fakeOwners(people);
const a = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000b1' };
const b = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000b2' };
const msg = (/** @type {string} */ mes) => ({ name: mes.startsWith('u') ? 'You' : 'Cara', is_user: mes.startsWith('u'), is_system: false, mes, extra: {} });

let n = 0;
/**
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
        const { store, chats, t, id, send, shown, replies } = await fresh(engine);
        await send(null, ['g']);
        await send('g', ['u1', 'b1', 'u2', 'b2']);
        await send('u1', ['b1x', 'u2x'], b);

        assert.deepEqual(await chats.deletePath({ tree: t, node_id: id.u2, actor: a }), { ok: true });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1']);
        assert.deepEqual(await replies('b1'), []);
        assert.deepEqual(await chats.deletePath({ tree: t, node_id: id.g, actor: a }), { ok: true });
        assert.deepEqual(await shown(a), ['g', 'u1']);
        assert.deepEqual(await replies('u1'), ['b1x']);
        assert.deepEqual(await shown(b), ['g', 'u1', 'b1x', 'u2x']);
        assert.deepEqual(await chats.deletePath({ tree: t, node_id: id.u2x, actor: a }), { ok: false, reason: 'not on the path' });
        assert.deepEqual(await chats.deletePath({ tree: t, node_id: id.u1, actor: a }), { ok: true });
        assert.deepEqual(await replies('u1'), ['b1x']);

        await send('u1', ['b1y']);
        assert.deepEqual(await chats.deleteBelow({ tree: t, node_id: id.u1, actor: a }), { ok: true });
        assert.deepEqual(await replies('u1'), []);
        assert.deepEqual(await shown(b), ['g', 'u1']);
        assert.deepEqual(await shown(a), ['g', 'u1']);

        await send('u1', ['c1', 'c2']);
        await send('u1', ['d1', 'd2'], b);
        assert.deepEqual(await chats.deleteSubtree({ tree: t, node_id: id.c1, actor: a }), { ok: true });
        assert.deepEqual(await replies('u1'), ['d1']);
        assert.deepEqual(await shown(a), ['g', 'u1'], 'the session moves to the nearest message left above');
        assert.deepEqual(await chats.deleteAlternatives({ tree: t, node_id: id.d1, actor: a }), { ok: true });
        assert.deepEqual(await replies('u1'), []);
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
        const change = String((await chats.store.chatRead('nextIds', {})).change);
        await chats.mergeMetadata({ tree: t, at: id.b1, set: { scene: 'inn' }, unset: [], actor: a });
        const preview = await chats.deleteSubtree({ tree: t, node_id: id.b1, actor: a, preview: true });
        const drops = {
            bookmarks: [{ id: String(/** @type {any} */ (pinned).bookmark), name: 'Pinned', node_id: id.b1 }],
            changes: [{ id: change, key: 'scene', variable: false, node_id: id.b1 }],
        };
        assert.deepEqual(preview, { ok: true, preview: true, drops });
        assert.deepEqual(await chats.deleteSubtree({ tree: t, node_id: id.b1, actor: a }), { ok: false, reason: 'confirm', drops });
        assert.deepEqual(await chats.deleteSubtree({ tree: t, node_id: id.b1, actor: a, confirm: { bookmarks: [drops.bookmarks[0].id] } }), { ok: false, reason: 'confirm', drops });
        assert.deepEqual(await replies('u1'), ['b1']);
        const confirm = { bookmarks: [drops.bookmarks[0].id], changes: [drops.changes[0].id] };
        assert.deepEqual(await chats.deleteSubtree({ tree: t, node_id: id.b1, actor: a, confirm }), { ok: true });
        assert.deepEqual(await replies('u1'), []);
        assert.deepEqual((await chats.bookmarks({ tree: t, limit: 10 })).rows.map(r => [r.name, r.at]), [['Following', id.u1]]);
        assert.deepEqual(await shown(a), ['g', 'u1']);
        await store.close();
    });

    test(`${kind}: a cut from this path forks it; a cut everywhere closes the gap`, async () => {
        const { store, chats, t, id, send, shown, replies } = await fresh(engine);
        await send(null, ['g']);
        await send('g', ['u1', 'b1', 'u2', 'b2', 'u3']);
        await chats.select({ tree: t, node_id: id.b2, actor: b });
        await send('b2', ['u3x'], b);
        await chats.mergeMetadata({ tree: t, at: id.b2, set: { mood: 'calm' }, unset: [], variables: { set: { hp: 5 } }, actor: a });
        await chats.mergeMetadata({ tree: t, at: id.b2, set: {}, unset: ['mood'], actor: a });
        const stateBefore = (await chats.stateAt({ tree: t, at: id.u3 }))?.state;

        const cut = /** @type {any} */ (await chats.cutFromPath({ tree: t, first: id.b1, last: id.u2, actor: a }));
        assert.equal(cut.ok, true);
        assert.deepEqual(Object.keys(cut.copied), [id.b2]);
        assert.deepEqual(await shown(a), ['g', 'u1', 'b2', 'u3']);
        assert.equal((await chats.load({ tree: t, at: (await chats.pointer(a.session)).at }))?.messages[2].node_id, cut.copied[id.b2]);
        assert.deepEqual(await shown(b), ['g', 'u1', 'b1', 'u2', 'b2', 'u3x']);
        assert.deepEqual(await replies('u1'), ['b1', 'b2']);
        assert.deepEqual(await replies('b2'), ['u3x']);
        const at = (await chats.pointer(a.session)).at;
        assert.deepEqual((await chats.stateAt({ tree: t, at }))?.state, stateBefore);
        assert.equal(at, id.u3, 'u3 moved, it is the same message');

        const c = await fresh(engine);
        await c.send(null, ['g']);
        await c.send('g', ['u1', 'b1', 'u2', 'b2']);
        assert.deepEqual(await c.chats.cutFromPath({ tree: c.t, first: c.id.u1, last: c.id.b1, actor: a }), { ok: true });
        assert.deepEqual(await c.shown(a), ['g', 'u2', 'b2']);
        assert.deepEqual(await c.replies('g'), ['u2']);
        assert.deepEqual(await c.chats.cutFromPath({ tree: c.t, first: c.id.b2, last: c.id.b2, actor: a }), { ok: true });
        assert.deepEqual(await c.shown(a), ['g', 'u2']);
        assert.deepEqual(await c.replies('u2'), []);

        const e = await fresh(engine);
        await e.send(null, ['g']);
        await e.send('g', ['u1', 'b1', 'u2', 'b2']);
        await e.chats.select({ tree: e.t, node_id: e.id.b1, actor: b });
        await e.send('b1', ['u2x'], b);
        assert.deepEqual(await e.chats.cutEverywhere({ tree: e.t, first: e.id.u1, last: e.id.b1, actor: a }), { ok: true });
        assert.deepEqual(await e.shown(a), ['g', 'u2', 'b2']);
        assert.deepEqual(await e.shown(b), ['g', 'u2x']);
        assert.deepEqual(await e.replies('g'), ['u2', 'u2x']);
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
        await chats.select({ tree: t, node_id: id.b2x, actor: a });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1', 'u2', 'b2x', 'u3x']);
        await chats.select({ tree: t, node_id: id.b2, actor: a });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1', 'u2', 'b2']);
        await chats.select({ tree: t, node_id: id.b1x, actor: a });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1x']);
        await chats.select({ tree: t, node_id: id.b1, actor: a });
        assert.deepEqual(await shown(a), ['g', 'u1', 'b1', 'u2', 'b2']);

        await send(null, ['g2']);
        await send('g2', ['u9'], b);
        await chats.newChat({ tree: t, actor: a });
        assert.deepEqual(await shown(a), []);
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
        const patched = await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: id.b1x, patch: { mes: 'b1x edited', extra: { note: 1 } } }], actor: a });
        assert.deepEqual(patched, { ok: true, applied: 1, refused: [] });
        assert.deepEqual((await replies('u1')).sort(), ['b1', 'b1x edited']);
        const [after] = await chats.decoded([(await chats.stored([(await chats.messageIds([id.b1x]))[0]])).values().next().value]);
        assert.deepEqual(after, { ...stored, mes: 'b1x edited', extra: { note: 1 } });
        await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: id.b1x, patch: { 'extra.bias': 'b' }, unset: ['extra.missing'] }], actor: a });
        const [keyed] = await chats.decoded([(await chats.stored([(await chats.messageIds([id.b1x]))[0]])).values().next().value]);
        assert.deepEqual(keyed.extra, { note: 1, bias: 'b' });
        await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: id.b1x, unset: ['extra.bias'] }], actor: a });
        const [unkeyed] = await chats.decoded([(await chats.stored([(await chats.messageIds([id.b1x]))[0]])).values().next().value]);
        assert.deepEqual(unkeyed.extra, { note: 1 });
        await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: id.b1x, unset: ['extra'] }], actor: a });
        const [unset] = await chats.decoded([(await chats.stored([(await chats.messageIds([id.b1x]))[0]])).values().next().value]);
        assert.equal(unset.extra, undefined);
        const before = await store.chatRead('nextIds', {});
        const same = await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: id.b1x, patch: { mes: 'b1x edited' } }], actor: a });
        assert.deepEqual(same, { ok: true, applied: 1, refused: [] });
        assert.deepEqual(await store.chatRead('nextIds', {}), before);
        const refused = await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [
            { node_id: id.b1, patch: { mes: '' } }, { node_id: 'no-such-message', patch: { mes: 'x' } }, { node_id: id.b1 },
        ], actor: a });
        assert.deepEqual(refused.refused.map((/** @type {any} */ r) => r.reason), ['refused to blank stored text', 'unknown node', 'no content']);
        await store.close();
    });

    test(`${kind}: a chat's name is its id, once in its tree; a session goes by its UUID or its label`, async () => {
        const { store, chats, t, id, send } = await fresh(engine);
        assert.equal((await chats.openingAlternatives({ tree: t, actor: a })).has_saved_chats, false);
        await send(null, ['g']);
        await send('g', ['u1']);
        assert.equal((await chats.openingAlternatives({ tree: t, actor: a })).has_saved_chats, true);
        const first = /** @type {any} */ (await chats.createBookmark({ tree: t, node_id: id.g, name: 'Morning', actor: a }));
        assert.deepEqual(await chats.createBookmark({ tree: t, node_id: id.u1, name: 'Morning', actor: a }), { ok: false, reason: 'name taken' });
        const second = /** @type {any} */ (await chats.createBookmark({ tree: t, node_id: id.u1, name: 'Morning', suggested: true, actor: a }));
        assert.equal(second.name, 'Morning (2)');
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: 'Morning' }), { bookmark: first.bookmark });
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: 'Morning (2)' }), { bookmark: second.bookmark });
        assert.equal(await chats.resolveChatName({ tree: t, name: `b${first.bookmark}` }), null);
        assert.equal(await chats.resolveChatName({ tree: t, name: String(first.bookmark) }), null);
        assert.equal(await chats.resolveChatName({ tree: t, name: id.u1 }), null);
        assert.deepEqual(await chats.changeBookmark({ tree: t, bookmark: String(second.bookmark), change: { name: 'Morning' } }), { ok: false, reason: 'name taken' });
        assert.deepEqual(await chats.changeBookmark({ tree: t, bookmark: String(second.bookmark), change: { name: null } }), { ok: false, reason: 'a chat needs a name' });
        assert.deepEqual(await chats.changeBookmark({ tree: t, bookmark: String(second.bookmark), change: { name: 'Noon' } }), { ok: true, name: 'Noon' });
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: 'Noon' }), { bookmark: second.bookmark });
        assert.equal(await chats.resolveChatName({ tree: t, name: 'Morning (2)' }), null);
        await chats.goTo({ tree: t, node_id: id.u1, actor: b });
        await chats.nameSession({ session: b.session, name: 'Evening', actor: b });
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: b.session }), { session: b.session });
        assert.deepEqual(await chats.resolveChatName({ tree: t, name: 'Evening' }), { session: b.session });
        assert.equal(await chats.resolveChatName({ tree: t, name: 'Dusk' }), null);
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
        assert.equal(await chats.landingOf(t, { user: a.user, session: null }), end);
        assert.equal(await chats.pointer(a.session), null);
        const v5 = (await chats.resolveSession({ tree: t, user: a.user, header: 'none' })).identifier;
        assert.deepEqual(await chats.resolveSession({ tree: t, user: a.user, header: undefined }), { session: v5, identifier: v5 });
        assert.deepEqual(await chats.rememberUserPosition({ tree: t, at: 'no-such-message', user: a.user }), { ok: false, reason: 'unknown node' });
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
        assert.equal(reply.swipe_id, 12);
        assert.deepEqual(reply.swipes, texts.map((x, i) => (i >= 7 && i <= 17 ? x : null)));
        assert.deepEqual(reply.swipe_info.map((/** @type {any} */ x) => x?.node_id ?? null), texts.map((x, i) => (i >= 7 && i <= 17 ? id[x] : null)));
        assert.deepEqual((await chats.load({ tree: t, at: id.r12, full: true })).messages[1].swipes, texts);

        await store.close();
    });
}
