import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
import '../../fetch-patch.js';
import { setConfigFilePath } from '../../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

// The server stores every reply that lands in the chat, once. When storing fails, the page is told so
// (a `reply-not-saved` warning naming the generation) instead of being left to write the reply itself,
// and `POST /api/generation/store/:id` stores it from the text the server kept.

const { router: textRouter } = await import('./text-completions.js');
const { router: chatRouter } = await import('./chat-completions.js');
const { router: generationRouter } = await import('../generation.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { CompactStreamDecoder } = await import('../../../public/scripts/llamacpp-compact-stream.js');
const { newSessionKey } = await import('../../chat-engine.js');
const { SESSION_HEADER } = await import('../../request-session.js');
const { convertedUser, writeLibraryCard, seedMessages, sessionPath, repliesOf } = await import('../../../tests/converted-user.fixture.js');

const user = await convertedUser('st-reply-not-saved-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

// `reply`: fail the next reply store (an append of a non-user message); the user's own message still stores.
// `user`: fail the next store of the user's message.
const failures = { reply: 0, user: 0 };
const append = user.store.chats.appendMessages.bind(user.store.chats);
user.store.chats.appendMessages = async (/** @type {any} */ p) => {
    const contents = Array.isArray(p?.contents) ? p.contents : [];
    if (failures.reply > 0 && contents.some(m => m?.is_user === false)) {
        failures.reply--;
        return { ok: false, reason: 'disk is full' };
    }
    if (failures.user > 0 && contents.some(m => m?.is_user === true)) {
        failures.user--;
        return { ok: false, reason: 'disk is full', node_ids: [] };
    }
    return append(p);
};

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'img', 'ai4.png'));

async function writeCharacter(avatar, name) {
    const card = {
        spec: 'chara_card_v2', spec_version: '2.0', name, description: '', personality: '', scenario: '',
        first_mes: '', mes_example: '', avatar,
        data: {
            name, description: '', personality: '', scenario: '', first_mes: 'Hi.', mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            alternate_greetings: [], extensions: {},
        },
    };
    const cardJson = JSON.stringify(card);
    await writeLibraryCard(user, avatar, cardJson, writeCard(baseImage, cardJson));
}

function textSettings(type, url) {
    return {
        username: 'Tester', amount_gen: 100, max_context: 4096,
        power_user: { instruct: { enabled: false }, context: {}, reasoning: {}, sysprompt: {} },
        world_info: { globalSelect: [], charLore: [] }, world_info_settings: {},
        textgenerationwebui_settings: { type, generic_model: 'test-model-7b', temp: 0.9, server_urls: { [type]: url } },
        extension_settings: { note: {}, cfg: {} },
    };
}

function chatSettings(url) {
    return {
        username: 'Tester',
        power_user: { console_log_prompts: false, pin_examples: false, request_token_probabilities: false },
        world_info: { globalSelect: [], charLore: [] },
        oai_settings: {
            chat_completion_source: 'custom', custom_model: 'test-model', custom_url: url,
            openai_max_context: 4096, openai_max_tokens: 300, temp_openai: 1, freq_pen_openai: 0, pres_pen_openai: 0, top_p_openai: 1,
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'You are {{char}}.', system_prompt: true },
                { identifier: 'chatHistory', name: 'Chat History', role: 'system', content: '', system_prompt: true },
            ],
            prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
        },
    };
}

/** A fake backend answering every generation with `reply`, streamed in three pieces or as one JSON body. */
async function startBackend({ reply, format, json }) {
    const hits = { generations: 0 };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const route = (req.url ?? '').split('?')[0];
            const send = (value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            if (route === '/props') return send({ model_path: '/models/t.gguf', build_info: 'b-t', default_generation_settings: { n_ctx: 8192 } });
            if (route === '/tokenize') return send({ tokens: String(JSON.parse(body || '{}').content ?? '').split(/(?=\s)/).filter(Boolean).map((_, i) => i) });
            if (route.endsWith('/models')) return send({ data: [] });
            const parsed = JSON.parse(body || '{}');
            hits.generations++;
            if (!parsed.stream) return send(json(reply));
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const pieces = [reply.slice(0, 4), reply.slice(4, 9), reply.slice(9)];
            for (const piece of pieces) res.write(format(piece, false));
            res.end(format('', true));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, hits, url: `http://127.0.0.1:${server.address().port}` };
}

