import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import path from 'node:path';

import express from 'express';

import { setConfigFilePath } from '../src/util.js';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let base = '';
const SESSION = '0190a1b2-0000-7000-8000-00000000c0de';

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
    user = await fixture.convertedUser('chats-cut-');
    const { router } = await import('../src/endpoints/chats.js');
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/chats', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await user.close();
});

/** @param {string} url @param {object} body */
async function post(url, body) {
    const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ST-Session': SESSION }, body: JSON.stringify({ avatar_url: 'Bob.png', ...body }) });
    return { status: res.status, data: await res.json() };
}

const msg = (/** @type {string} */ mes) => ({ name: mes.startsWith('u') ? 'You' : 'Bob', is_user: mes.startsWith('u'), is_system: false, mes, extra: {} });

/** The session's shown path, as texts and ids. */
async function shown() {
    const tree = await fixture.treeOf(user.store, { avatar: 'Bob.png' });
    const at = (await user.store.chats.pointer(SESSION))?.at ?? null;
    const loaded = await user.store.chats.load({ tree, at });
    return { texts: loaded?.messages.map(m => m.mes), ids: loaded?.messages.map(m => m.node_id) };
}

describe('POST /api/chats/message/cut', () => {
    test('cuts from the session\'s path, copying what other branches share, and asks before dropping a bookmark', async () => {
        const [g, u1, b1, u2, b2] = await fixture.seedMessages(user.store, { avatar: 'Bob.png' }, null, ['g', 'u1', 'b1', 'u2', 'b2'].map(msg), { session: SESSION });
        // Another branch passes through u2.
        await fixture.seedMessages(user.store, { avatar: 'Bob.png' }, u2, [msg('b2x')], { session: '0190a1b2-0000-7000-8000-00000000beef' });
        // b1 stays (the other branch passes through it); u2, which the other branch shares, is copied onto this path.
        const cut = await post('/api/chats/message/cut', { first_node_id: b1, last_node_id: b1 });
        expect(cut.status).toBe(200);
        expect(Object.keys(cut.data.copied)).toEqual([u2]);
        const after = await shown();
        expect(after.texts).toEqual(['g', 'u1', 'u2', 'b2']);
        expect(after.ids).toEqual([g, u1, cut.data.copied[u2], b2]);

        // A pinned bookmark on a message that goes is asked about first.
        const tree = await fixture.treeOf(user.store, { avatar: 'Bob.png' });
        const made = /** @type {any} */ (await user.store.chats.createBookmark({ tree, node_id: b2, name: 'At b2', actor: { user: 'u', session: SESSION } }));
        await user.store.chats.changeBookmark({ tree, bookmark: String(made.bookmark), change: { mode: 2 } });
        const preview = await post('/api/chats/message/cut', { first_node_id: b2, last_node_id: b2, preview: true });
        expect(preview.status).toBe(200);
        expect(preview.data.drops.bookmarks.map((/** @type {any} */ b) => b.name)).toEqual(['At b2']);
        const refused = await post('/api/chats/message/cut', { first_node_id: b2, last_node_id: b2 });
        expect(refused.status).toBe(409);
        expect(refused.data.reason).toBe('confirm');
        expect((await shown()).texts).toEqual(['g', 'u1', 'u2', 'b2']);
        const confirm = { bookmarks: preview.data.drops.bookmarks.map((/** @type {any} */ b) => b.id), changes: [] };
        expect((await post('/api/chats/message/cut', { first_node_id: b2, last_node_id: b2, confirm })).status).toBe(200);
        expect((await shown()).texts).toEqual(['g', 'u1', 'u2']);
    });
});
