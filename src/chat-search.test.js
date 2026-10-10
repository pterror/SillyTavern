// A tree's sessions searched on the engine (`ChatEngine.searchSessions`, `/api/chats/search`): by name, or by every
// word matching a message on the session's path, and a write found by the next search; and found by exact name
// (`sessionsNamed`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';

const { ChatEngine } = await import('./chat-engine.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-search-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cara = { id: 1n, name: 'Cara', avatar: 'cara.png' };
const people = {
    speakers: async (/** @type {bigint[]} */ ids) => new Map(ids.filter(id => id === cara.id).map(id => [id, cara])),
    byAvatar: async (/** @type {string[]} */ avatars) => new Map(avatars.filter(a => a === cara.avatar).map(a => [a, cara])),
};
const one = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000a1' };
const two = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000a2' };
const msg = (/** @type {boolean} */ isUser, /** @type {string} */ mes) => ({ name: isUser ? 'You' : 'Cara', is_user: isUser, is_system: false, mes, extra: {} });

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: sessions are found by their paths' words and by name`, async () => {
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
        await chats.nameSession({ session: two.session, name: 'Evening walk', actor: two });

        const found = async (/** @type {string} */ search) => (await chats.searchSessions({ tree: t, search, limit: 10 })).rows.map(r => r.session).sort();
        assert.deepEqual(await found(''), [one.session, two.session]);
        assert.deepEqual(await found('hello'), [one.session, two.session]);
        assert.deepEqual(await found('brings visiting'), [one.session]);
        assert.deepEqual(await found('how'), [two.session]);
        assert.deepEqual(await found('"how are"'), [two.session]);
        assert.deepEqual(await found('"are how"'), []);
        assert.deepEqual(await found('visit'), [], 'a word is matched whole');
        assert.deepEqual(await found('even'), [two.session], 'a name is a prefix field');
        assert.deepEqual(await found('evening hello'), [], 'the name and the path each match the whole query or not at all');

        // A name finds its session exactly; names are the store's, whoever asks.
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
        await chats.nameSession({ session: one.session, name: null, actor: one });
        assert.equal(await named('Evening walk'), null);
        await chats.nameSession({ session: two.session, name: 'Evening walk', actor: one });

        // Pages of one, read on through `next`.
        const first = await chats.searchSessions({ tree: t, search: 'hello', limit: 1 });
        assert.equal(first.rows.length, 1);
        assert.equal(first.more, true);
        const rest = await chats.searchSessions({ tree: t, search: 'hello', limit: 1, before: first.next });
        assert.deepEqual([...first.rows, ...rest.rows].map(r => r.session).sort(), [one.session, two.session]);

        // An edit is found by the next search, and the old word no longer is.
        await chats.editMessages({ tree: t, treeSpeaker: cara, edits: [{ node_id: u2, content: msg(true, 'Just wandering.') }], actor: one });
        assert.deepEqual(await found('wandering'), [one.session]);
        assert.deepEqual(await found('visiting'), []);
        await store.close();
    });
}
