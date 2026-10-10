import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import express from 'express';

import { write as writeCard } from './character-card-parser.js';
import './fetch-patch.js';
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

// A raw-action generate request carries what the page has that the server doesn't: the chat's greetings when none
// is stored, messages an extension put on the chat without storing them, and the chat metadata keys the page
// changed. The server stores them first, builds the prompt from them, and stores the user message exactly as the
// page sent it.

const { applyPageWrites } = await import('./page-writes.js');
const { router: textRouter } = await import('./endpoints/backends/text-completions.js');
const { writeAllSettings } = await import('./settings-store.js');
const { saveChatToTree, loadBranch, loadAtNode, getAncestorPath, labelNode, getDbHandle } = await import('./message-tree-db.js');
const { upsertCharacterFromWrite, getCharacterActiveChatsByIds } = await import('./character-metadata-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-page-writes-test-'));
const directories = { root };
for (const dir of ['characters', 'groups', 'worlds', 'files', 'chats']) {
    directories[dir] = path.join(root, dir);
    fs.mkdirSync(directories[dir], { recursive: true });
}
globalThis.DATA_ROOT = root;

const baseImage = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'ai4.png'));

async function writeCharacter(avatar, name) {
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0', name, description: '', personality: '', scenario: '',
        first_mes: 'Hi.', mes_example: '', avatar,
        data: {
            name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            alternate_greetings: [], extensions: {},
        },
    };
    const cardJson = JSON.stringify(card);
    fs.writeFileSync(path.join(directories.characters, avatar), writeCard(baseImage, cardJson));
    await upsertCharacterFromWrite(directories, avatar, cardJson);
}

/** A response that records what applyPageWrites() answers and stores. */
function fakeResponse() {
    const response = {
        locals: {},
        statusCode: 200,
        sent: /** @type {any} */ (null),
        headersSent: false,
        setHeader() {},
        writeHead() { return response; },
        status(code) { response.statusCode = code; return response; },
        json(body) { response.sent = body; return response; },
        send(body) { response.sent = body; return response; },
    };
    return response;
}

/** The messages from the first one down to `nodeId`. */
async function pathTo(nodeId) {
    return (await getAncestorPath(directories, nodeId)) ?? [];
}

