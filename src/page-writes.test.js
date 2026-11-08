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

const { applyPageWrites } = await import('./page-writes.js');
const { chatContext } = await import('./chat-request.js');
const { newSessionKey } = await import('./chat-engine.js');
const { SESSION_HEADER } = await import('./request-session.js');
const { router: generationRouter } = await import('./endpoints/generation.js');
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
 * @param {string} [session]
 */
function fakeRequest(session) {
    return { user: user.user, get: (/** @type {string} */ name) => (name === SESSION_HEADER ? session : undefined) };
}

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

test('a group\'s greetings no one has answered wait for what goes under them, and are stored with it in one write', async () => {
    const group = '1700000000001';
    const session = newSessionKey();
    const chat = await chatContext(fakeRequest(session), { group });
    const response = fakeResponse();
    const commits = [];
    const listen = (/** @type {any[]} */ records) => commits.push(records.filter(r => r.kind === 'messageAppend').length);
    user.store.events.on('commit', listen);
    try {
        const written = await applyPageWrites(response, chat, {
            node_id: null,
            opening: { refs: ['w1', 'w2'], messages: [{ name: 'Alice', is_user: false, mes: 'Ahoy again.' }, { name: 'Bob', is_user: false, mes: 'Welcome again.' }] },
            page_metadata: { ref: 'wm', set: {}, unset: [] },
        }, { waitForReply: true });
        assert.equal(written.nodeId, null);
        assert.equal(commits.filter(n => n > 0).length, 0, 'nothing is stored before what goes under them');
        const { storeUserMessage } = await import('./stored-messages.js');
        const userNode = await storeUserMessage(response, { chat, anchorNodeId: null, message: { name: 'Tester', is_user: true, mes: 'Hello all.', extra: {} }, ref: 'wu' });
        assert.deepEqual(commits.filter(n => n > 0), [3], 'both greetings and the user message in one write');
        assert.deepEqual((await pathTo({ group }, userNode)).messages.map(m => m.mes), ['Ahoy again.', 'Welcome again.', 'Hello all.']);
        assert.deepEqual(response.locals.storedMessages.map(s => s.ref), ['w1', 'w2', 'wm', 'wu']);
        assert.equal(response.locals.storedMessages[2].integrity, session);
    } finally {
        user.store.events.off('commit', listen);
    }
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
 * A backend answering `reply`, and the app's generation route sending to it; both close when the test ends.
 * @param {import('node:test').TestContext} t
 * @param {string} reply
 */
async function generateServer(t, reply) {
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
    t.after(() => new Promise(resolve => backend.close(() => resolve(undefined))));
    writeAllSettings(user.directories, {
        main_api: 'textgenerationwebui', username: 'Tester', amount_gen: 100, max_context: 4096,
        power_user: { instruct: { enabled: false }, context: {}, reasoning: {}, sysprompt: {} },
        world_info: { globalSelect: [], charLore: [] }, world_info_settings: {},
        textgenerationwebui_settings: { type: 'generic', generic_model: 'm', server_urls: { generic: `http://127.0.0.1:${backend.address().port}` } },
        extension_settings: { note: {}, cfg: {} },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user.user; next(); });
    app.use('/api/generation', generationRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(() => resolve(undefined)));
    });
    return {
        seen,
        /**
         * @param {object} body
         * @param {Record<string, string>} [headers]
         */
        post: (body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/generation/generate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ST-Session': 'none', ...headers }, body: JSON.stringify(body),
        }),
        /**
         * @param {object} body
         */
        raw: (body) => fetch(`http://127.0.0.1:${server.address().port}/api/generation/raw`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }),
    };
}

