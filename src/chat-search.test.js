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
        const morning = await chats.createBookmark({ tree: t, node_id: u2, name: 'Morning visit', mode: MODE.pinned, actor: one });
        await chats.createBookmark({ tree: t, node_id: b1, name: 'Evening walk', mode: MODE.pinned, actor: two });

        // The chat list, newest first by the time of the message each is at: bookmarks, and the tab's session when it
        // has no current chat there, even beside a bookmark at its message (before it).
        assert.deepEqual((await chats.chatList({ tree: t, session: one.session, limit: 10 })).rows.map(r => r.name ?? r.session), [one.session, 'Morning visit', 'Evening walk']);
        assert.ok(morning.ok);
        await chats.setCurrentChat({ tree: t, bookmark: morning.ok ? morning.bookmark : null, actor: one });
        const names = async (/** @type {any} */ p) => (await chats.searchChatList({ tree: t, limit: 10, search: '', ...p })).rows.map(r => r.name ?? r.session);
        assert.deepEqual((await chats.chatList({ tree: t, session: one.session, limit: 10 })).rows.map(r => r.name), ['Morning visit', 'Evening walk']);
        const withThree = (await chats.chatList({ tree: t, session: three.session, limit: 10 })).rows;
        assert.deepEqual(withThree.map(r => [r.session, r.name]), [[null, 'Morning visit'], [null, 'Evening walk'], [three.session, null]]);
        assert.equal(withThree[0].last_mes, 'Just visiting.');
        // Paged: each page goes on after the last row of the one before.
        const paged = [];
        let listAfter;
        for (;;) {
            const page = await chats.chatList({ tree: t, session: three.session, limit: 1, after: listAfter });
            paged.push(...page.rows.map(r => r.name ?? r.session));
            if (!page.more) break;
            listAfter = page.rows[page.rows.length - 1].position;
        }
        assert.deepEqual(paged, ['Morning visit', 'Evening walk', three.session]);

        // Searched: by name (a part of it, lower-cased), or by the path down to an item holding the words.
        const found = (/** @type {string} */ search, session = one.session) => names({ search, session });
        assert.deepEqual(await found('visiting'), ['Morning visit']);
        assert.deepEqual(await found('how'), ['Evening walk']);
        assert.deepEqual(await found('hello'), ['Morning visit', 'Evening walk']);
        assert.deepEqual(await found('hello', three.session), ['Morning visit', 'Evening walk', three.session]);
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

        // The chat list by the scan too: a part of a word, whole-query and lower-cased, the path down to an item.
        assert.deepEqual(await found('wande'), ['Morning visit'], 'a part of a word, by the scan');
        assert.deepEqual(await found('WANDE'), ['Morning visit']);
        assert.deepEqual(await found('ello'), ['Morning visit', 'Evening walk'], 'a message on both paths');
        assert.deepEqual(await found('ello', three.session), ['Morning visit', 'Evening walk', three.session]);
        assert.deepEqual(await found('wande x'), [], 'the whole query is one substring');
        assert.deepEqual(await found('just wande'), ['Morning visit'], 'a substring across words');
        // Search syntax isn't scanned for: a phrase's quotes, a leading dash (no negation: the index reads a word).
        assert.deepEqual(await found('"just wande"'), ['Morning visit'], 'a closed phrase without its quotes');
        assert.deepEqual(await found('"just wande'), ['Morning visit'], 'an open phrase without its quote');
        assert.deepEqual(await found('-wande'), ['Morning visit'], 'a leading dash dropped');
        assert.deepEqual((await messages('-wande')).rows.map(r => r.id), [u2], 'messages: a leading dash dropped');
        // Deduped: whole words found it, the scan finds the message too, and the item is listed once.
        assert.deepEqual(await found('wandering'), ['Morning visit']);
        assert.deepEqual(await found('walk'), ['Evening walk'], 'a name match');
        const mixed = await names({ search: 'o', session: one.session });
        assert.equal(new Set(mixed).size, mixed.length, 'index, name and scan matches of one item are listed once');
        // The scan's items come after a first page's rows; a later page of items scans nothing.
        const firstPage = await chats.searchChatList({ tree: t, search: 'ello', session: one.session, limit: 1 });
        assert.deepEqual(firstPage.rows.map(r => r.name), ['Morning visit', 'Evening walk']);
        const laterPage = await chats.searchChatList({ tree: t, search: 'ello', session: one.session, limit: 10, after: '99999999999999999:99999999999' });
        assert.deepEqual(laterPage.rows, []);
        // A scan stopped by its cap is marked "~" (not exact) and goes on from its cursor.
        const cappedList = await chats.searchChatList({ tree: t, search: 'wande', session: one.session, limit: 10, scanBytes: 0 });
        assert.equal(cappedList.exact, false);
        assert.ok(cappedList.scanCursor);
        const listed = cappedList.rows.map(r => r.name);
        let listCursor = cappedList.scanCursor;
        for (let i = 0; listCursor && i < 20; i++) {
            const next = await chats.searchChatList({ tree: t, search: 'wande', session: one.session, limit: 10, scanBytes: 0, scanCursor: listCursor });
            listed.push(...next.rows.map(r => r.name));
            listCursor = next.scanCursor;
            assert.equal(next.exact, listCursor === undefined);
        }
        assert.equal(listCursor, undefined);
        assert.deepEqual([...new Set(listed)], ['Morning visit']);
        await assert.rejects(chats.searchChatList({ tree: t, search: 'x', limit: 1, scanCursor: 'nope' }), /invalid scan cursor/);

        // A new chat (no current chat): the session goes to a fresh greeting; no bookmark is made.
        await chats.newChat({ tree: t, actor: one });
        await chats.setCurrentChat({ tree: t, bookmark: null, actor: one });
        const fresh = (await chats.chatList({ tree: t, session: one.session, limit: 10 })).rows;
        // At the tree's root it is placed by when it got there: the newest, so first, as upstream lists a new chat.
        assert.deepEqual(fresh.map(r => [r.session, r.name, r.at]), [[one.session, null, null], [null, 'Morning visit', u2], [null, 'Evening walk', b1]]);
        // A bookmark at the root is placed by when it was made: made last, it comes first.
        const now = chats.now;
        chats.now = () => Date.now() + 60_000;
        await chats.createBookmark({ tree: t, node_id: null, name: 'Blank', actor: two });
        chats.now = now;
        const withBlank = (await chats.chatList({ tree: t, session: one.session, limit: 10 })).rows.map(r => r.name ?? r.session);
        assert.deepEqual(withBlank, ['Blank', one.session, 'Morning visit', 'Evening walk']);

        // A name finds its session exactly, while one session has it; names are the store's, whoever asks.
        await chats.nameSession({ session: two.session, name: 'Evening walk', actor: two });
        const named = (/** @type {string} */ name) => chats.sessionNamed(name);
        assert.equal(await named('Evening walk'), two.session);
        assert.equal(await named('evening walk'), null);
        assert.deepEqual(await chats.nameSession({ session: one.session, name: '!!!', actor: one }), { ok: true, name: '!!!' });
        assert.equal(await named('!!!'), one.session);
        // A name another session holds is kept as given, whichever user names it; the name then finds neither.
        assert.deepEqual(await chats.nameSession({ session: one.session, name: 'Evening walk', actor: { ...one, user: 'someone else' } }), { ok: true, name: 'Evening walk' });
        assert.equal(await named('Evening walk'), null);
        assert.equal(await named('!!!'), null);
        assert.deepEqual(await chats.nameSession({ session: two.session, name: 'Dawn', actor: one }), { ok: true, name: 'Dawn' });
        assert.equal(await named('Evening walk'), one.session);
        assert.equal(await named('Dawn'), two.session);
        await store.close();
    });
}

