import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect } from '@jest/globals';
import path from 'node:path';

// The single-message edits of a chat (graft, cut, swap, swipe delete) through a tab's session, on an engine user.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** The tab the requests come from. */
let tab = '';

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
    const chats = await import('../src/endpoints/chats.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/chats', chats.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-chats-graft-test-');
    globalThis.DATA_ROOT = user.dataRoot;
    tab = (await import('../src/chat-engine.js')).newSessionKey();
});

afterEach(() => user.close());

async function postJson(urlPath, body) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ST-Session': tab },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** A minimal message-object body the tree store round-trips. */
function makeMessage(mes) {
    return { name: 'Char', is_user: false, mes, extra: {} };
}

let counter = 0;

/** A new character with a 3-message chain saved by the tab, returning its node ids in order. */
async function seedChain() {
    counter += 1;
    const avatar = `owner-${counter}.png`;
    await user.store.lib.writeCard(user.directories, avatar, JSON.stringify({ name: 'Char', data: { name: 'Char' } }));
    const chatData = [{ chat_metadata: {} }, makeMessage('m0'), makeMessage('m1'), makeMessage('m2')];
    const saved = await postJson('/api/chats/save', { avatar_url: avatar, file_name: 'chat', chat: chatData });
    expect(saved.status).toBe(200);
    return { avatar, ids: (await shown(avatar)).map(m => m.node_id) };
}

/** The messages the tab's session shows. */
function shown(avatar) {
    return fixture.sessionPath(user.store, { avatar }, tab);
}

describe('POST /api/chats/message/graft', () => {
    test('inserts a node between two adjacent nodes and returns its id', async () => {
        const { avatar, ids: [n0, n1] } = await seedChain();

        const res = await postJson('/api/chats/message/graft', {
            avatar_url: avatar, after_node_id: n0, before_node_id: n1, content: makeMessage('grafted'),
        });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(typeof res.body.node_id).toBe('string');
        expect(res.body.node_id).not.toBe(n0);
        expect(res.body.node_id).not.toBe(n1);
        expect((await shown(avatar)).map(m => m.mes)).toEqual(['m0', 'grafted', 'm1', 'm2']);
    });

    test('400s when after_node_id is missing', async () => {
        const { avatar, ids: [, n1] } = await seedChain();
        const res = await postJson('/api/chats/message/graft', { avatar_url: avatar, before_node_id: n1, content: makeMessage('x') });
        expect(res.status).toBe(400);
    });

    test('400s when before_node_id is missing', async () => {
        const { avatar, ids: [n0] } = await seedChain();
        const res = await postJson('/api/chats/message/graft', { avatar_url: avatar, after_node_id: n0, content: makeMessage('x') });
        expect(res.status).toBe(400);
    });

    test('409s and refuses when before_node_id is not adjacent to after_node_id', async () => {
        const { avatar, ids: [n0, , n2] } = await seedChain();
        const res = await postJson('/api/chats/message/graft', {
            avatar_url: avatar, after_node_id: n0, before_node_id: n2, content: makeMessage('x'),
        });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ ok: false, reason: 'not adjacent' });
    });
});

// `/message/cut` replaces `/message/degraft` (5f step 3): messages leave this chat's path; what other branches share
// stays.
describe('POST /api/chats/message/cut', () => {
    test('removes a single mid-chain message from the path', async () => {
        const { avatar, ids: [, n1] } = await seedChain();

        const res = await postJson('/api/chats/message/cut', { avatar_url: avatar, first_node_id: n1, last_node_id: n1 });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect((await shown(avatar)).map(m => m.mes)).toEqual(['m0', 'm2']);
    });

    test('last_node_id defaults to first_node_id', async () => {
        const { avatar, ids: [, n1] } = await seedChain();
        const res = await postJson('/api/chats/message/cut', { avatar_url: avatar, first_node_id: n1 });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect((await shown(avatar)).map(m => m.mes)).toEqual(['m0', 'm2']);
    });

    test('400s when first_node_id is missing', async () => {
        const { avatar } = await seedChain();
        const res = await postJson('/api/chats/message/cut', { avatar_url: avatar });
        expect(res.status).toBe(400);
    });

    test('409s and refuses a message that is not on the path, changing nothing', async () => {
        const { avatar, ids: [, n1] } = await seedChain();
        const altRes = await postJson('/api/chats/message/alternative', { avatar_url: avatar, sibling_node_id: n1, contents: [makeMessage('alt-m1')] });
        const altId = altRes.body.node_ids[0];

        const res = await postJson('/api/chats/message/cut', { avatar_url: avatar, first_node_id: altId, last_node_id: altId });
        expect(res.status).toBe(409);
        expect(res.body.ok).toBe(false);
        expect((await shown(avatar)).map(m => m.mes)).toEqual(['m0', 'm1', 'm2']);
    });

    test('a cut at the path\'s end deletes that end', async () => {
        const { avatar, ids: [, , n2] } = await seedChain();
        const res = await postJson('/api/chats/message/cut', { avatar_url: avatar, first_node_id: n2, last_node_id: n2 });
        expect(res.status).toBe(200);
        expect((await shown(avatar)).map(m => m.mes)).toEqual(['m0', 'm1']);
    });
});

