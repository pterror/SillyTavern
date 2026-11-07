import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
import '../../fetch-patch.js';
import { setConfigFilePath } from '../../util.js';
import { streamAsSetting } from '../../../tests/util/stream-as-setting.js';
import { handleGenerationStop } from '../../generation-stop.js';
import { handleGenerationResume } from './llamacpp-compact-stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

const { router } = await import('./chat-completions.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { CompactStreamDecoder } = await import('../../../public/scripts/llamacpp-compact-stream.js');
const { newSessionKey } = await import('../../chat-engine.js');
const { SESSION_HEADER } = await import('../../request-session.js');
const { convertedUser, writeLibraryCard, seedMessages, sessionPath } = await import('../../../tests/converted-user.fixture.js');

const user = await convertedUser('st-resume-stream-chat-completions-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

let branches = 0;

/**
 * @param {string} avatar
 */
async function newBranch(avatar) {
    const session = newSessionKey();
    const [greeting] = await seedMessages(user.store, { avatar }, null, [{ name: 'Rex', is_user: false, mes: `Hello there, traveler. (${++branches})`, send_date: 1, extra: {} }], { session });
    return { session, leaf: greeting, messages: await sessionPath(user.store, { avatar }, session) };
}

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'img', 'ai4.png'));

async function writeCharacter(avatar, overrides = {}) {
    const name = overrides.name ?? avatar.replace(/\.png$/, '');
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name,
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        avatar,
        data: {
            name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            alternate_greetings: [], extensions: {},
        },
        ...overrides,
    };
    const cardJson = JSON.stringify(card);
    const buffer = writeCard(baseImage, cardJson);
    await writeLibraryCard(user, avatar, cardJson, buffer);
    return avatar;
}

function buildSettingsFixture() {
    return {
        username: 'Tester',
        power_user: {
            console_log_prompts: false,
            pin_examples: false,
            request_token_probabilities: false,
        },
        world_info: { globalSelect: [], charLore: [] },
        oai_settings: {
            chat_completion_source: 'custom',
            custom_model: 'test-model',
            openai_max_context: 4096,
            openai_max_tokens: 300,
            temp_openai: 1,
            freq_pen_openai: 0,
            pres_pen_openai: 0,
            top_p_openai: 1,
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'You are {{char}}.', system_prompt: true },
                { identifier: 'charDescription', name: 'Char Description', role: 'system', content: '', system_prompt: true },
                { identifier: 'chatHistory', name: 'Chat History', role: 'system', content: '', system_prompt: true },
            ],
            prompt_order: [
                {
                    character_id: 100000,
                    order: [
                        { identifier: 'main', enabled: true },
                        { identifier: 'charDescription', enabled: true },
                        { identifier: 'chatHistory', enabled: true },
                    ],
                },
            ],
        },
    };
}

function pointClaudeBackendAt(url) {
    const settings = buildSettingsFixture();
    settings.oai_settings.chat_completion_source = 'claude';
    settings.oai_settings.claude_model = 'claude-test-model';
    settings.oai_settings.reverse_proxy = url;
    settings.oai_settings.proxy_password = 'test-claude-proxy-password';
    writeAllSettings(directories, settings);
}

function pointMakerSuiteBackendAt(url) {
    const settings = buildSettingsFixture();
    settings.oai_settings.chat_completion_source = 'makersuite';
    settings.oai_settings.google_model = 'gemini-test-model';
    settings.oai_settings.reverse_proxy = url;
    settings.oai_settings.proxy_password = 'test-makersuite-proxy-password';
    writeAllSettings(directories, settings);
}

function pointMistralBackendAt(url) {
    const settings = buildSettingsFixture();
    settings.oai_settings.chat_completion_source = 'mistralai';
    settings.oai_settings.mistralai_model = 'mistral-test-model';
    settings.oai_settings.reverse_proxy = url;
    settings.oai_settings.proxy_password = 'test-mistral-proxy-password';
    writeAllSettings(directories, settings);
}

async function startFakeBackend(handler) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => handler(req, res, body));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function startFakePacedSseBackend(rawChunks, { delayMs = 40, trailer = '' } = {}) {
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const fake = { done, handlerStarted: false };
    const startPromise = startFakeBackend((_req, res) => {
        fake.handlerStarted = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        (async () => {
            for (const chunk of rawChunks) {
                res.write(chunk);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            res.end(trailer);
            resolveDone();
        })();
    });
    return startPromise.then(backend => Object.assign(fake, backend));
}

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: 'u' } };
        next();
    });
    app.use(streamAsSetting());
    app.post('/generate/stop/:id', handleGenerationStop);
    app.get('/generate/resume/:id', handleGenerationResume);
    app.use('/', router);
    return app;
}

