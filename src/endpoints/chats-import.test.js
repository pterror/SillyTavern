import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// chats.js's import chain reads process-wide config at import time, so the config path is set first.
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// An imported chat goes into the message tree, or the import fails and says so; nothing is written to a chat file.
// A new character has no chat name minted for it.
const { router: chatsRouter } = await import('./chats.js');
const { router: charactersRouter } = await import('./characters.js');
const { loadBranch } = await import('../message-tree-db.js');
const { getCharacterActiveChatsByIds, upsertCharacterFromWrite } = await import('../character-metadata-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chats-import-test-'));
const directories = { root };
for (const dir of ['chats', 'groupChats', 'groups', 'backups', 'characters', 'thumbnailsAvatar', 'uploads']) {
    directories[dir] = path.join(root, dir);
    fs.mkdirSync(directories[dir], { recursive: true });
}
globalThis.DATA_ROOT = root;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.user = { directories, profile: { handle: 'tester' } };
    next();
});
// Stands in for the server's upload middleware: the test names a file it wrote under `uploads`.
app.use((req, _res, next) => {
    const upload = req.get('X-Test-Upload');
    if (upload) req.file = /** @type {any} */ ({ destination: directories.uploads, filename: upload });
    next();
});
app.use('/api/chats', chatsRouter);
app.use('/api/characters', charactersRouter);

/** @returns {Promise<{status: number, data: any}>} */
async function postJson(urlPath, body, headers = {}) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data };
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));

async function writeCharacter(avatar, name) {
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0', name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', avatar,
        data: { name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '', system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '', alternate_greetings: [], extensions: {} },
    };
    const cardJson = JSON.stringify(card);
    fs.writeFileSync(path.join(directories.characters, avatar), writeCard(baseImage, cardJson));
    await upsertCharacterFromWrite(directories, avatar, cardJson);
}

/** Writes an upload and names it for the next request. */
function upload(text) {
    const name = `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.writeFileSync(path.join(directories.uploads, name), text);
    return { 'X-Test-Upload': name, name };
}

const jsonl = [
    JSON.stringify({ user_name: 'User', character_name: 'Nia', chat_metadata: {} }),
    JSON.stringify({ name: 'Nia', is_user: false, mes: 'Imported hello.', send_date: 'x', extra: {} }),
].join('\n');

test('an imported chat is stored in the tree, and no chat file is written', async () => {
    await writeCharacter('nia.png', 'Nia');
    const file = upload(jsonl);
    const { status, data } = await postJson('/api/chats/import', { avatar_url: 'nia.png', file_type: 'jsonl', character_name: 'Nia', user_name: 'User' }, { 'X-Test-Upload': file['X-Test-Upload'] });
    assert.equal(status, 200);
    assert.equal(data.res, true);
    const name = data.fileNames[0].replace(/\.jsonl$/, '');
    assert.deepEqual((await loadBranch(directories, 'nia', name)).messages.map(m => m.mes), ['Imported hello.']);
    assert.equal(fs.existsSync(path.join(directories.chats, 'nia')), false, 'no chat folder or file');
    assert.equal(fs.existsSync(path.join(directories.uploads, file.name)), false, 'the upload is removed');
});

test('a group chat import that names no group fails and leaves no file', async () => {
    const file = upload(jsonl);
    const { data } = await postJson('/api/chats/group/import', {}, { 'X-Test-Upload': file['X-Test-Upload'] });
    assert.equal(data.error, true);
    assert.equal(fs.existsSync(path.join(directories.uploads, file.name)), false);
    assert.deepEqual(fs.readdirSync(directories.groupChats), []);
});

test('a new character has no chat name minted for it', async () => {
    const created = await postJson('/api/characters/create', { ch_name: 'Ola', first_mes: 'Hi.' });
    assert.equal(created.status, 200);
    const avatar = String(created.data);
    assert.match(avatar, /\.png$/);
    const active = (await getCharacterActiveChatsByIds(directories, [avatar]))[avatar];
    assert.equal(active, undefined);
});

after(() => setImmediate(() => process.exit(0)));
