// Recent chats on the engine: the conversations (a bookmark, or a session's where it has no current chat) by their
// last meaningful activity, one row per compat chat id; a message without a key is a bug.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { loadEngine } from '../engine/load.js';

const { ChatEngine, bookmarkCompatId, sessionCompatId } = await import('./chat-engine.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-recent-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cast = [1n, 2n, 3n].map(id => ({ id, name: `Char${id}`, avatar: `char${id}.png` }));
const people = {
    speakers: async (/** @type {bigint[]} */ ids) => new Map(cast.filter(c => ids.includes(c.id)).map(c => [c.id, c])),
    byAvatar: async (/** @type {string[]} */ avatars) => new Map(cast.filter(c => avatars.includes(c.avatar)).map(c => [c.avatar, c])),
};
const a = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000c1' };
const b = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000c2' };
const msg = (/** @type {string} */ mes) => ({ name: 'Someone', is_user: false, is_system: false, mes, extra: {} });

let n = 0;
for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: recent chats are the conversations by their last meaningful activity`, async () => {
        const store = await engine.Store.open(path.join(root, `s${n++}`));
        const chats = await ChatEngine.open(store, people);
        let clock = 1_760_090_000_000;
        chats.now = () => (clock += 1000);
        const send = async (/** @type {bigint} */ tree, /** @type {string | null} */ after, /** @type {string} */ text, actor = a) =>
            (await chats.appendMessages({ tree, treeSpeaker: cast[Number(tree) - 1], after, contents: [msg(text)], actor })).node_ids[0];
        const ids = async (/** @type {object} */ page) => (await chats.recentConversations(page)).rows.map((/** @type {any} */ r) => r.id);

        assert.deepEqual(await ids({ limit: 10 }), []);

        // Sessions in several characters' trees: one row each, the latest act first.
        const one = await send(1n, null, 'one');
        const two = await send(2n, null, 'two', b);
        await send(3n, null, 'three');
        const s = (/** @type {any} */ actor, /** @type {bigint} */ tree) => sessionCompatId(actor.session, tree);
        assert.deepEqual(await ids({ limit: 10 }), [s(a, 3n), s(b, 2n), s(a, 1n)]);

        // A row's shape: the compat id, the message it is at, and that message's text and time.
        const [top] = (await chats.recentConversations({ limit: 1 })).rows;
        assert.equal(top.name, null);
        assert.equal(top.tree, 3n);
        assert.equal(top.last_mes, 'three');
        assert.equal(top.message_count, 1);
        const stored = (await chats.stored(await chats.messageIds([top.at]))).values().next().value;
        assert.equal(top.last_activity, stored.time);

        // Paging by the last row's position.
        const first = await chats.recentConversations({ limit: 2 });
        assert.equal(first.more, true);
        const rest = await chats.recentConversations({ limit: 2, before: first.rows[1].position });
        assert.deepEqual([first.rows, rest.rows].flat().map((/** @type {any} */ r) => r.id), [s(a, 3n), s(b, 2n), s(a, 1n)]);
        assert.equal(rest.more, false);

        // A bookmark made through a session is that session's act, not a row of its own.
        const made = /** @type {any} */ (await chats.createBookmark({ tree: 1n, node_id: one, name: 'Mark', actor: a }));
        assert.deepEqual(await ids({ limit: 10 }), [s(a, 1n), s(a, 3n), s(b, 2n)]);

        // Switching to it is no activity, and the conversation became the bookmark's.
        await chats.setCurrentChat({ tree: 1n, bookmark: String(made.bookmark), actor: a });
        assert.deepEqual(await ids({ limit: 10 }), [s(a, 3n), s(b, 2n)]);

        // The next act in it gives the bookmark its row: titled by its label, at the message it follows to.
        const reply = await send(1n, one, 'one-reply');
        const rows = (await chats.recentConversations({ limit: 10 })).rows;
        assert.deepEqual(rows.map((/** @type {any} */ r) => r.id), [bookmarkCompatId(made.bookmark), s(a, 3n), s(b, 2n)]);
        assert.equal(rows[0].name, 'Mark');
        assert.equal(rows[0].at, reply);
        assert.equal(rows[0].last_mes, 'one-reply');
        assert.equal(rows[0].message_count, 2);
        assert.equal(rows[1].name, null);

        // Another session using the same bookmark: still one row, moved up by that session's act.
        await chats.setCurrentChat({ tree: 1n, bookmark: String(made.bookmark), actor: b });
        await send(2n, two, 'two-reply', b);
        assert.deepEqual(await ids({ limit: 10 }), [s(b, 2n), bookmarkCompatId(made.bookmark), s(a, 3n)]);
        await send(1n, reply, 'one-again', b);
        assert.deepEqual(await ids({ limit: 10 }), [bookmarkCompatId(made.bookmark), s(b, 2n), s(a, 3n)]);

        // A deleted bookmark and a deleted session leave the list.
        assert.deepEqual(await chats.changeBookmark({ tree: 1n, bookmark: String(made.bookmark), change: { delete: true } }), { ok: true });
        assert.deepEqual(await ids({ limit: 10 }), [s(b, 2n), s(a, 3n)]);
        assert.deepEqual(await chats.deleteSession(b.session), { ok: true });
        assert.deepEqual(await ids({ limit: 10 }), [s(a, 3n)]);
        await store.close();
    });

    test(`${kind}: a message without a key is a bug, and a message that is gone has no outside id`, async () => {
        const store = await engine.Store.open(path.join(root, `s${n++}`));
        const chats = await ChatEngine.open(store, people);
        assert.throws(() => chats.externalId({ id: 7n, oldKey: null }), /no key/);
        assert.equal(chats.externalId({ id: 7n, oldKey: 'abc' }), 'abc');
        assert.deepEqual(await chats.externalIds([123456n]), [null]);
        await store.close();
    });
}
