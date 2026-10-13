/**
 * A non-PNG avatar upload is converted to PNG without first trying the PNG-only fast path, so a normal
 * jpg/webp upload logs no "writeCardToFile failed" error. A PNG upload still takes the fast path.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('../src/character-avatars.js')} */
let avatars;
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
    // The server installs this at startup; Jimp's WASM decoders load their .wasm through a file:// fetch.
    await import('../src/fetch-patch.js');

    characters = await import('../src/endpoints/characters.js');
    cardParser = await import('../src/character-card-parser.js');
    avatars = await import('../src/character-avatars.js');

    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-non-png-upload-test-uploads-'));
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
    user = await (await import('./converted-user.fixture.js')).emptyUser('st-non-png-upload-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(async () => {
    jest.restoreAllMocks();
    await user.close();
});

/** The character's stored image (card data stripped) and its card. */
async function storedAlice() {
    const image = fs.readFileSync(/** @type {string} */ (await avatars.avatarPathOf(user.store.lib, directories, 'Alice.png')));
    const [card] = await user.store.lib.cards(['Alice.png']);
    return { image, card };
}

const post = (route, body) => fetch(`${baseUrl}/api/characters/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// A 1x1 lossy WebP.
const WEBP_1X1 = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');

/**
 * @param {string} mime
 * @returns {Buffer}
 */
function sampleImage(mime) {
    return mime === 'image/webp' ? WEBP_1X1 : fs.readFileSync(path.resolve('default/content/backgrounds/_black.jpg'));
}

/**
 * Uploads `bytes` as Alice's new avatar through /edit, the route that logged the error.
 * @param {Buffer} bytes
 * @param {string} type
 * @param {string} name
 */
async function editWithUpload(bytes, type, name) {
    const formData = new FormData();
    formData.append('avatar', new Blob([bytes], { type }), name);
    formData.append('avatar_url', 'Alice.png');
    formData.append('ch_name', 'Alice');
    formData.append('description', 'after upload');
    return await fetch(`${baseUrl}/api/characters/edit`, { method: 'POST', body: formData });
}

function fastPathFailureLogged(warnSpy) {
    return warnSpy.mock.calls.some(args => String(args[0]).includes('writeCardToFile failed'));
}

describe('avatar uploads through /edit', () => {
    beforeEach(async () => {
        const res = await post('create', { ch_name: 'Alice', description: 'before', file_name: 'Alice' });
        if (res.status !== 200) throw new Error(`create failed: ${res.status}`);
    });

    for (const [label, mime, name] of [['jpg', 'image/jpeg', 'new.jpg'], ['webp', 'image/webp', 'new.webp']]) {
        test(`a ${label} upload becomes a valid card PNG without a fast-path error`, async () => {
            const warnSpy = jest.spyOn(console, 'warn');
            const bytes = sampleImage(mime);
            expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(false);

            const res = await editWithUpload(bytes, mime, name);
            expect(res.status).toBe(200);

            const { image: written, card } = await storedAlice();
            expect(written.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
            expect(card.data.description).toBe('after upload');
            expect(fastPathFailureLogged(warnSpy)).toBe(false);
        });
    }

    test('a png upload still goes through the fast path, with no error', async () => {
        const warnSpy = jest.spyOn(console, 'warn');
        const bytes = fs.readFileSync(path.resolve('public/img/user-default.png'));

        const res = await editWithUpload(bytes, 'image/png', 'new.png');
        expect(res.status).toBe(200);

        const { image: written, card } = await storedAlice();
        expect(cardParser.computeAvatarIdentityHashFromImageBuffer(written)).toBe(cardParser.computeAvatarIdentityHashFromImageBuffer(bytes));
        expect(card.data.description).toBe('after upload');
        expect(fastPathFailureLogged(warnSpy)).toBe(false);
    });
});
