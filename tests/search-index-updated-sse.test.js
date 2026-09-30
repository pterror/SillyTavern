import { test, expect, beforeAll, afterAll } from '@jest/globals';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js').createSearchIndexCoordinator} */
let createSearchIndexCoordinator;
let tempDir;
let previousDataRoot;

beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-index-updated-sse-test-'));
    // `/changes/stream` writes browser-presence.json under DATA_ROOT.
    previousDataRoot = globalThis.DATA_ROOT;
    globalThis.DATA_ROOT = tempDir;

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    const { router } = await import('../src/endpoints/characters.js');
    const { default: compressionMiddleware } = await import('../src/middleware/compression.js');
    ({ createSearchIndexCoordinator } = await import('../src/endpoints/search-index-coordinator.js'));

    const express = (await import('express')).default;
    const app = express();
    app.use(compressionMiddleware);
    app.use((req, res, next) => {
        req.user = { directories: { root: tempDir }, profile: { handle: String(req.headers['x-test-handle']) } };
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
    fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Stands in for search-index-worker.js, so a test can post a 'committed' or 'swapped' message. */
class FakeWorker extends EventEmitter {
    postMessage() { }
    terminate() { }
    send(msg) {
        this.emit('message', msg);
    }
}

/**
 * A coordinator with the default onSearchIndexUpdated, and ways to post a characters commit or a groups swap for a
 * handle. Nothing sends 'ready', so the other index's reader has no position.
 */
async function coordinatorWithWorkers() {
    /** @type {Map<string, FakeWorker>} */
    const workers = new Map();
    const coordinator = createSearchIndexCoordinator({
        spawnWorker: ({ handle }) => {
            const worker = new FakeWorker();
            workers.set(handle, worker);
            return worker;
        },
        openIndex: () => ({ index: { reload() { } }, schema: {} }),
    });
    /** @param {string} handle */
    const workerFor = async (handle) => {
        if (!workers.has(handle)) {
            coordinator.getIndex(handle, /** @type {any} */ ({}), 'characters').catch(() => { });
            for (let i = 0; i < 5; i++) await Promise.resolve();
        }
        return workers.get(handle);
    };
    /** @param {string} handle @param {number} seq */
    const commit = async (handle, seq) => {
        const worker = await workerFor(handle);
        worker.send({ type: 'ready', target: 'characters', dir: '/chars', seq: 0, tagNameSeq: 0, retrySeq: 0 });
        worker.send({ type: 'committed', target: 'characters', changed: true, seq, tagNameSeq: 0, retrySeq: 0 });
    };
    /** @param {string} handle @param {number} version */
    const swapGroups = async (handle, version) => {
        (await workerFor(handle)).send({ type: 'swapped', target: 'groups', dir: '/groups', version, tagNameSeq: 0 });
    };
    const commitGroups = async (handle, version, tagNameSeq) => {
        (await workerFor(handle)).send({ type: 'committed', target: 'groups', changed: true, version, tagNameSeq });
    };
    return { commit, swapGroups, commitGroups };
}

/**
 * Opens /changes/stream as `handle` (accepting gzip, like a browser) and collects its `data:` messages.
 * @param {string} handle
 */
async function openStream(handle) {
    const request = http.get(`${baseUrl}/api/characters/changes/stream`, {
        headers: { 'Accept-Encoding': 'gzip', 'X-Test-Handle': handle },
    });
    /** @type {import('node:http').IncomingMessage} */
    const response = await new Promise((resolve, reject) => {
        request.once('response', resolve);
        request.once('error', reject);
    });
    expect(response.statusCode).toBe(200);
    const body = response.headers['content-encoding'] === 'gzip'
        ? response.pipe(zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH }))
        : response;
    body.setEncoding('utf8');

    /** @type {string[]} */
    const messages = [];
    const waiters = [];
    let buffered = '';
    body.on('data', chunk => {
        buffered += chunk;
        let end;
        while ((end = buffered.indexOf('\n\n')) !== -1) {
            const block = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            if (block.startsWith('data: ')) {
                messages.push(block);
                waiters.splice(0).forEach(resolve => resolve());
            }
        }
    });
    // Let the route register its listeners.
    await new Promise(resolve => setTimeout(resolve, 50));

    /** Resolves true once a `data:` message has arrived, false if none within `ms`. */
    const nextMessage = (ms) => messages.length > 0
        ? Promise.resolve(true)
        : Promise.race([
            new Promise(resolve => waiters.push(() => resolve(true))),
            new Promise(resolve => setTimeout(() => resolve(false), ms)),
        ]);
    return { messages, nextMessage, close: () => request.destroy() };
}

