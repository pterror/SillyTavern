import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import express from 'express';

import { write as writeCard } from './character-card-parser.js';
import './fetch-patch.js';
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

// A raw-action generate request carries what the page has that the server doesn't: the chat's greetings when none
// is stored, messages an extension put on the chat without storing them, and the chat metadata keys the page
// changed. The server stores them first, through the request's session, builds the prompt from them, and stores the
// user message exactly as the page sent it.

const { applyPageWrites } = await import('./page-writes.js');
const { chatContext } = await import('./chat-request.js');
const { newSessionKey } = await import('./chat-engine.js');
const { SESSION_HEADER } = await import('./request-session.js');
const { router: textRouter } = await import('./endpoints/backends/text-completions.js');
const { writeAllSettings } = await import('./settings-store.js');
const { convertedUser, writeLibraryCard, treeOf, seedMessages } = await import('../tests/converted-user.fixture.js');

/** @type {Awaited<ReturnType<typeof convertedUser>>} */
let user;
before(async () => {
    user = await convertedUser('st-page-writes-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});
after(async () => {
    await user.close();
});

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
    await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
}

/**
 * A request as the chat routes read it.
 * @param {string} [session] The tab's session.
 */
function fakeRequest(session) {
    return { user: user.user, get: (/** @type {string} */ name) => (name === SESSION_HEADER ? session : undefined) };
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

/**
 * The messages from the first one down to `nodeId`, and the state there.
 * @param {{ avatar?: string, group?: string }} owner
 * @param {string} nodeId
 */
async function pathTo(owner, nodeId) {
    return user.store.chats.load({ tree: await treeOf(user.store, owner), at: nodeId });
}

test('a character chat with no stored greeting: the greeting, a message an extension added and metadata keys are stored first', async () => {
    const avatar = `pw-solo-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const session = newSessionKey();
    const chat = await chatContext(fakeRequest(session), { avatar });
    const response = fakeResponse();
    const body = {
        node_id: null,
        opening: { refs: ['r-open'], messages: [{ name: 'Rex', is_user: false, mes: 'Hi.', extra: {} }] },
        page_messages: { refs: ['r-ext'], messages: [{ name: 'Narrator', is_user: false, is_system: true, mes: 'The wind rises.', extra: { type: 'narrator' } }] },
        page_metadata: { ref: 'r-meta', set: { note_prompt: 'Be brief.' }, unset: [], variables: { set: { mood: 'calm' } } },
    };

    const written = await applyPageWrites(response, chat, body);

    assert.ok(written && typeof written.nodeId === 'string');
    const loaded = await pathTo({ avatar }, written.nodeId);
    assert.deepEqual(loaded.messages.map(m => m.mes), ['Hi.', 'The wind rises.']);
    const stored = response.locals.storedMessages;
    assert.deepEqual(stored.map(s => s.ref), ['r-open', 'r-ext', 'r-meta']);
    assert.equal(stored[0].node_id, loaded.messages[0].node_id);
    assert.equal(stored[1].node_id, written.nodeId);
    assert.equal(stored[2].integrity, session, 'the metadata answers the session it was written through');
    assert.equal(stored[2].node_id, written.nodeId, 'the metadata goes on the message the generation goes on from');
    assert.equal(loaded.metadata.note_prompt, 'Be brief.');
    assert.deepEqual(loaded.metadata.variables, { mood: 'calm' });
    assert.deepEqual(await user.store.chats.pointer(session), { tree: await treeOf(user.store, { avatar }), at: written.nodeId }, 'the session moved to what was stored');

    // Sent again (a retry), nothing is stored twice.
    const again = fakeResponse();
    const rewritten = await applyPageWrites(again, await chatContext(fakeRequest(session), { avatar }), body);
    assert.equal(rewritten.nodeId, written.nodeId);
    assert.equal((await pathTo({ avatar }, rewritten.nodeId)).messages.length, 2);
});

test('metadata keys are set and removed one by one, leaving the others', async () => {
    const avatar = `pw-meta-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const [leaf] = await seedMessages(user.store, { avatar }, null, [{ name: 'Rex', is_user: false, mes: 'Hello.', send_date: 1, extra: {} }]);
    const first = await chatContext(fakeRequest(newSessionKey()), { avatar });
    await applyPageWrites(fakeResponse(), first, { node_id: leaf, page_metadata: { ref: 'm0', set: { keep: 1, drop: 2, change: 'old' } } });
    await applyPageWrites(fakeResponse(), first, { node_id: leaf, page_metadata: { ref: 'm', set: { change: 'new' }, unset: ['drop'] } });
    const { metadata } = await pathTo({ avatar }, leaf);
    assert.equal(metadata.keep, 1);
    assert.equal(metadata.change, 'new');
    assert.equal('drop' in metadata, false);
});

test('a group chat with no stored greetings: its members\' greetings are stored in a row', async () => {
    const group = '1700000000001';
    const tree = await treeOf(user.store, { group });
    const session = newSessionKey();
    const chat = await chatContext(fakeRequest(session), { group });
    assert.equal(chat.tree, tree);
    const response = fakeResponse();
    const written = await applyPageWrites(response, chat, {
        node_id: null,
        opening: { refs: ['g1', 'g2'], messages: [{ name: 'Alice', is_user: false, mes: 'Ahoy.' }, { name: 'Bob', is_user: false, mes: 'Welcome.' }] },
        page_metadata: { ref: 'gm', set: {}, unset: [] },
    });
    assert.deepEqual((await pathTo({ group }, written.nodeId)).messages.map(m => m.mes), ['Ahoy.', 'Welcome.']);
    assert.deepEqual(response.locals.storedMessages.map(s => s.ref), ['g1', 'g2', 'gm']);
    assert.equal(response.locals.storedMessages[2].integrity, session);
});

test('messages with no stored message to follow are refused, and nothing is generated', async () => {
    const avatar = `pw-none-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const response = fakeResponse();
    const written = await applyPageWrites(response, await chatContext(fakeRequest(newSessionKey()), { avatar }), {
        node_id: null, page_messages: { refs: ['x'], messages: [{ mes: 'Lost?' }] },
    });
    assert.equal(written, null);
    assert.equal(response.statusCode, 409);
    assert.equal(response.sent.page_changes_not_saved, true);
});

test('a message\'s token count is not stored', async () => {
    const avatar = `pw-count-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const response = fakeResponse();
    const written = await applyPageWrites(response, await chatContext(fakeRequest(newSessionKey()), { avatar }), {
        node_id: null, opening: { refs: ['o'], messages: [{ name: 'Rex', is_user: false, mes: 'Counted.', send_date: 1, extra: { token_count: 3, keep: true } }] },
    });
    const [message] = (await pathTo({ avatar }, written.nodeId)).messages;
    assert.equal(message.extra.keep, true);
    assert.equal('token_count' in message.extra, false);
});

/**
 * A text-completion backend answering `reply`, and the router mounted for the converted user.
 * @param {string} reply
 */
async function generateServer(reply) {
    const seen = { prompt: '' };
    const backend = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if ((req.url ?? '').includes('/models')) return res.end(JSON.stringify({ data: [] }));
            seen.prompt = String(JSON.parse(raw || '{}').prompt ?? '');
            res.end(JSON.stringify({ choices: [{ text: reply }] }));
        });
    });
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    writeAllSettings(user.directories, {
        username: 'Tester', amount_gen: 100, max_context: 4096,
        power_user: { instruct: { enabled: false }, context: {}, reasoning: {}, sysprompt: {} },
        world_info: { globalSelect: [], charLore: [] }, world_info_settings: {},
        textgenerationwebui_settings: { type: 'generic', generic_model: 'm', server_urls: { generic: `http://127.0.0.1:${backend.address().port}` } },
        extension_settings: { note: {}, cfg: {} },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user.user; next(); });
    app.use('/', textRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    return {
        seen,
        /**
         * @param {object} body
         * @param {Record<string, string>} [headers]
         */
        post: (body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/generate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
        }),
        close: () => {
            server.close();
            backend.close();
        },
    };
}

