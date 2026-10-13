import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import path from 'node:path';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    fixture = await import('./converted-user.fixture.js');
    const chats = await import('../src/endpoints/chats.js');

    user = await fixture.emptyUser('st-openings-land-test-');
    globalThis.DATA_ROOT = user.dataRoot;

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

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await user.close();
});

async function postJson(urlPath, body) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

let counter = 0;

/**
 * A character whose stored openings are `texts`, in order. Resolves to its avatar and their row ids.
 * @param {string[]} texts
 */
async function ownerWithOpenings(texts) {
    counter += 1;
    const avatar = `land-owner-${counter}.png`;
    const contents = texts.map(mes => ({ name: 'Char', is_user: false, is_system: false, send_date: 'd0', mes, extra: {} }));
    await user.store.lib.writeCard(user.directories, avatar, JSON.stringify({ name: 'Char', data: { name: 'Char' } }));
    // Each text an opening of its own: a message with no parent.
    const ids = [];
    for (const content of contents) ids.push(...await fixture.seedMessages(user.store, { avatar }, null, [content]));
    return { avatar, ids };
}

const openings = n => Array.from({ length: n }, (_, i) => `opening ${i}`);

describe('POST /api/chats/openings/land', () => {
    test('rule 1: the opening with exactly the shown text, even outside a first window of 11', async () => {
        const texts = openings(20);
        const { avatar, ids } = await ownerWithOpenings(texts);
        const res = await postJson('/api/chats/openings/land', { avatar_url: avatar, shown_text: texts[17], index: 2 });
        expect(res.status).toBe(200);
        expect(res.body.index).toBe(17);
        expect(res.body.opening).toMatchObject({ node_id: ids[17], mes: texts[17] });
    });

    test('rule 2: this page\'s own edit from the shown text leads to the opening with its new text', async () => {
        const texts = openings(15);
        const { avatar, ids } = await ownerWithOpenings(texts);
        const res = await postJson('/api/chats/openings/land', {
            avatar_url: avatar, shown_text: 'was edited', index: 1,
            edits: [{ from: 'other', to: texts[3] }, { from: 'was edited', to: texts[13] }],
        });
        expect(res.body.index).toBe(13);
        expect(res.body.opening.node_id).toBe(ids[13]);
    });

    test('rule 3: a shown text no opening has lands at the same index', async () => {
        const texts = openings(15);
        const { avatar, ids } = await ownerWithOpenings(texts);
        const res = await postJson('/api/chats/openings/land', { avatar_url: avatar, shown_text: 'gone', index: 12 });
        expect(res.body.index).toBe(12);
        expect(res.body.opening).toMatchObject({ node_id: ids[12], mes: texts[12] });
    });

    test('rule 3: an index past the end is clamped to the last opening', async () => {
        const texts = openings(5);
        const { avatar, ids } = await ownerWithOpenings(texts);
        const res = await postJson('/api/chats/openings/land', { avatar_url: avatar, shown_text: 'gone', index: 9 });
        expect(res.body.index).toBe(4);
        expect(res.body.opening.node_id).toBe(ids[4]);
    });

    test('no openings at all answers with no opening', async () => {
        // A character with no greeting and no stored opening (an avatar no character has is an unknown chat, 404).
        await user.store.lib.writeCard(user.directories, 'land-nobody.png', JSON.stringify({ name: 'Nobody', data: { name: 'Nobody' } }));
        const res = await postJson('/api/chats/openings/land', { avatar_url: 'land-nobody.png', shown_text: 'gone', index: 0 });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ index: -1, opening: null });
    });

    test('every edit of a save counts, however many: one among 150 still leads to its opening', async () => {
        const texts = openings(15);
        const { avatar, ids } = await ownerWithOpenings(texts);
        const edits = [{ from: 'was edited', to: texts[13] }, ...Array.from({ length: 149 }, (_, i) => ({ from: `before ${i}`, to: `after ${i}` }))];
        const res = await postJson('/api/chats/openings/land', { avatar_url: avatar, shown_text: 'was edited', index: 1, edits });
        expect(res.status).toBe(200);
        expect(res.body.index).toBe(13);
        expect(res.body.opening.node_id).toBe(ids[13]);
    });

    test('a missing shown_text, a bad index or edits that aren\'t a list is a 400', async () => {
        expect((await postJson('/api/chats/openings/land', { avatar_url: 'a.png', index: 0 })).status).toBe(400);
        expect((await postJson('/api/chats/openings/land', { avatar_url: 'a.png', shown_text: 'x', index: -1 })).status).toBe(400);
        expect((await postJson('/api/chats/openings/land', { avatar_url: 'a.png', shown_text: 'x', index: 1.5 })).status).toBe(400);
        expect((await postJson('/api/chats/openings/land', { avatar_url: 'a.png', shown_text: 'x', index: 0, edits: { from: 'a', to: 'b' } })).status).toBe(400);
    });
});
