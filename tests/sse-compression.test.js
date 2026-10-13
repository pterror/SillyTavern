import { test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';

/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
let previousDataRoot;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    user = await (await import('./converted-user.fixture.js')).emptyUser('st-sse-compression-test-');
    // `/changes/stream` writes browser-presence.json under DATA_ROOT.
    previousDataRoot = globalThis.DATA_ROOT;
    globalThis.DATA_ROOT = user.dataRoot;

    const { router } = await import('../src/endpoints/characters.js');
    const { default: compressionMiddleware } = await import('../src/middleware/compression.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(compressionMiddleware);
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

test('a /changes/stream event reaches a gzip-accepting client within a second', async () => {
    const request = http.get(`${baseUrl}/api/characters/changes/stream`, { headers: { 'Accept-Encoding': 'gzip' } });
    try {
        /** @type {import('node:http').IncomingMessage} */
        const response = await new Promise((resolve, reject) => {
            request.once('response', resolve);
            request.once('error', reject);
        });
        expect(response.statusCode).toBe(200);

        // Decode if the server did compress, so a failure here means the event never arrived, not that it was unreadable.
        const body = response.headers['content-encoding'] === 'gzip'
            ? response.pipe(zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH }))
            : response;
        body.setEncoding('utf8');

        let received = '';
        const eventArrived = new Promise(resolve => {
            body.on('data', chunk => {
                received += chunk;
                if (received.includes('data: ')) resolve(true);
            });
        });

        // A commit to the store is what the stream reports.
        await user.store.lib.writeCard(user.directories, 'Sse.png', JSON.stringify({ name: 'Sse', data: { name: 'Sse' } }));

        const arrived = await Promise.race([
            eventArrived,
            new Promise(resolve => setTimeout(() => resolve(false), 1000)),
        ]);
        expect(arrived).toBe(true);
    } finally {
        request.destroy();
    }
});