test('a characters commit reaches /changes/stream within a second as data: {"type":"search-index-updated","seq":N,"groupsVersion":V}', async () => {
    const { commit } = await coordinatorWithWorkers();
    const stream = await openStream('sse-user-live');
    try {
        await commit('sse-user-live', 42);
        expect(await stream.nextMessage(1000)).toBe(true);
        expect(stream.messages).toEqual(['data: {"type":"search-index-updated","seq":42,"groupsVersion":null}']);
    } finally {
        stream.close();
    }
});

test('a groups swap reaches /changes/stream within a second with its groupsVersion, and seq null while the characters reader has no position', async () => {
    const { swapGroups } = await coordinatorWithWorkers();
    const stream = await openStream('sse-user-groups');
    try {
        await swapGroups('sse-user-groups', 17);
        expect(await stream.nextMessage(1000)).toBe(true);
        expect(stream.messages).toEqual(['data: {"type":"search-index-updated","seq":null,"groupsVersion":17}']);
    } finally {
        stream.close();
    }
});

test('a groups catch-up reaches /changes/stream, also when only its tag-rename cursor moved', async () => {
    const { swapGroups, commitGroups } = await coordinatorWithWorkers();
    const stream = await openStream('sse-user-groups-commit');
    try {
        await swapGroups('sse-user-groups-commit', 17);
        expect(await stream.nextMessage(1000)).toBe(true);
        stream.messages.splice(0);
        // The same groups version: the browser re-queries on any search-index-updated, whatever it carries.
        await commitGroups('sse-user-groups-commit', 17, 5);
        expect(await stream.nextMessage(2000)).toBe(true);
        expect(stream.messages).toEqual(['data: {"type":"search-index-updated","seq":null,"groupsVersion":17}']);
    } finally {
        stream.close();
    }
});

test('search-index-updated reaches only the streams of the commit\'s handle', async () => {
    const { commit } = await coordinatorWithWorkers();
    const mine = await openStream('sse-user-a');
    const other = await openStream('sse-user-b');
    try {
        await commit('sse-user-a', 3);
        expect(await mine.nextMessage(1000)).toBe(true);
        expect(mine.messages).toEqual(['data: {"type":"search-index-updated","seq":3,"groupsVersion":null}']);
        expect(await other.nextMessage(300)).toBe(false);
    } finally {
        mine.close();
        other.close();
    }
});