test('the user message is stored as the page sent it, and the prompt has what the page added', async () => {
    const avatar = `pw-route-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const generate = await generateServer('At dawn.');
    const sent = { name: 'Tester', is_user: true, is_system: false, send_date: '2026-10-10T00:00:00.000Z', mes: 'When do we leave, Rex?', persona: 'tester.png', force_avatar: '/thumbnail?type=persona&file=tester.png', extra: { isSmallSys: false, bias: 'Calmly' } };
    const answer = await generate.post({
        owner_id: avatar, character_avatar: avatar, type: 'normal', stream: false,
        node_id: null,
        opening: { refs: ['o'], messages: [{ name: 'Rex', is_user: false, mes: 'Hi.', extra: {} }] },
        page_messages: { refs: ['e'], messages: [{ name: 'Narrator', is_user: false, is_system: false, mes: 'Thunder rolls.', extra: {} }] },
        user_message: sent, user_message_ref: 'u',
    }, { [SESSION_HEADER]: 'none' });
    const data = await answer.json();
    generate.close();

    assert.equal(answer.status, 200);
    assert.ok(generate.seen.prompt.includes('Thunder rolls.'), 'the message the page added is in the prompt');
    assert.deepEqual(data.stored.map(s => s.ref), ['o', 'e', 'u']);
    const made = answer.headers.get('X-ST-Session-Moved');
    assert.ok(made, 'a tab with no session is handed the one its writes were made through');
    const userNode = data.stored.find(s => s.ref === 'u').node_id;
    const reloaded = (await pathTo({ avatar }, data.assistant_node_id)).messages;
    assert.deepEqual(reloaded.map(m => m.mes), ['Hi.', 'Thunder rolls.', sent.mes, 'At dawn.']);
    const storedUser = reloaded.find(m => m.node_id === userNode);
    for (const key of ['name', 'mes', 'persona', 'force_avatar', 'send_date']) {
        assert.equal(storedUser[key], sent[key], `the stored user message keeps ${key} as sent`);
    }
    assert.equal(storedUser.extra.bias, 'Calmly');
    assert.equal((await user.store.chats.pointer(made)).at, data.assistant_node_id, 'the session is at the reply');
});

test('a quiet generation\'s prompt reaches the backend, and its answer isn\'t stored', async () => {
    const avatar = `pw-quiet-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const generate = await generateServer('A quiet answer.');
    const answer = await generate.post({
        owner_id: avatar, character_avatar: avatar, type: 'quiet', stream: false,
        node_id: null,
        opening: { refs: ['o'], messages: [{ name: 'Rex', is_user: false, mes: 'Hi.', extra: {} }] },
        quiet_prompt: 'Describe the weather in one word.',
    }, { [SESSION_HEADER]: 'none' });
    const data = await answer.json();
    generate.close();

    assert.equal(answer.status, 200);
    assert.ok(generate.seen.prompt.endsWith('Hi.\nDescribe the weather in one word.'), 'the quiet prompt ends the prompt sent to the backend');
    assert.equal(data.assistant_node_id ?? null, null, 'a quiet answer is not stored');
});

