/**
 * A character whose PNG is missing exists because its row does, and is treated as if its image were the
 * default avatar (DEFAULT_AVATAR_PATH). Metadata edits never create the file.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/characters.js')} */
let characters;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {string} */
let defaultAvatarPath;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

// DEFAULT_AVATAR_PATH is repo-root-relative.
const originalCwd = process.cwd();

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    characters = await import('../src/endpoints/characters.js');
    cardParser = await import('../src/character-card-parser.js');
    metadataDb = await import('../src/character-metadata-db.js');
    const { DEFAULT_AVATAR_PATH } = await import('../src/constants.js');

    process.chdir(path.resolve(originalCwd, '..'));
    defaultAvatarPath = path.resolve(DEFAULT_AVATAR_PATH);

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();
    const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-png-less-test-uploads-'));
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
    process.chdir(originalCwd);
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-png-less-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    const thumbnailsAvatarDir = path.join(tempDir, 'thumbnails', 'avatar');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.mkdirSync(thumbnailsAvatarDir, { recursive: true });
    directories = { characters: charactersDir, chats: chatsDir, root: tempDir, thumbnailsAvatar: thumbnailsAvatarDir };
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

const post = (route, body) => fetch(`${baseUrl}/api/characters/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

const pngPath = (avatar) => path.join(directories.characters, avatar);

/** Creates Alice, then removes her PNG so only the row is left. */
async function createPngLessAlice() {
    expect((await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' })).status).toBe(200);
    fs.unlinkSync(pngPath('Alice.png'));
    expect(fs.existsSync(pngPath('Alice.png'))).toBe(false);
}

async function storedCard(avatar) {
    return JSON.parse(await metadataDb.getCharacterCardJson(directories, avatar));
}

describe('metadata edits on a PNG-less character stay DB-only', () => {
    test('/rename', async () => {
        await createPngLessAlice();
        const res = await post('rename', { avatar_url: 'Alice.png', new_name: 'Alicia' });
        expect(res.status).toBe(200);
        expect((await storedCard('Alice.png')).data.name).toBe('Alicia');
        expect(fs.existsSync(pngPath('Alice.png'))).toBe(false);
    });

    test('/edit without an upload', async () => {
        await createPngLessAlice();
        const res = await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED' });
        expect(res.status).toBe(200);
        expect((await storedCard('Alice.png')).data.description).toBe('EDITED');
        expect(fs.existsSync(pngPath('Alice.png'))).toBe(false);
    });

    test('/edit-attribute', async () => {
        await createPngLessAlice();
        const res = await post('edit-attribute', { avatar_url: 'Alice.png', ch_name: 'Alice', field: 'description', value: 'ATTR' });
        expect(res.status).toBe(200);
        expect((await storedCard('Alice.png')).data.description).toBe('ATTR');
        expect(fs.existsSync(pngPath('Alice.png'))).toBe(false);
    });

    test('a greeting op', async () => {
        await createPngLessAlice();
        const res = await post('greetings/add', { avatar_url: 'Alice.png', position: 0, expected_length: 0, text: 'Hello there' });
        expect(res.status).toBe(200);
        expect((await storedCard('Alice.png')).data.alternate_greetings).toContain('Hello there');
        expect(fs.existsSync(pngPath('Alice.png'))).toBe(false);
    });

    test('/merge-attributes without an upload', async () => {
        await createPngLessAlice();
        const res = await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'MERGED' } });
        expect(res.status).toBe(200);
        expect((await storedCard('Alice.png')).data.description).toBe('MERGED');
        expect(fs.existsSync(pngPath('Alice.png'))).toBe(false);
    });
});

describe('image routes on a PNG-less character', () => {
    test('/edit-avatar writes the uploaded image', async () => {
        await createPngLessAlice();
        const uploadPath = path.resolve('public/img/user-default.png');

        const formData = new FormData();
        formData.append('avatar', new Blob([fs.readFileSync(uploadPath)], { type: 'image/png' }), 'new.png');
        formData.append('avatar_url', 'Alice.png');
        const res = await fetch(`${baseUrl}/api/characters/edit-avatar`, { method: 'POST', body: formData });
        expect(res.status).toBe(200);

        expect(fs.existsSync(pngPath('Alice.png'))).toBe(true);
        const written = cardParser.computeAvatarIdentityHashFromImageBuffer(fs.readFileSync(pngPath('Alice.png')));
        const uploaded = cardParser.computeAvatarIdentityHashFromImageBuffer(fs.readFileSync(uploadPath));
        expect(written).toBe(uploaded);
    });

    test('/duplicate creates the new file with the default avatar\'s bytes', async () => {
        await createPngLessAlice();
        const res = await post('duplicate', { avatar_url: 'Alice.png' });
        expect(res.status).toBe(200);
        const { path: newAvatar } = await res.json();

        expect(fs.readFileSync(pngPath(newAvatar)).equals(fs.readFileSync(defaultAvatarPath))).toBe(true);
        expect((await storedCard(newAvatar)).data.name).toBe('Alice');
    });

    test('/duplicate skips a suffix whose row exists without a file', async () => {
        await createPngLessAlice();
        expect((await post('create', { ch_name: 'Bob', file_name: 'Alice_1' })).status).toBe(200);
        fs.unlinkSync(pngPath('Alice_1.png'));

        const res = await post('duplicate', { avatar_url: 'Alice.png' });
        expect(res.status).toBe(200);
        expect((await res.json()).path).toBe('Alice_2.png');
        expect((await storedCard('Alice_1.png')).data.name).toBe('Bob');
    });

    test('/export png returns the default avatar image carrying the current card', async () => {
        await createPngLessAlice();
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'CURRENT' });

        const res = await post('export', { avatar_url: 'Alice.png', format: 'png' });
        expect(res.status).toBe(200);
        const buffer = Buffer.from(await res.arrayBuffer());

        const exportedPath = path.join(directories.root, 'exported.png');
        fs.writeFileSync(exportedPath, buffer);
        expect(JSON.parse(await cardParser.parse(exportedPath, 'png')).data.description).toBe('CURRENT');
        expect(cardParser.computeAvatarIdentityHashFromImageBuffer(buffer))
            .toBe(cardParser.computeAvatarIdentityHashFromImageBuffer(fs.readFileSync(defaultAvatarPath)));
    });
});

describe('existence follows the row', () => {
    test('/delete succeeds and removes the row', async () => {
        await createPngLessAlice();
        const res = await post('delete', { avatar_url: 'Alice.png' });
        expect(res.status).toBe(200);
        expect(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).toBeNull();
    });

    test('/delete with neither row nor file is 400', async () => {
        const res = await post('delete', { avatar_url: 'Nobody.png' });
        expect(res.status).toBe(400);
    });

    test('/get includes the character', async () => {
        await createPngLessAlice();
        const res = await post('get', { avatar_url: 'Alice.png' });
        expect(res.status).toBe(200);
        expect((await res.json()).name).toBe('Alice');
    });

    describe('mintCharacterId', () => {
        /** Makes uuidv7() return the same sequence of ids on every replay. */
        function replayableIds() {
            let n = 0;
            jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
            jest.spyOn(crypto, 'randomBytes').mockImplementation(() => Buffer.alloc(16, ++n));
            return () => { n = 0; };
        }

        afterEach(() => jest.restoreAllMocks());

        test('skips an id whose row exists without a file', async () => {
            const replay = replayableIds();
            const first = characters.mintCharacterId(directories);
            const second = characters.mintCharacterId(directories);
            replay();

            await metadataDb.upsertCharacterFromWrite(directories, `${first}.png`, JSON.stringify({ name: 'Ghost', spec: 'chara_card_v2', data: { name: 'Ghost' } }));
            expect(fs.existsSync(pngPath(`${first}.png`))).toBe(false);

            expect(characters.mintCharacterId(directories)).toBe(second);
        });

        test('skips an id still pending in the batch-import buffer', async () => {
            const replay = replayableIds();
            const first = characters.mintCharacterId(directories);
            const second = characters.mintCharacterId(directories);
            replay();

            await metadataDb.beginBatchImport(directories);
            try {
                await metadataDb.upsertCharacterFromWrite(directories, `${first}.png`, JSON.stringify({ name: 'Ghost', spec: 'chara_card_v2', data: { name: 'Ghost' } }), null, null, { fromImport: true });
                expect(await metadataDb.characterRowExists(directories, `${first}.png`)).toBe(false);

                expect(characters.mintCharacterId(directories)).toBe(second);
            } finally {
                await metadataDb.endBatchImport(directories);
            }
        });
    });

    test('processCharacter takes date_added from the default avatar', async () => {
        await createPngLessAlice();
        const character = await characters.processCharacter('Alice.png', directories, { shallow: false });
        expect(character.name).toBe('Alice');
        expect(character.date_added).toBe(fs.statSync(defaultAvatarPath).ctimeMs);
    });
});
