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

// An explicit stop (POST /generate/stop/:id) aborts the upstream request of a raw-action generation,
// and what is stored is exactly what the server streamed up to the stop. A disconnect without a stop
// still lets the generation run to the end.
const { router: textRouter } = await import('./text-completions.js');
const { router: chatRouter } = await import('./chat-completions.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { CompactStreamDecoder } = await import('../../../public/scripts/llamacpp-compact-stream.js');
const { newSessionKey } = await import('../../chat-engine.js');
const { SESSION_HEADER } = await import('../../request-session.js');
const { convertedUser, writeLibraryCard, seedMessages, sessionPath } = await import('../../../tests/converted-user.fixture.js');

const user = await convertedUser('st-generation-stop-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

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
    return avatar;
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

function chatSettings(source, url) {
    const oai = {
        chat_completion_source: source, custom_model: 'test-model', mistralai_model: 'mistral-test-model',
        openai_max_context: 4096, openai_max_tokens: 300, temp_openai: 1, freq_pen_openai: 0, pres_pen_openai: 0, top_p_openai: 1,
        prompts: [
            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'You are {{char}}.', system_prompt: true },
            { identifier: 'chatHistory', name: 'Chat History', role: 'system', content: '', system_prompt: true },
        ],
        prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
    };
    if (source === 'custom') oai.custom_url = url;
    else { oai.reverse_proxy = url; oai.proxy_password = 'test-proxy-password'; }
    return {
        username: 'Tester',
        power_user: { console_log_prompts: false, pin_examples: false, request_token_probabilities: false },
        world_info: { globalSelect: [], charLore: [] },
        oai_settings: oai,
    };
}

/**
 * A fake backend that streams `count` pieces, one every `delayMs`, and records whether its connection
 * was closed before it finished. `format` builds one SSE event from a piece; `/props` and `/tokenize`
 * answer llama.cpp's probes; with `nonStream` it answers once with JSON after `count * delayMs`.
 */
async function startPacedBackend({ count = 30, delayMs = 60, format, finalJson = null, nonStream = false }) {
    const state = { written: 0, closedEarly: false, closedAt: 0, finished: false, started: false };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const route = (req.url ?? '').split('?')[0];
            const json = (value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            if (route === '/props') return json({ model_path: '/models/stop.gguf', build_info: 'b-stop', default_generation_settings: { n_ctx: 8192 } });
            if (route === '/tokenize') return json({ tokens: String(JSON.parse(body || '{}').content ?? '').split(/(?=\s)/).filter(Boolean).map((_, i) => i) });
            if (route.endsWith('/models')) return json({ data: [] });
            state.started = true;
            res.on('close', () => {
                if (!state.finished) {
                    state.closedEarly = true;
                    state.closedAt = Date.now();
                }
            });
            if (nonStream) {
                setTimeout(() => {
                    if (state.closedEarly) return;
                    state.finished = true;
                    json(finalJson);
                }, count * delayMs);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            (async () => {
                for (let i = 0; i < count; i++) {
                    if (state.closedEarly) return;
                    res.write(format(`w${i} `, false));
                    state.written++;
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
                state.finished = true;
                res.end(format('', true));
            })();
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, state, url: `http://127.0.0.1:${server.address().port}` };
}

const genericFormat = (text, last) => last ? 'data: [DONE]\n\n' : `data: ${JSON.stringify({ choices: [{ text }] })}\n\n`;
const llamaFormat = (content, stop) => `data: ${JSON.stringify({ content, stop })}\n\n`;
const chatFormat = (content, last) => last ? 'data: [DONE]\n\n' : `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

function startApp(router) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: req.get('X-Test-User') ?? 'u' } };
        next();
    });
    app.use('/', router);
    const server = app.listen(0, '127.0.0.1');
    return new Promise(resolve => server.once('listening', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

async function closeApp(server) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
}

let branches = 0;

/**
 * A new conversation of `avatar`'s, its greeting stored through a session of its own: what a generate request's
 * session continues.
 * @param {string} avatar
 */
async function newBranch(avatar) {
    const session = newSessionKey();
    // A greeting of its own: one with the same text would be the stored one, and so would the messages after it.
    const [greeting] = await seedMessages(user.store, { avatar }, null, [{ name: 'Rex', is_user: false, mes: `Hello there. (${++branches})`, send_date: 1, extra: {} }], { session });
    return { session, leaf: greeting, messages: await sessionPath(user.store, { avatar }, session) };
}

const shown = (/** @type {string} */ avatar, /** @type {{ session: string }} */ branch) => sessionPath(user.store, { avatar }, branch.session);

async function waitFor(check, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (; ;) {
        const result = await check();
        if (result) return result;
        if (Date.now() > deadline) throw new Error('waitFor() timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

/**
 * Streams a generation, stops it after the first content arrives, and checks the upstream was closed
 * at once, the stop answered with the stored text and node, and the page's stream ends with that same text.
 */
async function stopMidStreamCase({ label, router, settings, format, avatar }) {
    const backend = await startPacedBackend({ format });
    writeAllSettings(directories, settings(backend.url));
    const branch = await newBranch(avatar);
    const { server, base } = await startApp(router);
    const id = randomUUID();
    try {
        const res = await fetch(`${base}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Generation-Id': id, [SESSION_HEADER]: branch.session },
            body: JSON.stringify({ owner_id: avatar, character_avatar: avatar, node_id: branch.leaf, type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Go on.' }, stream: true }),
        });
        assert.equal(res.status, 200, `${label}: stream started`);
        assert.equal(res.headers.get('X-Generation-Id'), id, `${label}: the server used the page's generation id`);

        const reader = res.body.getReader();
        const decoder = new CompactStreamDecoder();
        let text = '';
        let nodeId = null;
        const take = (events) => {
            for (const event of events) {
                if ('content' in event) text += event.content;
                else if ('assistantNodeId' in event) nodeId = event.assistantNodeId;
            }
        };
        while (!text) {
            const { value, done } = await reader.read();
            assert.ok(!done, `${label}: content arrived before the stream ended`);
            take(decoder.push(value));
        }

        const wrongUser = await fetch(`${base}/generate/stop/${id}`, { method: 'POST', headers: { 'X-Test-User': 'mallory' } });
        assert.equal(wrongUser.status, 404, `${label}: another user can't stop it`);
        assert.equal(backend.state.closedEarly, false, `${label}: another user's stop did nothing`);

        const stoppedAt = Date.now();
        const stopRes = await fetch(`${base}/generate/stop/${id}`, { method: 'POST' });
        assert.equal(stopRes.status, 200);
        const stop = await stopRes.json();
        assert.equal(stop.state, 'stopped', `${label}: the stop answers stopped`);
        await waitFor(() => backend.state.closedEarly, 1000).catch(() => assert.fail(`${label}: the upstream connection was closed`));
        assert.ok(backend.state.closedAt - stoppedAt < 1000, `${label}: closed within a second of the stop (${backend.state.closedAt - stoppedAt}ms)`);
        assert.ok(backend.state.written < 30, `${label}: the backend did not generate to the end (${backend.state.written}/30)`);

        for (; ;) {
            const { value, done } = await reader.read();
            if (done) break;
            take(decoder.push(value));
        }
        take(decoder.flush());

        assert.ok(stop.mes && stop.node_id, `${label}: the stop answers with the stored text and node`);
        // The stored reply is the streamed text cleaned up as upstream's page cleaned it (trimmed, trim_spaces being on).
        assert.equal(text.trim(), stop.mes, `${label}: the page's stream ends with exactly the stored text`);
        assert.equal(nodeId, stop.node_id, `${label}: the stream's last frame names the same node`);
        const after = await shown(avatar, branch);
        const last = after[after.length - 1];
        assert.equal(last.is_user, false);
        assert.equal(last.mes, stop.mes, `${label}: the stored reply is what was streamed, not the full generation`);
        assert.equal(last.node_id, stop.node_id);
        assert.equal(after.length, branch.messages.length + 2, `${label}: one user message and one reply, no extra`);
    } finally {
        backend.server.close();
        await closeApp(server);
    }
}

async function run() {
    const avatar = await writeCharacter('Rex.png', 'Rex');

    await stopMidStreamCase({ label: 'text-generic', router: textRouter, settings: url => textSettings('generic', url), format: genericFormat, avatar });
    await stopMidStreamCase({ label: 'text-llamacpp', router: textRouter, settings: url => textSettings('llamacpp', url), format: llamaFormat, avatar });
    await stopMidStreamCase({ label: 'chat-custom', router: chatRouter, settings: url => chatSettings('custom', url), format: chatFormat, avatar });
    await stopMidStreamCase({ label: 'chat-mistral', router: chatRouter, settings: url => chatSettings('mistralai', url), format: chatFormat, avatar });

    // Non-streaming: the stop aborts the upstream request and nothing is stored as a reply.
    {
        const backend = await startPacedBackend({ count: 30, delayMs: 60, nonStream: true, finalJson: { choices: [{ text: 'never sent' }] }, format: genericFormat });
        writeAllSettings(directories, textSettings('generic', backend.url));
        const branch = await newBranch(avatar);
        const { server, base } = await startApp(textRouter);
        const id = randomUUID();
        const controller = new AbortController();
        try {
            const pending = fetch(`${base}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Generation-Id': id, [SESSION_HEADER]: branch.session },
                body: JSON.stringify({ owner_id: avatar, character_avatar: avatar, node_id: branch.leaf, type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Quick.' }, stream: false }),
                signal: controller.signal,
            }).catch(() => null);
            await waitFor(() => backend.state.started);
            const stoppedAt = Date.now();
            const stop = await (await fetch(`${base}/generate/stop/${id}`, { method: 'POST' })).json();
            controller.abort();
            await pending;
            assert.equal(stop.state, 'stopped');
            assert.equal(stop.mes, null, 'non-streaming: nothing was shown, nothing is stored as a reply');
            await waitFor(() => backend.state.closedEarly, 1000).catch(() => assert.fail('non-streaming: the upstream request was aborted'));
            assert.ok(backend.state.closedAt - stoppedAt < 1000, 'non-streaming: aborted within a second of the stop');
            const after = await shown(avatar, branch);
            assert.deepEqual(after.slice(branch.messages.length).map(m => m.is_user), [true], 'non-streaming: only the user message is stored');
        } finally {
            backend.server.close();
            await closeApp(server);
        }
    }

    // A disconnect without a stop still runs to the end and stores the whole reply.
    {
        const backend = await startPacedBackend({ count: 8, delayMs: 30, format: genericFormat });
        writeAllSettings(directories, textSettings('generic', backend.url));
        const branch = await newBranch(avatar);
        const { server, base } = await startApp(textRouter);
        const controller = new AbortController();
        try {
            const res = await fetch(`${base}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: branch.session },
                body: JSON.stringify({ owner_id: avatar, character_avatar: avatar, node_id: branch.leaf, type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Keep going.' }, stream: true }),
                signal: controller.signal,
            });
            const reader = res.body.getReader();
            await reader.read();
            controller.abort();
            await waitFor(() => backend.state.finished);
            assert.equal(backend.state.closedEarly, false, 'a disconnect does not close the upstream request');
            const full = Array.from({ length: 8 }, (_, i) => `w${i} `).join('');
            const after = await waitFor(async () => {
                const b = await shown(avatar, branch);
                return b.length === branch.messages.length + 2 ? b : null;
            });
            assert.equal(after[after.length - 1].mes, full.trim(), 'the whole reply is stored (cleaned up: trimmed) after a disconnect');
        } finally {
            backend.server.close();
            await closeApp(server);
        }
    }

    // An unknown id answers 404.
    {
        const { server, base } = await startApp(textRouter);
        try {
            const res = await fetch(`${base}/generate/stop/${randomUUID()}`, { method: 'POST' });
            assert.equal(res.status, 404);
        } finally {
            await closeApp(server);
        }
    }

    console.log('generation-stop.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => user.close());
