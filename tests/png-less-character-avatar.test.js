import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
let defaultAvatarBytes;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

const originalCwd = process.cwd();

// DEFAULT_AVATAR_PATH is repo-root-relative.
beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));
    process.chdir(path.resolve(originalCwd, '..'));

    metadataDb = await import('../src/character-metadata-db.js');
    const { router: userFilesRouter } = await import('../src/users.js');
    const { router: thumbnailRouter } = await import('../src/endpoints/thumbnails.js');
    const { DEFAULT_AVATAR_PATH } = await import('../src/constants.js');
    defaultAvatarBytes = fs.readFileSync(DEFAULT_AVATAR_PATH);

    const express = (await import('express')).default;
    const app = express();
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/thumbnail', thumbnailRouter);
    app.use(userFilesRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-png-less-avatar-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        thumbnailsAvatar: path.join(tempDir, 'thumbnails', 'avatar'),
    };
    fs.mkdirSync(directories.characters, { recursive: true });
    fs.mkdirSync(directories.chats, { recursive: true });
    fs.mkdirSync(directories.thumbnailsAvatar, { recursive: true });
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

/** Seeds a row with no PNG on disk. */
async function seedPngLessCharacter(avatar) {
    const name = avatar.replace(/\.png$/, '');
    const card = { name, spec: 'chara_card_v2', spec_version: '2.0', data: { name, extensions: {} } };
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card));
}

async function getBytes(urlPath) {
    const response = await fetch(`${baseUrl}${urlPath}`);
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

describe('character whose PNG is missing', () => {
    const avatar = '11ee9c30-3aaa-7000-8000-000000000001.png';

    test('/characters/<avatar> returns the default avatar bytes', async () => {
        await seedPngLessCharacter(avatar);

        const { status, bytes } = await getBytes(`/characters/${avatar}`);

        expect(status).toBe(200);
        expect(bytes.equals(defaultAvatarBytes)).toBe(true);
    });

    test('/thumbnail?type=avatar returns the default avatar bytes, not a stale cached thumbnail', async () => {
        await seedPngLessCharacter(avatar);
        fs.writeFileSync(path.join(directories.thumbnailsAvatar, avatar), 'stale cached thumbnail');

        const { status, bytes } = await getBytes(`/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`);

        expect(status).toBe(200);
        expect(bytes.equals(defaultAvatarBytes)).toBe(true);
    });
});

describe('missing files that keep their 404', () => {
    const avatar = '11ee9c30-3aaa-7000-8000-000000000002.png';

    test('/characters/<avatar> with no row is a 404', async () => {
        const { status } = await getBytes(`/characters/${avatar}`);
        expect(status).toBe(404);
    });

    test('/thumbnail?type=avatar with no row is a 404', async () => {
        const { status } = await getBytes(`/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`);
        expect(status).toBe(404);
    });

    test('a missing sprite is a 404 even when its basename has a row', async () => {
        await seedPngLessCharacter('joy.png');

        const { status } = await getBytes('/characters/Alice/joy.png');

        expect(status).toBe(404);
    });
});
