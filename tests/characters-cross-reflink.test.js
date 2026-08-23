import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Buffer } from 'node:buffer';

// Same reasoning as character-card-parser-write-card-to-file.test.js: @reflink/reflink is a real native
// binding, not something a unit test should depend on this platform/filesystem actually supporting -
// mocked here so the fast-path-vs-fallback behavior (and WHICH source path each write reflinks from) is
// deterministic and inspectable regardless of what /tmp happens to be mounted on in CI.
const reflinkFileMock = jest.fn();
jest.unstable_mockModule('@reflink/reflink', () => ({
    reflinkFile: reflinkFileMock,
}));

/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {import('express').Router} */
let router;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/**
 * Mounts the real characters.js router behind a fake auth middleware - same harness shape as
 * characters-duplicate.test.js - so /create and /edit exercise writeCharacterData()'s actual fast path
 * (including the new cross-character reflink lookup) end to end, against real files on a real temp
 * directory, with only the native reflink binding swapped for an inspectable mock.
 */
// writeCharacterData()'s DEFAULT_AVATAR_PATH fallback ('./public/img/ai4.png') is repo-root-relative, not
// tests/-relative - same reasoning/fix as characters-import.test.js's own chdir.
const originalCwd = process.cwd();

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    cardParser = await import('../src/character-card-parser.js');

    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: 'test-user' } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-cross-reflink-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    directories = { characters: charactersDir, chats: chatsDir, root: tempDir };

    reflinkFileMock.mockReset();
    // Default: simulate a working reflink by doing a real copy - deterministic byte contents regardless of
    // whether the mock's src/dst actually share a filesystem that supports reflink.
    reflinkFileMock.mockImplementation(async (src, dst) => {
        fs.copyFileSync(src, dst);
        return 0;
    });
});

afterEach(() => {
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/**
 * @param {object} body
 */
async function create(body) {
    return fetch(`${baseUrl}/api/characters/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * @param {string} avatarUrl
 * @param {object} body
 */
async function edit(avatarUrl, body) {
    return fetch(`${baseUrl}/api/characters/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar_url: avatarUrl, ...body }),
    });
}

describe('cross-character reflink on the live write path', () => {
    test('a second character with matching content reflinks from the FIRST character\'s own file, not the default avatar', async () => {
        const firstCreate = await create({ ch_name: 'Twin', description: 'Same everything', file_name: 'Twin1' });
        expect(firstCreate.status).toBe(200);

        reflinkFileMock.mockClear();
        const secondCreate = await create({ ch_name: 'Twin', description: 'Same everything', file_name: 'Twin2' });
        expect(secondCreate.status).toBe(200);

        expect(reflinkFileMock).toHaveBeenCalledTimes(1);
        const [srcArg] = reflinkFileMock.mock.calls[0];
        expect(srcArg).toBe(path.join(directories.characters, 'Twin1.png'));

        // Both files parse back to the intended (matching) content.
        const twin1 = JSON.parse(cardParser.read(fs.readFileSync(path.join(directories.characters, 'Twin1.png'))));
        const twin2 = JSON.parse(cardParser.read(fs.readFileSync(path.join(directories.characters, 'Twin2.png'))));
        expect(twin2.data.description).toBe(twin1.data.description);
    });

    test('a character with genuinely different content never gets cross-reflinked (no false positive)', async () => {
        const firstCreate = await create({ ch_name: 'Alpha', description: 'Alpha description', file_name: 'Alpha1' });
        expect(firstCreate.status).toBe(200);

        reflinkFileMock.mockClear();
        const secondCreate = await create({ ch_name: 'Beta', description: 'Totally different description', file_name: 'Beta1' });
        expect(secondCreate.status).toBe(200);

        expect(reflinkFileMock).toHaveBeenCalledTimes(1);
        const [srcArg] = reflinkFileMock.mock.calls[0];
        // Self-path only (the default avatar it was created from) - never Alpha1's file.
        expect(srcArg).not.toBe(path.join(directories.characters, 'Alpha1.png'));
    });

    test('matching JSON content but a DIFFERENT uploaded image never reflinks the image across - the hash match alone is not trusted', async () => {
        // Character A gets a real (non-default) image via /edit-avatar-less path: simulate by writing its
        // file directly with a distinct 1x1 PNG whose pixel byte differs from the default avatar, then let
        // a second character reach byte-identical JSON content but originate from the (different) default
        // avatar image - content_identity_hash only ever hashes the JSON, so a hash match here is a real
        // risk case, not a contrived one.
        const distinctPng = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        );
        // Flip a byte inside IDAT so it's provably not byte-identical to the app's own default avatar.
        const { default: extract } = await import('png-chunks-extract');
        const { default: encode } = await import('../src/png/encode.js');
        const chunks = extract(new Uint8Array(distinctPng));
        const idat = chunks.find(c => c.name === 'IDAT');
        idat.data = new Uint8Array(idat.data);
        idat.data[0] ^= 0xff;
        const mutatedImage = Buffer.from(encode(chunks));

        const cardA = { name: 'Clone', spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Clone', description: 'Shared text', personality: '', scenario: '', first_mes: '', mes_example: '', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } };
        const aBuffer = cardParser.write(mutatedImage, JSON.stringify(cardA));
        fs.writeFileSync(path.join(directories.characters, 'CloneA.png'), aBuffer);

        reflinkFileMock.mockClear();
        const secondCreate = await create({ ch_name: 'Clone', description: 'Shared text', file_name: 'CloneB' });
        expect(secondCreate.status).toBe(200);

        // CloneB must never end up wearing CloneA's picture: either it declines the reflink fast path
        // entirely, or (if it does reflink) it must be from ITS OWN source, never CloneA.png.
        if (reflinkFileMock.mock.calls.length > 0) {
            const [srcArg] = reflinkFileMock.mock.calls[0];
            expect(srcArg).not.toBe(path.join(directories.characters, 'CloneA.png'));
        }
        const cloneB = fs.readFileSync(path.join(directories.characters, 'CloneB.png'));
        // CloneB's image bytes must be its own default-avatar-derived image, not CloneA's mutated one.
        const cloneBChunks = extract(new Uint8Array(cloneB));
        const cloneBIdat = cloneBChunks.find(c => c.name === 'IDAT');
        expect(Buffer.compare(Buffer.from(cloneBIdat.data), Buffer.from(idat.data))).not.toBe(0);
    });

    test('editing the second (cross-reflinked) character afterward never mutates the first character\'s file', async () => {
        await create({ ch_name: 'Twin', description: 'Same everything', file_name: 'Twin1' });
        await create({ ch_name: 'Twin', description: 'Same everything', file_name: 'Twin2' });

        const twin1Before = fs.readFileSync(path.join(directories.characters, 'Twin1.png'));

        reflinkFileMock.mockClear();
        const editResponse = await edit('Twin2.png', { ch_name: 'Twin', description: 'Now diverged', avatar_url: 'Twin2.png' });
        expect(editResponse.status).toBe(200);

        const twin1After = fs.readFileSync(path.join(directories.characters, 'Twin1.png'));
        expect(Buffer.compare(twin1Before, twin1After)).toBe(0);

        const twin2 = JSON.parse(cardParser.read(fs.readFileSync(path.join(directories.characters, 'Twin2.png'))));
        expect(twin2.data.description).toBe('Now diverged');
        const twin1 = JSON.parse(cardParser.read(fs.readFileSync(path.join(directories.characters, 'Twin1.png'))));
        expect(twin1.data.description).toBe('Same everything');
    });
});
