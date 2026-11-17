import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadEngine } from '../engine/load.js';
import { ChatEngine } from './chat-engine.js';
import { fakeOwners } from './chat-test-people.js';
import { cleanupGeneratedBookmarks, isGeneratedBookmarkName } from './generated-bookmark-cleanup.js';

test('only complete generated date and branch labels match', () => {
    const name = 'Cara - 2026-11-17@12h34m56s789ms';
    for (const label of [name, `${name} - Branch #12`]) assert.equal(isGeneratedBookmarkName(label), true);
    for (const label of [null, 'A bookmark', `${name} - Checkpoint #1`, `${name} notes`, 'Cara - (date)', '2026-11-17@12h34m56s789ms']) {
        assert.equal(isGeneratedBookmarkName(label), false);
    }
});

test('cleanup retains messages and custom bookmarks, previews and repeats safely', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-bookmarks-'));
    const store = await loadEngine().binding.Store.open(root);
    try {
        const cara = { id: 1n, name: 'Cara', avatar: 'cara.png' };
        const people = { speakers: async () => new Map([[1n, cara]]) };
        people.owners = fakeOwners(people);
        const chats = await ChatEngine.open(store, people);
        const actor = { user: 'tester', session: '0190a1b2-0000-7000-8000-0000000000b1' };
        const sent = await chats.appendMessages({ tree: 1n, treeSpeaker: cara, after: null, contents: [{ name: 'Cara', mes: 'Synthetic message', is_user: false, extra: {} }], actor });
        for (const name of ['Cara - 2026-11-17@12h34m56s789ms', 'Cara - 2026-11-17@12h34m56s789ms - Branch #1', 'My bookmark']) {
            assert.equal((await chats.createBookmark({ tree: 1n, node_id: sent.node_ids[0], name, actor })).ok, true);
        }
        assert.equal(await cleanupGeneratedBookmarks(store), 2);
        assert.equal((await chats.bookmarks({ tree: 1n, limit: 50 })).rows.length, 3);
        assert.equal(await cleanupGeneratedBookmarks(store, { apply: true }), 2);
        assert.deepEqual((await chats.bookmarks({ tree: 1n, limit: 50 })).rows.map(b => b.name), ['My bookmark']);
        assert.equal(await cleanupGeneratedBookmarks(store, { apply: true }), 0);
        const loaded = await chats.load({ tree: 1n, at: sent.node_ids[0] });
        assert.equal(loaded.messages[0].mes, 'Synthetic message');
    } finally {
        await store.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
