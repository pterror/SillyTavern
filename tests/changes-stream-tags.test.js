import { test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import path from 'node:path';

// A tag definition written by any route reaches every open page's change stream as a `tags-changed` frame, so other
// tabs ask `/api/tags/changes`.

/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
let previousDataRoot;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    user = await (await import('./converted-user.fixture.js')).emptyUser('st-changes-stream-tags-test-');
    // `/changes/stream` writes browser-presence.json under DATA_ROOT.
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
 * Opens the stream and collects its data frames.
 * @returns {Promise<{ frames: any[], close: () => void }>}
 */
async function openStream() {
    const request = http.get(`${baseUrl}/api/characters/changes/stream`);
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
    // The stream reads its feeds' ends before it listens; a write before then would be part of what it started from.
    await new Promise(resolve => setTimeout(resolve, 100));
    return { frames, close: () => request.destroy() };
}

/** @param {any[]} frames @param {(frame: any) => boolean} match */
async function frameArrives(frames, match) {
    for (let waited = 0; waited < 4000; waited += 50) {
        if (frames.some(match)) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
}

test('each tag definition written sends tags-changed', async () => {
    const stream = await openStream();
    try {
        const { tags } = user.store.lib;
        const tagsChanged = (/** @type {any} */ f) => f?.type === 'tags-changed';

        await tags.create({ id: 'stream-tag', name: 'Stream tag' }, { freeName: false });
        expect(await frameArrives(stream.frames, tagsChanged)).toBe(true);

        stream.frames.length = 0;
        await tags.create({ id: 'stream-tag-2', name: 'Another' }, { freeName: false });
        expect(await frameArrives(stream.frames, tagsChanged)).toBe(true);
    } finally {
        stream.close();
    }
});

test('a commit that changes no tag definition sends no tags-changed', async () => {
    const stream = await openStream();
    try {
        await user.store.lib.writeCard(user.directories, 'Plain.png', JSON.stringify({ name: 'Plain', data: { name: 'Plain' } }));
        expect(await frameArrives(stream.frames, f => Object.keys(f).length === 0)).toBe(true);
        expect(stream.frames.some(f => f?.type === 'tags-changed')).toBe(false);
    } finally {
        stream.close();
    }
});

test('a saved view write sends views-changed and no data: {}; a character write still sends it', async () => {
    const views = await import('../src/saved-views.js');
    const stream = await openStream();
    try {
        const view = { conditions: [{ field: 'name', op: 'contains', value: 'a' }], ranges: { tokens: { min: 1 } }, fav: true };
        const made = await views.createSavedView(user.directories, { name: 'V', view });
        await views.changeSavedView(user.directories, made.id, { view: { ...view, conditions: [{ field: 'name', op: 'not_contains', value: 'b' }] } });
        await views.deleteSavedView(user.directories, made.id);
        expect(await frameArrives(stream.frames, f => f?.type === 'views-changed')).toBe(true);
        // Past the library frame's debounce.
        await new Promise(resolve => setTimeout(resolve, 1000));
        expect(stream.frames.some(f => Object.keys(f).length === 0)).toBe(false);
        await user.store.lib.writeCard(user.directories, 'AfterViews.png', JSON.stringify({ name: 'AfterViews', data: { name: 'AfterViews' } }));
        expect(await frameArrives(stream.frames, f => Object.keys(f).length === 0)).toBe(true);
    } finally {
        stream.close();
    }
});
