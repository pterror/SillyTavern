// How a tab gets its session: the server's choice for a fresh tab, and the fork a tab makes of a session another tab
// holds (public/scripts/tab-session.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';
import { ChatEngine } from './chat-engine.js';
import { claimTabSession, heldByOther } from './session-presence.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-presence-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cara = { id: 1n, name: 'Cara', avatar: 'cara.png' };
const people = {
    speakers: async (/** @type {bigint[]} */ ids) => new Map(ids.filter(id => id === cara.id).map(id => [id, cara])),
    byAvatar: async (/** @type {string[]} */ avatars) => new Map(avatars.filter(a => a === cara.avatar).map(a => [a, cara])),
};
const t = 1n;
const user = 'u';
const S1 = '0190a1b2-0000-7000-8000-000000000001';
const S2 = '0190a1b2-0000-7000-8000-000000000002';
const say = (/** @type {string} */ mes) => ({ name: 'You', is_user: true, is_system: false, send_date: '2025-10-10T10:00:00.000Z', mes, extra: {} });

for (const kind of ['native', 'wasm']) {
    test(`a fresh tab takes the most recent session no tab holds; two tabs never share one (${kind})`, async () => {
        const engine = loadEngine(kind === 'wasm' ? { platform: null } : {}).binding;
        const store = await engine.Store.open(path.join(root, `claim-${kind}`));
        const userRoot = `claim-${kind}`;
        try {
            const chats = await ChatEngine.open(store, people);
            const claim = (/** @type {string} */ token, /** @type {string | null} */ asked = null) => claimTabSession({ root: userRoot, user, chats, asked, token });

            // No session at all: a new one, nothing stored until it moves.
            const none = await claim('tab-zero-0');
            assert.equal(none.reused, false);
            assert.equal(await chats.sessionPlace(none.session), null);
            none.release();

            const [a] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: null, contents: [say('a')], actor: { user, session: S1 } })).node_ids;
            await chats.appendMessages({ tree: t, treeSpeaker: cara, after: a, contents: [say('b')], actor: { user, session: S2 } });

            // Two fresh tabs at once (two devices): the most recent, then the next; never the same.
            const [one, two] = await Promise.all([claim('device-one'), claim('device-two')]);
            assert.deepEqual([one.session, two.session], [S2, S1]);
            // Every session open: a new one where the most recent is, its history that one move.
            const three = await claim('device-three');
            assert.ok(![S1, S2].includes(three.session));
            assert.deepEqual(await chats.pointer(three.session), await chats.pointer(S2));
            assert.deepEqual(await chats.sessionPlace(three.session), { length: 1, cursor: 1 });
            assert.equal(await chats.currentChat(three.session, t), null);

            // Close and reopen: the same session again.
            one.release();
            assert.equal(heldByOther(userRoot, S2), false);
            const reopened = await claim('device-four');
            assert.equal(reopened.session, S2);

            // A tab asking for its own: held by another tab's token, or its own (a reload's stream still open).
            assert.equal((await claim('device-five', S2)).held, true);
            const reload = await claim('device-four', S2);
            assert.equal(reload.held, false);
            reload.release();
            for (const c of [two, three, reopened]) c.release();
        } finally {
            await store.close();
        }
    });

    test(`a fork reads the original's history, goes on its own and keeps the tab's current chats (${kind})`, async () => {
        const engine = loadEngine(kind === 'wasm' ? { platform: null } : {}).binding;
        const store = await engine.Store.open(path.join(root, `fork-${kind}`));
        try {
            const chats = await ChatEngine.open(store, people);
            const actor = { user, session: S1 };
            const [a, b, c] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: null, contents: [say('a'), say('b'), say('c')], actor })).node_ids;
            const made = await chats.createBookmark({ tree: t, node_id: b, name: 'mark', actor });
            assert.equal(made.ok, true);
            const bookmark = String(/** @type {any} */ (made).bookmark);
            await chats.setCurrentChat({ tree: t, bookmark, actor });
            assert.equal((await chats.step({ back: true, actor })).ok, true);
            const place = await chats.sessionPlace(S1);
            assert.deepEqual(place, { length: 3, cursor: 2 });

            // A duplicated tab: every entry, forward ones included, at the original's cursor.
            const dup = await chats.forkSession({ from: S1, ...place, chats: [{ tree: t, bookmark }], user });
            assert.equal(dup.ok, true);
            const fork = /** @type {any} */ (dup).session;
            assert.deepEqual(await chats.sessionPlace(fork), place);
            assert.deepEqual(await chats.pointer(fork), { tree: t, at: b });
            assert.equal(String(await chats.currentChat(fork, t)), bookmark);
            assert.equal((await chats.step({ back: false, actor: { user, session: fork } })).ok, true);
            assert.deepEqual(await chats.pointer(fork), { tree: t, at: c });
            assert.deepEqual(await chats.pointer(S1), { tree: t, at: b });

            // Each moves on its own from then on.
            await chats.goTo({ tree: t, node_id: a, actor: { user, session: fork } });
            await chats.goTo({ tree: t, node_id: c, actor });
            assert.deepEqual(await chats.pointer(fork), { tree: t, at: a });
            assert.deepEqual(await chats.pointer(S1), { tree: t, at: c });
            assert.deepEqual(await chats.sessionPlace(fork), { length: 4, cursor: 4 });
            assert.deepEqual(await chats.sessionPlace(S1), { length: 4, cursor: 4 });

            // A restored tab whose session was taken: from its own last place, not the session's now.
            const restored = await chats.forkSession({ from: S1, length: 3, cursor: 2, chats: [], user });
            const r = /** @type {any} */ (restored).session;
            assert.deepEqual(await chats.sessionPlace(r), { length: 3, cursor: 2 });
            assert.deepEqual(await chats.pointer(r), { tree: t, at: b });
            assert.equal(await chats.currentChat(r, t), null);

            // A session the server doesn't have isn't forked.
            assert.deepEqual(await chats.forkSession({ from: S2, length: 0, cursor: 0, chats: [], user }), { ok: false, reason: 'unknown session' });
            // The original's delete leaves the forks' history whole.
            await chats.deleteSession(S1);
            assert.deepEqual(await chats.sessionPlace(r), { length: 3, cursor: 2 });
            assert.equal((await chats.step({ back: true, actor: { user, session: r } })).ok, true);
            assert.deepEqual(await chats.pointer(r), { tree: t, at: a });
        } finally {
            await store.close();
        }
    });
}
