import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

// `/manifest` and `/batch` on a user's engine store: the library is the characters the store holds (not the files in
// `characters/`), each listed by its avatar with its version as `mtime`.

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

beforeAll(async () => {
    // characters.js transitively imports modules that read config.yaml at import time.
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
    user = await fixture.emptyUser('st-characters-manifest-test-');
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

/** Stores a character. @param {string} avatar @param {string} [description] */
async function seedCharacter(avatar, description = 'd') {
    const name = avatar.replace(/\.png$/, '');
    await user.store.lib.writeCard(user.directories, avatar, JSON.stringify({ name, data: { name, description, extensions: {} } }));
}

describe('POST /api/characters/manifest', () => {
    test('returns an empty array when the library is empty', async () => {
        const response = await postJson('/api/characters/manifest', {});
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
    });

    test('returns one { avatar, mtime } entry per stored character, whatever files characters/ holds', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        fs.writeFileSync(path.join(user.directories.characters, 'Stray.png'), 'a file the store has no character for');
        fs.writeFileSync(path.join(user.directories.characters, 'notes.txt'), 'should be ignored');

        const response = await postJson('/api/characters/manifest', {});
        expect(response.status).toBe(200);
        /** @type {{avatar: string, mtime: number}[]} */
        const manifest = await response.json();
        expect(manifest.map(e => e.avatar).sort()).toEqual(['Alice.png', 'Bob.png']);
        for (const entry of manifest) {
            expect(typeof entry.mtime).toBe('number');
            expect(entry.mtime).toBeGreaterThan(0);
        }
    });

    test('mtime changes when the character is written again, so a client can detect the edit', async () => {
        await seedCharacter('Alice.png', 'version 1');
        const before = (await (await postJson('/api/characters/manifest', {})).json())[0];

        await seedCharacter('Alice.png', 'version 2');

        const after = (await (await postJson('/api/characters/manifest', {})).json())[0];
        expect(after.mtime).not.toBe(before.mtime);
    });

    test('thumbnailVersion is null when no cached thumbnail exists yet', async () => {
        await seedCharacter('Alice.png');

        const manifest = await (await postJson('/api/characters/manifest', {})).json();
        expect(manifest[0].thumbnailVersion).toBeNull();
    });

    test('thumbnailVersion is the cached thumbnail\'s own mtime', async () => {
        await seedCharacter('Alice.png');
        const cachedThumbPath = path.join(user.directories.thumbnailsAvatar, 'Alice.png');
        fs.mkdirSync(path.dirname(cachedThumbPath), { recursive: true });
        fs.writeFileSync(cachedThumbPath, 'cached thumbnail bytes');
        const when = new Date(Date.now() + 5000);
        fs.utimesSync(cachedThumbPath, when, when);

        const manifest = await (await postJson('/api/characters/manifest', {})).json();
        const entry = manifest.find(e => e.avatar === 'Alice.png');
        expect(entry.thumbnailVersion).toBe(String(Math.round(fs.statSync(cachedThumbPath).mtimeMs)));
        expect(entry.thumbnailVersion).not.toBe(String(Math.round(entry.mtime)));
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

    test('leaves out an avatar no character has (a file in characters/ is not a character), as /all does', async () => {
        await seedCharacter('Alice.png');
        fs.writeFileSync(path.join(user.directories.characters, 'Broken.png'), 'not a real character card');

        const response = await postJson('/api/characters/batch', { avatars: ['Broken.png', 'Alice.png'] });
        expect(response.status).toBe(200);
        expect((await response.json()).map(c => c.avatar)).toEqual(['Alice.png']);
    });
});
