import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {import('express').Router} */
let router;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/**
 * Mounts the real characters.js router behind a fake auth middleware, mirroring characters-query.test.js's setup.
 */
beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');

    const express = (await import('express')).default;
    const app = express();
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-rename-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, chats: chatsDir };
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

async function postJson(urlPath, body) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return response;
}

/**
 * Writes a real (parseable) PNG card under `avatar` and seeds its metadata row, mirroring
 * characters-query.test.js's seedCharacterWithFile().
 * @param {string} avatar
 * @param {object} overrides
 * @param {number} [fileMtime]
 */
async function seedCharacterWithFile(avatar, overrides = {}, fileMtime = 1000) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const name = avatar.replace(/\.png$/, '');
    const card = {
        name,
        fav: false,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '',
            extensions: { fav: false, world: '' },
        },
        ...overrides,
    };
    const buffer = cardParser.write(baseImage, JSON.stringify(card));
    await fs.promises.writeFile(path.join(directories.characters, avatar), buffer);
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify(card), fileMtime);
}

describe('POST /api/characters/rename (design doc §9 phase 4d: collapses to a card-data edit)', () => {
    test('keeps the same avatar/id in the response - no file move', async () => {
        await seedCharacterWithFile('11ee9c30-3aaa-7000-8000-000000000001.png');

        const response = await postJson('/api/characters/rename', {
            avatar_url: '11ee9c30-3aaa-7000-8000-000000000001.png',
            new_name: 'New Display Name',
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.avatar).toBe('11ee9c30-3aaa-7000-8000-000000000001.png');

        // The file is still at the exact same path - no rename, no copy.
        expect(fs.existsSync(path.join(directories.characters, '11ee9c30-3aaa-7000-8000-000000000001.png'))).toBe(true);
    });

    test('updates the display name in the card payload', async () => {
        await seedCharacterWithFile('11ee9c30-3aaa-7000-8000-000000000002.png', { name: 'Old Name', data: { name: 'Old Name', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        await postJson('/api/characters/rename', {
            avatar_url: '11ee9c30-3aaa-7000-8000-000000000002.png',
            new_name: 'New Name',
        });

        const row = await metadataDb.getCharacterMetadataRow(directories, '11ee9c30-3aaa-7000-8000-000000000002.png');
        expect(row.name).toBe('New Name');
    });

    test('does not move or create a chats directory', async () => {
        const avatar = '11ee9c30-3aaa-7000-8000-000000000003.png';
        await seedCharacterWithFile(avatar);
        const chatsDir = path.join(directories.chats, avatar.replace(/\.png$/, ''));
        fs.mkdirSync(chatsDir, { recursive: true });
        fs.writeFileSync(path.join(chatsDir, 'a.jsonl'), '{}\n');

        await postJson('/api/characters/rename', { avatar_url: avatar, new_name: 'Renamed' });

        // Same directory, same content - never touched.
        expect(fs.existsSync(chatsDir)).toBe(true);
        expect(fs.existsSync(path.join(chatsDir, 'a.jsonl'))).toBe(true);
    });

    test('never changes date_added (id is immutable, so there is no old-row/new-row carry-forward to get wrong)', async () => {
        const avatar = '11ee9c30-3aaa-7000-8000-000000000004.png';
        await seedCharacterWithFile(avatar);
        const before = await metadataDb.getCharacterMetadataRow(directories, avatar);

        await new Promise(resolve => setTimeout(resolve, 5));
        await postJson('/api/characters/rename', { avatar_url: avatar, new_name: 'Renamed Again' });

        const after = await metadataDb.getCharacterMetadataRow(directories, avatar);
        expect(after.date_added).toBe(before.date_added);
    });

    test('400s when avatar_url or new_name is missing', async () => {
        const r1 = await postJson('/api/characters/rename', { new_name: 'X' });
        expect(r1.status).toBe(400);
        const r2 = await postJson('/api/characters/rename', { avatar_url: 'x.png' });
        expect(r2.status).toBe(400);
    });
});