test('a tag move failure for the stream\'s store is written as data: {"type":"tag-move-failed",...} and acked; another store\'s isn\'t', async () => {
    const { characterChangeEmitter, TAG_MOVE_FAILED_EVENT } = await import('../src/character-metadata-db.js');
    const stream = await openStream('sse-user-tag-move');
    try {
        const payload = { tagId: 'x', tagName: 'Ex', anchorId: 'a', anchorName: null, refusedId: 'a', reason: 'deleted' };
        const other = { delivered: false };
        characterChangeEmitter.emit(TAG_MOVE_FAILED_EVENT, `${tempDir}-other`, payload, other);
        expect(other.delivered).toBe(false);
        const ack = { delivered: false };
        characterChangeEmitter.emit(TAG_MOVE_FAILED_EVENT, tempDir, payload, ack);
        expect(ack.delivered).toBe(true);
        expect(await stream.nextMessage(1000)).toBe(true);
        expect(stream.messages).toEqual([`data: ${JSON.stringify({ type: 'tag-move-failed', ...payload })}`]);
    } finally {
        stream.close();
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(characterChangeEmitter.listenerCount(TAG_MOVE_FAILED_EVENT)).toBe(0);
});

test('a settled tag order for the stream\'s store is written as data: {"type":"tag-order-settled"}; another store\'s isn\'t', async () => {
    const { characterChangeEmitter, reportTagOrderSettled, TAG_ORDER_SETTLED_EVENT } = await import('../src/character-metadata-db.js');
    const stream = await openStream('sse-user-tag-order');
    try {
        reportTagOrderSettled(`${tempDir}-other`);
        reportTagOrderSettled(tempDir);
        expect(await stream.nextMessage(1000)).toBe(true);
        expect(stream.messages).toEqual([`data: ${JSON.stringify({ type: 'tag-order-settled' })}`]);
    } finally {
        stream.close();
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(characterChangeEmitter.listenerCount(TAG_ORDER_SETTLED_EVENT)).toBe(0);
});

test('logged tag changes for the stream\'s store are written as one data: {"type":"tags-changed"}, however many were reported; another store\'s aren\'t', async () => {
    const { characterChangeEmitter, reportTagChanges, TAG_CHANGES_EVENT } = await import('../src/character-metadata-db.js');
    const stream = await openStream('sse-user-tags-changed');
    try {
        reportTagChanges(`${tempDir}-other`);
        expect(await stream.nextMessage(800)).toBe(false);
        reportTagChanges(tempDir);
        reportTagChanges(tempDir);
        reportTagChanges(tempDir);
        expect(await stream.nextMessage(1500)).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 800));
        expect(stream.messages).toEqual([`data: ${JSON.stringify({ type: 'tags-changed' })}`]);
    } finally {
        stream.close();
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(characterChangeEmitter.listenerCount(TAG_CHANGES_EVENT)).toBe(0);
});

test('groups version rows are written as one data: {"type":"groups-changed"}, however many were added', async () => {
    const { characterChangeEmitter, GROUP_CHANGES_EVENT } = await import('../src/character-metadata-db.js');
    const stream = await openStream('sse-user-groups-changed');
    try {
        characterChangeEmitter.emit(GROUP_CHANGES_EVENT);
        characterChangeEmitter.emit(GROUP_CHANGES_EVENT);
        characterChangeEmitter.emit(GROUP_CHANGES_EVENT);
        expect(await stream.nextMessage(1500)).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 800));
        expect(stream.messages).toEqual([`data: ${JSON.stringify({ type: 'groups-changed' })}`]);
    } finally {
        stream.close();
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(characterChangeEmitter.listenerCount(GROUP_CHANGES_EVENT)).toBe(0);
});

test('a character index failure for the stream\'s handle is written as data: {"type":"character-index-failed",...}; another handle\'s isn\'t', async () => {
    const { characterChangeEmitter } = await import('../src/character-metadata-db.js');
    const { CHARACTER_INDEX_FAILED_EVENT } = await import('../src/endpoints/search-index-coordinator.js');
    const mine = await openStream('sse-user-index-failed');
    const other = await openStream('sse-user-index-failed-other');
    try {
        const warning = { id: 'Flaky.png', name: 'Flaky', error: 'SyntaxError: x', retryInMs: 1000, keptEntry: true };
        characterChangeEmitter.emit(CHARACTER_INDEX_FAILED_EVENT, 'sse-user-index-failed', warning);
        expect(await mine.nextMessage(1000)).toBe(true);
        expect(mine.messages).toEqual([`data: ${JSON.stringify({ type: 'character-index-failed', ...warning })}`]);
        expect(await other.nextMessage(300)).toBe(false);
    } finally {
        mine.close();
        other.close();
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(characterChangeEmitter.listenerCount(CHARACTER_INDEX_FAILED_EVENT)).toBe(0);
});