const genericFormat = (text, last) => last ? 'data: [DONE]\n\n' : `data: ${JSON.stringify({ choices: [{ text }] })}\n\n`;
const llamaFormat = (content, stop) => `data: ${JSON.stringify({ content, stop })}\n\n`;
const chatFormat = (content, last) => last ? 'data: [DONE]\n\n' : `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const textJson = text => ({ choices: [{ text }] });
const chatJson = text => ({ choices: [{ message: { role: 'assistant', content: text } }] });

async function startApp(router) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: req.get('X-Test-User') ?? 'u' } };
        next();
    });
    app.use('/api/generation', generationRouter);
    app.use('/', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function closeApp(server) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
}

let branches = 0;

/**
 * A new conversation of `avatar`'s, its greeting stored through a session of its own.
 * @param {string} avatar
 */
async function newBranch(avatar) {
    const session = newSessionKey();
    // A greeting of its own: one with the same text would be the stored one, and so would the messages after it.
    const [greeting] = await seedMessages(user.store, { avatar }, null, [{ name: 'Rex', is_user: false, mes: `Hello there. (${++branches})`, send_date: 1, extra: {} }], { session });
    return { session, leaf: greeting, messages: await sessionPath(user.store, { avatar }, session) };
}

/**
 * One generation per case: once stored normally (exactly one reply, its node id given to the page), and
 * once with the store failing (no reply stored, the page told `reply-not-saved` with the generation id,
 * then the retry stores it exactly once).
 */
async function storeCase({ label, router, settings, format, json, stream, avatar }) {
    const reply = 'The ship sails at dawn.';
    const backend = await startBackend({ reply, format, json });
    writeAllSettings(directories, settings(backend.url));
    const { server, base } = await startApp(router);

    async function post(branch, { id = randomUUID(), ref = randomUUID(), nodeId = branch.leaf } = {}) {
        return fetch(`${base}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Generation-Id': id, [SESSION_HEADER]: branch.session },
            body: JSON.stringify({ owner_id: avatar, character_avatar: avatar, node_id: nodeId, type: 'normal', user_message: { is_user: true, name: 'User', mes: 'When do we leave?' }, user_message_ref: ref, stream }),
        });
    }

    const shown = (/** @type {{ session: string }} */ branch) => sessionPath(user.store, { avatar }, branch.session);

    /** @param {{ failReply?: boolean }} [o] `failReply`: the reply's store fails (the branch is made first). */
    async function generate({ failReply = false } = {}) {
        const branch = await newBranch(avatar);
        if (failReply) failures.reply = 1;
        const id = randomUUID();
        const res = await post(branch, { id });
        assert.equal(res.status, 200, `${label}: generation answered`);
        let text = '';
        let nodeId = null;
        const warnings = [];
        if (stream) {
            const decoder = new CompactStreamDecoder();
            const take = (events) => {
                for (const event of events) {
                    if ('content' in event) text += event.content;
                    else if ('assistantNodeId' in event) nodeId = event.assistantNodeId;
                    else if ('control' in event && Array.isArray(event.control?.warnings)) warnings.push(...event.control.warnings);
                }
            };
            const reader = res.body.getReader();
            for (; ;) {
                const { value, done } = await reader.read();
                if (done) break;
                take(decoder.push(value));
            }
            take(decoder.flush());
        } else {
            const data = await res.json();
            text = String(data?.choices?.[0]?.text ?? data?.choices?.[0]?.message?.content ?? '');
            nodeId = data.assistant_node_id ?? null;
            warnings.push(...(data.warnings ?? []));
        }
        return { branch, id, text, nodeId, warnings };
    }

    /** The stored reply carries when it was generated, as ISO strings, started no later than it finished. */
    function assertGenerationTimes(message, before, after) {
        assert.equal(typeof message.gen_started, 'string', `${label}: the reply's gen_started is stored`);
        assert.equal(typeof message.gen_finished, 'string', `${label}: the reply's gen_finished is stored`);
        const started = Date.parse(message.gen_started);
        const finished = Date.parse(message.gen_finished);
        assert.ok(started >= before && started <= finished && finished <= after, `${label}: ${message.gen_started} .. ${message.gen_finished} lies within the request (${new Date(before).toISOString()} .. ${new Date(after).toISOString()})`);
    }

    try {
        // Stored normally: exactly one reply, and the page is told where.
        {
            const before = Date.now();
            const result = await generate();
            const afterTime = Date.now();
            const after = await shown(result.branch);
            assert.equal(after.length, result.branch.messages.length + 2, `${label}: one user message and one reply`);
            const last = after[after.length - 1];
            assert.equal(last.mes, reply, `${label}: the stored reply is the generated text`);
            assert.equal(result.nodeId, last.node_id, `${label}: the page is told the stored reply's node`);
            assert.ok(!result.warnings.some(w => w.kind === 'reply-not-saved'), `${label}: no not-saved warning when it was stored`);
            assertGenerationTimes(last, before, afterTime);
        }

        // The store fails: nothing is stored, the page is told, and the retry stores it once.
        {
            const before = Date.now();
            const result = await generate({ failReply: true });
            const generatedBy = Date.now();
            failures.reply = 0;
            const after = await shown(result.branch);
            const notSaved = result.warnings.find(w => w.kind === 'reply-not-saved');
            assert.ok(notSaved, `${label}: the page is told the reply wasn't saved`);
            assert.equal(notSaved.generation_id, result.id, `${label}: the warning names the generation`);
            assert.match(notSaved.message, /disk is full/, `${label}: the warning says why`);
            assert.equal(result.nodeId, null, `${label}: no node id is given for a reply that wasn't stored`);
            assert.equal(result.text, reply, `${label}: the page still got the reply's text`);
            assert.equal(after.length, result.branch.messages.length + 1, `${label}: only the user message is stored`);

            const wrongUser = await fetch(`${base}/api/generation/store/${result.id}`, { method: 'POST', headers: { 'X-Test-User': 'mallory' } });
            assert.equal(wrongUser.status, 404, `${label}: another user can't store it`);

            const retry = await fetch(`${base}/api/generation/store/${result.id}`, { method: 'POST' });
            assert.equal(retry.status, 200);
            const stored = await retry.json();
            assert.equal(stored.state, 'saved', `${label}: the retry stored it`);
            const again = await (await fetch(`${base}/api/generation/store/${result.id}`, { method: 'POST' })).json();
            assert.equal(again.node_id, stored.node_id, `${label}: a second retry answers the same node, nothing new`);

            const final = await shown(result.branch);
            assert.equal(final.length, result.branch.messages.length + 2, `${label}: the reply is stored exactly once`);
            const last = final[final.length - 1];
            assert.equal(last.mes, reply);
            assert.equal(last.node_id, stored.node_id);
            // A retry keeps the times of the generation, not of the retry.
            assertGenerationTimes(last, before, generatedBy);
        }

        // The user's message can't be stored: the request says so and generates nothing.
        {
            const branch = await newBranch(avatar);
            const generationsBefore = backend.hits.generations;
            failures.user = 1;
            const res = await post(branch);
            failures.user = 0;
            assert.equal(res.status, 500, `${label}: the request fails`);
            const body = await res.json();
            assert.equal(body.user_message_not_saved, true, `${label}: the answer says the message wasn't saved`);
            assert.match(body.error.message, /couldn't be saved \(disk is full\)/, `${label}: and why`);
            assert.equal(body.stored, undefined, `${label}: nothing is reported stored`);
            assert.equal(backend.hits.generations, generationsBefore, `${label}: nothing was generated`);
            const after = await shown(branch);
            assert.equal(after.length, branch.messages.length, `${label}: nothing was stored`);
        }

        // A send repeated with its key is stored once, even when the repeat names another place: it lands
        // on the stored message.
        {
            const branch = await newBranch(avatar);
            const ref = randomUUID();
            const first = await post(branch, { ref });
            await first.arrayBuffer();
            const afterFirst = await shown(branch);
            const userNode = afterFirst[branch.messages.length].node_id;
            const replyNode = afterFirst[afterFirst.length - 1].node_id;
            const second = await post(branch, { ref, nodeId: replyNode });
            await second.arrayBuffer();
            assert.deepEqual((await repliesOf(user.store, { avatar }, branch.leaf)).map(r => r.node_id), [userNode], `${label}: the stored message stays where it was`);
            assert.equal((await repliesOf(user.store, { avatar }, replyNode)).filter(r => r.mes === 'When do we leave?').length, 0, `${label}: the repeat stored nothing new`);
        }
    } finally {
        backend.server.close();
        await closeApp(server);
    }
}

async function run() {
    const avatar = 'Rex.png';
    await writeCharacter(avatar, 'Rex');

    await storeCase({ label: 'text-generic-stream', router: textRouter, settings: url => textSettings('generic', url), format: genericFormat, json: textJson, stream: true, avatar });
    await storeCase({ label: 'text-generic-json', router: textRouter, settings: url => textSettings('generic', url), format: genericFormat, json: textJson, stream: false, avatar });
    await storeCase({ label: 'text-llamacpp-stream', router: textRouter, settings: url => textSettings('llamacpp', url), format: llamaFormat, json: textJson, stream: true, avatar });
    await storeCase({ label: 'chat-custom-stream', router: chatRouter, settings: url => chatSettings(url), format: chatFormat, json: chatJson, stream: true, avatar });
    await storeCase({ label: 'chat-custom-json', router: chatRouter, settings: url => chatSettings(url), format: chatFormat, json: chatJson, stream: false, avatar });

    console.log('reply-not-saved.test.js: all assertions passed');
}

try {
    await run();
} finally {
    await user.close();
}
