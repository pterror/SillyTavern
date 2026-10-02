import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
import '../../fetch-patch.js';
import { setConfigFilePath } from '../../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

// The server stores every reply that lands in the chat, once. When storing fails, the page is told so
// (a `reply-not-saved` warning naming the generation) instead of being left to write the reply itself,
// and `POST /api/generation/store/:id` stores it from the text the server kept.

const realTree = await import('../../message-tree-db.js');
// Set to fail the next reply store (an append of a non-user message); the user's own message still stores.
const failures = { reply: 0 };
mock.module('../../message-tree-db.js', {
    namedExports: {
        ...realTree,
        appendMessages: async (directories, ownerId, anchorNodeId, messages, ...rest) => {
            if (failures.reply > 0 && Array.isArray(messages) && messages.some(m => m?.is_user === false)) {
                failures.reply--;
                return { ok: false, reason: 'disk is full' };
            }
            return realTree.appendMessages(directories, ownerId, anchorNodeId, messages, ...rest);
        },
    },
});

const { router: textRouter } = await import('./text-completions.js');
const { router: chatRouter } = await import('./chat-completions.js');
const { router: generationRouter } = await import('../generation.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { saveChatToTree, loadBranch } = realTree;
const { CompactStreamDecoder } = await import('../../../public/scripts/llamacpp-compact-stream.js');
const { upsertCharacterFromWrite } = await import('../../character-metadata-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-reply-not-saved-test-'));
const directories = { root };
for (const dir of ['characters', 'groups', 'worlds', 'files', 'chats']) {
    directories[dir] = path.join(root, dir);
    fs.mkdirSync(directories[dir], { recursive: true });
}
globalThis.DATA_ROOT = root;

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
    fs.writeFileSync(path.join(directories.characters, avatar), writeCard(baseImage, cardJson));
    await upsertCharacterFromWrite(directories, avatar, cardJson);
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
            if (!parsed.stream) return send(json(reply));
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const pieces = [reply.slice(0, 4), reply.slice(4, 9), reply.slice(9)];
            for (const piece of pieces) res.write(format(piece, false));
            res.end(format('', true));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
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
        req.user = { directories, profile: { handle: req.get('X-Test-User') ?? 'alice' } };
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

async function newBranch(ownerId, name) {
    await saveChatToTree(directories, ownerId, name, [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Hello there.', send_date: 1, extra: {} },
    ]);
    return loadBranch(directories, ownerId, name);
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

    async function generate(branchName) {
        const branch = await newBranch(avatar, branchName);
        const id = randomUUID();
        const res = await fetch(`${base}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Generation-Id': id },
            body: JSON.stringify({ owner_id: avatar, character_avatar: avatar, node_id: branch.branch.leaf_id, type: 'normal', user_message: 'When do we leave?', stream }),
        });
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
        return { branch, id, text, nodeId, warnings, branchName };
    }

    try {
        // Stored normally: exactly one reply, and the page is told where.
        {
            const result = await generate(`ok-${label}`);
            const after = await loadBranch(directories, avatar, result.branchName);
            assert.equal(after.messages.length, result.branch.messages.length + 2, `${label}: one user message and one reply`);
            const last = after.messages[after.messages.length - 1];
            assert.equal(last.mes, reply, `${label}: the stored reply is the generated text`);
            assert.equal(result.nodeId, last.node_id, `${label}: the page is told the stored reply's node`);
            assert.ok(!result.warnings.some(w => w.kind === 'reply-not-saved'), `${label}: no not-saved warning when it was stored`);
        }

        // The store fails: nothing is stored, the page is told, and the retry stores it once.
        {
            const branchName = `fail-${label}`;
            failures.reply = 1;
            const result = await generate(branchName);
            failures.reply = 0;
            const after = await loadBranch(directories, avatar, branchName);
            const notSaved = result.warnings.find(w => w.kind === 'reply-not-saved');
            assert.ok(notSaved, `${label}: the page is told the reply wasn't saved`);
            assert.equal(notSaved.generation_id, result.id, `${label}: the warning names the generation`);
            assert.match(notSaved.message, /disk is full/, `${label}: the warning says why`);
            assert.equal(result.nodeId, null, `${label}: no node id is given for a reply that wasn't stored`);
            assert.equal(result.text, reply, `${label}: the page still got the reply's text`);
            assert.equal(after.messages.length, result.branch.messages.length + 1, `${label}: only the user message is stored`);

            const wrongUser = await fetch(`${base}/api/generation/store/${result.id}`, { method: 'POST', headers: { 'X-Test-User': 'mallory' } });
            assert.equal(wrongUser.status, 404, `${label}: another user can't store it`);

            const retry = await fetch(`${base}/api/generation/store/${result.id}`, { method: 'POST' });
            assert.equal(retry.status, 200);
            const stored = await retry.json();
            assert.equal(stored.state, 'saved', `${label}: the retry stored it`);
            const again = await (await fetch(`${base}/api/generation/store/${result.id}`, { method: 'POST' })).json();
            assert.equal(again.node_id, stored.node_id, `${label}: a second retry answers the same node, nothing new`);

            const final = await loadBranch(directories, avatar, branchName);
            assert.equal(final.messages.length, result.branch.messages.length + 2, `${label}: the reply is stored exactly once`);
            const last = final.messages[final.messages.length - 1];
            assert.equal(last.mes, reply);
            assert.equal(last.node_id, stored.node_id);
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

await run();
