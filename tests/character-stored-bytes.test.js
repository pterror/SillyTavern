import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-stored-bytes-server-'));

jest.unstable_mockModule('../src/server-directory.js', () => ({
    serverDirectory: fixtureRoot,
}));

const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/character-avatars.js')} */
let avatars;
/** @type {typeof import('../src/endpoints/content-manager.js')} */
let contentManager;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {import('node:http').Server} */
let server;
let baseUrl = '';

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));
    cardParser = await import('../src/character-card-parser.js');
    avatars = await import('../src/character-avatars.js');
    contentManager = await import('../src/endpoints/content-manager.js');
    const { router } = await import('../src/endpoints/characters.js');

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();
    app.use(multer({ dest: fs.mkdtempSync(path.join(os.tmpdir(), 'st-stored-bytes-uploads-')) }).single('avatar'));
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(async () => {
    user = await (await import('./converted-user.fixture.js')).emptyUser('st-stored-bytes-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/** @param {string} avatar */
async function storedFile(avatar) {
    return fs.readFileSync(/** @type {string} */ (await avatars.avatarPathOf(user.store.lib, user.directories, avatar)));
}

describe('a character\'s image file is the one it came as, byte for byte, card chunks included', () => {
    test('created with an uploaded PNG card', async () => {
        const uploaded = cardParser.write(BLANK_PNG, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Other', data: { name: 'Other' } }));
        const form = new FormData();
        form.set('ch_name', 'Made');
        form.set('avatar', new Blob([uploaded], { type: 'image/png' }), 'made.png');
        const response = await fetch(`${baseUrl}/api/characters/create`, { method: 'POST', body: form });
        expect(response.ok).toBe(true);
        const avatar = await response.text();
        expect((await storedFile(avatar)).equals(uploaded)).toBe(true);
        expect((await user.store.lib.cards([avatar]))[0].name).toBe('Made');
    });

    test('seeded from the bundled content', async () => {
        const bundled = cardParser.write(BLANK_PNG, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Bundled', data: { name: 'Bundled' } }));
        const contentDir = path.join(fixtureRoot, 'default', 'content');
        fs.mkdirSync(contentDir, { recursive: true });
        fs.writeFileSync(path.join(contentDir, 'Bundled.png'), bundled);
        fs.writeFileSync(path.join(contentDir, 'index.json'), JSON.stringify([{ filename: 'Bundled.png', type: 'character' }]));

        await contentManager.checkForNewContent([user.directories]);

        expect((await storedFile('Bundled.png')).equals(bundled)).toBe(true);
        expect((await user.store.lib.cards(['Bundled.png']))[0].name).toBe('Bundled');
    });
});
