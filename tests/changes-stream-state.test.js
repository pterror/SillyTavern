import { test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import path from 'node:path';

/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').convertedUser>>} */
let user;
let previousDataRoot;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    user = await (await import('./converted-user.fixture.js')).convertedUser('st-changes-stream-state-test-');
    previousDataRoot = globalThis.DATA_ROOT;
    globalThis.DATA_ROOT = user.dataRoot;

    const { router } = await import('../src/endpoints/characters.js');
    const express = (await import('express')).default;
    const app = express();
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    globalThis.DATA_ROOT = previousDataRoot;
    await user.close();
});

/**
 * @param {string} query
 * @returns {Promise<{ frames: any[], close: () => void }>}
 */
async function openStream(query = '') {
    const request = http.get(`${baseUrl}/api/characters/changes/stream${query}`);
    /** @type {import('node:http').IncomingMessage} */
    const response = await new Promise((resolve, reject) => {
        request.once('response', resolve);
        request.once('error', reject);
    });
    expect(response.statusCode).toBe(200);
    response.setEncoding('utf8');
    const frames = [];
    let buffered = '';
    response.on('data', chunk => {
        buffered += chunk;
        const events = buffered.split('\n\n');
        buffered = events.pop() ?? '';
        for (const event of events) {
            if (event.startsWith('data: ')) frames.push(JSON.parse(event.slice('data: '.length)));
        }
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    return { frames, close: () => request.destroy() };
}

/**
 * @param {any[]} frames
 * @param {(frame: any) => boolean} match
 * @param {number} [within]
 */
async function frameArrives(frames, match, within = 4000) {
    for (let waited = 0; waited < within; waited += 50) {
        if (frames.some(match)) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
}

test('another session\'s change to the chat a tab is at is pushed with the state; the tab\'s own change is not pushed', async () => {
    const stream = await openStream('?token=statetab0001&claim=1');
    try {
        expect(await frameArrives(stream.frames, f => f?.type === 'session')).toBe(true);
        const session = stream.frames.find(f => f?.type === 'session').session;
        const { chats, people } = user.store;
        const [tree] = await people.trees([{ avatar: 'Alice.png' }]);
        const { storedForm } = await import('../src/chat-engine.js');
        const made = await chats.appendMessages({
            tree, treeSpeaker: null, after: null,
            contents: [storedForm({ name: 'Alice', is_user: false, mes: 'Hello there.', extra: {}, send_date: Date.now() })],
            actor: { user: 'u', session },
        });
        expect(made.ok).toBe(true);
        const at = made.node_ids[0];
        expect(await chats.pointer(session)).toEqual({ tree, at });

        const isState = (/** @type {any} */ f) => f?.type === 'state';
        await chats.mergeMetadata({ tree, at, set: {}, unset: [], variables: { set: { hp: 3 } }, actor: { user: 'u', session } });
        expect(await frameArrives(stream.frames, isState, 1000)).toBe(false);

        await chats.mergeMetadata({ tree, at, set: { scene: 'inn' }, unset: [], actor: { user: 'u', session: '0190a1b2-0000-7000-8000-0000000000ab' } });
        expect(await frameArrives(stream.frames, isState)).toBe(true);
        const pushed = stream.frames.find(isState);
        expect(pushed.tree).toEqual({ avatar: 'Alice.png' });
        expect(pushed.at).toBe(at);
        expect(pushed.state).toEqual({ scene: 'inn', variables: { hp: 3 }, integrity: session });

        stream.frames.length = 0;
        const [otherTree] = await people.trees([{ avatar: 'Bob.png' }]);
        await chats.mergeMetadata({ tree: otherTree, at: null, set: { scene: 'road' }, unset: [], actor: { user: 'u', session: '0190a1b2-0000-7000-8000-0000000000ab' } });
        expect(await frameArrives(stream.frames, isState, 1000)).toBe(false);
    } finally {
        stream.close();
    }
});

test('deleting a lorebook the tab\'s chat links pushes the state without it, even when the tab set the link', async () => {
    const stream = await openStream('?token=statetab0002&claim=1');
    try {
        expect(await frameArrives(stream.frames, f => f?.type === 'session')).toBe(true);
        const session = stream.frames.find(f => f?.type === 'session').session;
        const { chats, people, lib } = user.store;
        const [tree] = await people.trees([{ avatar: 'Alice.png' }]);
        const { storedForm } = await import('../src/chat-engine.js');
        const made = await chats.appendMessages({
            tree, treeSpeaker: null, after: null,
            contents: [storedForm({ name: 'Alice', is_user: false, mes: 'Hi.', extra: {}, send_date: Date.now() })],
            actor: { user: 'u', session },
        });
        const at = made.node_ids[0];
        await lib.books.write('Doomed', { entries: {} });
        const isState = (/** @type {any} */ f) => f?.type === 'state';
        await chats.mergeMetadata({ tree, at, set: { world_info: 'Doomed' }, unset: [], actor: { user: 'u', session } });
        expect(await frameArrives(stream.frames, isState, 1000)).toBe(false);
        expect(await lib.books.delete('Doomed')).toEqual({ characters: [], trees: [tree] });
        expect(await frameArrives(stream.frames, isState)).toBe(true);
        const pushed = stream.frames.find(isState);
        expect(pushed.tree).toEqual({ avatar: 'Alice.png' });
        expect(pushed.at).toBe(at);
        expect(pushed.state.world_info).toBeUndefined();
    } finally {
        stream.close();
    }
});

test('a write that changes no character or group sends no library change', async () => {
    const stream = await openStream();
    try {
        await user.store.lib.tags.create({ id: 'state-stream-tag', name: 'State stream tag' }, { freeName: false });
        expect(await frameArrives(stream.frames, f => f?.type === 'tags-changed')).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 1000));
        expect(stream.frames.some(f => Object.keys(f).length === 0)).toBe(false);
    } finally {
        stream.close();
    }
});
