import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const reflinkFileMock = jest.fn();

// Same reasoning as character-card-parser-write-card-to-file.test.js: @reflink/reflink is a real native
// binding, not something a unit test should depend on this platform/filesystem actually supporting.
jest.unstable_mockModule('@reflink/reflink', () => ({
    reflinkFile: reflinkFileMock,
}));

const originalCwd = process.cwd();
afterAll(() => process.chdir(originalCwd));

/** @type {import('express').Router} */
let router;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/** @type {typeof import('../src/character-card-parser.js').write} */
let writeCard;

// A minimal valid 1x1 transparent PNG - same fixture other test files use.
const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

// A second, byte-different 1x1 PNG (different pixel color) so its IDAT - and therefore avatar_identity_hash -
// differs from BLANK_PNG's.
const OTHER_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    metadataDb = await import('../src/character-metadata-db.js');
    ({ write: writeCard } = await import('../src/character-card-parser.js'));

    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();

    const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-import-reflink-test-uploads-'));
    app.use(multer({ dest: uploadsDir }).single('avatar'));
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-import-reflink-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    const thumbnailsAvatarDir = path.join(tempDir, 'thumbnails', 'avatar');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.mkdirSync(thumbnailsAvatarDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, chats: chatsDir, thumbnailsAvatar: thumbnailsAvatarDir };

    reflinkFileMock.mockReset();
    reflinkFileMock.mockImplementation(async (src, dst) => {
        fs.copyFileSync(src, dst);
        return 0;
    });
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

/**
 * Embeds a Spec V2 card into `png`'s own tEXt chunk (importFromPng() reads the card from the uploaded PNG
 * itself, not a separate form field) and posts it to /import.
 * @param {Buffer} png
 * @param {string} name
 * @returns {Promise<Response>}
 */
async function importPngCharacter(png, name) {
    const card = writeCard(png, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name, data: { name, description: `A card named ${name}` } }));
    const formData = new FormData();
    formData.append('avatar', new Blob([card], { type: 'image/png' }), `${name}.png`);
    formData.append('file_type', 'png');
    return fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });
}

describe('import-time cross-character reflink dedup', () => {
    test('a second import with byte-identical avatar image bytes but different card content reflinks against the first', async () => {
        const first = await importPngCharacter(BLANK_PNG, 'Alice');
        expect(first.status).toBe(200);
        reflinkFileMock.mockClear();

        const second = await importPngCharacter(BLANK_PNG, 'Bob');
        expect(second.status).toBe(200);
        const secondData = await second.json();

        expect(reflinkFileMock).toHaveBeenCalledTimes(1);
        const [srcArg, dstArg] = reflinkFileMock.mock.calls[0];
        expect(dstArg.startsWith(path.join(directories.characters, `${secondData.file_name}.png`))).toBe(true);
        expect(srcArg).not.toBe(dstArg);
    });

    test('a second import with different avatar image bytes does not reflink', async () => {
        const first = await importPngCharacter(BLANK_PNG, 'Carol');
        expect(first.status).toBe(200);
        reflinkFileMock.mockClear();

        const second = await importPngCharacter(OTHER_PNG, 'Dave');
        expect(second.status).toBe(200);

        expect(reflinkFileMock).not.toHaveBeenCalled();
    });

    test('the very first import of its kind never reflinks (no existing candidate)', async () => {
        const response = await importPngCharacter(BLANK_PNG, 'Eve');
        expect(response.status).toBe(200);

        expect(reflinkFileMock).not.toHaveBeenCalled();
    });
});
