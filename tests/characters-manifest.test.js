import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {import('express').Router} */
let router;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let tempDir;
let charactersDir;
let chatsDir;
let thumbnailsAvatarDir;

/**
 * Mounts the real characters.js router behind a fake auth middleware that stamps a per-user
 * `directories` object pointing at a throwaway temp directory, mirroring how the real app's user
 * middleware populates `request.user` - the new `/manifest` and `/batch` endpoints (see
 * src/endpoints/characters.js) only need `directories.characters`/`directories.chats` and
 * `profile.handle` to run.
 */
beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-manifest-test-'));
    charactersDir = path.join(tempDir, 'characters');
    chatsDir = path.join(tempDir, 'chats');
    thumbnailsAvatarDir = path.join(tempDir, 'thumbnails', 'avatar');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.mkdirSync(thumbnailsAvatarDir, { recursive: true });

    // characters.js transitively imports modules (e.g. image-metadata.js) that read config.yaml at import time
    // via getConfigValue() - point that at the repo's default config so the import doesn't hard process.exit(1)
    // for lacking a configured path. Doesn't touch the real user's config.yaml.
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = {
            directories: { characters: charactersDir, chats: chatsDir, root: tempDir, thumbnailsAvatar: thumbnailsAvatarDir },
            profile: { handle: 'test-user' },
        };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

async function postJson(urlPath, body) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return response;
}

describe('POST /api/characters/manifest', () => {
    afterEachClearCharactersDir();

    test('returns an empty array when the library is empty', async () => {
        const response = await postJson('/api/characters/manifest', {});
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
    });

    test('returns one { avatar, mtime } entry per .png file, ignoring non-png files', async () => {
        fs.writeFileSync(path.join(charactersDir, 'Alice.png'), 'not a real png, just needs to exist');
        fs.writeFileSync(path.join(charactersDir, 'Bob.png'), 'not a real png, just needs to exist');
        fs.writeFileSync(path.join(charactersDir, 'notes.txt'), 'should be ignored');

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

    test('mtime changes when a file is rewritten, so a client can detect the edit', async () => {
        const filePath = path.join(charactersDir, 'Alice.png');
        fs.writeFileSync(filePath, 'version 1');
        const before = (await (await postJson('/api/characters/manifest', {})).json())[0];

        // Ensure the filesystem's mtime resolution can't make this a false negative.
        const bumpedTime = new Date(before.mtime + 2000);
        fs.writeFileSync(filePath, 'version 2');
        fs.utimesSync(filePath, bumpedTime, bumpedTime);

        const after = (await (await postJson('/api/characters/manifest', {})).json())[0];
        expect(after.mtime).not.toBe(before.mtime);
    });

    test('thumbnailVersion is null when no cached thumbnail exists yet', async () => {
        fs.writeFileSync(path.join(charactersDir, 'Alice.png'), 'not a real png, just needs to exist');

        const manifest = await (await postJson('/api/characters/manifest', {})).json();
        expect(manifest[0].thumbnailVersion).toBeNull();
    });

    test('thumbnailVersion reflects the cached thumbnail\'s own mtime, not the source PNG\'s', async () => {
        const originalPath = path.join(charactersDir, 'Alice.png');
        const cachedThumbPath = path.join(thumbnailsAvatarDir, 'Alice.png');
        fs.writeFileSync(originalPath, 'source bytes');
        fs.writeFileSync(cachedThumbPath, 'cached thumbnail bytes');
        // Force the two mtimes apart - a thumbnail is only generated lazily, well after the source file was
        // written, and on a fast filesystem both writes above can otherwise land in the same mtime tick.
        const originalMtime = fs.statSync(originalPath).mtimeMs;
        fs.utimesSync(cachedThumbPath, new Date(originalMtime + 5000), new Date(originalMtime + 5000));

        const manifest = await (await postJson('/api/characters/manifest', {})).json();
        const entry = manifest.find(e => e.avatar === 'Alice.png');
        const expectedVersion = String(Math.round(fs.statSync(cachedThumbPath).mtimeMs));

        expect(entry.thumbnailVersion).toBe(expectedVersion);
        expect(entry.thumbnailVersion).not.toBe(String(Math.round(entry.mtime)));

        fs.rmSync(cachedThumbPath);
    });
});

describe('POST /api/characters/batch', () => {
    afterEachClearCharactersDir();

    test('with no avatars, returns an empty array', async () => {
        const response = await postJson('/api/characters/batch', { avatars: [] });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
    });

    test('rejects a path-traversal avatar with 400 before touching the filesystem', async () => {
        const response = await postJson('/api/characters/batch', { avatars: ['../../etc/passwd'] });
        expect(response.status).toBe(400);
    });

    test('rejects a non-string avatar entry with 400', async () => {
        const response = await postJson('/api/characters/batch', { avatars: [123] });
        expect(response.status).toBe(400);
    });

    test('silently drops avatars that fail to parse as character cards, matching /all\'s behavior', async () => {
        // A .png that isn't a real character card - processCharacter() should catch the parse failure and
        // return a nameless placeholder, which both /all and /batch filter out rather than erroring the whole
        // request over one bad file.
        fs.writeFileSync(path.join(charactersDir, 'Broken.png'), 'not a real character card');

        const response = await postJson('/api/characters/batch', { avatars: ['Broken.png'] });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
    });
});

function afterEachClearCharactersDir() {
    afterEach(() => {
        for (const file of fs.readdirSync(charactersDir)) {
            fs.rmSync(path.join(charactersDir, file));
        }
    });
}