describe('POST /api/chats/message/swap-adjacent', () => {
    test('swaps two adjacent messages and keeps the new order', async () => {
        const { avatar, ids: [n0, n1, n2] } = await seedChain();

        const res = await postJson('/api/chats/message/swap-adjacent', { avatar_url: avatar, upper_node_id: n1, lower_node_id: n2 });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });

        const messages = await shown(avatar);
        expect(messages.map(m => m.mes)).toEqual(['m0', 'm2', 'm1']);
        expect(messages.map(m => m.node_id)).toEqual([n0, n2, n1]);
    });

    test('400s when upper_node_id is missing', async () => {
        const { avatar, ids: [, , n2] } = await seedChain();
        const res = await postJson('/api/chats/message/swap-adjacent', { avatar_url: avatar, lower_node_id: n2 });
        expect(res.status).toBe(400);
    });

    test('400s when lower_node_id is missing', async () => {
        const { avatar, ids: [, n1] } = await seedChain();
        const res = await postJson('/api/chats/message/swap-adjacent', { avatar_url: avatar, upper_node_id: n1 });
        expect(res.status).toBe(400);
    });

    test('409s and refuses non-adjacent nodes', async () => {
        const { avatar, ids: [n0, , n2] } = await seedChain();
        const res = await postJson('/api/chats/message/swap-adjacent', { avatar_url: avatar, upper_node_id: n0, lower_node_id: n2 });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ ok: false, reason: 'not adjacent' });
    });

    test('409s and refuses when the upper node is not the lower one\'s parent', async () => {
        const { avatar, ids: [, n1, n2] } = await seedChain();
        const altRes = await postJson('/api/chats/message/alternative', { avatar_url: avatar, sibling_node_id: n1, contents: [makeMessage('alt-m1')] });
        const altId = altRes.body.node_ids[0];

        const res = await postJson('/api/chats/message/swap-adjacent', { avatar_url: avatar, upper_node_id: altId, lower_node_id: n2 });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ ok: false, reason: 'not adjacent' });
    });

    test('swapping twice in a row returns to the original order', async () => {
        const { avatar, ids: [n0, n1, n2] } = await seedChain();
        expect((await postJson('/api/chats/message/swap-adjacent', { avatar_url: avatar, upper_node_id: n1, lower_node_id: n2 })).body).toEqual({ ok: true });
        expect((await postJson('/api/chats/message/swap-adjacent', { avatar_url: avatar, upper_node_id: n2, lower_node_id: n1 })).body).toEqual({ ok: true });

        const messages = await shown(avatar);
        expect(messages.map(m => m.mes)).toEqual(['m0', 'm1', 'm2']);
        expect(messages.map(m => m.node_id)).toEqual([n0, n1, n2]);
    });
});

