// A tree's chats on the engine: upstream's chat list (`ChatEngine.chatList`: its bookmarks, and the tab's session
// when no bookmark is at its message), that list searched (`searchChatList`: by name, or by the path down to an item
// holding the words), the tree's messages searched (`searchMessages`: the index, then the capped substring scan), a
// new chat, and sessions found by exact name (`sessionNamed`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';

const { ChatEngine, MODE } = await import('./chat-engine.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-search-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cara = { id: 1n, name: 'Cara', avatar: 'cara.png' };
const people = {
    speakers: async (/** @type {bigint[]} */ ids) => new Map(ids.filter(id => id === cara.id).map(id => [id, cara])),
    byAvatar: async (/** @type {string[]} */ avatars) => new Map(avatars.filter(a => a === cara.avatar).map(a => [a, cara])),
};
const one = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000a1' };
const two = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000a2' };
const three = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000a3' };
const msg = (/** @type {boolean} */ isUser, /** @type {string} */ mes) => ({ name: isUser ? 'You' : 'Cara', is_user: isUser, is_system: false, mes, extra: {} });

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: the chat list, its search, message search and names`, async () => {
        const store = await engine.Store.open(path.join(root, kind));
        const chats = await ChatEngine.open(store, people);
        const t = cara.id;
        const [greeting] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: null, contents: [msg(false, 'Hello there!')], actor: { user: one.user } })).node_ids;
        await chats.select({ tree: t, node_id: greeting, actor: one });
        const [u1, b1] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: greeting, contents: [msg(true, 'Hi Cara.'), msg(false, 'How are you?')], actor: one })).node_ids;
        const [b1b] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: u1, contents: [msg(false, 'What brings you here?')], actor: one })).node_ids;
        await chats.select({ tree: t, node_id: b1b, actor: one });
        const [u2] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: b1b, contents: [msg(true, 'Just visiting.')], actor: one })).node_ids;
        await chats.select({ tree: t, node_id: b1, actor: two });
        await chats.goTo({ tree: t, node_id: u1, actor: three });
        await chats.createBookmark({ tree: t, node_id: u2, name: 'Morning visit', mode: MODE.pinned, actor: one });
        await chats.createBookmark({ tree: t, node_id: b1, name: 'Evening walk', mode: MODE.pinned, actor: two });

        // The chat list: bookmarks, and the tab's session first when no bookmark is at its message.
        const names = async (/** @type {any} */ p) => (await chats.searchChatList({ tree: t, limit: 10, search: '', ...p })).rows.map(r => r.name ?? r.session);
        assert.deepEqual((await chats.chatList({ tree: t, session: one.session, limit: 10 })).rows.map(r => r.name), ['Morning visit', 'Evening walk']);
        const withThree = (await chats.chatList({ tree: t, session: three.session, limit: 10 })).rows;
        assert.deepEqual(withThree.map(r => [r.session, r.name]), [[three.session, null], [null, 'Morning visit'], [null, 'Evening walk']]);
        assert.equal(withThree[1].last_mes, 'Just visiting.');

        // Searched: by name (a part of it, lower-cased), or by the path down to an item holding the words.
        const found = (/** @type {string} */ search, session = one.session) => names({ search, session });
        assert.deepEqual(await found('visiting'), ['Morning visit']);
        assert.deepEqual(await found('how'), ['Evening walk']);
        assert.deepEqual(await found('hello'), ['Morning visit', 'Evening walk']);
        assert.deepEqual(await found('hello', three.session), [three.session, 'Morning visit', 'Evening walk']);
        assert.deepEqual(await found('ORNING'), ['Morning visit'], 'a name holds a part of a word');
        assert.deepEqual(await found('"how are"'), ['Evening walk']);
        assert.deepEqual(await found('"are how"'), []);
        assert.deepEqual(await found('brings how'), [], 'every word on one path');
        const first = await chats.searchChatList({ tree: t, search: 'hello', session: one.session, limit: 1 });
        assert.equal(first.more, true);
        assert.equal(first.exact, true);
        const rest = await chats.searchChatList({ tree: t, search: 'hello', session: one.session, limit: 1, after: first.next });
        assert.deepEqual([...first.rows, ...rest.rows].map(r => r.name), ['Morning visit', 'Evening walk']);

        // Messages: the index's whole words best first, then what the substring scan adds.
        const messages = async (/** @type {string} */ search, p = {}) => (await chats.searchMessages({ tree: t, search, limit: 10, ...p }));
        const hello = await messages('hello');
        assert.deepEqual(hello.rows.map(r => [r.id, r.snippet, r.depth]), [[greeting, 'Hello there!', 1n]]);
        assert.equal(hello.partial, undefined);
        assert.deepEqual((await messages('visit')).rows.map(r => [r.id, r.score]), [[u2, null]], 'a part of a word, by the scan');
        assert.deepEqual((await messages('VISIT')).rows.map(r => r.id), [u2]);
        assert.deepEqual((await messages('visiting')).rows.map(r => [r.id, r.score === null]), [[u2, false]], 'whole words aren\'t scanned twice');
        assert.deepEqual((await messages('hello visit')).rows, []);
        // A scan stopped by its cap is marked and goes on from its cursor.
        const capped = await messages('visit', { scanBytes: 0 });
        assert.equal(capped.partial, true);
        const all = capped.rows.map(r => r.id);
        let cursor = capped.scanCursor;
        for (let i = 0; cursor && i < 20; i++) {
            const next = await messages('visit', { scanBytes: 0, scanCursor: cursor });
            all.push(...next.rows.map(r => r.id));
            cursor = next.scanCursor;
        }
        assert.equal(cursor, undefined);
        assert.deepEqual(all, [u2]);

        // An edit is found by the next searches, and the old word no longer is.
        await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: u2, content: msg(true, 'Just wandering.') }], actor: one });
        assert.deepEqual(await found('wandering'), ['Morning visit']);
        assert.deepEqual(await found('visiting'), []);
        assert.deepEqual((await messages('wander')).rows.map(r => r.id), [u2]);

        // A new chat: the session goes to a fresh greeting; no bookmark is made.
        await chats.newChat({ tree: t, actor: one });
        const fresh = (await chats.chatList({ tree: t, session: one.session, limit: 10 })).rows;
        assert.deepEqual(fresh.map(r => [r.session, r.name, r.at]), [[one.session, null, null], [null, 'Morning visit', u2], [null, 'Evening walk', b1]]);

        // A name finds its session exactly; names are the store's, whoever asks.
        await chats.nameSession({ session: two.session, name: 'Evening walk', actor: two });
        const named = (/** @type {string} */ name) => chats.sessionNamed(name);
        assert.equal(await named('Evening walk'), two.session);
        assert.equal(await named('evening walk'), null);
        assert.deepEqual(await chats.nameSession({ session: one.session, name: '!!!', actor: one }), { ok: true, name: '!!!' });
        assert.equal(await named('!!!'), one.session);
        // A name another session holds gets upstream's suffix, whichever user names it; its own name is kept.
        assert.deepEqual(await chats.nameSession({ session: one.session, name: 'Evening walk', actor: { ...one, user: 'someone else' } }), { ok: true, name: 'Evening walk (1)' });
        assert.equal(await named('Evening walk (1)'), one.session);
        assert.equal(await named('!!!'), null);
        assert.deepEqual(await chats.nameSession({ session: two.session, name: 'Evening walk', actor: one }), { ok: true, name: 'Evening walk' });
        assert.deepEqual(await chats.nameSession({ session: two.session, name: 'Evening walk (1)', actor: one }), { ok: true, name: 'Evening walk (1) (1)' }, 'as getUniqueName() builds on the name given');
        assert.deepEqual(await chats.nameSession({ session: one.session, name: 'Evening walk', actor: one }), { ok: true, name: 'Evening walk' });
        assert.equal(await named('Evening walk'), one.session);
        // The engine refuses a name another session holds.
        const [sid] = await store.chatRead('ids', { space: 1, keys: [two.session] });
        await assert.rejects(store.commit([{ kind: 'positionName', id: sid, name: 'Evening walk' }]));
        await store.close();
    });
}
