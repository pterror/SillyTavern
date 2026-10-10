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

// Upstream's whole-chat save (/api/chats/save) stores what changed in the array: an edited message, a message added
// without an id; it names the chat by its name or by a message on it, leaves unchanged metadata unwritten, and puts a
// character with no current chat on an unnamed chat it saves.
const { router: chatsRouter } = await import('./chats.js');
const { loadBranch, loadAtNode, getAncestorPath } = await import('../message-tree-db.js');
const { upsertCharacterFromWrite, getCharacterActiveChatsByIds } = await import('../character-metadata-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chats-save-compat-test-'));
const directories = { root };
for (const dir of ['chats', 'groupChats', 'groups', 'backups', 'characters', 'thumbnailsAvatar']) {
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
app.use('/api/chats', chatsRouter);

/** @returns {Promise<{status: number, data: any}>} */
async function postJson(urlPath, body) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: res.status, data: await res.json().catch(() => ({})) };
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

const header = metadata => ({ chat_metadata: metadata, user_name: 'User', character_name: 'Pia' });

test('an edited message and a message added without an id are stored; unchanged metadata keeps its integrity', async () => {
    await writeCharacter('pia.png', 'Pia');
    await postJson('/api/chats/save', {
        avatar_url: 'pia.png', file_name: 'Talk',
        chat: [header({ note_prompt: 'x' }), { name: 'Pia', is_user: false, mes: 'One.', send_date: 'x', extra: {} }],
    });
    const before = await loadBranch(directories, 'pia', 'Talk');
    const first = before.messages[0];
    const integrity = before.metadata.integrity;

    const { status, data } = await postJson('/api/chats/save', {
        avatar_url: 'pia.png', file_name: 'Talk',
        chat: [header({ note_prompt: 'x', integrity }), { ...first, mes: 'One, edited.' }, { name: 'Narrator', is_user: false, mes: 'Added.', send_date: 'x', extra: {} }],
    });
    assert.equal(status, 200);
    assert.equal(data.integrity, integrity, 'unchanged metadata isn\'t written');
    assert.deepEqual(data.assigned_node_ids.map(a => a.index), [1]);
    const after = await loadBranch(directories, 'pia', 'Talk');
    assert.deepEqual(after.messages.map(m => m.mes), ['One, edited.', 'Added.']);
    assert.equal(after.messages[0].node_id, first.node_id, 'the edit landed on the same message');
});

test('a chat named by a message on it keeps its metadata there and gets no new name', async () => {
    await writeCharacter('qin.png', 'Qin');
    const saved = await postJson('/api/chats/save', {
        avatar_url: 'qin.png', file_name: '',
        chat: [header({}), { name: 'Qin', is_user: false, mes: 'Hi.', send_date: 'x', extra: {} }],
    });
    const nodeId = saved.data.assigned_node_ids[0].node_id;
    assert.equal(saved.data.file_name, nodeId, 'an unnamed chat is answered by its first message');
    assert.equal((await getCharacterActiveChatsByIds(directories, ['qin.png']))['qin.png'], nodeId, 'the character is on it');

    const again = await postJson('/api/chats/save', {
        avatar_url: 'qin.png', file_name: nodeId,
        chat: [header({ note_prompt: 'kept' }), { name: 'Qin', is_user: false, mes: 'Hi.', send_date: 'x', extra: {}, node_id: nodeId }],
    });
    assert.equal(again.status, 200);
    const atNode = await loadAtNode(directories, 'qin', nodeId);
    assert.equal(atNode.metadata.note_prompt, 'kept');
    assert.equal(atNode.label, null);
    assert.equal((await getAncestorPath(directories, nodeId)).length, 1);
});

after(() => setImmediate(() => process.exit(0)));
