import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('express').Router} */
let router;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

// writeCharacterData()'s DEFAULT_AVATAR_PATH fallback ('./public/img/ai4.png') is repo-root-relative, not
// tests/-relative - same reasoning/fix as characters-cross-reflink.test.js's own chdir.
const originalCwd = process.cwd();

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    cardParser = await import('../src/character-card-parser.js');
    metadataDb = await import('../src/character-metadata-db.js');

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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-active-chat-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    directories = { characters: charactersDir, chats: chatsDir, root: tempDir };
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
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

/**
 * @param {object} body
 */
async function setChat(body) {
    return fetch(`${baseUrl}/api/characters/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * @param {object} body
 */
async function mergeAttributes(body) {
    return fetch(`${baseUrl}/api/characters/merge-attributes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /api/characters/chat (dedicated active-chat write path)', () => {
    test('happy path: 204, and the row\'s active_chat is updated', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);

        const response = await setChat({ avatar: 'Alice.png', chat: 'Alice - Some Chat' });
        expect(response.status).toBe(204);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        expect(row.active_chat).toBe('Alice - Some Chat');
    });

    test('404 for an untracked avatar', async () => {
        const response = await setChat({ avatar: 'Ghost.png', chat: 'Some Chat' });
        expect(response.status).toBe(404);
    });

    test('400 for a missing avatar', async () => {
        const response = await setChat({ chat: 'Some Chat' });
        expect(response.status).toBe(400);
    });

    test('400 for a missing chat', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);

        const response = await setChat({ avatar: 'Alice.png' });
        expect(response.status).toBe(400);
    });
});

describe('/edit no longer writes chat into the card file, but still updates the db row', () => {
    test('the actual PNG on disk never carries a chat field after /edit', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);

        const editResponse = await edit('Alice.png', { ch_name: 'Alice', description: 'desc', avatar_url: 'Alice.png', chat: 'Alice - Edited Chat' });
        expect(editResponse.status).toBe(200);

        const cardJson = cardParser.read(fs.readFileSync(path.join(directories.characters, 'Alice.png')));
        const card = JSON.parse(cardJson);
        expect(card.chat).toBeUndefined();
    });

    test('the db row is updated via the seed-after-write path', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);

        const editResponse = await edit('Alice.png', { ch_name: 'Alice', description: 'desc', avatar_url: 'Alice.png', chat: 'Alice - Edited Chat' });
        expect(editResponse.status).toBe(200);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        expect(row.active_chat).toBe('Alice - Edited Chat');
    });

    test('an /edit with no chat in the request body leaves the existing db active_chat untouched', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);
        await setChat({ avatar: 'Alice.png', chat: 'Alice - Original Chat' });

        const editResponse = await edit('Alice.png', { ch_name: 'Alice', description: 'now edited', avatar_url: 'Alice.png' });
        expect(editResponse.status).toBe(200);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        expect(row.active_chat).toBe('Alice - Original Chat');
    });
});

describe('/merge-attributes carves chat out the same way, and never writes it into the card', () => {
    test('a chat-carrying merge payload updates the db row, not the card file', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);

        const mergeResponse = await mergeAttributes({ avatar: 'Alice.png', chat: 'Alice - Merged Chat' });
        expect(mergeResponse.status).toBe(200);

        const cardJson = cardParser.read(fs.readFileSync(path.join(directories.characters, 'Alice.png')));
        const card = JSON.parse(cardJson);
        expect(card.chat).toBeUndefined();

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        expect(row.active_chat).toBe('Alice - Merged Chat');
    });

    test('a merge payload with no chat key leaves the existing db active_chat untouched', async () => {
        const createResponse = await create({ ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        expect(createResponse.status).toBe(200);
        await setChat({ avatar: 'Alice.png', chat: 'Alice - Original Chat' });

        const mergeResponse = await mergeAttributes({ avatar: 'Alice.png', description: 'now merged' });
        expect(mergeResponse.status).toBe(200);

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        expect(row.active_chat).toBe('Alice - Original Chat');
    });
});
