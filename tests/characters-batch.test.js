import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
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
    const { router } = await import('../src/endpoints/characters.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-characters-batch-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

async function postJson(urlPath, body) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * @param {string} avatar
 * @param {string} [description]
 */
async function seedCharacter(avatar, description = 'd') {
    const name = avatar.replace(/\.png$/, '');
    await user.store.lib.writeCard(user.directories, avatar, JSON.stringify({ name, data: { name, description, extensions: {} } }));
}

describe('no route hands out the whole library', () => {
    test('/manifest and /all are gone', async () => {
        await seedCharacter('Alice.png');
        expect((await postJson('/api/characters/manifest', {})).status).toBe(404);
        expect((await postJson('/api/characters/all', {})).status).toBe(404);
    });
});

describe('POST /api/characters/batch', () => {
    test('with no avatars, returns an empty array', async () => {
        const response = await postJson('/api/characters/batch', { avatars: [] });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
    });

    test('rejects a path-traversal avatar with 400 before touching the store', async () => {
        const response = await postJson('/api/characters/batch', { avatars: ['../../etc/passwd'] });
        expect(response.status).toBe(400);
    });

    test('rejects a non-string avatar entry with 400', async () => {
        const response = await postJson('/api/characters/batch', { avatars: [123] });
        expect(response.status).toBe(400);
    });

    test('leaves out an avatar no character has (a file in characters/ is not a character)', async () => {
        await seedCharacter('Alice.png');
        fs.writeFileSync(path.join(user.directories.characters, 'Broken.png'), 'not a real character card');

        const response = await postJson('/api/characters/batch', { avatars: ['Broken.png', 'Alice.png'] });
        expect(response.status).toBe(200);
        expect((await response.json()).map(c => c.avatar)).toEqual(['Alice.png']);
    });
});