test('a character chat with no stored greeting: the greeting, a message an extension added and metadata keys are stored first', async () => {
    const avatar = `pw-solo-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const ownerId = avatar.replace('.png', '');
    const response = fakeResponse();
    const body = {
        node_id: null,
        opening: { refs: ['r-open'], messages: [{ name: 'Rex', is_user: false, mes: 'Hi.', extra: {} }] },
        page_messages: { refs: ['r-ext'], messages: [{ name: 'Narrator', is_user: false, is_system: true, mes: 'The wind rises.', extra: { type: 'narrator' } }] },
        page_metadata: { ref: 'r-meta', target: null, set: { note_prompt: 'Be brief.' }, unset: [] },
    };

    const written = await applyPageWrites(response, directories, { ownerId, avatar, body });

    assert.ok(written && typeof written.nodeId === 'string');
    const chain = await pathTo(written.nodeId);
    assert.deepEqual(chain.map(m => m.mes), ['Hi.', 'The wind rises.']);
    const stored = response.locals.storedMessages;
    assert.deepEqual(stored.map(s => s.ref), ['r-open', 'r-ext', 'r-meta']);
    assert.equal(stored[0].node_id, chain[0].node_id);
    assert.equal(stored[1].node_id, written.nodeId);
    assert.equal(typeof stored[2].integrity, 'string');
    assert.equal(stored[2].node_id, chain[0].node_id, 'the metadata goes on the greeting the chat is now at');
    const active = (await getCharacterActiveChatsByIds(directories, [avatar]))[avatar];
    assert.equal(active, chain[0].node_id, 'the character\'s chat is at the stored greeting');
    const opened = await loadAtNode(directories, ownerId, chain[0].node_id);
    assert.equal(opened.metadata.note_prompt, 'Be brief.');

    // Sent again (a retry), nothing is stored twice and an unchanged key isn't written.
    const again = fakeResponse();
    const rewritten = await applyPageWrites(again, directories, { ownerId, avatar, body });
    assert.equal(rewritten.nodeId, written.nodeId);
    assert.equal((await pathTo(rewritten.nodeId)).length, 2);
    assert.equal(again.locals.storedMessages[2].integrity, stored[2].integrity, 'nothing changed, so nothing was written');
});

test('metadata keys are set and removed one by one, leaving the others', async () => {
    const ownerId = `pw-meta-${randomUUID()}`;
    await saveChatToTree(directories, ownerId, 'chat', [
        { chat_metadata: { keep: 1, drop: 2, change: 'old' } },
        { name: 'Rex', is_user: false, mes: 'Hello.', send_date: 1, extra: {} },
    ]);
    const leaf = (await loadBranch(directories, ownerId, 'chat')).branch.leaf_id;
    await labelNode(directories, leaf, 'chat', { ownerId });
    const response = fakeResponse();
    await applyPageWrites(response, directories, {
        ownerId, body: { node_id: leaf, page_metadata: { ref: 'm', target: 'chat', set: { change: 'new' }, unset: ['drop'] } },
    });
    const metadata = (await loadAtNode(directories, ownerId, leaf)).metadata;
    assert.equal(metadata.keep, 1);
    assert.equal(metadata.change, 'new');
    assert.equal('drop' in metadata, false);
});

test('a group chat with no stored greetings: its members\' greetings are stored in a row under the chat\'s name', async () => {
    const groupId = String(Date.now());
    const chatName = `group-chat-${randomUUID()}`;
    fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify({ id: groupId, name: 'Crew', members: [], chat_id: chatName, chats: [chatName] }));
    const response = fakeResponse();
    const written = await applyPageWrites(response, directories, {
        ownerId: groupId, groupId, body: {
            node_id: null,
            opening: { refs: ['g1', 'g2'], messages: [{ name: 'Rex', is_user: false, mes: 'Ahoy.' }, { name: 'Ana', is_user: false, mes: 'Welcome.' }] },
            page_metadata: { ref: 'gm', target: chatName, set: {}, unset: [] },
        },
    });
    const chain = await pathTo(written.nodeId);
    assert.deepEqual(chain.map(m => m.mes), ['Ahoy.', 'Welcome.']);
    const branch = await loadBranch(directories, groupId, chatName);
    assert.deepEqual(branch.messages.map(m => m.mes), ['Ahoy.', 'Welcome.']);
    const db = await getDbHandle(directories);
    const stored = db.get('SELECT metadata FROM messages WHERE id = @id', { id: chain[0].node_id });
    assert.equal(JSON.parse(stored.metadata).__is_group, true);
    assert.equal(typeof response.locals.storedMessages.find(s => s.ref === 'gm')?.integrity, 'string');
});

test('messages with no stored message to follow are refused, and nothing is generated', async () => {
    const response = fakeResponse();
    const written = await applyPageWrites(response, directories, {
        ownerId: `pw-none-${randomUUID()}`, body: { node_id: null, page_messages: { refs: ['x'], messages: [{ mes: 'Lost?' }] } },
    });
    assert.equal(written, null);
    assert.equal(response.statusCode, 409);
    assert.equal(response.sent.page_changes_not_saved, true);
});

test('the user message is stored as the page sent it, and the prompt has what the page added', async () => {
    const avatar = `pw-route-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const ownerId = avatar.replace('.png', '');
    let prompt = '';
    const backend = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if ((req.url ?? '').includes('/models')) return res.end(JSON.stringify({ data: [] }));
            prompt = String(JSON.parse(raw || '{}').prompt ?? '');
            res.end(JSON.stringify({ choices: [{ text: 'At dawn.' }] }));
        });
    });
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    writeAllSettings(directories, {
        username: 'Tester', amount_gen: 100, max_context: 4096,
        power_user: { instruct: { enabled: false }, context: {}, reasoning: {}, sysprompt: {} },
        world_info: { globalSelect: [], charLore: [] }, world_info_settings: {},
        textgenerationwebui_settings: { type: 'generic', generic_model: 'm', server_urls: { generic: `http://127.0.0.1:${backend.address().port}` } },
        extension_settings: { note: {}, cfg: {} },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories, profile: { handle: 'alice' } }; next(); });
    app.use('/', textRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));

    const sent = { name: 'Tester', is_user: true, is_system: false, send_date: '2026-10-10T00:00:00.000Z', mes: 'When do we leave, Rex?', persona: 'tester.png', force_avatar: '/thumbnail?type=persona&file=tester.png', extra: { isSmallSys: false, bias: 'Calmly' } };
    const answer = await fetch(`http://127.0.0.1:${server.address().port}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            owner_id: ownerId, character_avatar: avatar, type: 'normal', stream: false,
            node_id: null,
            opening: { refs: ['o'], messages: [{ name: 'Rex', is_user: false, mes: 'Hi.', extra: {} }] },
            page_messages: { refs: ['e'], messages: [{ name: 'Narrator', is_user: false, is_system: false, mes: 'Thunder rolls.', extra: {} }] },
            user_message: sent, user_message_ref: 'u',
        }),
    });
    const data = await answer.json();
    server.close();
    backend.close();

    assert.equal(answer.status, 200);
    assert.ok(prompt.includes('Thunder rolls.'), 'the message the page added is in the prompt');
    assert.deepEqual(data.stored.map(s => s.ref), ['o', 'e', 'u']);
    const userNode = data.stored.find(s => s.ref === 'u').node_id;
    const reloaded = (await pathTo(data.assistant_node_id));
    assert.deepEqual(reloaded.map(m => m.mes), ['Hi.', 'Thunder rolls.', sent.mes, 'At dawn.']);
    const storedUser = reloaded.find(m => m.node_id === userNode);
    for (const key of ['name', 'mes', 'persona', 'force_avatar', 'send_date']) {
        assert.equal(storedUser[key], sent[key], `the stored user message keeps ${key} as sent`);
    }
    assert.equal(storedUser.extra.bias, 'Calmly');
});