for (const [kind, engine] of Object.entries({ native: loadEngine().binding, wasm: loadEngine({ platform: null }).binding })) {
    test(`${kind}: a bookmark at the tree's root is listed, renamed, and follows the first opening stored`, async () => {
        const store = await engine.Store.open(path.join(root, `${kind}-root`));
        const chats = await ChatEngine.open(store, people);
        const t = cara.id;
        const empty = await chats.createBookmark({ tree: t, node_id: null, name: 'Empty chat', actor: one });
        const pinned = await chats.createBookmark({ tree: t, node_id: null, name: 'Empty chat', mode: MODE.pinned, actor: one });
        assert.deepEqual([empty.ok, empty.name, pinned.name], [true, 'Empty chat', 'Empty chat']);
        const rows = (await chats.bookmarks({ tree: t, limit: 10 })).rows;
        assert.deepEqual(rows.map(r => [r.id, r.name, r.at, r.made_at]), [[String(empty.bookmark), 'Empty chat', null, null], [String(pinned.bookmark), 'Empty chat', null, null]]);
        const listed = (await chats.chatList({ tree: t, limit: 10 })).rows;
        // Both at the root, by when each was made: the newest first.
        assert.deepEqual(listed.map(r => [r.bookmark, r.name, r.at, r.message_count]), [[String(pinned.bookmark), 'Empty chat', null, 0], [String(empty.bookmark), 'Empty chat', null, 0]]);
        assert.deepEqual(await chats.changeBookmark({ tree: t, bookmark: String(pinned.ok && pinned.bookmark), change: { name: 'Kept' } }), { ok: true, name: 'Kept' });
        assert.deepEqual((await chats.changeBookmark({ tree: 99n, bookmark: String(pinned.ok && pinned.bookmark), change: { name: 'x' } })).ok, false);
        const [greeting] = (await chats.appendMessages({ tree: t, treeSpeaker: cara, after: null, contents: [msg(false, 'Hello!')], actor: { user: one.user } })).node_ids;
        const after = (await chats.bookmarks({ tree: t, limit: 10 })).rows;
        assert.deepEqual(after.map(r => [r.name, r.at]), [['Empty chat', greeting], ['Kept', null]]);
        await store.close();
    });
}
