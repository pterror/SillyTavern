import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
import '../../fetch-patch.js';
// Same process-wide config-path requirement as chat-completions.test.js/resume-stream.test.js (the
// import chain through chat-completion-generation-input.js -> characters.js -> character-shallow.js
// reads config at import time).
import { setConfigFilePath } from '../../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

// Real end-to-end resumability test for chat-completions.js's provider-specific `sendXRequest()`
// functions - resume-stream.text-completions.test.js already proves the shared guard/buffer/resume
// mechanism end-to-end for the default/legacy text-completion dispatch path; this file proves the
// SAME mechanism for three of chat-completions.js's ~13 independent provider functions, chosen to
// cover meaningfully different real upstream stream framings, not just three copies of the same
// OpenAI-delta shape:
// - Claude (sendClaudeRequest): named SSE events (content_block_delta/message_stop), no [DONE]
//   sentinel - the stream just ends when the connection closes.
// - Gemini/MakerSuite (sendMakerSuiteRequest): `alt=sse` chunks, each a FULL
//   GenerateContentResponse-shaped payload (not an OpenAI-style incremental delta).
// - Mistral (sendMistralAIRequest): the typical OpenAI-Chat-Completions-shaped
//   `choices[0].delta.content` stream every other provider function not covered here also uses.
// Each real client (fetch + AbortController) genuinely disconnects mid-stream from the real router
// (mounted on a real Express app, listening on a real ephemeral TCP port) while a real, paced `http`
// fake backend is still mid-generation, then reconnects via the real GET /generate/resume/:id route
// and is served the live continuation - the exact same mechanism resume-stream.test.js already
// verifies for the default path.
const { router } = await import('./chat-completions.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { saveChatToTree, loadBranch, disposeMessageTreeStores } = await import('../../message-tree-db.js');
const { CompactStreamDecoder } = await import('../../../public/scripts/llamacpp-compact-stream.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-resume-stream-chat-completions-test-'));
const charactersDir = path.join(root, 'characters');
const groupsDir = path.join(root, 'groups');
const worldsDir = path.join(root, 'worlds');
const filesDir = path.join(root, 'files');
fs.mkdirSync(charactersDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(worldsDir, { recursive: true });
fs.mkdirSync(filesDir, { recursive: true });

const directories = { root, characters: charactersDir, groups: groupsDir, worlds: worldsDir, files: filesDir };
globalThis.DATA_ROOT = root;

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'img', 'ai4.png'));

function writeCharacter(avatar, overrides = {}) {
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
    const buffer = writeCard(baseImage, JSON.stringify(card));
    fs.writeFileSync(path.join(charactersDir, avatar), buffer);
    return avatar;
}

/** Real settings.json fixture - only the keys resolveChatCompletionGenerationInput()/createGenerationParameters() actually read. */
function buildSettingsFixture() {
    return {
        username: 'Tester',
        power_user: {
            persona_description: '',
            persona_description_position: 0,
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

/**
 * Starts a fake backend that writes each of `rawChunks` (already-formatted SSE text, one write per
 * array entry) with a real delay between writes, so there is a genuine window during which the real
 * client can disconnect while the backend is still actively producing content the server has not
 * relayed yet. Resolves `done` once every chunk has been written (tests await this before asserting
 * final persisted state, to avoid racing the backend's own completion).
 */
function startFakePacedSseBackend(rawChunks, { delayMs = 40, trailer = '' } = {}) {
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const startPromise = startFakeBackend((_req, res) => {
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
    return startPromise.then(backend => ({ ...backend, done }));
}

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories };
        next();
    });
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
 * Runs one full disconnect-mid-stream-then-resume cycle against a real, paced fake backend, and
 * asserts the resumed stream reconstructs the complete text with nothing lost or duplicated, and that
 * the real persisted tree message matches exactly. Shared across all three provider cases below - only
 * the fake backend's own wire shape and the settings-pointing function differ between them.
 * @param {object} options
 * @param {string} options.branchName
 * @param {string} options.userMessage
 * @param {string} options.expectedText
 * @param {() => Promise<{server: import('http').Server, url: string, done: Promise<void>}>} options.startBackend
 * @param {(url: string) => void} options.pointBackendAt
 */
async function runResumeCase({ avatar, ownerId, branchName, userMessage, expectedText, startBackend, pointBackendAt }) {
    await saveChatToTree(directories, ownerId, branchName, [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
    ]);
    const branchBefore = await loadBranch(directories, ownerId, branchName);

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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: userMessage, stream: true,
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

        // Real socket-level disconnect - same mechanism resume-stream.test.js verifies for the
        // default text-completion dispatch path.
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
        await fakeBackend.done;
        fakeBackend.server.close();
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }

    assert.equal(text, expectedText, 'the resumed stream, spliced into the same decoder, reconstructs the exact complete text with nothing lost or duplicated across the disconnect/resume boundary');
    assert.ok(assistantNodeId, 'the assistant_node_id frame was received via the resume response - the generation completed and persisted for real');

    const branchAfter = await waitFor(async () => {
        const branch = await loadBranch(directories, ownerId, branchName);
        return branch.messages.length === branchBefore.messages.length + 2 ? branch : null;
    });
    const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
    assert.equal(assistantMsg.mes, expectedText, 'the real persisted tree message matches the resumed text exactly');
    assert.equal(assistantMsg.node_id, assistantNodeId, 'the node id learned via resume is the exact node the reply actually landed on');
}

async function run() {
    const avatar = writeCharacter('Rex.png', {
        name: 'Rex',
        description: 'Rex is a {{char}}.',
        data: { name: 'Rex', description: 'Rex is a {{char}}.', first_mes: 'Hi, I am Rex.' },
    });
    const ownerId = avatar;

    // --- Claude (sendClaudeRequest): named SSE events, content only lives in `text_delta` deltas on
    // the real `text` content block; the stream ends on `message_stop` with no [DONE] sentinel. ---
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

    // --- Gemini/MakerSuite (sendMakerSuiteRequest): `alt=sse` chunks, each a FULL
    // GenerateContentResponse-shaped payload carrying that chunk's own incremental
    // `candidates[0].content.parts` - not an OpenAI-style incremental delta at all. ---
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

    // --- Mistral (sendMistralAIRequest): the typical OpenAI-Chat-Completions-shaped
    // `choices[0].delta.content` stream, the same shape most of the other 13 provider functions not
    // individually covered here also use. ---
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
    .finally(() => {
        disposeMessageTreeStores();
        fs.rmSync(root, { recursive: true, force: true });
    });
