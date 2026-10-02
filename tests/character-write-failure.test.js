/**
 * The metadata db holds the only complete copy of a card, so a card write it refuses must fail the request: nothing
 * may report success for an edit that was never stored, and a new character whose row couldn't be written leaves no
 * image behind.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

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
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-write-failure-test-uploads-'));
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-write-failure-test-'));
    directories = {
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        root: tempDir,
        thumbnailsAvatar: path.join(tempDir, 'thumbnails', 'avatar'),
    };
    for (const dir of [directories.characters, directories.chats, directories.thumbnailsAvatar]) fs.mkdirSync(dir, { recursive: true });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post('create', { ch_name: 'Alice', description: 'stored', file_name: 'Alice' });
    if (res.status !== 200) throw new Error(`create failed: ${res.status}`);
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

const post = (route, body) => fetch(`${baseUrl}/api/characters/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

/** Makes every write to the characters table fail, as a full disk or a broken store would. */
function breakCharacterWrites() {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    db.exec(`
        CREATE TRIGGER inject_fail_insert BEFORE INSERT ON characters BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;
        CREATE TRIGGER inject_fail_update BEFORE UPDATE ON characters BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;
    `);
    db.close();
}

function repairCharacterWrites() {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    db.exec('DROP TRIGGER inject_fail_insert; DROP TRIGGER inject_fail_update;');
    db.close();
}

async function storedCard() {
    repairCharacterWrites();
    const res = await post('get', { avatar_url: 'Alice.png' });
    return await res.json();
}

describe('a card write the store refuses fails its request', () => {
    test('/edit without a new avatar', async () => {
        breakCharacterWrites();
        const res = await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'edited' });
        expect(res.ok).toBe(false);
        expect((await storedCard()).description).toBe('stored');
    });

    test('/merge-attributes (the field editor\'s save)', async () => {
        breakCharacterWrites();
        const res = await post('merge-attributes', { avatar: 'Alice.png', description: 'edited', data: { description: 'edited' } });
        expect(res.ok).toBe(false);
        expect((await storedCard()).description).toBe('stored');
    });

    test('/edit-attribute', async () => {
        breakCharacterWrites();
        const res = await post('edit-attribute', { avatar_url: 'Alice.png', ch_name: 'Alice', field: 'description', value: 'edited' });
        expect(res.ok).toBe(false);
        expect((await storedCard()).description).toBe('stored');
    });

    test('/rename', async () => {
        breakCharacterWrites();
        const res = await post('rename', { avatar_url: 'Alice.png', new_name: 'Bob' });
        expect(res.ok).toBe(false);
        expect((await storedCard()).name).toBe('Alice');
    });

    test('a greeting operation', async () => {
        breakCharacterWrites();
        const res = await post('greetings/add', { avatar_url: 'Alice.png', text: 'a new greeting', append: true });
        expect(res.ok).toBe(false);
        expect((await storedCard()).data.alternate_greetings ?? []).toEqual([]);
    });

    test('/create leaves no image behind', async () => {
        breakCharacterWrites();
        const res = await post('create', { ch_name: 'Carol', description: 'new', file_name: 'Carol' });
        expect(res.ok).toBe(false);
        expect(fs.existsSync(path.join(directories.characters, 'Carol.png'))).toBe(false);
    });

    test('/duplicate leaves no copy behind', async () => {
        breakCharacterWrites();
        const res = await post('duplicate', { avatar_url: 'Alice.png' });
        expect(res.ok).toBe(false);
        expect(fs.readdirSync(directories.characters)).toEqual(['Alice.png']);
    });

    test('the store being unavailable is a failure, not a silent no-op', async () => {
        await expect(metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', 'not json')).rejects.toThrow();
    });
});