test('a stored reply comes with its counts, as the message counter and auto-continue take them', async (t) => {
    const avatar = `pw-counts-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const generate = await generateServer(t, 'At dawn we ride.');
    const answer = await generate.post({
        owner_id: avatar, character_avatar: avatar, type: 'normal', stream: false, node_id: null,
        opening: { refs: ['o'], messages: [{ name: 'Rex', is_user: false, mes: 'Hi.', extra: {} }] },
        user_message: { name: 'Tester', is_user: true, mes: 'When?', extra: {} }, user_message_ref: 'u',
    });
    const reply = await answer.json();

    assert.equal(answer.status, 200, JSON.stringify(reply));
    const { extra, counted_with: countedWith } = reply.assistant_message;
    assert.ok(Number.isInteger(extra.token_count) && extra.token_count > 0, JSON.stringify(extra));
    assert.ok(Number.isInteger(extra.text_token_count) && extra.text_token_count > 0, JSON.stringify(extra));
    assert.equal(typeof countedWith?.key, 'string', 'the answer names the tokenizer the counts are in');
    const stored = (await pathTo({ avatar }, reply.assistant_node_id)).messages.at(-1);
    assert.equal(stored.extra.token_count, undefined, 'the counts aren\'t stored with the message');
});

test('a reply to given text needs no chat, no character and no session', async (t) => {
    const generate = await generateServer(t, 'Hello back.');
    const answer = await generate.raw({ prompt: 'Say hello.', response_length: 12 });
    const reply = await answer.json();

    assert.equal(answer.status, 200, JSON.stringify(reply));
    assert.equal(reply.choices?.[0]?.text, 'Hello back.');
    assert.ok(generate.seen.prompt.includes('Say hello.'), generate.seen.prompt);
    assert.equal(reply.stored, undefined, 'nothing is stored');
});

test('the user message is stored as the page sent it, and the prompt has what the page added', async (t) => {
    const avatar = `pw-route-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const generate = await generateServer(t, 'At dawn.');
    const sent = { name: 'Tester', is_user: true, is_system: false, send_date: '2026-10-10T00:00:00.000Z', mes: 'When do we leave, Rex?', persona: 'tester.png', force_avatar: '/thumbnail?type=persona&file=tester.png', extra: { isSmallSys: false, bias: 'Calmly' } };
    const answer = await generate.post({
        owner_id: avatar, character_avatar: avatar, type: 'normal', stream: false,
        node_id: null,
        opening: { refs: ['o'], messages: [{ name: 'Rex', is_user: false, mes: 'Hi.', extra: {} }] },
        page_messages: { refs: ['e'], messages: [{ name: 'Narrator', is_user: false, is_system: false, mes: 'Thunder rolls.', extra: {} }] },
        user_message: sent, user_message_ref: 'u',
    }, { [SESSION_HEADER]: 'none' });
    const data = await answer.json();

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

test('a quiet generation\'s prompt reaches the backend, and its answer isn\'t stored', async (t) => {
    const avatar = `pw-quiet-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const generate = await generateServer(t, 'A quiet answer.');
    const answer = await generate.post({
        owner_id: avatar, character_avatar: avatar, type: 'quiet', stream: false,
        node_id: null,
        opening: { refs: ['o'], messages: [{ name: 'Rex', is_user: false, mes: 'Hi.', extra: {} }] },
        quiet_prompt: 'Describe the weather in one word.',
    }, { [SESSION_HEADER]: 'none' });
    const data = await answer.json();

    assert.equal(answer.status, 200);
    assert.ok(generate.seen.prompt.endsWith('Hi.\nDescribe the weather in one word.'), 'the quiet prompt ends the prompt sent to the backend');
    assert.equal(data.assistant_node_id ?? null, null, 'a quiet answer is not stored');
});

test('a first send in a new chat with no greeting starts the chat with the user message', async (t) => {
    const avatar = `pw-empty-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const generate = await generateServer(t, 'Hello.');
    const answer = await generate.post({
        owner_id: avatar, character_avatar: avatar, type: 'normal', stream: false, node_id: null,
        user_message: { name: 'Tester', is_user: true, mes: 'Anyone here?', extra: {} }, user_message_ref: 'u',
    }, { [SESSION_HEADER]: newSessionKey() });
    const data = await answer.json();
    assert.equal(answer.status, 200);
    assert.deepEqual((await pathTo({ avatar }, data.assistant_node_id)).messages.map(m => m.mes), ['Anyone here?', 'Hello.']);
});

test('no node_id is refused once the chat has messages and the session isn\'t at its start, and taken at the start of a new chat', async (t) => {
    const avatar = `pw-root-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const elsewhere = newSessionKey();
    await seedMessages(user.store, { avatar }, null, [{ name: 'Rex', is_user: false, mes: 'Earlier.', extra: {} }], { session: elsewhere });
    const generate = await generateServer(t, 'Again.');
    const body = { owner_id: avatar, character_avatar: avatar, type: 'normal', stream: false, node_id: null, user_message: { name: 'Tester', is_user: true, mes: 'Hi?', extra: {} } };

    const behind = await generate.post(body, { [SESSION_HEADER]: elsewhere });
    assert.equal(behind.status, 400);
    assert.match((await behind.json()).message, /node_id is required/);

    const fresh = newSessionKey();
    await user.store.chats.goTo({ tree: await treeOf(user.store, { avatar }), node_id: null, actor: { user: 'u', session: fresh } });
    const atStart = await generate.post(body, { [SESSION_HEADER]: fresh });
    assert.equal(atStart.status, 200);
    const data = await atStart.json();
    assert.deepEqual((await pathTo({ avatar }, data.assistant_node_id)).messages.map(m => m.mes), ['Hi?', 'Again.']);
});

/**
 * @returns {{ appends: () => number[], stop: () => void }} how many messages each write appended
 */
function watchAppends() {
    /** @type {object[][]} */
    const commits = [];
    const listen = (/** @type {object[]} */ records) => commits.push(records.filter(r => /** @type {any} */ (r).kind === 'messageAppend'));
    user.store.events.on('commit', listen);
    return { appends: () => commits.filter(c => c.length > 0).map(c => c.length), stop: () => user.store.events.off('commit', listen) };
}

test('under a greeting no one has answered, a send stores the greeting with the user message, and the answer carries the tree\'s openings', async (t) => {
    const avatar = `pw-one-write-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const generate = await generateServer(t, 'At dawn.');
    const watch = watchAppends();
    const answer = await generate.post({
        owner_id: avatar, character_avatar: avatar, type: 'normal', stream: false, node_id: null,
        opening: { refs: ['o'], messages: [{ name: 'Rex', is_user: false, mes: 'Hi.', extra: {} }] },
        user_message: { name: 'Tester', is_user: true, mes: 'When?', extra: {} }, user_message_ref: 'u',
    }, { [SESSION_HEADER]: newSessionKey() });
    watch.stop();
    const reply = await answer.json();
    assert.equal(answer.status, 200, JSON.stringify(reply));
    assert.deepEqual(watch.appends(), [2, 1], 'the greeting and the user message in one write, the reply in the next');
    const openings = reply.stored.find(s => s.ref === 'openings');
    assert.equal(openings.avatar, avatar);
    assert.equal(openings.openings.openings.stored, 1);
    assert.equal(openings.openings.openings.alternatives[0].node_id, reply.stored.find(s => s.ref === 'o').node_id);
});

test('under a greeting no one has answered, a reply with nothing sent is stored with the greeting; a quiet one stores nothing unless it sets a chat variable', async (t) => {
    const avatar = `pw-reply-write-${randomUUID()}.png`;
    await writeCharacter(avatar, 'Rex');
    const generate = await generateServer(t, 'I speak first.');
    const opening = { refs: ['o'], messages: [{ name: 'Rex', is_user: false, mes: 'Hi.', extra: {} }] };

    const quiet = await generate.post({
        owner_id: avatar, character_avatar: avatar, type: 'quiet', stream: false, node_id: null, opening, quiet_prompt: 'One word.',
    }, { [SESSION_HEADER]: newSessionKey() });
    assert.equal(quiet.status, 200);
    const tree = await treeOf(user.store, { avatar });
    assert.equal((await user.store.chats.openings(tree)).length, 0, 'a quiet generation stores no opening');


    const watch = watchAppends();
    const answer = await generate.post({
        owner_id: avatar, character_avatar: avatar, type: 'normal', stream: false, node_id: null, opening,
    }, { [SESSION_HEADER]: newSessionKey() });
    watch.stop();
    const reply = await answer.json();
    assert.equal(answer.status, 200, JSON.stringify(reply));
    assert.deepEqual(watch.appends(), [2], 'the greeting and the reply in one write');
    assert.deepEqual((await pathTo({ avatar }, reply.assistant_node_id)).messages.map(m => m.mes), ['Hi.', 'I speak first.']);
    assert.ok(reply.stored.some(s => s.ref === 'openings'));

    const other = `pw-quiet-vars-${randomUUID()}.png`;
    await writeCharacter(other, 'Rex');
    const marked = await generate.post({
        owner_id: other, character_avatar: other, type: 'quiet', stream: false, node_id: null, opening, quiet_prompt: '{{setvar::mood::calm}}One word.',
    }, { [SESSION_HEADER]: newSessionKey() });
    const markedReply = await marked.json();
    assert.equal(marked.status, 200, JSON.stringify(markedReply));
    const otherTree = await treeOf(user.store, { avatar: other });
    const kept = await user.store.chats.openings(otherTree);
    assert.deepEqual(kept.map(o => o.message.mes), ['Hi.'], 'a quiet generation that sets a chat variable stores the greeting with it');
    const read = await user.store.chats.stateAt({ tree: otherTree, at: user.store.chats.externalId(kept[0].stored), session: null });
    assert.equal(/** @type {any} */ (read).state.variables.mood, 'calm');
    assert.ok(markedReply.stored.some(s => s.ref === 'o'));
});
