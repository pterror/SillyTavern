import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {import('express').Router} */
let router;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
let avatarsDir;
let thumbnailsPersonaDir;

/**
 * Mounts the real avatars.js router (persona avatars) behind a fake auth middleware, mirroring
 * characters-manifest.test.js's pattern. Covers the `/get` route's `thumbnailVersions` field - the piece that
 * lets the client's getThumbnailUrl() emit the thumbnail route's `?v=` for personas up front instead of always
 * taking its no-cache redirect detour.
 */
beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-avatars-get-test-'));
    avatarsDir = path.join(tempDir, 'avatars');
    thumbnailsPersonaDir = path.join(tempDir, 'thumbnails', 'persona');
    fs.mkdirSync(avatarsDir, { recursive: true });
    fs.mkdirSync(thumbnailsPersonaDir, { recursive: true });

    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/avatars.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = {
            directories: { avatars: avatarsDir, thumbnailsPersona: thumbnailsPersonaDir, root: tempDir },
            profile: { handle: 'test-user' },
        };
        next();
    });
    app.use('/api/avatars', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

async function postJson(urlPath) {
    return fetch(`${baseUrl}${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
}

describe('POST /api/avatars/get', () => {
    test('returns an empty avatars list and empty thumbnailVersions when the library is empty', async () => {
        const response = await postJson('/api/avatars/get');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ avatars: [], thumbnailVersions: {} });
    });

    test('lists avatar filenames with no thumbnailVersions entry for ones with no cached thumbnail yet', async () => {
        fs.writeFileSync(path.join(avatarsDir, 'user1.png'), 'not a real png, just needs to exist');

        const response = await postJson('/api/avatars/get');
        const data = await response.json();

        expect(data.avatars).toEqual(['user1.png']);
        expect(data.thumbnailVersions).toEqual({});

        fs.rmSync(path.join(avatarsDir, 'user1.png'));
    });

    test('includes a thumbnailVersion for avatars with a cached thumbnail, matching its own mtime', async () => {
        fs.writeFileSync(path.join(avatarsDir, 'user2.png'), 'not a real png, just needs to exist');
        const cachedThumbPath = path.join(thumbnailsPersonaDir, 'user2.png');
        fs.writeFileSync(cachedThumbPath, 'cached thumbnail bytes');

        const response = await postJson('/api/avatars/get');
        const data = await response.json();
        const expectedVersion = String(Math.round(fs.statSync(cachedThumbPath).mtimeMs));

        expect(data.thumbnailVersions).toEqual({ 'user2.png': expectedVersion });

        fs.rmSync(path.join(avatarsDir, 'user2.png'));
        fs.rmSync(cachedThumbPath);
    });
});
