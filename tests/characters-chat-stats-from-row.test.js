import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

// writeCharacterData()'s and the JSON importer's DEFAULT_AVATAR_PATH ('./public/img/...') is repo-root-relative.
const originalCwd = process.cwd();

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    fixture = await import('./converted-user.fixture.js');
    const { router } = await import('../src/endpoints/characters.js');

    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();
    const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-stats-from-row-uploads-'));
    app.use(multer({ dest: uploadsDir }).single('avatar'));
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
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

beforeEach(async () => {
    user = await fixture.emptyUser('st-chat-stats-from-row-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

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
        // The character's chat messages are what the stats come from; the chats folder (a stray file) is not read.
        await fixture.saveBranch(user.store, { avatar }, 'Zorkmid chat', [{}, { name: 'User', is_user: true, mes: 'hello there', send_date: 5678, extra: {} }]);
        const tree = await fixture.treeOf(user.store, { avatar });
        const stats = (await user.store.lib.chatStats([tree])).get(tree);
        const expected = [stats?.chat_size, stats?.date_last_chat];
        expect(expected[0]).toBeGreaterThan(0);
        expect(expected[0]).not.toBe(4321);
        expect(expected[1]).toBeGreaterThan(0);
        fs.mkdirSync(path.join(directories.chats, 'Zorkmid'), { recursive: true });
        fs.writeFileSync(path.join(directories.chats, 'Zorkmid', 'chat.jsonl'), 'x'.repeat(4321));

        /** @type {[string, any][]} */
        const sent = [];

        sent.push(['/all', (await (await postJson('/api/characters/all', {})).json()).find(c => c.avatar === avatar)]);

        let searched;
        searched = await (await postJson('/api/characters/all', { search: 'zorkmid' })).json();
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
            .toEqual(sent.map(([route]) => [route, expected[0], expected[1]]));
    }, 30000);
});
