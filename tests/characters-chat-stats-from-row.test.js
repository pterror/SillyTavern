import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

// writeCharacterData()'s and the JSON importer's DEFAULT_AVATAR_PATH ('./public/img/...') is repo-root-relative.
const originalCwd = process.cwd();

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    const { router } = await import('../src/endpoints/characters.js');

    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();
    const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-stats-from-row-uploads-'));
    app.use(multer({ dest: uploadsDir }).single('avatar'));
    app.use(express.json());
    app.use((req, res, next) => {
        // Search index workers are keyed by handle, so each test's fresh directories get their own handle.
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-stats-from-row-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
        thumbnailsAvatar: path.join(tempDir, 'thumbnails', 'avatar'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.thumbnailsAvatar]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(async () => {
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

async function postJson(urlPath, body) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('every route sending a character takes chat_size and date_last_chat from its row, not its chats folder', () => {
    test('a character whose row and chats folder disagree', async () => {
        const avatar = 'Zorkmid.png';
        expect((await postJson('/api/characters/create', { ch_name: 'Zorkmid', file_name: 'Zorkmid', description: 'd' })).status).toBe(200);
        await metadataDb.applyCharacterChatStats(directories, avatar, { sizeChange: 1234, addedCreatedAt: 5678, readLastCreatedAt: null });
        fs.mkdirSync(path.join(directories.chats, 'Zorkmid'), { recursive: true });
        fs.writeFileSync(path.join(directories.chats, 'Zorkmid', 'chat.jsonl'), 'x'.repeat(4321));

        /** @type {[string, any][]} */
        const sent = [];

        sent.push(['/all', (await (await postJson('/api/characters/all', {})).json()).find(c => c.avatar === avatar)]);

        let searched;
        const deadline = Date.now() + 10000;
        do {
            searched = await (await postJson('/api/characters/all', { search: 'zorkmid' })).json();
            if (searched.items?.length > 0) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        sent.push(['/all search', searched.items.find(c => c.avatar === avatar)]);

        sent.push(['/batch', (await (await postJson('/api/characters/batch', { avatars: [avatar] })).json())[0]]);
        sent.push(['/batch fields', (await (await postJson('/api/characters/batch', { avatars: [avatar], fields: ['chat_size', 'date_last_chat'] })).json())[0]]);
        sent.push(['/get', await (await postJson('/api/characters/get', { avatar_url: avatar })).json()]);

        const formData = new FormData();
        formData.append('avatar', new Blob([JSON.stringify({ name: 'Zorkmid', description: 'reimported' })], { type: 'application/json' }), 'zorkmid.json');
        formData.append('file_type', 'json');
        formData.append('preserved_name', avatar);
        const imported = await (await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData })).json();
        sent.push(['/import', imported.character]);

        expect(sent.map(([route, record]) => [route, record?.chat_size, record?.date_last_chat]))
            .toEqual(sent.map(([route]) => [route, 1234, 5678]));
    }, 30000);
});
