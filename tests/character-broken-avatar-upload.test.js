/**
 * An uploaded image that can't be read must fail the request and write nothing: it never silently becomes the default
 * avatar over the character's existing one. Creating a character with no upload at all still gets the default.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/characters.js')} */
let characters;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
let uploadsDir;

const originalCwd = process.cwd();
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    await import('../src/fetch-patch.js');

    characters = await import('../src/endpoints/characters.js');
    metadataDb = await import('../src/character-metadata-db.js');

    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-broken-avatar-test-uploads-'));
    app.use(multer({ dest: uploadsDir }).single('avatar'));
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: 'test-user' } };
        next();
    });
    app.use('/api/characters', characters.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(uploadsDir, { recursive: true, force: true });
    process.chdir(originalCwd);
});

beforeEach(async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-broken-avatar-test-'));
    directories = {
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        root: tempDir,
        thumbnailsAvatar: path.join(tempDir, 'thumbnails', 'avatar'),
    };
    for (const dir of [directories.characters, directories.chats, directories.thumbnailsAvatar]) fs.mkdirSync(dir, { recursive: true });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/**
 * @param {string} route
 * @param {Record<string, string>} fields
 * @param {Buffer|null} file
 * @param {string} [fileName]
 */
function postForm(route, fields, file, fileName = 'my-avatar.webp') {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (file) form.append('avatar', new Blob([file]), fileName);
    return fetch(`${baseUrl}/api/characters/${route}`, { method: 'POST', body: form });
}

const notAnImage = Buffer.from('this is not an image at all');
const brokenPng = Buffer.concat([PNG_SIGNATURE, Buffer.from('garbage after the signature')]);

describe('a broken avatar upload', () => {
    test('creating with no upload still gets the default avatar', async () => {
        const res = await postForm('create', { ch_name: 'Alice', file_name: 'Alice' }, null);
        expect(res.status).toBe(200);
        expect(fs.existsSync(path.join(directories.characters, 'Alice.png'))).toBe(true);
    });

    test.each([['not an image', notAnImage], ['a broken png', brokenPng]])('creating with %s fails and writes nothing', async (_label, bytes) => {
        const res = await postForm('create', { ch_name: 'Bob', file_name: 'Bob' }, bytes);
        expect(res.status).toBe(400);
        expect(await res.text()).toMatch(/couldn't read my-avatar\.webp as an image/);
        expect(fs.readdirSync(directories.characters)).toEqual([]);
        expect(fs.readdirSync(directories.chats)).toEqual([]);
    });

    test.each([['not an image', notAnImage], ['a broken png', brokenPng]])('an avatar edit with %s fails and keeps the old avatar', async (_label, bytes) => {
        const created = await postForm('create', { ch_name: 'Alice', file_name: 'Alice' }, null);
        expect(created.status).toBe(200);
        const avatarPath = path.join(directories.characters, 'Alice.png');
        const before = fs.readFileSync(avatarPath);

        const res = await postForm('edit-avatar', { avatar_url: 'Alice.png' }, bytes);
        expect(res.status).toBe(400);
        expect(await res.text()).toMatch(/couldn't read my-avatar\.webp as an image/);
        expect(fs.readFileSync(avatarPath).equals(before)).toBe(true);
    });

    test('an edit with a broken new avatar fails and keeps the old avatar', async () => {
        const created = await postForm('create', { ch_name: 'Alice', file_name: 'Alice' }, null);
        expect(created.status).toBe(200);
        const avatarPath = path.join(directories.characters, 'Alice.png');
        const before = fs.readFileSync(avatarPath);

        const res = await postForm('edit', { avatar_url: 'Alice.png', ch_name: 'Alice' }, notAnImage);
        expect(res.status).toBe(400);
        expect(fs.readFileSync(avatarPath).equals(before)).toBe(true);
    });
});
