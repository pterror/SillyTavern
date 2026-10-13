/**
 * The metadata db holds the only complete copy of a card, so a card write it refuses must fail the request: nothing
 * may report success for an edit that was never stored, and a new character whose row couldn't be written leaves no
 * image behind.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
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

    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-write-failure-test-uploads-'));
    app.use(multer({ dest: uploadsDir }).single('avatar'));
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
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
    user = await (await import('./converted-user.fixture.js')).emptyUser('st-write-failure-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post('create', { ch_name: 'Alice', description: 'stored', file_name: 'Alice' });
    if (res.status !== 200) throw new Error(`create failed: ${res.status}`);
});

afterEach(async () => {
    jest.restoreAllMocks();
    await user.close();
});

const post = (route, body) => fetch(`${baseUrl}/api/characters/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

/** Makes every write to the characters table fail, as a full disk or a broken store would. */
let commit = null;
function breakCharacterWrites() {
    const store = user.store.lib.store;
    commit = store.commit;
    store.commit = async () => { throw new Error('injected write failure'); };
}

function repairCharacterWrites() {
    if (commit !== null) user.store.lib.store.commit = commit;
    commit = null;
}

/** What the user's image folder holds. */
function imageFiles() {
    const dir = directories.characters;
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
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
        const before = imageFiles();
        breakCharacterWrites();
        const res = await post('create', { ch_name: 'Carol', description: 'new', file_name: 'Carol' });
        expect(res.ok).toBe(false);
        expect(imageFiles()).toEqual(before);
    });

    test('/duplicate leaves no copy behind', async () => {
        const before = imageFiles();
        breakCharacterWrites();
        const res = await post('duplicate', { avatar_url: 'Alice.png' });
        expect(res.ok).toBe(false);
        expect(imageFiles()).toEqual(before);
    });

    test('the store being unavailable is a failure, not a silent no-op', async () => {
        await expect(user.store.lib.writeCard(directories, 'Alice.png', 'not json')).rejects.toThrow();
    });
});