test('a first send in a new chat with no greeting starts the chat with the user message', async () => {
    const avatar = `pw-empty-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const generate = await generateServer('Hello.');
    const answer = await generate.post({
        owner_id: avatar, character_avatar: avatar, type: 'normal', stream: false, node_id: null,
        user_message: { name: 'Tester', is_user: true, mes: 'Anyone here?', extra: {} }, user_message_ref: 'u',
    }, { [SESSION_HEADER]: newSessionKey() });
    const data = await answer.json();
    generate.close();
    assert.equal(answer.status, 200);
    assert.deepEqual((await pathTo({ avatar }, data.assistant_node_id)).messages.map(m => m.mes), ['Anyone here?', 'Hello.']);
});

test('no node_id is refused once the chat has messages and the session isn\'t at its start, and taken at the start of a new chat', async () => {
    const avatar = `pw-root-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const elsewhere = newSessionKey();
    await seedMessages(user.store, { avatar }, null, [{ name: 'Rex', is_user: false, mes: 'Earlier.', extra: {} }], { session: elsewhere });
    const generate = await generateServer('Again.');
    const body = { owner_id: avatar, character_avatar: avatar, type: 'normal', stream: false, node_id: null, user_message: { name: 'Tester', is_user: true, mes: 'Hi?', extra: {} } };

    const behind = await generate.post(body, { [SESSION_HEADER]: elsewhere });
    assert.equal(behind.status, 400);
    assert.match((await behind.json()).message, /node_id is required/);

    // A session at the tree's root (a new chat) may send without one.
    const fresh = newSessionKey();
    await user.store.chats.goTo({ tree: await treeOf(user.store, { avatar }), node_id: null, actor: { user: 'u', session: fresh } });
    const atStart = await generate.post(body, { [SESSION_HEADER]: fresh });
    generate.close();
    assert.equal(atStart.status, 200);
    const data = await atStart.json();
    assert.deepEqual((await pathTo({ avatar }, data.assistant_node_id)).messages.map(m => m.mes), ['Hi?', 'Again.']);
});