async function waitFor(check, { timeoutMs = 3000, intervalMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (; ;) {
        const result = await check();
        if (result) return result;
        if (Date.now() > deadline) throw new Error('waitFor() timed out waiting for condition to become true');
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

/**
 * @param {object} options
 * @param {string} options.userMessage
 * @param {string} options.expectedText
 * @param {() => Promise<{server: import('http').Server, url: string, done: Promise<void>}>} options.startBackend
 * @param {(url: string) => void} options.pointBackendAt
 */
async function runResumeCase({ avatar, ownerId, userMessage, expectedText, startBackend, pointBackendAt }) {
    const branchBefore = await newBranch(avatar);

    const fakeBackend = await startBackend();
    pointBackendAt(fakeBackend.url);

    const app = buildTestApp();
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;

    const controller = new AbortController();
    const decoder = new CompactStreamDecoder();
    let text = '';
    let assistantNodeId = null;
    let generationId = null;
    let bytesReceived = 0;

    function applyEvents(events) {
        for (const event of events) {
            if ('content' in event) text += event.content;
            else if ('assistantNodeId' in event) assistantNodeId = event.assistantNodeId;
        }
    }

    try {
        const res = await fetch(`http://127.0.0.1:${port}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: branchBefore.session },
            body: JSON.stringify({
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.leaf,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: userMessage }, stream: true,
            }),
            signal: controller.signal,
        });

        assert.equal(res.status, 200);
        assert.equal(res.headers.get('X-ST-Stream-Format'), 'compact-v1');
        generationId = res.headers.get('X-Generation-Id');
        assert.ok(generationId, 'a real X-Generation-Id header was sent for this raw-action stream, required for resume');

        const reader = res.body.getReader();
        const { value: firstChunk, done: firstDone } = await reader.read();
        assert.ok(!firstDone && firstChunk && firstChunk.length > 0, 'a real first chunk was received before disconnecting - proves the stream was genuinely underway');
        bytesReceived += firstChunk.length;
        applyEvents(decoder.push(firstChunk));
        assert.ok(text.length > 0 && expectedText.startsWith(text), 'the first real chunk decoded to a real prefix of the expected text');
        assert.ok(text.length < expectedText.length, 'the backend has more content still to send - the drop below is genuinely mid-generation, not after the fact');

        controller.abort();
        await assert.rejects(() => reader.read(), 'the original connection is genuinely dead after abort()');

        const resumeRes = await fetch(`http://127.0.0.1:${port}/generate/resume/${encodeURIComponent(generationId)}?from=${bytesReceived}`);
        assert.equal(resumeRes.status, 200, 'the resume endpoint accepted the real generation id and byte offset');
        assert.equal(resumeRes.headers.get('X-ST-Stream-Format'), 'compact-v1');

        const resumeReader = resumeRes.body.getReader();
        for (; ;) {
            const { done, value } = await resumeReader.read();
            if (done) break;
            if (value && value.length) {
                bytesReceived += value.length;
                applyEvents(decoder.push(value));
            }
        }
        applyEvents(decoder.flush());
    } finally {
        if (fakeBackend.handlerStarted) await fakeBackend.done;
        fakeBackend.server.close();
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }

    assert.equal(text, expectedText, 'the resumed stream, spliced into the same decoder, reconstructs the exact complete text with nothing lost or duplicated across the disconnect/resume boundary');
    assert.ok(assistantNodeId, 'the assistant_node_id frame was received via the resume response - the generation completed and persisted for real');

    const branchAfter = await waitFor(async () => {
        const shown = await sessionPath(user.store, { avatar }, branchBefore.session);
        return shown.length === branchBefore.messages.length + 2 ? shown : null;
    });
    const assistantMsg = branchAfter[branchAfter.length - 1];
    assert.equal(assistantMsg.mes, expectedText, 'the real persisted tree message matches the resumed text exactly');
    assert.equal(assistantMsg.node_id, assistantNodeId, 'the node id learned via resume is the exact node the reply actually landed on');
}

async function run() {
    const avatar = await writeCharacter('Rex.png', {
        name: 'Rex',
        description: 'Rex is a {{char}}.',
        data: { name: 'Rex', description: 'Rex is a {{char}}.', first_mes: 'Hi, I am Rex.' },
    });
    const ownerId = avatar;

    {
        const chunks = ['Once ', 'upon ', 'a ', 'time, ', 'a ', 'dropped ', 'connection ', 'resumed.'];
        const expectedText = chunks.join('');
        const claudeEvents = [
            { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            ...chunks.map(text => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
            { type: 'message_stop' },
        ];
        const rawChunks = claudeEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

        await runResumeCase({
            avatar, ownerId, branchName: 'resume-claude-chat',
            userMessage: 'Tell me a story, then vanish (Claude).',
            expectedText,
            startBackend: () => startFakePacedSseBackend(rawChunks),
            pointBackendAt: pointClaudeBackendAt,
        });
    }

    {
        const chunks = ['Once ', 'upon ', 'a ', 'time, ', 'a ', 'dropped ', 'connection ', 'resumed.'];
        const expectedText = chunks.join('');
        const rawChunks = chunks.map(text => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }], role: 'model' } }] })}\n\n`);

        await runResumeCase({
            avatar, ownerId, branchName: 'resume-makersuite-chat',
            userMessage: 'Tell me a story, then vanish (Gemini).',
            expectedText,
            startBackend: () => startFakePacedSseBackend(rawChunks),
            pointBackendAt: pointMakerSuiteBackendAt,
        });
    }

    {
        const chunks = ['Once ', 'upon ', 'a ', 'time, ', 'a ', 'dropped ', 'connection ', 'resumed.'];
        const expectedText = chunks.join('');
        const rawChunks = chunks.map(text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);

        await runResumeCase({
            avatar, ownerId, branchName: 'resume-mistral-chat',
            userMessage: 'Tell me a story, then vanish (Mistral).',
            expectedText,
            startBackend: () => startFakePacedSseBackend(rawChunks, { trailer: 'data: [DONE]\n\n' }),
            pointBackendAt: pointMistralBackendAt,
        });
    }

    console.log('resume-stream-chat-completions.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => user.close());