// A swipe delete is "delete this swipe and all descendants" (5b addendum: the old route maps to `deleteSubtree`);
// what else it would drop is answered and has to be confirmed.
describe('POST /api/chats/message/alternative/delete', () => {
    test('deletes an unshown alternative, leaving the path as it was', async () => {
        const { avatar, ids: [, n1] } = await seedChain();
        const altRes = await postJson('/api/chats/message/alternative', { avatar_url: avatar, sibling_node_id: n1, contents: [makeMessage('unused-alt')] });
        const altId = altRes.body.node_ids[0];
        expect(altId).not.toBe(n1);

        const res = await postJson('/api/chats/message/alternative/delete', { avatar_url: avatar, node_id: altId });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect((await shown(avatar)).map(m => m.mes)).toEqual(['m0', 'm1', 'm2']);
        expect((await fixture.repliesOf(user.store, { avatar }, (await shown(avatar))[0].node_id)).length).toBe(1);
    });

    test('400s when node_id is missing', async () => {
        const { avatar } = await seedChain();
        const res = await postJson('/api/chats/message/alternative/delete', { avatar_url: avatar });
        expect(res.status).toBe(400);
    });

    test('deleting the shown swipe deletes what is below it, and the tab goes to the message above', async () => {
        const { avatar, ids: [, n1] } = await seedChain();
        const res = await postJson('/api/chats/message/alternative/delete', { avatar_url: avatar, node_id: n1 });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect((await shown(avatar)).map(m => m.mes)).toEqual(['m0']);
    });

    test('an alternative that has its own reply goes with it', async () => {
        const { avatar, ids: [, n1] } = await seedChain();
        const altRes = await postJson('/api/chats/message/alternative', { avatar_url: avatar, sibling_node_id: n1, contents: [makeMessage('once-continued-alt')] });
        const altId = altRes.body.node_ids[0];
        const appendRes = await postJson('/api/chats/message/append', { avatar_url: avatar, after_node_id: altId, messages: [makeMessage('child-of-alt')] });
        expect(appendRes.body.ok).toBe(true);
        const childId = appendRes.body.node_ids[0];

        const res = await postJson('/api/chats/message/alternative/delete', { avatar_url: avatar, node_id: altId });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect((await postJson('/api/chats/message/edit', { avatar_url: avatar, node_id: childId, content: makeMessage('child-of-alt') })).body.ok).not.toBe(true);
    });

    test('a following bookmark at the alternative moves up to the message above it', async () => {
        const { avatar, ids: [n0, n1] } = await seedChain();
        const altRes = await postJson('/api/chats/message/alternative', { avatar_url: avatar, sibling_node_id: n1, contents: [makeMessage('bookmarked-alt')] });
        const altId = altRes.body.node_ids[0];
        expect((await postJson('/api/chats/bookmark', { avatar_url: avatar, node_id: altId, label: 'checkpoint-on-alt' })).status).toBe(200);

        const res = await postJson('/api/chats/message/alternative/delete', { avatar_url: avatar, node_id: altId });
        expect(res.status).toBe(200);
        const tree = await fixture.treeOf(user.store, { avatar });
        const rows = (await user.store.chats.bookmarks({ tree, limit: 10 })).rows;
        expect(rows.find(b => b.name === 'checkpoint-on-alt')?.at).toBe(n0);
    });

    test('a pinned bookmark at the alternative goes with it, only once that drop is confirmed', async () => {
        const { avatar, ids: [, n1] } = await seedChain();
        const altRes = await postJson('/api/chats/message/alternative', { avatar_url: avatar, sibling_node_id: n1, contents: [makeMessage('bookmarked-alt')] });
        const altId = altRes.body.node_ids[0];
        const bookmark = await postJson('/api/chats/bookmark', { avatar_url: avatar, node_id: altId, label: 'checkpoint-on-alt' });
        expect(bookmark.status).toBe(200);
        const tree = await fixture.treeOf(user.store, { avatar });
        const made = (await user.store.chats.bookmarks({ tree, limit: 10 })).rows.find(b => b.name === 'checkpoint-on-alt');
        expect(await user.store.chats.changeBookmark({ tree, bookmark: made.id, change: { mode: 2 } })).toMatchObject({ ok: true });

        const refused = await postJson('/api/chats/message/alternative/delete', { avatar_url: avatar, node_id: altId });
        expect(refused.status).toBe(409);
        expect(refused.body.ok).toBe(false);
        expect(refused.body.drops.bookmarks.map(b => b.name)).toEqual(['checkpoint-on-alt']);

        const confirmed = await postJson('/api/chats/message/alternative/delete', { avatar_url: avatar, node_id: altId, confirm: { bookmarks: refused.body.drops.bookmarks.map(b => b.id), changes: refused.body.drops.changes.map(c => c.id) } });
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.ok).toBe(true);
    });

    test('409s when the node does not exist', async () => {
        const { avatar } = await seedChain();
        const res = await postJson('/api/chats/message/alternative/delete', { avatar_url: avatar, node_id: 'not-a-real-node-id' });
        expect(res.status).toBe(409);
        expect(res.body.ok).toBe(false);
    });

    test('end-to-end: 3 swipes, select swipe 2, delete swipe 1', async () => {
        const { avatar, ids: [, , n2] } = await seedChain();
        const altsRes = await postJson('/api/chats/message/alternative', { avatar_url: avatar, sibling_node_id: n2, contents: [makeMessage('swipe-2'), makeMessage('swipe-3')] });
        const [swipe2, swipe3] = altsRes.body.node_ids;

        const selectRes = await postJson('/api/chats/message/select', { avatar_url: avatar, node_id: swipe2 });
        expect(selectRes.body.ok).toBe(true);

        const deleteRes = await postJson('/api/chats/message/alternative/delete', { avatar_url: avatar, node_id: n2 });
        expect(deleteRes.status).toBe(200);
        expect(deleteRes.body.ok).toBe(true);

        const messages = await shown(avatar);
        expect(messages.map(m => m.mes)).toEqual(['m0', 'm1', 'swipe-2']);
        expect(messages.map(m => m.node_id)).toContain(swipe2);

        // swipe-3 is still there, off the path: adding the same content again is that message (speaker and text).
        const reAddRes = await postJson('/api/chats/message/alternative', { avatar_url: avatar, sibling_node_id: swipe2, contents: [makeMessage('swipe-3')] });
        expect(reAddRes.body.node_ids[0]).toBe(swipe3);
    });
});
