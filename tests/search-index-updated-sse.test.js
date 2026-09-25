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

/** Stands in for search-index-worker.js, so a test can post a 'committed' message. */
class FakeWorker extends EventEmitter {
    postMessage() { }
    terminate() { }
    send(msg) {
        this.emit('message', msg);
    }
}

/** A coordinator with the default onSearchIndexUpdated, and a way to post a characters commit for a handle. */
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
    /** @param {string} handle @param {number} seq */
    const commit = async (handle, seq) => {
        if (!workers.has(handle)) {
            coordinator.getIndex(handle, /** @type {any} */ ({}), 'characters').catch(() => { });
            for (let i = 0; i < 5; i++) await Promise.resolve();
        }
        workers.get(handle).send({ type: 'committed', target: 'characters', changed: true, seq });
    };
    return { commit };
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

test('a characters commit reaches /changes/stream within a second as data: {"type":"search-index-updated","seq":N}', async () => {
    const { commit } = await coordinatorWithWorkers();
    const stream = await openStream('sse-user-live');
    try {
        await commit('sse-user-live', 42);
        expect(await stream.nextMessage(1000)).toBe(true);
        expect(stream.messages).toEqual(['data: {"type":"search-index-updated","seq":42}']);
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
        expect(mine.messages).toEqual(['data: {"type":"search-index-updated","seq":3}']);
        expect(await other.nextMessage(300)).toBe(false);
    } finally {
        mine.close();
        other.close();
    }
});
