import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
import '../../fetch-patch.js';
import { Jimp, JimpMime } from '../../jimp.js';
// chat-completions.js -> chat-completion-generation-input.js pulls in src/endpoints/characters.js
// (via readCardContent) and src/endpoints/tokenizers.js, both of which read process-wide config at
// import time - the config path must be set before that import chain runs, same as
// chat-completion-generation-input.test.js/text-completions.test.js.
import { setConfigFilePath } from '../../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

// JUDGMENT CALL: sendAI21Request/sendCohereRequest/sendAimlapiRequest/sendChutesRequest/
// sendMinimaxRequest/sendElectronHubRequest (chat-completions.js) are the SIX of the twelve provider
// functions with NO override for their target host at all - verified by reading each function's full
// body: AI21 always calls `fetch(API_AI21 + '/chat/completions', options)` (hardcoded
// `https://api.ai21.com/studio/v1`); Cohere always calls `fetch(API_COHERE_V2 + '/chat', config)`
// (hardcoded `https://api.cohere.ai/v2`); AI/ML API always calls
// `fetch(API_AIMLAPI + '/chat/completions', config)` (hardcoded `https://api.aimlapi.com/v1`); Chutes
// always calls `fetch(API_CHUTES + '/chat/completions', config)` (hardcoded `https://llm.chutes.ai/v1`);
// MiniMax always calls `fetch(apiUrl + '/chat/completions', config)` where `apiUrl` is one of the two
// hardcoded `API_MINIMAX`/`API_MINIMAX_CN` hosts (selected only by `minimax_endpoint`, never a
// caller-supplied URL); Electron Hub always calls `fetch(API_ELECTRONHUB + '/chat/completions', config)`
// (hardcoded `https://api.electronhub.ai/v1`) - completely unlike sendClaudeRequest/
// sendMakerSuiteRequest/sendMistralAIRequest/sendDeepSeekRequest/sendXaiRequest (all of which honor
// `request.body.reverse_proxy`) and sendAzureOpenAIRequest (whose `azure_base_url` IS itself a
// caller-supplied endpoint override, so it needs no such mock - see `pointAzureOpenAIBackendAt()`
// below), and all six are confirmed absent from chat-completion-generation-data.js's own
// `proxySupportedSources` list too (which DOES list DEEPSEEK and XAI, confirming those two really do
// support a raw-action reverse-proxy override end-to-end). So there is no way, via any
// REQUEST-BUILDING field, to route a real raw-action AI21/Cohere/AI-ML-API/Chutes/MiniMax/Electron-Hub
// call at this route to a local fake backend - the only two options are (a) add reverse-proxy support
// to these functions, which is explicitly out of scope (touches request-building logic, not just
// persistence), or (b) intercept the `node-fetch` module itself for the duration of these
// provider-specific tests, using Node's built-in (currently experimental) `node:test` `mock.module()`
// - real network is never touched: the mock rewrites ONLY requests whose origin is
// `https://api.ai21.com`/`https://api.cohere.ai`/`https://api.aimlapi.com`/`https://llm.chutes.ai`/
// `https://api.minimax.io`/`https://api.minimaxi.com`/`https://api.electronhub.ai` to instead hit this
// session's own local fake HTTP backend (a REAL `node-fetch` call still runs against that local server
// - the mock is a thin reroute, not a hand-built fake Response, so
// `.ok`/`.status`/`.json()`/`.text()`/`.body` streaming semantics are all genuinely real), and passes
// every other URL straight through to the real, unmodified `node-fetch` (captured via its own file
// path below, bypassing the mock) - which is exactly what every other test in this file already relies
// on (the 'custom'/'claude'/'makersuite'/'mistralai'/'deepseek'/'xai'/'azure_openai' fake-backend tests
// all still go through this same indirection, unaffected, since none of their URLs are ever those seven
// origins).
//
// `mock.module()` only exists when Node is launched with `--experimental-test-module-mocks` (not
// otherwise enabled anywhere in this repo's tooling) - feature-detected below so this file still runs
// to completion under a plain `node chat-completions.test.js` invocation exactly as before; the
// AI21/Cohere/AI-ML-API/Chutes/MiniMax/Electron-Hub-specific tests further down skip themselves (with a
// clear console.log, not a silent no-op) when the feature isn't available, and only then. Must run
// before `chat-completions.js` is first imported below (its own top-level `import fetch from
// 'node-fetch'` needs to resolve to the mock).
const canMockAi21Backend = typeof mock.module === 'function';
/** @type {string|null} Set by pointAI21BackendAt() below; read by the node-fetch reroute mock. */
let ai21FakeBackendUrl = null;
/** @type {string|null} Set by pointCohereBackendAt() below; read by the node-fetch reroute mock. */
let cohereFakeBackendUrl = null;
/** @type {string|null} Set by pointAimlapiBackendAt() below; read by the node-fetch reroute mock. */
let aimlapiFakeBackendUrl = null;
/** @type {string|null} Set by pointChutesBackendAt() below; read by the node-fetch reroute mock. */
let chutesFakeBackendUrl = null;
/** @type {string|null} Set by pointMinimaxBackendAt() below; read by the node-fetch reroute mock. */
let minimaxFakeBackendUrl = null;
/** @type {string|null} Set by pointElectronHubBackendAt() below; read by the node-fetch reroute mock. */
let electronhubFakeBackendUrl = null;
if (canMockAi21Backend) {
    const realNodeFetch = (await import(path.join(__dirname, '..', '..', '..', 'node_modules', 'node-fetch', 'src', 'index.js'))).default;
    mock.module('node-fetch', {
        defaultExport: async (url, opts) => {
            const target = new URL(url);
            if (ai21FakeBackendUrl && target.origin === 'https://api.ai21.com') {
                return realNodeFetch(new URL(target.pathname + target.search, ai21FakeBackendUrl), opts);
            }
            if (cohereFakeBackendUrl && target.origin === 'https://api.cohere.ai') {
                return realNodeFetch(new URL(target.pathname + target.search, cohereFakeBackendUrl), opts);
            }
            if (aimlapiFakeBackendUrl && target.origin === 'https://api.aimlapi.com') {
                return realNodeFetch(new URL(target.pathname + target.search, aimlapiFakeBackendUrl), opts);
            }
            if (chutesFakeBackendUrl && target.origin === 'https://llm.chutes.ai') {
                return realNodeFetch(new URL(target.pathname + target.search, chutesFakeBackendUrl), opts);
            }
            if (minimaxFakeBackendUrl && (target.origin === 'https://api.minimax.io' || target.origin === 'https://api.minimaxi.com')) {
                return realNodeFetch(new URL(target.pathname + target.search, minimaxFakeBackendUrl), opts);
            }
            if (electronhubFakeBackendUrl && target.origin === 'https://api.electronhub.ai') {
                return realNodeFetch(new URL(target.pathname + target.search, electronhubFakeBackendUrl), opts);
            }
            return realNodeFetch(url, opts);
        },
    });
}

// This route handler (src/endpoints/backends/chat-completions.js) mirrors
// src/endpoints/backends/text-completions.js's own precedent (commits ac42ce8c9/6eaa7897d) - no
// existing route-level Express-integration-test convention elsewhere either, so the REQUEST-BUILDING
// portion of the new raw-action /generate branch was extracted into a small, Express-independent,
// directly-testable function - buildRawActionChatCompletionRequest() - exercised here directly with
// real on-disk fixtures, the same way chat-completion-generation-input.test.js and
// text-completions.test.js test their own real logic.
//
// The assistant-reply-persistence addition (wired into the single shared non-streaming response
// point of the default/legacy inline OpenAI/custom dispatch block) DOES need a real route-level
// exercise - there is no way to observe `pendingAssistantPersist` being read from outside the route
// handler otherwise. A minimal harness is built here, identical in spirit to
// text-completions.test.js's own: mount the real `router` on a real `express` app (with a tiny
// middleware standing in for auth middleware's `request.user.directories`), listen on an ephemeral
// port, and point a SECOND real `http` server (standing in for the chat-completion backend) at it via
// `oai_settings.chat_completion_source: 'custom'` + `custom_url` in the settings fixture below - both
// real network I/O, no mocking framework.
const { router, buildRawActionChatCompletionRequest } = await import('./chat-completions.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { saveChatToTree, loadBranch, appendMessages, getAncestorPath, getAlternatives, disposeMessageTreeStores } = await import('../../message-tree-db.js');
const { writeSecret, SECRET_KEYS } = await import('../secrets.js');
const { registerServerTool, unregisterServerTool } = await import('../../server-tools.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-completions-raw-action-test-'));
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
            name,
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            character_version: '',
            creator_notes: '',
            alternate_greetings: [],
            extensions: {},
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

async function run() {
    writeAllSettings(directories, buildSettingsFixture());
    const avatar = writeCharacter('Rex.png', {
        name: 'Rex',
        description: 'Rex is a {{char}}.',
        data: { name: 'Rex', description: 'Rex is a {{char}}.', first_mes: 'Hi, I am Rex.' },
    });

    const ownerId = avatar;
    // `branchName` here is ONLY message-tree-db.js's own label/bookmark concept - a real, still-
    // supported, unrelated primitive. It is NOT a raw-action request field anymore (see
    // buildRawActionChatCompletionRequest()'s own ADDRESSING MODEL doc comment) - every raw-action
    // call below resolves and passes the real `node_id` (a leaf id from `loadBranch()`) instead.
    const branchName = 'main-chat';
    await saveChatToTree(directories, ownerId, branchName, [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        { name: 'Tester', is_user: true, mes: 'Hi Rex, nice to meet you.', send_date: 2, extra: {} },
        { name: 'Rex', is_user: false, mes: 'Likewise!', send_date: 3, extra: {} },
    ]);
    const mainBranchInfo = await loadBranch(directories, ownerId, branchName);
    const mainLeafId = mainBranchInfo.branch.leaf_id;

    // --- happy path: a new user message on an existing conversation, addressed by its real node_id ---
    const built = await buildRawActionChatCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, nodeId: mainLeafId,
        type: 'normal', userMessageText: 'What happens next, Rex?',
    });

    assert.equal(built.settings.chat_completion_source, 'custom', 'settings resolves for real from oai_settings');
    assert.equal(built.name1, 'Tester', 'name1 resolves from settings.json username, same as the orchestrator input');
    assert.equal(built.name2, 'Rex');
    assert.ok(built.anchorNodeId, 'anchorNodeId resolves to the real leaf of the loaded branch');

    const branchBeforeAppend = await loadBranch(directories, ownerId, branchName);
    assert.equal(built.anchorNodeId, branchBeforeAppend.branch.leaf_id, 'anchorNodeId is exactly the given node_id\'s real leaf_id');
    assert.equal(built.anchorNodeId, mainLeafId, 'anchorNodeId is exactly the given node_id, unchanged from before');

    assert.ok(built.params && typeof built.params === 'object', 'params (generate_data) is a real object');
    assert.equal(built.params.model, 'test-model', 'params.model is the resolved chat-completion model, matching getChatCompletionModel()');
    assert.equal(built.params.chat_completion_source, 'custom');
    assert.ok(Array.isArray(built.params.messages), 'params.messages is the real, prepared chat-completion message array');
    const joined = built.params.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.ok(joined.includes('Hello there, traveler.'), 'the real loaded chat history made it into the prepared messages');
    assert.ok(joined.includes('What happens next, Rex?'), 'the raw user_message made it into the prepared messages');

    // --- persistence: the anchorNodeId this function resolves is really appendable-after ---
    const appendResult = await appendMessages(directories, ownerId, built.anchorNodeId, [
        { name: built.name1, is_user: true, mes: 'What happens next, Rex?', extra: {}, send_date: Date.now() },
    ]);
    assert.equal(appendResult.ok, true, 'appendMessages() accepts the resolved anchorNodeId as a real anchor');
    const branchAfterAppend = await loadBranch(directories, ownerId, branchName);
    assert.equal(branchAfterAppend.messages.length, 4, 'the persisted user message is now part of the real loaded branch');
    assert.equal(branchAfterAppend.messages[3].mes, 'What happens next, Rex?');

    // --- continue: no userMessageText, still resolves and assembles from the real history,
    // addressed by the real current leaf's node_id ---
    const continued = await buildRawActionChatCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, nodeId: branchAfterAppend.branch.leaf_id, type: 'continue', isContinue: true,
    });
    const continuedJoined = continued.params.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.ok(continuedJoined.includes('Likewise!'), 'continue resolves from the real existing history with no new message appended');
    assert.equal(continued.anchorNodeId, branchAfterAppend.branch.leaf_id, 'the continue anchor is the real current leaf');
    assert.equal(continued.anchorContent?.mes, 'What happens next, Rex?', 'anchorContent is the anchor\'s real, current, unmodified content (the real leaf at this point in the test, appended above) - exactly what the route\'s is_continue edit needs as "oldText"');

    // --- error handling: missing owner_id ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, nodeId: mainLeafId,
        }),
        /owner_id is required/,
    );

    // --- error handling: unknown character ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: 'NoSuchCharacter.png', ownerId, nodeId: mainLeafId,
        }),
        /Character not found/,
    );

    // --- error handling: unknown node ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, ownerId, nodeId: 'no-such-node-id',
        }),
        /Chat node not found/,
    );

    // --- error handling: node_id key entirely absent (not even explicit null) - loud failure
    // instead of a silent wrong-guess (see buildRawActionChatCompletionRequest()'s own ADDRESSING
    // MODEL doc comment). ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, ownerId,
        }),
        /node_id is required \(pass null explicitly for a brand-new, empty conversation\)/,
    );

    // --- error handling: node_id: null on an owner that ALREADY has real history - must be a real,
    // reportable error, never a silent guess at "the current leaf". ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, ownerId, nodeId: null,
        }),
        /node_id is required: this character\/group already has an existing conversation/,
    );

    // --- happy path: node_id: null on a GENUINELY BRAND-NEW character with zero prior messages -
    // the ONLY case where omitting a real node id is safe. Resolves via the owner's own anchor to an
    // empty chat, and still produces a real, appendable anchorNodeId. ---
    const freshAvatar = writeCharacter('Fresh.png', {
        name: 'Fresh',
        description: 'Fresh is a brand-new character with no chat history yet.',
        data: { name: 'Fresh', description: 'Fresh is a brand-new character with no chat history yet.', first_mes: 'Hello, this is Fresh.' },
    });
    const builtFresh = await buildRawActionChatCompletionRequest(directories, {
        characterAvatar: freshAvatar, ownerId: freshAvatar, nodeId: null,
        type: 'normal', userMessageText: 'Hi Fresh, this is our first message ever.',
    });
    assert.ok(builtFresh.anchorNodeId, 'a genuinely new, empty conversation still resolves to a real, appendable anchor node id');
    const freshJoined = builtFresh.params.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.ok(!freshJoined.includes('Hello there, traveler.'), 'no unrelated prior history (Rex\'s) leaked into a brand-new character\'s resolved, empty chat');
    assert.ok(freshJoined.includes('Hi Fresh, this is our first message ever.'), 'the raw user_message for this turn still made it into the prepared messages even though the resolved prior history was empty');
    const freshAppendResult = await appendMessages(directories, freshAvatar, builtFresh.anchorNodeId, [
        { name: builtFresh.name1, is_user: true, mes: 'Hi Fresh, this is our first message ever.', extra: {}, send_date: Date.now() },
    ]);
    assert.equal(freshAppendResult.ok, true, 'the anchor-resolved node id for a brand-new conversation is a real, appendable node');

    // --- error handling: missing character/group (nodeId irrelevant - the character/group check
    // runs first) ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            ownerId, nodeId: mainLeafId,
        }),
        /character_avatar or group_id is required/,
    );

    // --- route-level: non-streaming raw-action /generate persists the assistant reply for real ---
    async function startFakeBackend(handler) {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => handler(req, res, body));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        return { server, url: `http://127.0.0.1:${server.address().port}` };
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

    async function postGenerate(app, body) {
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            return { status: res.status, data };
        } finally {
            // Without forcing idle keep-alive sockets closed, server.close() only resolves once the
            // client's persistent HTTP/1.1 connection times out on its own (Node's default
            // keepAliveTimeout) - which would otherwise stall every subsequent test in this same
            // process for several seconds each, for no reason relevant to what's under test here.
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    /** Like postGenerate(), but for a streaming request: returns the raw response status/body text, unparsed - so the test can assert on the literal bytes the client received. */
    async function postGenerateStream(app, body) {
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const bodyText = await res.text();
            return { status: res.status, bodyText };
        } finally {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    /** Polls `check()` until it returns truthy or `timeoutMs` elapses - streaming persistence completes asynchronously, after the HTTP response to the client has already fully ended, so tests observe it by polling rather than assuming a fixed ordering. */
    async function waitFor(check, { timeoutMs = 2000, intervalMs = 10 } = {}) {
        const deadline = Date.now() + timeoutMs;
        for (; ;) {
            const result = await check();
            if (result) return result;
            if (Date.now() > deadline) {
                throw new Error('waitFor() timed out waiting for condition to become true');
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
    }

    /** Starts a fake backend that emits a real OpenAI-Chat-Completions-shaped SSE stream (`choices[0].delta.content` chunks), ending with `data: [DONE]\n\n`. */
    async function startFakeSseBackend(textChunks) {
        const sseBody = textChunks.map(text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
        return { ...await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(sseBody);
        }), expectedBody: sseBody };
    }

    /**
     * Like pointBackendAt(), but also flips on `oai_settings.function_calling` (and a real, allowed
     * `custom_prompt_post_processing` value) so `isToolCallingSupported()`
     * (src/chat-completion-tool-capabilities.js) - and therefore `canUseTools` inside
     * `prepareOpenAIMessages()`/`populateChatHistory()` - resolves true for these requests. Without
     * this, a persisted `extra.tool_invocations` turn would NOT be replayed as a real tool-call/
     * tool-result turn on the next round (it would instead fall through to the plain-assistant-text
     * path in `populateChatHistory()`), which would break the server-tool-calling round-trip tests
     * below. Kept as its own helper (not folded into `pointBackendAt()`) so every OTHER existing test
     * in this file keeps exercising the (much more common) `function_calling: false` default,
     * unaffected by this addition.
     */
    function pointBackendAtWithToolsEnabled(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.custom_url = url;
        settings.oai_settings.function_calling = true;
        settings.oai_settings.custom_prompt_post_processing = '';
        writeAllSettings(directories, settings);
    }

    function pointBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.custom_url = url;
        writeAllSettings(directories, settings);
    }

    /** Routes a raw-action request to sendClaudeRequest() via a real `reverse_proxy` override - the exact same mechanism a real self-hosted Claude-compatible proxy would use. */
    function pointClaudeBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'claude';
        settings.oai_settings.claude_model = 'claude-test-model';
        settings.oai_settings.reverse_proxy = url;
        settings.oai_settings.proxy_password = 'test-claude-proxy-password';
        writeAllSettings(directories, settings);
    }

    /** Routes a raw-action request to sendMakerSuiteRequest() via a real `reverse_proxy` override. */
    function pointMakerSuiteBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'makersuite';
        settings.oai_settings.google_model = 'gemini-test-model';
        settings.oai_settings.reverse_proxy = url;
        settings.oai_settings.proxy_password = 'test-makersuite-proxy-password';
        writeAllSettings(directories, settings);
    }

    /** Routes a raw-action request to sendMistralAIRequest() via a real `reverse_proxy` override. */
    function pointMistralBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'mistralai';
        settings.oai_settings.mistralai_model = 'mistral-test-model';
        settings.oai_settings.reverse_proxy = url;
        settings.oai_settings.proxy_password = 'test-mistral-proxy-password';
        writeAllSettings(directories, settings);
    }

    /**
     * Routes a raw-action request to sendAI21Request() - sendAI21Request has NO reverse-proxy support
     * at all (see the `canMockAi21Backend` comment near the top of this file), so this instead (a)
     * writes a real secret (sendAI21Request reads it via readSecret(), unlike the other three, which
     * accept `proxy_password` instead) and (b) points the module-level `ai21FakeBackendUrl` the
     * node-fetch reroute mock reads. Only meaningful when `canMockAi21Backend` is true - callers must
     * check that themselves and skip the AI21 test(s) otherwise.
     */
    function pointAI21BackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'ai21';
        settings.oai_settings.ai21_model = 'jamba-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.AI21, 'test-ai21-key');
        ai21FakeBackendUrl = url;
    }

    /** Routes a raw-action request to sendDeepSeekRequest() via a real `reverse_proxy` override - DeepSeek IS in chat-completion-generation-data.js's own `proxySupportedSources`, confirmed by reading that file, and sendDeepSeekRequest itself reads `request.body.reverse_proxy`/`proxy_password`. */
    function pointDeepSeekBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'deepseek';
        settings.oai_settings.deepseek_model = 'deepseek-test-model';
        settings.oai_settings.reverse_proxy = url;
        settings.oai_settings.proxy_password = 'test-deepseek-proxy-password';
        writeAllSettings(directories, settings);
    }

    /** Routes a raw-action request to sendXaiRequest() via a real `reverse_proxy` override - xAI IS in `proxySupportedSources` too, and sendXaiRequest itself reads `request.body.reverse_proxy`/`proxy_password`. */
    function pointXaiBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'xai';
        settings.oai_settings.xai_model = 'grok-test-model';
        settings.oai_settings.reverse_proxy = url;
        settings.oai_settings.proxy_password = 'test-xai-proxy-password';
        writeAllSettings(directories, settings);
    }

    /**
     * Routes a raw-action request to sendCohereRequest() - sendCohereRequest has NO reverse-proxy
     * support at all (see the `canMockAi21Backend` comment near the top of this file), so this instead
     * (a) writes a real secret (sendCohereRequest reads it via readSecret()) and (b) points the
     * module-level `cohereFakeBackendUrl` the node-fetch reroute mock reads. Only meaningful when
     * `canMockAi21Backend` is true - callers must check that themselves and skip the Cohere test(s)
     * otherwise.
     */
    function pointCohereBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'cohere';
        settings.oai_settings.cohere_model = 'command-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.COHERE, 'test-cohere-key');
        cohereFakeBackendUrl = url;
    }

    /**
     * Routes a raw-action request to sendAimlapiRequest() - sendAimlapiRequest has NO reverse-proxy
     * support at all (same situation as sendCohereRequest/sendAI21Request above), so this instead (a)
     * writes a real secret (sendAimlapiRequest reads it via readSecret()) and (b) points the
     * module-level `aimlapiFakeBackendUrl` the node-fetch reroute mock reads. Only meaningful when
     * `canMockAi21Backend` is true - callers must check that themselves and skip the AI/ML API test(s)
     * otherwise.
     */
    function pointAimlapiBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'aimlapi';
        settings.oai_settings.aimlapi_model = 'aimlapi-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.AIMLAPI, 'test-aimlapi-key');
        aimlapiFakeBackendUrl = url;
    }

    /**
     * Routes a raw-action request to sendChutesRequest() - sendChutesRequest has NO reverse-proxy
     * support at all (same situation as sendCohereRequest/sendAI21Request/sendAimlapiRequest above), so
     * this instead (a) writes a real secret (sendChutesRequest reads it via readSecret()) and (b)
     * points the module-level `chutesFakeBackendUrl` the node-fetch reroute mock reads. Only
     * meaningful when `canMockAi21Backend` is true - callers must check that themselves and skip the
     * Chutes test(s) otherwise.
     */
    function pointChutesBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'chutes';
        settings.oai_settings.chutes_model = 'chutes-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.CHUTES, 'test-chutes-key');
        chutesFakeBackendUrl = url;
    }

    /**
     * Routes a raw-action request to sendMinimaxRequest() - sendMinimaxRequest has NO reverse-proxy
     * support at all (same situation as the other no-override providers above), so this instead (a)
     * writes a real secret (sendMinimaxRequest reads it via readSecret()) and (b) points the
     * module-level `minimaxFakeBackendUrl` the node-fetch reroute mock reads (the mock reroutes BOTH
     * the global `API_MINIMAX` and CN `API_MINIMAX_CN` origins - this leaves `minimax_endpoint` at its
     * default, targeting the global host). Only meaningful when `canMockAi21Backend` is true - callers
     * must check that themselves and skip the MiniMax test(s) otherwise.
     */
    function pointMinimaxBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'minimax';
        settings.oai_settings.minimax_model = 'minimax-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.MINIMAX, 'test-minimax-key');
        minimaxFakeBackendUrl = url;
    }

    /**
     * Routes a raw-action request to sendElectronHubRequest() - sendElectronHubRequest has NO
     * reverse-proxy support at all (same situation as the other no-override providers above), so this
     * instead (a) writes a real secret (sendElectronHubRequest reads it via readSecret()) and (b)
     * points the module-level `electronhubFakeBackendUrl` the node-fetch reroute mock reads. Only
     * meaningful when `canMockAi21Backend` is true - callers must check that themselves and skip the
     * Electron Hub test(s) otherwise.
     */
    function pointElectronHubBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'electronhub';
        settings.oai_settings.electronhub_model = 'electronhub-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.ELECTRONHUB, 'test-electronhub-key');
        electronhubFakeBackendUrl = url;
    }

    /**
     * Routes a raw-action request to sendAzureOpenAIRequest() via a real `azure_base_url` override -
     * UNLIKE the six providers above, sendAzureOpenAIRequest's own request-building already targets a
     * fully caller-supplied endpoint (`azure_base_url`/`azure_deployment_name`/`azure_api_version` -
     * see sendAzureOpenAIRequest's own `url`/`config` construction), so no `mock.module()` reroute is
     * needed here at all - this works identically whether or not `canMockAi21Backend` is true.
     */
    function pointAzureOpenAIBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'azure_openai';
        settings.oai_settings.azure_openai_model = 'azure-test-model';
        settings.oai_settings.azure_base_url = url;
        settings.oai_settings.azure_deployment_name = 'test-deployment';
        settings.oai_settings.azure_api_version = '2024-02-01';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.AZURE_OPENAI, 'test-azure-openai-key');
    }

    // (a) a real non-streaming generation appends the assistant's reply onto the tree, chained after
    // the just-persisted user message, with the correct name/is_user.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Rex says hello back.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'One more time, Rex?', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'Rex says hello back.' } }] }, 'response body reaches the client unmodified');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply were appended');
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'One more time, Rex?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back.', 'the assistant reply text was extracted from data.choices[0].message.content and appended');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex', 'the assistant message uses name2 (the character\'s display name), not name1');
    }

    // (b) a failed backend response (non-2xx) does NOT append an assistant reply (the user message,
    // already committed as "the user really sent this" before dispatch, is unaffected either way).
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'backend exploded' }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Are you there, Rex?', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the error branch still responds (with an error body), not a thrown exception');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was appended - no assistant reply for a failed generation');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Are you there, Rex?');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].is_user, true);
    }

    // (c) is_impersonate: true - NEITHER the (spuriously passed) user_message NOR the generated reply
    // may ever land on the tree, even though the backend call succeeds and returns real text. The
    // generated text must still reach the client unchanged.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'I think you should go north.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;
        const leafBefore = branchBefore.branch.leaf_id;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'impersonate', is_impersonate: true,
            // Deliberately included even though a real client never sends this for impersonate - the
            // route must defensively ignore it regardless.
            user_message: 'This should never be persisted.',
            stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'I think you should go north.' } }] }, 'the generated text still reaches the client unmodified');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no message (user or assistant) was appended for is_impersonate: true');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the branch leaf/ancestor path is completely unchanged');
    }

    // (d) type: 'quiet' - same assertion as (c): no tree mutation on either side, response still
    // forwarded to the client unchanged.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Meta/background result.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;
        const leafBefore = branchBefore.branch.leaf_id;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'quiet',
            // Also deliberately included to verify the defensive skip - a real quiet call has no
            // fresh user text to send either.
            user_message: 'This should never be persisted.',
            stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'Meta/background result.' } }] }, 'the generated text still reaches the client unmodified');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no message (user or assistant) was appended for type: \'quiet\'');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the branch leaf/ancestor path is completely unchanged');
    }

    // (e) is_swipe: true - the reply must land as a real SIBLING alongside the swiped message (under
    // ITS real parent), not a CHILD chained after it, and the new sibling must become the active path
    // (selectDefaultChild()). Uses its own small, dedicated branch so it isn't coupled to the mutating
    // shared `branchName` state above.
    {
        const swipeBranch = 'swipe-chat';
        await saveChatToTree(directories, ownerId, swipeBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there!', send_date: 2, extra: {} },
        ]);

        const branchBefore = await loadBranch(directories, ownerId, swipeBranch);
        const swipedNodeId = branchBefore.branch.leaf_id;
        const swipedAncestry = await getAncestorPath(directories, swipedNodeId);
        const parentNodeId = swipedAncestry[swipedAncestry.length - 2].node_id;

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Greetings, traveler!' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: swipedNodeId,
            type: 'swipe', is_swipe: true, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'Greetings, traveler!' } }] }, 'the generated text still reaches the client unmodified');

        const branchAfter = await loadBranch(directories, ownerId, swipeBranch);
        assert.notEqual(branchAfter.branch.leaf_id, swipedNodeId, 'the branch is now positioned on a DIFFERENT node - the new alternative');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Greetings, traveler!', 'the new alternative is now the active/default path');

        // (a) a new SIBLING was added under the correct parent - not a child of the swiped message.
        const newNodeId = branchAfter.branch.leaf_id;
        const newAncestry = await getAncestorPath(directories, newNodeId);
        assert.equal(newAncestry.length, swipedAncestry.length, 'the new alternative sits at the SAME depth as the swiped message (a sibling), not one deeper (a child)');
        assert.equal(newAncestry[newAncestry.length - 2].node_id, parentNodeId, 'the new alternative shares the swiped message\'s real parent');

        const alternatives = await getAlternatives(directories, swipedNodeId);
        assert.equal(alternatives.total, 2, 'the swiped message and the new alternative are now real siblings under the same parent');
        assert.ok(alternatives.alternatives.some(a => a.node_id === swipedNodeId && a.mes === 'Hello there!'), '(b) the swiped message\'s own original content is completely unchanged');
        assert.ok(alternatives.alternatives.some(a => a.node_id === newNodeId && a.mes === 'Greetings, traveler!'));

        // (c) selectDefaultChild() really was called - the new alternative is the one reported as
        // currently selected.
        const parentAlternatives = await getAlternatives(directories, newNodeId);
        assert.equal(parentAlternatives.selected, parentAlternatives.alternatives.findIndex(a => a.node_id === newNodeId), 'the new alternative is the one getAlternatives() reports as currently selected');
    }

    // (f) type: 'regenerate' maps onto the SAME is_swipe-driven persistence as 'swipe' - a real client
    // sends `is_swipe: true` for both (see public/script.js's own `isSwipe` local), so the route never
    // distinguishes between the two literal `type` strings for persistence purposes.
    {
        const regenBranch = 'regenerate-chat';
        await saveChatToTree(directories, ownerId, regenBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, regenerate test.', send_date: 101, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, regenerate test!', send_date: 102, extra: {} },
        ]);

        const branchBefore = await loadBranch(directories, ownerId, regenBranch);
        const swipedNodeId = branchBefore.branch.leaf_id;

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A completely new reply.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: swipedNodeId,
            type: 'regenerate', is_swipe: true, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        const branchAfter = await loadBranch(directories, ownerId, regenBranch);
        assert.notEqual(branchAfter.branch.leaf_id, swipedNodeId, 'regenerate also produced a sibling alternative, now selected as current');
        const alternatives = await getAlternatives(directories, swipedNodeId);
        assert.equal(alternatives.total, 2, 'regenerate did not chain a child - the original message still has exactly one real sibling');
    }

    // (g) is_continue: true - the reply must EDIT the existing leaf node's text in place (oldText +
    // newText), on the SAME node id, at the SAME position in the tree - never a new node.
    {
        const continueBranch = 'continue-chat';
        await saveChatToTree(directories, ownerId, continueBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Tell me a story, Rex.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Once upon a time,', send_date: 2, extra: {} },
        ]);

        const branchBefore = await loadBranch(directories, ownerId, continueBranch);
        const messageCountBefore = branchBefore.messages.length;
        const leafBefore = branchBefore.branch.leaf_id;

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ' there was a brave adventurer.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: leafBefore,
            type: 'continue', is_continue: true, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: ' there was a brave adventurer.' } }] }, 'the generated text still reaches the client unmodified');

        const branchAfter = await loadBranch(directories, ownerId, continueBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no new node (user or assistant) was created - continue only edits the existing leaf');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the SAME node is still the leaf - editMessage() edits in place, it does not reparent/replace the node');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Once upon a time, there was a brave adventurer.', 'the stored text is now oldText + newText, on the same node, at the same position');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].name, 'Rex');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].is_user, false);
    }

    // (h) is_continue: true combined with a REAL (non-empty) user_message - see text-completions.test.js's
    // own identical case for the full rationale (public/script.js's own Generate() does not exempt
    // 'continue' from its send-textarea-as-user_message condition). The real user message must still be
    // committed, but the assistant reply must NOT be persisted anywhere (neither spliced onto the
    // original leaf, nor appended as a plain new child) - `continueUserTextConflict` skips it entirely.
    {
        const continueWithUserTextBranch = 'continue-with-user-text-chat';
        await saveChatToTree(directories, ownerId, continueWithUserTextBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Tell me a story, Rex.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Once upon a time,', send_date: 2, extra: {} },
        ]);

        const branchBefore = await loadBranch(directories, ownerId, continueWithUserTextBranch);
        const messageCountBefore = branchBefore.messages.length;
        const originalLeafId = branchBefore.branch.leaf_id;

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ' this should NOT be persisted anywhere.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: originalLeafId,
            type: 'continue', is_continue: true,
            user_message: 'Wait, actually - tell me about dragons instead.',
            stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);

        const branchAfter = await loadBranch(directories, ownerId, continueWithUserTextBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was added - the generated reply was NOT persisted anywhere in this guarded combination');
        const newLeaf = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(newLeaf.mes, 'Wait, actually - tell me about dragons instead.');
        assert.equal(newLeaf.is_user, true);

        const originalNode = (await getAlternatives(directories, originalLeafId)).alternatives.find(a => a.node_id === originalLeafId);
        assert.equal(originalNode.mes, 'Once upon a time,', 'the original assistant leaf\'s text is byte-for-byte unchanged - continueUserTextConflict correctly skipped persisting the reply');
    }

    // (j) GROUP CHAT support (this follow-up task): `character_avatar` (the specific responding member)
    // AND `group_id` (the group's own addressing) given TOGETHER - the shape public/script.js's widened
    // chat-completion raw-action gate now sends for a group turn, mirroring text-completions.test.js's
    // own group test (case (j) there) with the identical real on-disk fixture conventions: a real
    // group.json (matching the exact shape src/endpoints/groups.js's own `/create` route writes), a
    // real chat branch OWNED BY THE GROUP'S id (not either member's avatar), and two real member
    // character cards with deliberately distinct `description`s so a wrong-member/uncombined-card
    // mixup would be detectable.
    {
        const nova = writeCharacter('Nova.png', {
            name: 'Nova',
            description: 'Nova is a stoic starship engineer.',
            data: { name: 'Nova', description: 'Nova is a stoic starship engineer.', first_mes: 'Systems nominal.' },
        });
        const zephyr = writeCharacter('Zephyr.png', {
            name: 'Zephyr',
            description: 'Zephyr is a chaotic weather spirit.',
            data: { name: 'Zephyr', description: 'Zephyr is a chaotic weather spirit.', first_mes: 'Winds are shifting!' },
        });

        const groupId = 'test-group-1';
        const groupChatId = 'test-group-1-chat';
        /** Exact shape src/endpoints/groups.js's own POST /create route writes to <id>.json.
         * generation_mode: 1 (group_generation_mode.APPEND) so computeGroupCards() actually produces
         * COMBINED cards - see chat-completion-generation-input.test.js's own identical fixture note. */
        const groupMetadata = {
            id: groupId,
            name: 'Adventuring Party',
            members: [nova, zephyr],
            avatar_url: 'img/ai4.png',
            allow_self_responses: false,
            activation_strategy: 0,
            generation_mode: 1,
            disabled_members: [],
            fav: false,
            chat_id: groupChatId,
            chats: [groupChatId],
            auto_mode_delay: 5,
            generation_mode_join_prefix: '',
            generation_mode_join_suffix: '',
        };
        fs.writeFileSync(path.join(groupsDir, `${groupId}.json`), JSON.stringify(groupMetadata, null, 4));

        // A chat branch owned by the GROUP's own id - not either member's avatar - with one message
        // from each member already in history, matching a real multi-member group conversation.
        await saveChatToTree(directories, groupId, groupChatId, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hello, party!', send_date: 1, extra: {} },
            { name: 'Zephyr', is_user: false, mes: 'Winds are shifting!', send_date: 2, extra: {} },
        ]);

        const groupLeafId = (await loadBranch(directories, groupId, groupChatId)).branch.leaf_id;

        // --- assembly: buildRawActionChatCompletionRequest() with BOTH characterAvatar (Nova, the
        // member actually responding this turn) AND groupId (the group) set together, addressed by
        // the group chat's real node_id. ---
        const builtGroup = await buildRawActionChatCompletionRequest(directories, {
            characterAvatar: nova, groupId, ownerId: groupId, nodeId: groupLeafId,
            type: 'normal', userMessageText: 'Nova, status report?',
        });

        assert.equal(builtGroup.name2, 'Nova', 'name2 resolves to the SPECIFIC RESPONDING MEMBER (characterAvatar), not the group\'s own name, even though groupId is also set');
        assert.ok(Array.isArray(builtGroup.params.messages), 'params.messages is the real, prepared chat-completion message array');
        const groupJoined = builtGroup.params.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
        assert.ok(groupJoined.includes('Nova is a stoic starship engineer.'), 'the assembled messages reflect the COMBINED group cards (Nova\'s own description)');
        assert.ok(groupJoined.includes('Zephyr is a chaotic weather spirit.'), 'the assembled messages ALSO reflect the OTHER member\'s combined-card description - proving real combining, not just the responding member\'s own uncombined card');
        assert.ok(groupJoined.includes('Zephyr: Winds are shifting!'), 'the real group chat HISTORY is name-prefixed for the non-responding member, per real isGroup-driven name-prefixing');
        assert.ok(groupJoined.includes('Nova, status report?'), 'the raw user_message made it into the prepared messages');

        // --- persistence: a real, route-level raw-action /generate call persists BOTH sides against
        // the GROUP's own owner_id, chained under the group's real chat branch. ---
        const branchBeforeGroup = await loadBranch(directories, groupId, groupChatId);
        const messageCountBeforeGroup = branchBeforeGroup.messages.length;

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'All systems nominal, Captain.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: groupId, character_avatar: nova, group_id: groupId, node_id: branchBeforeGroup.branch.leaf_id,
            type: 'normal', user_message: 'Nova, status report?', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the group raw-action generation succeeds');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'All systems nominal, Captain.' } }] }, 'response body reaches the client unmodified');

        const branchAfterGroup = await loadBranch(directories, groupId, groupChatId);
        assert.equal(branchAfterGroup.messages.length, messageCountBeforeGroup + 2, 'both the user message and the assistant reply were persisted under the GROUP\'s own owner_id');
        const [userMsg, assistantMsg] = branchAfterGroup.messages.slice(-2);
        assert.equal(userMsg.mes, 'Nova, status report?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'All systems nominal, Captain.');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Nova', 'the persisted assistant message is attributed to the SPECIFIC RESPONDING MEMBER (name2/Nova), not the group\'s own name or the other member (Zephyr)');

        // Sanity: none of this leaked into the single-character owner namespace used elsewhere in this file.
        const rexBranchUnaffected = await loadBranch(directories, ownerId, branchName);
        assert.ok(rexBranchUnaffected.messages.every(m => m.mes !== 'All systems nominal, Captain.'), 'the group turn did not leak into an unrelated single-character owner namespace');
    }

    // (i) STREAMING raw-action, plain reply: a real OpenAI-Chat-Completions-shaped SSE stream
    // (`data: {"choices":[{"delta":{"content":"..."}}]}`, ending `data: [DONE]`) is teed - the
    // client-facing bytes must be byte-for-byte identical to what the fake backend sent, AND the
    // full concatenated text must land on the tree afterward (persistence happens asynchronously,
    // after the HTTP response to the client has already ended - see forwardAndPersistSseText()'s own
    // doc comment in chat-completions.js - so this polls via waitFor() rather than asserting
    // immediately after the fetch resolves).
    {
        const streamBranch = 'stream-plain-chat';
        await saveChatToTree(directories, ownerId, streamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const fakeBackend = await startFakeSseBackend(['Rex ', 'says ', 'hello ', 'back, ', 'streamed.']);
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, streamBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Say hi, streamed.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, fakeBackend.expectedBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent - the teeing did not alter, buffer, or reorder anything');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, streamBranch);
            return branch.messages.length === messageCountBefore + 2 ? branch : null;
        });
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, streamed.');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back, streamed.', 'the full text, accumulated across every SSE chunk, was persisted - not just the last chunk');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (i-2) STREAMING raw-action, is_swipe: true - same SSE teeing, but must land as a real SIBLING
    // alternative (addAlternatives() + selectDefaultChild()), exactly like the non-streaming swipe
    // case (e) above - proving persistAssistantReply() drives the streaming path through the exact
    // same shared branching, not a re-implementation of it. Uses its own DISTINCT preceding message
    // text - see (e)'s/(f)'s own reasoning for why (message-tree-db.js structurally shares nodes
    // across branches for the same owner whenever their preceding content is byte-identical).
    {
        const streamSwipeBranch = 'stream-swipe-chat';
        await saveChatToTree(directories, ownerId, streamSwipeBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, streaming swipe test.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, streaming swipe test!', send_date: 2, extra: {} },
        ]);

        const branchBefore = await loadBranch(directories, ownerId, streamSwipeBranch);
        const swipedNodeId = branchBefore.branch.leaf_id;

        const fakeBackend = await startFakeSseBackend(['Greetings, ', 'traveler, ', 'streamed!']);
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'swipe', is_swipe: true, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, fakeBackend.expectedBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, streamSwipeBranch);
            return branch.branch.leaf_id !== swipedNodeId ? branch : null;
        });
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Greetings, traveler, streamed!');
        const alternatives = await getAlternatives(directories, swipedNodeId);
        assert.equal(alternatives.total, 2, 'the streamed swipe produced a real sibling alternative, not a chained child');
        assert.ok(alternatives.alternatives.some(a => a.mes === 'Hello there, streaming swipe test!'), 'the original swiped message is unchanged');
    }

    // (i-3) STREAMING raw-action, is_continue: true - same SSE teeing, but must EDIT the existing
    // leaf in place (oldText + newText) via editMessage(), exactly like the non-streaming continue
    // case (g) above. Uses its own DISTINCT preceding text - continue's editMessage() mutates a
    // potentially-SHARED leaf node in place, so reusing (g)/(h)'s exact text here would edit THEIR
    // fixture's node instead of a clean one of this test's own.
    {
        const streamContinueBranch = 'stream-continue-chat';
        await saveChatToTree(directories, ownerId, streamContinueBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Tell me a streaming story, Rex.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Once upon a streaming time,', send_date: 2, extra: {} },
        ]);

        const branchBefore = await loadBranch(directories, ownerId, streamContinueBranch);
        const leafBefore = branchBefore.branch.leaf_id;
        const messageCountBefore = branchBefore.messages.length;

        const fakeBackend = await startFakeSseBackend([' there was ', 'a brave, ', 'streamed adventurer.']);
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'continue', is_continue: true, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, fakeBackend.expectedBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, streamContinueBranch);
            const leaf = branch.messages[branch.messages.length - 1];
            return leaf.mes === 'Once upon a streaming time, there was a brave, streamed adventurer.' ? branch : null;
        });
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no new node was created - the streamed continue only edited the existing leaf');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the SAME node is still the leaf');
    }

    // (i-4) A NON-raw-action streaming request (a connection_profile_id-less, owner_id-less legacy
    // request) must be COMPLETELY unaffected by the teeing mechanism: forwardAndPersistSseText()'s
    // own top-of-function guard (`if (!persist || ...)`) falls straight through to a plain, untouched
    // forwardFetchResponse() call - no listener is even attached in this case. Verified here by
    // asserting the client-facing bytes are still byte-for-byte identical to the fake backend's own
    // SSE stream, and that nothing was persisted anywhere.
    {
        const fakeBackend = await startFakeSseBackend(['This ', 'is ', 'a ', 'plain ', 'legacy ', 'stream.']);
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            // No owner_id/character_avatar/group_id/connection_profile_id - falls through to the
            // legacy/default branch, which only dispatches request.body through the shared block
            // completely unchanged.
            messages: [{ role: 'user', content: 'Legacy raw prompt, no raw-action fields.' }],
            model: 'test-model', chat_completion_source: 'custom', custom_url: fakeBackend.url, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, fakeBackend.expectedBody, 'a non-raw-action stream is forwarded byte-for-byte unchanged - pendingAssistantPersist stays null, so no teeing/accumulation/persistence logic ever runs for it');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'nothing was persisted onto any tree for a non-raw-action stream');
    }

    // (j) sendClaudeRequest, non-streaming: a real Messages-API-shaped response whose `content` array
    // deliberately carries a `type: 'thinking'` block BEFORE the real `type: 'text'` block - proving
    // persistence extracts only the real text block, never the thinking content (the existing,
    // untouched client-facing `responseText` still only reads `content[0]` - a pre-existing quirk,
    // unrelated to this task, left completely alone here; its own value is asserted below as evidence
    // that the client-visible reply is unaffected by this task's change).
    {
        const claudeBranch = 'claude-plain-chat';
        await saveChatToTree(directories, ownerId, claudeBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const claudeContent = [
            { type: 'thinking', thinking: 'The user wants a greeting back.' },
            { type: 'text', text: 'Rex says hello back, Claude-style.' },
        ];
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ content: claudeContent }));
        });
        pointClaudeBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, claudeBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Say hi, Claude.', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.deepEqual(data, { choices: [{ message: { content: claudeContent[0].text ?? '' } }], content: claudeContent }, 'the client-facing reply shape is exactly this function\'s own pre-existing (unmodified) content[0]-only wrapping');

        const branchAfter = await loadBranch(directories, ownerId, claudeBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, Claude.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, Claude-style.', 'only the real type: \'text\' block was persisted - the type: \'thinking\' block is completely absent from the persisted text');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (j-2) sendClaudeRequest, streaming: a real Messages-API SSE event sequence
    // (message_start/content_block_start/ping/content_block_delta.../content_block_stop/message_delta/
    // message_stop), including a `thinking_delta` event that must be excluded from the persisted text,
    // alongside the real `text_delta` events that must be included.
    {
        const claudeStreamBranch = 'claude-stream-chat';
        await saveChatToTree(directories, ownerId, claudeStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(directories, ownerId, claudeStreamBranch)).branch.leaf_id;

        const claudeSseEvents = [
            { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Thinking about a greeting...' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
            { type: 'ping' },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Rex ' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'says hi, ' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'streamed via Claude.' } },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
            { type: 'message_stop' },
        ];
        const claudeSseBody = claudeSseEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(claudeSseBody);
        });
        pointClaudeBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: 'Say hi, streamed Claude.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, claudeSseBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent - the teeing did not alter, buffer, or reorder anything');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, claudeStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Claude.', 'only text_delta chunks were accumulated - the thinking_delta event never contributed to the persisted text');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (k) sendMakerSuiteRequest, non-streaming: a real GenerateContentResponse-shaped body whose
    // `candidates[0].content.parts` deliberately carries a `thought: true` part BEFORE the real text
    // part - proving persistence reuses this function's own existing `!part.thought` filter (already
    // applied, unmodified, to the client-facing `responseText` too - both are asserted equal below).
    {
        const makerSuiteBranch = 'makersuite-plain-chat';
        await saveChatToTree(directories, ownerId, makerSuiteBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const geminiParts = [
            { thought: true, text: 'The user wants a greeting back.' },
            { text: 'Rex says hello back, Gemini-style.' },
        ];
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ candidates: [{ content: { parts: geminiParts, role: 'model' } }] }));
        });
        pointMakerSuiteBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, makerSuiteBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Say hi, Gemini.', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(data?.choices?.[0]?.message?.content, 'Rex says hello back, Gemini-style.', 'the client-facing reply already excluded the thought part - this function\'s own pre-existing, unmodified behavior');

        const branchAfter = await loadBranch(directories, ownerId, makerSuiteBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, Gemini.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, Gemini-style.', 'only the real, non-thought part was persisted');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (k-2) sendMakerSuiteRequest, streaming: real `alt=sse` chunks - each a FULL
    // GenerateContentResponse-shaped JSON payload carrying that chunk's own incremental
    // `candidates[0].content.parts` (verified against this function's own non-streaming parsing
    // above, which this reuses) - including one thought-only chunk that must be excluded.
    {
        const makerSuiteStreamBranch = 'makersuite-stream-chat';
        await saveChatToTree(directories, ownerId, makerSuiteStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(directories, ownerId, makerSuiteStreamBranch)).branch.leaf_id;

        const geminiChunks = [
            { candidates: [{ content: { parts: [{ thought: true, text: 'Thinking about a greeting...' }], role: 'model' } }] },
            { candidates: [{ content: { parts: [{ text: 'Rex ' }], role: 'model' } }] },
            { candidates: [{ content: { parts: [{ text: 'says hi, ' }], role: 'model' } }] },
            { candidates: [{ content: { parts: [{ text: 'streamed via Gemini.' }], role: 'model' } }] },
        ];
        const geminiSseBody = geminiChunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('');
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(geminiSseBody);
        });
        pointMakerSuiteBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: 'Say hi, streamed Gemini.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, geminiSseBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, makerSuiteStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Gemini.', 'the thought-only chunk never contributed to the persisted text');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (l) sendMistralAIRequest, non-streaming: a standard OpenAI-Chat-Completions-shaped body, sent
    // to the client completely unmodified (response.send(generateResponseJson) as-is, pre-existing
    // behavior) - asserted structurally identical, alongside the persisted reply.
    {
        const mistralBranch = 'mistral-plain-chat';
        await saveChatToTree(directories, ownerId, mistralBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const mistralBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, Mistral-style.' } }] };
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mistralBody));
        });
        pointMistralBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, mistralBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Say hi, Mistral.', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.deepEqual(data, mistralBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');

        const branchAfter = await loadBranch(directories, ownerId, mistralBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, Mistral.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, Mistral-style.');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (l-2) sendMistralAIRequest, streaming: standard OpenAI Chat-Completions delta SSE chunks.
    {
        const mistralStreamBranch = 'mistral-stream-chat';
        await saveChatToTree(directories, ownerId, mistralStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(directories, ownerId, mistralStreamBranch)).branch.leaf_id;

        const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via Mistral.']);
        pointMistralBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: 'Say hi, streamed Mistral.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, fakeBackend.expectedBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, mistralStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Mistral.');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (n) sendDeepSeekRequest, non-streaming: a standard OpenAI-Chat-Completions-shaped body, sent to
    // the client completely unmodified (response.send(generateResponseJson) as-is, pre-existing
    // behavior) - deliberately including a `reasoning_content` field alongside `content`, proving
    // persistence reads only the real `content` and never the separate reasoning field.
    {
        const deepseekBranch = 'deepseek-plain-chat';
        await saveChatToTree(directories, ownerId, deepseekBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const deepseekBody = { choices: [{ message: { role: 'assistant', reasoning_content: 'The user wants a greeting back.', content: 'Rex says hello back, DeepSeek-style.' } }] };
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(deepseekBody));
        });
        pointDeepSeekBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, deepseekBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Say hi, DeepSeek.', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.deepEqual(data, deepseekBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');

        const branchAfter = await loadBranch(directories, ownerId, deepseekBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, DeepSeek.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, DeepSeek-style.', 'only the real content field was persisted - reasoning_content is completely absent from the persisted text');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (n-2) sendDeepSeekRequest, streaming: standard OpenAI Chat-Completions delta SSE chunks,
    // deliberately including a `delta.reasoning_content`-only chunk that must be excluded.
    {
        const deepseekStreamBranch = 'deepseek-stream-chat';
        await saveChatToTree(directories, ownerId, deepseekStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(directories, ownerId, deepseekStreamBranch)).branch.leaf_id;

        const deepseekSseBody = [
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Thinking about a greeting...' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'Rex ' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'says hi, ' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'streamed via DeepSeek.' } }] })}\n\n`,
            'data: [DONE]\n\n',
        ].join('');
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(deepseekSseBody);
        });
        pointDeepSeekBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: 'Say hi, streamed DeepSeek.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, deepseekSseBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, deepseekStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via DeepSeek.', 'only delta.content chunks were accumulated - the reasoning_content-only chunk never contributed to the persisted text');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (o) sendXaiRequest, non-streaming: a standard OpenAI-Chat-Completions-shaped body, sent to the
    // client completely unmodified.
    {
        const xaiBranch = 'xai-plain-chat';
        await saveChatToTree(directories, ownerId, xaiBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const xaiBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, xAI-style.' } }] };
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(xaiBody));
        });
        pointXaiBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, xaiBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Say hi, xAI.', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.deepEqual(data, xaiBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');

        const branchAfter = await loadBranch(directories, ownerId, xaiBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, xAI.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, xAI-style.');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (o-2) sendXaiRequest, streaming: standard OpenAI Chat-Completions delta SSE chunks.
    {
        const xaiStreamBranch = 'xai-stream-chat';
        await saveChatToTree(directories, ownerId, xaiStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(directories, ownerId, xaiStreamBranch)).branch.leaf_id;

        const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via xAI.']);
        pointXaiBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: 'Say hi, streamed xAI.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, fakeBackend.expectedBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, xaiStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via xAI.');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (m)/(m-2)/(p)/(p-2)/(q)/(q-2) sendAI21Request/sendCohereRequest/sendAimlapiRequest,
    // non-streaming AND streaming - see the `canMockAi21Backend` comment near the top of this file for
    // exactly why this needs `node:test`'s `mock.module()` (unlike sendDeepSeekRequest/sendXaiRequest
    // above, none of these three have a reverse-proxy override at all) and why these tests skip
    // themselves, loudly, when that (currently experimental, opt-in-flag-gated) capability isn't
    // available in the running Node process - every other test in this file (including the four
    // provider tests directly above) runs identically either way.
    if (!canMockAi21Backend) {
        console.log('chat-completions.test.js: skipping sendAI21Request/sendCohereRequest/sendAimlapiRequest persistence tests - run with `node --experimental-test-module-mocks` to include them (see the canMockAi21Backend comment near the top of this file)');
    } else {
        // (m) non-streaming: a standard OpenAI-Chat-Completions-shaped body, sent to the client
        // completely unmodified (response.send(generateResponseJson) as-is, pre-existing behavior).
        {
            const ai21Branch = 'ai21-plain-chat';
            await saveChatToTree(directories, ownerId, ai21Branch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const ai21Body = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, AI21-style.' } }] };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(ai21Body));
            });
            pointAI21BackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(directories, ownerId, ai21Branch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Say hi, AI21.', stream: false,
            });
            fakeBackend.server.close();
            ai21FakeBackendUrl = null;

            assert.equal(status, 200);
            assert.deepEqual(data, ai21Body, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');

            const branchAfter = await loadBranch(directories, ownerId, ai21Branch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, AI21.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, AI21-style.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        // (m-2) streaming: standard OpenAI Chat-Completions delta SSE chunks.
        {
            const ai21StreamBranch = 'ai21-stream-chat';
            await saveChatToTree(directories, ownerId, ai21StreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(directories, ownerId, ai21StreamBranch)).branch.leaf_id;

            const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via AI21.']);
            pointAI21BackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyText } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: 'Say hi, streamed AI21.', stream: true,
            });
            fakeBackend.server.close();
            ai21FakeBackendUrl = null;

            assert.equal(status, 200);
            assert.equal(bodyText, fakeBackend.expectedBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(directories, ownerId, ai21StreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via AI21.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        // (p) sendCohereRequest, non-streaming: a real Cohere v2 chat-shaped response whose
        // `message.content` array deliberately carries a non-`text` block type alongside the real
        // `type: 'text'` block, plus a `tool_plan` field - proving persistence extracts only the real
        // text block(s), never falling back to `tool_plan` when real text content is present (this
        // function's own existing, unmodified client-facing `response.send(generateResponseJson)`
        // forwards the whole body as-is - asserted below as evidence the client-visible reply is
        // unaffected).
        {
            const cohereBranch = 'cohere-plain-chat';
            await saveChatToTree(directories, ownerId, cohereBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const cohereBody = { message: { role: 'assistant', tool_plan: 'I will just greet the user.', content: [{ type: 'text', text: 'Rex says hello back, Cohere-style.' }] } };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(cohereBody));
            });
            pointCohereBackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(directories, ownerId, cohereBranch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Say hi, Cohere.', stream: false,
            });
            fakeBackend.server.close();
            cohereFakeBackendUrl = null;

            assert.equal(status, 200);
            assert.deepEqual(data, cohereBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');

            const branchAfter = await loadBranch(directories, ownerId, cohereBranch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, Cohere.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, Cohere-style.', 'the real type: \'text\' content block was persisted, NOT the tool_plan fallback (which is only used when there is no real text content)');
            assert.equal(assistantMsg.name, 'Rex');
        }

        // (p-2) sendCohereRequest, streaming: real Cohere v2 SSE events - a `tool-plan-delta` event
        // followed by `content-delta` events, each carrying `delta.message.content.text`, matching the
        // exact shape this codebase's own public/scripts/sse-stream.js `parseStreamData()` already
        // parses for Cohere.
        {
            const cohereStreamBranch = 'cohere-stream-chat';
            await saveChatToTree(directories, ownerId, cohereStreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(directories, ownerId, cohereStreamBranch)).branch.leaf_id;

            const cohereSseEvents = [
                { type: 'message-start', delta: { message: { role: 'assistant' } } },
                { type: 'content-start', index: 0, delta: { message: { content: { type: 'text', text: '' } } } },
                { type: 'content-delta', index: 0, delta: { message: { content: { text: 'Rex ' } } } },
                { type: 'content-delta', index: 0, delta: { message: { content: { text: 'says hi, ' } } } },
                { type: 'content-delta', index: 0, delta: { message: { content: { text: 'streamed via Cohere.' } } } },
                { type: 'content-end', index: 0 },
                { type: 'message-end', delta: { finish_reason: 'COMPLETE' } },
            ];
            const cohereSseBody = cohereSseEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end(cohereSseBody);
            });
            pointCohereBackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyText } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: 'Say hi, streamed Cohere.', stream: true,
            });
            fakeBackend.server.close();
            cohereFakeBackendUrl = null;

            assert.equal(status, 200);
            assert.equal(bodyText, cohereSseBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(directories, ownerId, cohereStreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Cohere.', 'only content-delta events\' own delta.message.content.text were accumulated');
            assert.equal(assistantMsg.name, 'Rex');
        }

        // (q) sendAimlapiRequest, non-streaming: a standard OpenAI-Chat-Completions-shaped body, sent
        // to the client completely unmodified.
        {
            const aimlapiBranch = 'aimlapi-plain-chat';
            await saveChatToTree(directories, ownerId, aimlapiBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const aimlapiBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, AI/ML-API-style.' } }] };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(aimlapiBody));
            });
            pointAimlapiBackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(directories, ownerId, aimlapiBranch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Say hi, AI/ML API.', stream: false,
            });
            fakeBackend.server.close();
            aimlapiFakeBackendUrl = null;

            assert.equal(status, 200);
            assert.deepEqual(data, aimlapiBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');

            const branchAfter = await loadBranch(directories, ownerId, aimlapiBranch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, AI/ML API.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, AI/ML-API-style.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        // (q-2) sendAimlapiRequest, streaming: standard OpenAI Chat-Completions delta SSE chunks.
        {
            const aimlapiStreamBranch = 'aimlapi-stream-chat';
            await saveChatToTree(directories, ownerId, aimlapiStreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(directories, ownerId, aimlapiStreamBranch)).branch.leaf_id;

            const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via AI/ML API.']);
            pointAimlapiBackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyText } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: 'Say hi, streamed AI/ML API.', stream: true,
            });
            fakeBackend.server.close();
            aimlapiFakeBackendUrl = null;

            assert.equal(status, 200);
            assert.equal(bodyText, fakeBackend.expectedBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(directories, ownerId, aimlapiStreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via AI/ML API.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        // (r) sendChutesRequest, non-streaming: a standard OpenAI-Chat-Completions-shaped body, sent to
        // the client completely unmodified.
        {
            const chutesBranch = 'chutes-plain-chat';
            await saveChatToTree(directories, ownerId, chutesBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const chutesBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, Chutes-style.' } }] };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(chutesBody));
            });
            pointChutesBackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(directories, ownerId, chutesBranch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Say hi, Chutes.', stream: false,
            });
            fakeBackend.server.close();
            chutesFakeBackendUrl = null;

            assert.equal(status, 200);
            assert.deepEqual(data, chutesBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');

            const branchAfter = await loadBranch(directories, ownerId, chutesBranch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, Chutes.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, Chutes-style.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        // (r-2) sendChutesRequest, streaming: standard OpenAI Chat-Completions delta SSE chunks.
        {
            const chutesStreamBranch = 'chutes-stream-chat';
            await saveChatToTree(directories, ownerId, chutesStreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(directories, ownerId, chutesStreamBranch)).branch.leaf_id;

            const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via Chutes.']);
            pointChutesBackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyText } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: 'Say hi, streamed Chutes.', stream: true,
            });
            fakeBackend.server.close();
            chutesFakeBackendUrl = null;

            assert.equal(status, 200);
            assert.equal(bodyText, fakeBackend.expectedBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(directories, ownerId, chutesStreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Chutes.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        // (s) sendMinimaxRequest, non-streaming: a standard OpenAI-Chat-Completions-shaped body, sent to
        // the client completely unmodified (MiniMax's own request-building - message merging via
        // postProcessPrompt() - is untouched; only the already-standard response shape is read here).
        {
            const minimaxBranch = 'minimax-plain-chat';
            await saveChatToTree(directories, ownerId, minimaxBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const minimaxBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, MiniMax-style.' } }] };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(minimaxBody));
            });
            pointMinimaxBackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(directories, ownerId, minimaxBranch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Say hi, MiniMax.', stream: false,
            });
            fakeBackend.server.close();
            minimaxFakeBackendUrl = null;

            assert.equal(status, 200);
            assert.deepEqual(data, minimaxBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');

            const branchAfter = await loadBranch(directories, ownerId, minimaxBranch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, MiniMax.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, MiniMax-style.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        // (s-2) sendMinimaxRequest, streaming: standard OpenAI Chat-Completions delta SSE chunks.
        {
            const minimaxStreamBranch = 'minimax-stream-chat';
            await saveChatToTree(directories, ownerId, minimaxStreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(directories, ownerId, minimaxStreamBranch)).branch.leaf_id;

            const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via MiniMax.']);
            pointMinimaxBackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyText } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: 'Say hi, streamed MiniMax.', stream: true,
            });
            fakeBackend.server.close();
            minimaxFakeBackendUrl = null;

            assert.equal(status, 200);
            assert.equal(bodyText, fakeBackend.expectedBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(directories, ownerId, minimaxStreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via MiniMax.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        // (t) sendElectronHubRequest, non-streaming: a standard OpenAI-Chat-Completions-shaped body,
        // sent to the client completely unmodified.
        {
            const electronhubBranch = 'electronhub-plain-chat';
            await saveChatToTree(directories, ownerId, electronhubBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const electronhubBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, Electron-Hub-style.' } }] };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(electronhubBody));
            });
            pointElectronHubBackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(directories, ownerId, electronhubBranch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Say hi, Electron Hub.', stream: false,
            });
            fakeBackend.server.close();
            electronhubFakeBackendUrl = null;

            assert.equal(status, 200);
            assert.deepEqual(data, electronhubBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');

            const branchAfter = await loadBranch(directories, ownerId, electronhubBranch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, Electron Hub.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, Electron-Hub-style.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        // (t-2) sendElectronHubRequest, streaming: standard OpenAI Chat-Completions delta SSE chunks.
        {
            const electronhubStreamBranch = 'electronhub-stream-chat';
            await saveChatToTree(directories, ownerId, electronhubStreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(directories, ownerId, electronhubStreamBranch)).branch.leaf_id;

            const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via Electron Hub.']);
            pointElectronHubBackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyText } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: 'Say hi, streamed Electron Hub.', stream: true,
            });
            fakeBackend.server.close();
            electronhubFakeBackendUrl = null;

            assert.equal(status, 200);
            assert.equal(bodyText, fakeBackend.expectedBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(directories, ownerId, electronhubStreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Electron Hub.');
            assert.equal(assistantMsg.name, 'Rex');
        }
    }

    // (u) sendAzureOpenAIRequest, non-streaming: a standard OpenAI-Chat-Completions-shaped body, sent
    // to the client completely unmodified. UNLIKE the six providers directly above, this needs no
    // `canMockAi21Backend`/`mock.module()` gate at all - sendAzureOpenAIRequest's own request-building
    // already targets a fully caller-supplied `azure_base_url`, so `pointAzureOpenAIBackendAt()` routes
    // it at the real local fake backend with zero mocking, exactly like the plain reverse-proxy-backed
    // providers (Claude/MakerSuite/MistralAI/DeepSeek/xAI) above.
    {
        const azureBranch = 'azure-openai-plain-chat';
        await saveChatToTree(directories, ownerId, azureBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const azureBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, Azure-style.' } }] };
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(azureBody));
        });
        pointAzureOpenAIBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, azureBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Say hi, Azure.', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.deepEqual(data, azureBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');

        const branchAfter = await loadBranch(directories, ownerId, azureBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, Azure.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, Azure-style.');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (u-2) sendAzureOpenAIRequest, streaming: standard OpenAI Chat-Completions delta SSE chunks.
    {
        const azureStreamBranch = 'azure-openai-stream-chat';
        await saveChatToTree(directories, ownerId, azureStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(directories, ownerId, azureStreamBranch)).branch.leaf_id;

        const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via Azure.']);
        pointAzureOpenAIBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: 'Say hi, streamed Azure.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, fakeBackend.expectedBody, 'the client-facing SSE bytes are byte-for-byte identical to what the fake backend sent');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, azureStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Azure.');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // This completes coverage of ALL 12 provider-`switch` cases in this file - every one of them now
    // has a real, route-level non-streaming AND streaming persistence test: six gated behind
    // `canMockAi21Backend` (AI21/Cohere/AI-ML-API/Chutes/MiniMax/Electron-Hub - matching
    // chat-completions.js's own real absence of a reverse-proxy override for exactly those six
    // providers), and six ungated, with real reverse-proxy/caller-supplied-endpoint support
    // (Claude/MakerSuite/MistralAI/DeepSeek/xAI further above, and AzureOpenAI directly above).

    // --- error handling (route-level): missing owner_id falls through as an ordinary (non-raw-action)
    // request - it is NOT gated into the raw-action branch at all (the gate itself requires owner_id),
    // so it reaches the default dispatch code below with whatever fields the client actually sent.
    // Not asserted further here - this is the same "not a raw action" byte-for-byte-unchanged path the
    // connection_profile_id branch and legacy default path already exercise elsewhere.

    // --- CORRECTED ADDRESSING MODEL (this task), route-level: a raw-action body whose `node_id` key
    // is entirely absent gets a real 400, distinct from an explicit `node_id: null` - proving the
    // "absent key" vs. "explicit null" distinction survives through Express's own JSON body-parser,
    // not just when calling buildRawActionChatCompletionRequest() directly. ---
    {
        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar,
            type: 'normal', user_message: 'This should be rejected.', stream: false,
        });
        assert.equal(status, 400, 'a request body with no node_id key at all is a real 400, not a silent guess');
        assert.match(data.message, /node_id is required/, 'the error names the real, specific problem');
    }

    // --- CORRECTED ADDRESSING MODEL (this task), route-level: `node_id: null` on a character that
    // already has real history is a real 400 - the server does not silently pick "the current leaf"
    // once real, possibly-stale history exists. ---
    {
        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: null,
            type: 'normal', user_message: 'This should also be rejected.', stream: false,
        });
        assert.equal(status, 400, 'node_id: null on an owner with real existing history is a real 400');
        assert.match(data.message, /already has an existing conversation/, 'the error explains why null was rejected here');
    }

    // --- file attachment reference, route-level: PERSISTENCE *and* INLINING. Chat-completion's
    // raw-action pipeline now reuses `file-attachment-inline.js`'s `appendFileAttachments()` - the
    // exact same function `text-completion-prompt-orchestrator.js` already wires in - from
    // `resolveChatCompletionGenerationInput()` (src/chat-completion-generation-input.js), applied to
    // `promptChat` (which already includes the just-appended in-memory turn) BEFORE
    // `buildChatCompletionMessages()` converts it to `{role, content}`. This closes the real,
    // previously-documented gap versus the legacy CLIENT-assembled chat-completion path, which already
    // inlined file text via `coreChat`'s own `appendFileContent()` call in public/script.js. Both the
    // persisted-node shape (unaffected - `.extra` is stored verbatim, the inlining only affects the
    // outgoing prompt) AND the actual outgoing request body (asserted below, mirroring the media/image
    // test just below it) are verified.
    {
        fs.writeFileSync(path.join(filesDir, 'raw-action-attach.txt'), 'The password is hunter2.');

        let capturedRequestBody = null;
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            capturedRequestBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Got your file.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Check the attached file.', stream: false,
            user_message_extra: { files: [{ url: '/user/files/raw-action-attach.txt', size: 25, name: 'raw-action-attach.txt', created: 1700000000000 }] },
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.ok(capturedRequestBody, 'the fake backend actually received a request');
        const outgoingMessages = capturedRequestBody.messages;
        assert.ok(Array.isArray(outgoingMessages), 'the outgoing request carries a real messages array');
        const turnWithFile = outgoingMessages.find(m => typeof m.content === 'string' && m.content.includes('The password is hunter2.'));
        assert.ok(
            turnWithFile,
            `expected the attached file's text to be inlined into the outgoing turn's own content, got: ${JSON.stringify(outgoingMessages)}`,
        );
        assert.ok(
            turnWithFile.content.includes('Check the attached file.'),
            'the inlined file text is prepended onto the turn\'s own message text, not a replacement of it',
        );

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        const persistedUserMsg = branchAfter.messages[branchAfter.messages.length - 2];
        assert.equal(persistedUserMsg.mes, 'Check the attached file.', 'the persisted node keeps the ORIGINAL (non-inlined) message text - inlining only affects the outgoing prompt, not what is stored');
        assert.deepEqual(
            persistedUserMsg.extra,
            { files: [{ url: '/user/files/raw-action-attach.txt', size: 25, name: 'raw-action-attach.txt', created: 1700000000000 }] },
            'the persisted user message node carries the (sanitized) forwarded extra unchanged',
        );
    }

    // --- media (image) attachment, route-level: requires the real `oai_settings.media_inlining`
    // toggle to be on (see buildRawActionChatCompletionRequest()'s own JUDGMENT CALL comment on why
    // this is a real, narrower-than-the-client capability check, not a fabricated one). ---
    {
        const jpeg = await (async () => {
            const image = new Jimp({ width: 8, height: 8, color: 0xffffffff });
            return image.getBuffer(JimpMime.jpeg, { quality: 90, jpegColorSpace: 'ycbcr' });
        })();
        const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

        let capturedRequestBody = null;
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            capturedRequestBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Nice picture.' } }] }));
        });
        const mediaSettings = buildSettingsFixture();
        mediaSettings.oai_settings.custom_url = fakeBackend.url;
        mediaSettings.oai_settings.media_inlining = true;
        writeAllSettings(directories, mediaSettings);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Look at this.', stream: false,
            user_message_extra: { media: [{ url: dataUrl, type: 'image', source: 'upload' }], media_index: 0 },
        });
        fakeBackend.server.close();
        pointBackendAt(fakeBackend.url); // restore the plain (non-media) fixture for anything after this block

        assert.equal(status, 200);
        assert.ok(capturedRequestBody, 'the fake backend actually received a request');
        const outgoingMessages = capturedRequestBody.messages;
        assert.ok(Array.isArray(outgoingMessages), 'the outgoing request carries a real messages array');
        const turnWithImage = outgoingMessages.find(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
        assert.ok(
            turnWithImage,
            `expected an outgoing message with a real image_url content part, got: ${JSON.stringify(outgoingMessages)}`,
        );

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        const persistedUserMsg = branchAfter.messages[branchAfter.messages.length - 2];
        assert.equal(persistedUserMsg.mes, 'Look at this.');
        assert.deepEqual(persistedUserMsg.extra, { media: [{ url: dataUrl, type: 'image', source: 'upload' }], media_index: 0 });
    }

    // --- rejection/sanitization, route-level: a garbage-shaped `user_message_extra` is dropped
    // rather than stored verbatim or crashing the request - sanitizeUserMessageExtra()'s own
    // allowlist (message-tree-db.js) is exercised through the real HTTP route. ---
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Fine either way.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'This has a garbage attachment payload.', stream: false,
            user_message_extra: {
                evil_script: '<script>alert(1)</script>',
                files: [{ url: 12345, name: 'not-a-real-url.txt' }],
                media: [{ url: '/user/files/whatever.png', type: 'application/x-not-a-real-media-type' }],
                media_index: 'not-a-number',
                inline_image: 'yes',
            },
        });
        fakeBackend.server.close();
        assert.equal(status, 200, 'a garbage-shaped user_message_extra does not crash the request - it is sanitized, not rejected outright');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        const persistedUserMsg = branchAfter.messages[branchAfter.messages.length - 2];
        assert.equal(persistedUserMsg.mes, 'This has a garbage attachment payload.');
        assert.deepEqual(persistedUserMsg.extra, {}, 'every field of the garbage payload was dropped by the allowlist - nothing survived, not even partially');
    }

    // --- server-native tool calling (chunk (b): wiring src/server-tools.js's registry into this
    // route's non-streaming raw-action path) ---

    // (a) No server tools registered at all: a real regression guard - the raw-action request must
    // behave EXACTLY as before (no `tools`/`tool_choice` sent to the backend, response handled as
    // plain text), even with `oai_settings.function_calling` turned on.
    {
        let capturedBody = null;
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'No tools here.' } }] }));
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const toolBranch = 'tool-branch-no-tools-registered';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, no-tools-registered branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, no-tools-registered branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Anything new?', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'No tools here.' } }] });
        assert.ok(capturedBody, 'the fake backend actually received a request');
        assert.equal(capturedBody.tools, undefined, 'no `tools` field is sent when no server tools are registered - unchanged from before this chunk');
        assert.equal(capturedBody.tool_choice, undefined);

        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'No tools here.', 'plain-text persistence, unaffected by the (empty) tool registry');
    }

    // (b) One server tool registered: backend's first response calls it, backend's SECOND response
    // (after the tool result is fed back) is plain text. Full round-trip verification: the tool was
    // actually advertised, actually invoked with the right args/ctx, the persisted tree has the
    // correct shape, and the SECOND backend request actually carries the reconstructed tool-call/
    // result history (proving the loop really re-resolved history, not just that two requests fired).
    {
        const toolBranch = 'tool-branch-happy-path';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, happy-path branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, happy-path branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);

        let invokeArgs = null;
        let invokeCtx = null;
        registerServerTool({
            id: 'test-tool:get_weather',
            name: 'get_weather',
            description: 'Gets the current weather for a city.',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            invoke: async (args, ctx) => {
                invokeArgs = args;
                invokeCtx = ctx;
                return `Sunny in ${args.city}`;
            },
        });

        const requestBodies = [];
        let callCount = 0;
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            callCount++;
            requestBodies.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (callCount === 1) {
                res.end(JSON.stringify({
                    choices: [{
                        message: {
                            role: 'assistant', content: null,
                            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Booktown' }) } }],
                        },
                    }],
                }));
            } else {
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'It is sunny in Booktown.' } }] }));
            }
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'What is the weather in Booktown?', stream: false,
            }));
        } finally {
            fakeBackend.server.close();
            unregisterServerTool('test-tool:get_weather');
        }

        assert.equal(status, 200, 'the (unchanged) final response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'It is sunny in Booktown.' } }] });
        assert.equal(callCount, 2, 'backend was called twice: once producing tool_calls, once with the final plain-text reply');

        assert.ok(Array.isArray(requestBodies[0].tools) && requestBodies[0].tools.length === 1, 'the FIRST request actually advertised the registered tool');
        assert.equal(requestBodies[0].tools[0].function.name, 'get_weather');
        assert.equal(requestBodies[0].tool_choice, 'auto');

        assert.deepEqual(invokeArgs, { city: 'Booktown' }, 'invoke() was called with the parsed (not raw-string) arguments');
        assert.ok(invokeCtx, 'invoke() received a ctx object');
        assert.equal(invokeCtx.ownerId, ownerId, 'ctx carries ownerId');
        assert.equal(invokeCtx.characterAvatar, avatar, 'ctx carries characterAvatar');
        assert.ok(invokeCtx.directories, 'ctx carries directories');

        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        assert.equal(branchAfter.messages.length, 2 + 3, 'user message + tool-call/result turn + final assistant reply were all appended as three separate nodes');
        const [userMsg, toolMsg, finalMsg] = branchAfter.messages.slice(-3);
        assert.equal(userMsg.is_user, true);
        assert.equal(userMsg.mes, 'What is the weather in Booktown?');
        assert.equal(toolMsg.is_user, false);
        assert.equal(toolMsg.is_system, true, 'the tool-call/result turn is a system entry, mirroring the client\'s own ToolManager.saveFunctionToolInvocations()');
        assert.ok(Array.isArray(toolMsg.extra?.tool_invocations), 'tool_invocations persisted on extra, the exact shape populateChatHistory()/buildChatCompletionMessages() expect for replay');
        assert.equal(toolMsg.extra.tool_invocations.length, 1);
        assert.equal(toolMsg.extra.tool_invocations[0].id, 'call_1');
        assert.equal(toolMsg.extra.tool_invocations[0].name, 'get_weather');
        assert.equal(typeof toolMsg.extra.tool_invocations[0].parameters, 'string', 'parameters is stored as a JSON string, not a live object');
        assert.deepEqual(JSON.parse(toolMsg.extra.tool_invocations[0].parameters), { city: 'Booktown' });
        assert.equal(toolMsg.extra.tool_invocations[0].result, 'Sunny in Booktown');
        assert.equal(toolMsg.extra.tool_invocations[0].error, false);
        assert.equal(finalMsg.is_user, false);
        assert.equal(finalMsg.mes, 'It is sunny in Booktown.');
        assert.equal(finalMsg.name, 'Rex', 'the final reply uses name2, same as any other real assistant reply');

        // Prove the loop actually re-resolved history for the second call (not just that two
        // requests happened): the SECOND request's own messages carry the tool call and its result.
        const secondRequestDump = JSON.stringify(requestBodies[1].messages);
        assert.ok(secondRequestDump.includes('get_weather'), 'second request history includes the tool call by name');
        assert.ok(secondRequestDump.includes('Sunny in Booktown'), 'second request history includes the tool result text');
    }

    // (c) A registered tool's invoke() throws: the loop must continue (the backend gets a follow-up
    // call with the error result visible in its request body), not crash the request.
    {
        const toolBranch = 'tool-branch-invoke-throws';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, invoke-throws branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, invoke-throws branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);

        registerServerTool({
            id: 'test-tool:always_throws',
            name: 'always_throws',
            description: 'A tool that always throws.',
            parameters: { type: 'object', properties: {} },
            invoke: async () => { throw new Error('boom'); },
        });

        let callCount = 0;
        const requestBodies = [];
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            callCount++;
            requestBodies.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (callCount === 1) {
                res.end(JSON.stringify({
                    choices: [{
                        message: {
                            role: 'assistant', content: null,
                            tool_calls: [{ id: 'call_err', type: 'function', function: { name: 'always_throws', arguments: '{}' } }],
                        },
                    }],
                }));
            } else {
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Sorry, that failed.' } }] }));
            }
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Try the broken tool.', stream: false,
            }));
        } finally {
            fakeBackend.server.close();
            unregisterServerTool('test-tool:always_throws');
        }

        assert.equal(status, 200, 'a thrown invoke() does not crash the request');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'Sorry, that failed.' } }] });
        assert.equal(callCount, 2, 'the loop continued to a second backend call after the tool error, instead of aborting');

        const secondRequestDump = JSON.stringify(requestBodies[1].messages);
        assert.ok(secondRequestDump.includes('boom'), 'the error text is visible to the backend in the follow-up request history');

        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        const toolMsg = branchAfter.messages[branchAfter.messages.length - 2];
        assert.equal(toolMsg.extra.tool_invocations[0].error, true, 'the invocation is flagged as an error');
        assert.equal(toolMsg.extra.tool_invocations[0].result, 'boom', 'the error message became the (string) result, so the model can see the failure');
    }

    // (d) Backend calls a tool name that is NOT in the registry: a real, sane error response (not a
    // 500 crash, not a silently-dropped/empty response) - and the recognized/unrelated registered
    // tool is never even invoked for this round.
    {
        const toolBranch = 'tool-branch-unrecognized';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, unrecognized-tool branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, unrecognized-tool branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);
        const messageCountBefore = branchBefore.messages.length;

        let knownToolInvoked = false;
        registerServerTool({
            id: 'test-tool:known_tool',
            name: 'known_tool',
            description: 'A real, registered tool - just not the one the fake backend calls.',
            parameters: { type: 'object', properties: {} },
            invoke: async () => { knownToolInvoked = true; return 'ok'; },
        });

        let callCount = 0;
        const fakeBackend = await startFakeBackend((_req, res) => {
            callCount++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant', content: null,
                        tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'totally_unregistered_tool', arguments: '{}' } }],
                    },
                }],
            }));
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Call something weird.', stream: false,
            }));
        } finally {
            fakeBackend.server.close();
            unregisterServerTool('test-tool:known_tool');
        }

        assert.equal(callCount, 1, 'the loop does not proceed to a second backend call for an unrecognized tool name');
        assert.equal(knownToolInvoked, false, 'the unrelated recognized tool is never invoked for a round that also names an unrecognized tool');
        assert.ok(status >= 400 && status < 600, `expected a real error status, got ${status}`);
        assert.equal(data.error, true, 'matches this route\'s existing {error: true, message} convention for build/dispatch failures');
        assert.ok(typeof data.message === 'string' && data.message.includes('totally_unregistered_tool'), 'the error names the unrecognized tool');

        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was appended - no tool-call turn or assistant reply for an unrecognized-tool round');
    }

    // (e) Round-limit exceeded: a tool that always asks to be called again must trip the real error
    // path at SERVER_TOOL_ROUND_LIMIT, not loop forever. The test's OWN fake backend has a hard
    // sanity bound on its own call counter, so a bug in the implementation can't hang the suite.
    {
        const toolBranch = 'tool-branch-round-limit';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, round-limit branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, round-limit branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);
        const messageCountBefore = branchBefore.messages.length;

        registerServerTool({
            id: 'test-tool:infinite',
            name: 'infinite_tool',
            description: 'A tool whose result always makes the (fake) backend ask to call it again.',
            parameters: { type: 'object', properties: {} },
            invoke: async () => 'called again',
        });

        const TEST_SANITY_BOUND = 20; // independent of SERVER_TOOL_ROUND_LIMIT - just a hard stop so a real infinite loop can't hang this test suite
        let callCount = 0;
        const fakeBackend = await startFakeBackend((_req, res) => {
            callCount++;
            if (callCount > TEST_SANITY_BOUND) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'test sanity bound exceeded - the server-side loop did not respect its own round limit' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant', content: null,
                        tool_calls: [{ id: `call_${callCount}`, type: 'function', function: { name: 'infinite_tool', arguments: '{}' } }],
                    },
                }],
            }));
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Keep going forever.', stream: false,
            }));
        } finally {
            fakeBackend.server.close();
            unregisterServerTool('test-tool:infinite');
        }

        assert.ok(callCount <= TEST_SANITY_BOUND, 'the loop terminated on its own well before the test\'s own hard sanity bound');
        assert.ok(status >= 400 && status < 600, `expected a real error status once the round limit is exceeded, got ${status}`);
        assert.equal(data.error, true);
        assert.ok(typeof data.message === 'string' && /round/i.test(data.message), 'the error explains the round-limit failure');

        // The tool-call/result turns already persisted along the way stay on the tree - they're real
        // facts that happened, even though the overall request ultimately failed.
        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        assert.ok(branchAfter.messages.length > messageCountBefore + 1, 'the tool-call turns persisted up to the limit remain on the tree even though the request errored');
    }

    // --- client-proxy tool calling (chunk (c): client_tools / pending_tool_calls / type:
    // 'tool_result') --- a "client-only" tool below just means a name advertised via `client_tools`
    // on the request that is NOT registered via registerServerTool() - exactly what a real browser
    // ToolManager tool looks like from this route's point of view.

    // (f) Backend calls a tool that's ONLY in `client_tools` (no server registration at all): the
    // route must hand off via `pending_tool_calls`, not 422, and must persist an in-flight
    // (`result: null`) invocation node.
    {
        const toolBranch = 'tool-branch-client-only-pending';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, client-only-pending branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, client-only-pending branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);
        const messageCountBefore = branchBefore.messages.length;

        const clientTools = [{
            type: 'function',
            function: { name: 'open_curtains', description: 'Opens the curtains in the room (client-only, DOM access).', parameters: { type: 'object', properties: {} } },
        }];

        let callCount = 0;
        const fakeBackend = await startFakeBackend((_req, res) => {
            callCount++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant', content: null,
                        tool_calls: [{ id: 'call_curtains', type: 'function', function: { name: 'open_curtains', arguments: JSON.stringify({ side: 'left' }) } }],
                    },
                }],
            }));
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Open the curtains.', stream: false,
                client_tools: clientTools,
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(callCount, 1, 'the backend is called exactly once - the client-only call is handed off, not looped on server-side');
        assert.equal(status, 200, 'a client-tool hand-off is a normal 200, not an error');
        assert.equal(data.error, undefined);
        assert.ok(Array.isArray(data.pending_tool_calls), 'the distinct pending_tool_calls response shape is used instead of a normal generation result');
        assert.equal(data.pending_tool_calls.length, 1);
        assert.equal(data.pending_tool_calls[0].tool_call_id, 'call_curtains');
        assert.equal(data.pending_tool_calls[0].name, 'open_curtains');
        assert.deepEqual(data.pending_tool_calls[0].arguments, { side: 'left' }, 'arguments are the parsed object, not a JSON string');
        assert.ok(typeof data.pending_tool_calls[0].node_id === 'string' && data.pending_tool_calls[0].node_id, 'a real node_id addressing the persisted tree node');

        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'user message + one in-flight tool-invocation node were persisted (no final reply yet)');
        const toolMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(toolMsg.node_id, data.pending_tool_calls[0].node_id, 'the response names the exact node that was persisted');
        assert.ok(Array.isArray(toolMsg.extra?.tool_invocations));
        assert.equal(toolMsg.extra.tool_invocations.length, 1);
        assert.equal(toolMsg.extra.tool_invocations[0].id, 'call_curtains');
        assert.equal(toolMsg.extra.tool_invocations[0].result, null, 'in-flight: not yet resolved by a tool_result follow-up');
        assert.equal(toolMsg.extra.tool_invocations[0].error, null);
    }

    // (g) The type: 'tool_result' follow-up: resolves the exact pending node IN PLACE (no new node for
    // the edit itself), then resumes the loop - the SECOND backend response (plain text) is persisted
    // as a NEW node after the tool node.
    {
        const toolBranch = 'tool-branch-tool-result-followup';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, tool-result-followup branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, tool-result-followup branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);
        const messageCountBefore = branchBefore.messages.length;

        const clientTools = [{
            type: 'function',
            function: { name: 'get_local_time', description: 'Reads the local clock (client-only).', parameters: { type: 'object', properties: {} } },
        }];

        let callCount = 0;
        const requestBodies = [];
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            callCount++;
            requestBodies.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (callCount === 1) {
                res.end(JSON.stringify({
                    choices: [{
                        message: {
                            role: 'assistant', content: null,
                            tool_calls: [{ id: 'call_time', type: 'function', function: { name: 'get_local_time', arguments: '{}' } }],
                        },
                    }],
                }));
            } else {
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'It is currently 3pm where you are.' } }] }));
            }
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        const { status: status1, data: data1 } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'What time is it?', stream: false,
            client_tools: clientTools,
        });
        assert.equal(status1, 200);
        assert.equal(data1.pending_tool_calls.length, 1);
        const pendingNodeId = data1.pending_tool_calls[0].node_id;

        const midBranch = await loadBranch(directories, ownerId, toolBranch);
        assert.equal(midBranch.messages.length, messageCountBefore + 2, 'user message + in-flight tool node, no final reply yet');

        let status2, data2;
        try {
            ({ status: status2, data: data2 } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: pendingNodeId, type: 'tool_result',
                tool_results: [{ id: 'call_time', result: '15:00', error: false }],
                client_tools: clientTools,
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(callCount, 2, 'the loop resumed and called the backend again after the result was submitted');
        assert.equal(status2, 200);
        assert.deepEqual(data2, { choices: [{ message: { role: 'assistant', content: 'It is currently 3pm where you are.' } }] });

        // The SECOND backend request's own history must carry the real, submitted result - proving
        // the loop really re-resolved the tree, not just that two requests happened.
        const secondRequestDump = JSON.stringify(requestBodies[1].messages);
        assert.ok(secondRequestDump.includes('get_local_time'), 'second request history includes the tool call by name');
        assert.ok(secondRequestDump.includes('15:00'), 'second request history includes the submitted result text');

        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 3, 'exactly ONE new node was added by the tool_result follow-up (the final reply) - the pending node was edited in place, not duplicated');
        const [, toolMsg, finalMsg] = branchAfter.messages.slice(-3);
        assert.equal(toolMsg.node_id, pendingNodeId, 'the SAME node id - editMessage() edited it in place rather than appending a new one');
        assert.equal(toolMsg.extra.tool_invocations[0].result, '15:00', 'the pending invocation was filled in with the real submitted result');
        assert.equal(toolMsg.extra.tool_invocations[0].error, false);
        assert.equal(finalMsg.mes, 'It is currently 3pm where you are.');
        assert.equal(finalMsg.is_user, false);
    }

    // (h) A mixed round: one server-native call and one client-only call in the SAME backend
    // response. The server-native one executes immediately; the client-only one comes back via
    // pending_tool_calls; both invocations persist on the SAME tree node (this task's chosen
    // single-node-per-round shape - see runServerToolRounds()'s own doc comment for the rationale).
    // The mixed node then round-trips correctly once the client's result is submitted.
    {
        const toolBranch = 'tool-branch-mixed-round';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, mixed-round branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, mixed-round branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);
        const messageCountBefore = branchBefore.messages.length;

        registerServerTool({
            id: 'test-tool:server_side_lookup',
            name: 'server_side_lookup',
            description: 'A real server-native tool.',
            parameters: { type: 'object', properties: {} },
            invoke: async () => 'server-side result',
        });
        const clientTools = [{
            type: 'function',
            function: { name: 'client_side_prompt', description: 'A client-only tool (DOM access).', parameters: { type: 'object', properties: {} } },
        }];

        let callCount = 0;
        const requestBodies = [];
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            callCount++;
            requestBodies.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (callCount === 1) {
                res.end(JSON.stringify({
                    choices: [{
                        message: {
                            role: 'assistant', content: null,
                            tool_calls: [
                                { id: 'call_server', type: 'function', function: { name: 'server_side_lookup', arguments: '{}' } },
                                { id: 'call_client', type: 'function', function: { name: 'client_side_prompt', arguments: '{}' } },
                            ],
                        },
                    }],
                }));
            } else {
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Combined both results, thanks.' } }] }));
            }
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status1, data1, status2, data2;
        try {
            ({ status: status1, data: data1 } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Do both things.', stream: false,
                client_tools: clientTools,
            }));

            assert.equal(callCount, 1, 'the backend is only called once before the client-only call needs a hand-off');
            assert.equal(status1, 200);
            assert.equal(data1.pending_tool_calls.length, 1, 'only the client-only call is surfaced - the server-native one already executed');
            assert.equal(data1.pending_tool_calls[0].tool_call_id, 'call_client');
            const pendingNodeId = data1.pending_tool_calls[0].node_id;

            const midBranch = await loadBranch(directories, ownerId, toolBranch);
            const midToolMsg = midBranch.messages[midBranch.messages.length - 1];
            assert.equal(midToolMsg.node_id, pendingNodeId, 'single shared node for the whole mixed round');
            assert.equal(midToolMsg.extra.tool_invocations.length, 2, 'both invocations (resolved server + pending client) live on the SAME node');
            const serverInvocation = midToolMsg.extra.tool_invocations.find(i => i.id === 'call_server');
            const clientInvocation = midToolMsg.extra.tool_invocations.find(i => i.id === 'call_client');
            assert.equal(serverInvocation.result, 'server-side result', 'the server-native call already executed for real');
            assert.equal(serverInvocation.error, false);
            assert.equal(clientInvocation.result, null, 'the client-only call is still pending on this same node');

            ({ status: status2, data: data2 } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: pendingNodeId, type: 'tool_result',
                tool_results: [{ id: 'call_client', result: 'client-side result', error: false }],
                client_tools: clientTools,
            }));
        } finally {
            fakeBackend.server.close();
            unregisterServerTool('test-tool:server_side_lookup');
        }

        assert.equal(callCount, 2, 'the loop resumed with a second real backend call once the mixed node was fully resolved');
        assert.equal(status2, 200);
        assert.deepEqual(data2, { choices: [{ message: { role: 'assistant', content: 'Combined both results, thanks.' } }] });

        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 3, 'user message + the ONE mixed tool node (edited in place, not duplicated) + the final reply');
        const [, toolMsg, finalMsg] = branchAfter.messages.slice(-3);
        assert.equal(toolMsg.extra.tool_invocations.length, 2);
        assert.equal(toolMsg.extra.tool_invocations.find(i => i.id === 'call_client').result, 'client-side result', 'the pending client invocation was filled in by the follow-up');
        assert.equal(toolMsg.extra.tool_invocations.find(i => i.id === 'call_server').result, 'server-side result', 'the already-resolved server invocation is untouched by the edit');
        assert.equal(finalMsg.mes, 'Combined both results, thanks.');
    }

    // (i) A tool name matching NEITHER a server tool NOR a client-advertised tool: still a clean 422,
    // unchanged from chunk (b) - even when `client_tools` was sent (naming a DIFFERENT tool).
    {
        const toolBranch = 'tool-branch-neither-known';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, neither-known branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, neither-known branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);
        const messageCountBefore = branchBefore.messages.length;

        const clientTools = [{
            type: 'function',
            function: { name: 'a_real_client_tool', description: 'A real, advertised client tool - just not the one the fake backend calls.', parameters: { type: 'object', properties: {} } },
        }];

        let callCount = 0;
        const fakeBackend = await startFakeBackend((_req, res) => {
            callCount++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant', content: null,
                        tool_calls: [{ id: 'call_ghost', type: 'function', function: { name: 'completely_hallucinated_tool', arguments: '{}' } }],
                    },
                }],
            }));
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Call something imaginary.', stream: false,
                client_tools: clientTools,
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(callCount, 1, 'no second backend call - the round fails immediately');
        assert.ok(status >= 400 && status < 600, `expected a real error status, got ${status}`);
        assert.equal(data.error, true);
        assert.ok(typeof data.message === 'string' && data.message.includes('completely_hallucinated_tool'), 'the error names the unrecognized tool');
        assert.equal(data.pending_tool_calls, undefined, 'a genuinely unrecognized name is a real error, never a hand-off');

        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was appended - no tool-call turn for a wholly-unrecognized round');
    }

    // (j) Name collision between a server tool and a client-advertised tool: server-native wins (this
    // task's chosen policy - server tools are operator-configured, the client cannot be trusted to
    // not accidentally collide) - the client's colliding schema is dropped, and calling that name
    // invokes the SERVER tool for real rather than being treated as a client hand-off.
    {
        const toolBranch = 'tool-branch-name-collision';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, name-collision branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, name-collision branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);

        let serverToolInvoked = false;
        registerServerTool({
            id: 'test-tool:shared_name',
            name: 'shared_tool_name',
            description: 'The REAL, operator-configured server tool.',
            parameters: { type: 'object', properties: {} },
            invoke: async () => { serverToolInvoked = true; return 'server tool won'; },
        });
        const clientTools = [{
            type: 'function',
            function: { name: 'shared_tool_name', description: 'An unprivileged client tool trying to shadow the server one.', parameters: { type: 'object', properties: {} } },
        }];

        let callCount = 0;
        const requestBodies = [];
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            callCount++;
            requestBodies.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (callCount === 1) {
                res.end(JSON.stringify({
                    choices: [{
                        message: {
                            role: 'assistant', content: null,
                            tool_calls: [{ id: 'call_shared', type: 'function', function: { name: 'shared_tool_name', arguments: '{}' } }],
                        },
                    }],
                }));
            } else {
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done.' } }] }));
            }
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Trigger the shared name.', stream: false,
                client_tools: clientTools,
            }));
        } finally {
            fakeBackend.server.close();
            unregisterServerTool('test-tool:shared_name');
        }

        assert.equal(requestBodies[0].tools.length, 1, 'only ONE tool named shared_tool_name is ever advertised - the colliding client schema was dropped, not sent twice');
        assert.equal(requestBodies[0].tools[0].function.description, 'The REAL, operator-configured server tool.', 'the SERVER tool\'s schema won the collision, not the client\'s');
        assert.equal(callCount, 2, 'the call resolved server-side (a second backend call happened), it was never treated as a client hand-off');
        assert.equal(serverToolInvoked, true, 'the server-native tool actually executed for this name');
        assert.equal(status, 200);
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'Done.' } }] });
        assert.equal(data.pending_tool_calls, undefined, 'never a hand-off for a name the server tool registry owns');
    }

    // --- STREAMING tool calling (this task's own scope: extends chunk (b)/(c) to the streaming branch) ---

    // (j) STREAMING, server-native tool call: the fake backend's FIRST response streams `tool_calls`
    // deltas split across several chunks (including a mid-argument-string split); the server must
    // accumulate them faithfully, execute the registered tool, persist the round, and re-call the
    // backend (non-streamingly, per the established round-2+ precedent) for the final reply - which
    // must reach the client as an ordinary-looking SSE content chunk (no client-side special-casing
    // needed for this case), AND be persisted on the tree, exactly like the non-streaming happy-path
    // test (b) above.
    {
        const toolBranch = 'stream-tool-branch-server-native';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, streaming server-tool branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, streaming server-tool branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);

        let invokeArgs = null;
        registerServerTool({
            id: 'test-tool:stream_get_weather',
            name: 'get_weather',
            description: 'Gets the current weather for a city.',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            invoke: async (args) => { invokeArgs = args; return `Sunny in ${args.city}`; },
        });

        let callCount = 0;
        const requestBodies = [];
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            callCount++;
            requestBodies.push(JSON.parse(body));
            if (callCount === 1) {
                // First round: a real SSE stream, tool-call arguments split mid-token across chunks -
                // '{"ci' + 'ty": "Bo' + 'oktown"}' must reassemble to '{"city": "Booktown"}'.
                const deltaChunks = [
                    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_stream_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] },
                    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] },
                    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty": "Bo' } }] } }] },
                    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'oktown"}' } }] } }] },
                ];
                const sseBody = deltaChunks.map(json => `data: ${JSON.stringify(json)}\n\n`).join('') + 'data: [DONE]\n\n';
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end(sseBody);
            } else {
                // Round 2+: the established precedent (point 3) - always a plain, non-streaming JSON
                // reply, regardless of the original request's own `stream: true`.
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'It is sunny in Booktown, streamed.' } }] }));
            }
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, bodyText;
        try {
            ({ status, bodyText } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'What is the weather in Booktown, streamed?', stream: true,
            }));
        } finally {
            fakeBackend.server.close();
            unregisterServerTool('test-tool:stream_get_weather');
        }

        assert.equal(status, 200);
        assert.equal(callCount, 2, 'backend was called twice: once streaming tool_calls, once with the final plain-text reply');
        assert.equal(requestBodies[1].stream, false, 'round 2+ is forced non-streaming regardless of the original request\'s own stream:true');
        assert.deepEqual(invokeArgs, { city: 'Booktown' }, 'the split-across-chunks arguments string was reassembled correctly before parsing');

        assert.ok(!bodyText.includes('tool_calls'), 'raw tool_calls deltas are never forwarded to the client for this gated case');
        assert.ok(bodyText.includes('It is sunny in Booktown, streamed.'), 'the final round\'s content reaches the client as an ordinary-looking SSE content chunk');
        assert.ok(bodyText.trim().endsWith('data: [DONE]'), 'the stream still ends with the normal [DONE] sentinel');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, toolBranch);
            return branch.messages.length === branchBefore.messages.length + 3 ? branch : null;
        });
        const [userMsg, toolMsg, finalMsg] = branchAfter.messages.slice(-3);
        assert.equal(userMsg.is_user, true);
        assert.equal(toolMsg.is_system, true);
        assert.equal(toolMsg.extra.tool_invocations[0].name, 'get_weather');
        assert.equal(toolMsg.extra.tool_invocations[0].result, 'Sunny in Booktown');
        assert.equal(finalMsg.mes, 'It is sunny in Booktown, streamed.');
        assert.equal(finalMsg.name, 'Rex');
    }

    // (k) STREAMING, client-only tool call: the fake backend streams a `tool_calls` delta for a name
    // the server does NOT recognize (only advertised via this request's own `client_tools`) - the
    // server must hand off via the `tool_call_handoff` SSE trailer instead of corrupting the stream,
    // AND must have already persisted the pending node server-side (a real, addressable `node_id`)
    // before that trailer is even sent - mirroring non-streaming test (f)'s own invariants.
    {
        const toolBranch = 'stream-tool-branch-client-only';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, streaming client-tool branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, streaming client-tool branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);

        let callCount = 0;
        const fakeBackend = await startFakeBackend((_req, res) => {
            callCount++;
            const deltaChunks = [
                { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_curtains_stream', type: 'function', function: { name: 'open_curtains', arguments: '' } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"side": "left"}' } }] } }] },
            ];
            const sseBody = deltaChunks.map(json => `data: ${JSON.stringify(json)}\n\n`).join('') + 'data: [DONE]\n\n';
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(sseBody);
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, bodyText;
        try {
            ({ status, bodyText } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Open the curtains, streamed.', stream: true,
                client_tools: [{ type: 'function', function: { name: 'open_curtains', description: 'Opens the curtains.', parameters: { type: 'object', properties: { side: { type: 'string' } } } } }],
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(status, 200);
        assert.equal(callCount, 1, 'the backend is never re-called for a client-only hand-off - there is nothing left for the server to resolve');
        assert.ok(!bodyText.includes('"tool_calls"'), 'the raw tool_calls delta is never forwarded to the client');

        const handoffLine = bodyText.split('\n').map(line => line.trim()).find(line => line.startsWith('data:') && line.includes('tool_call_handoff'));
        assert.ok(handoffLine, 'a tool_call_handoff trailer event was sent before the stream closed');
        const handoffPayload = JSON.parse(handoffLine.slice(5).trim());
        assert.ok(Array.isArray(handoffPayload.tool_call_handoff.pending_tool_calls) && handoffPayload.tool_call_handoff.pending_tool_calls.length === 1);
        assert.equal(handoffPayload.tool_call_handoff.pending_tool_calls[0].tool_call_id, 'call_curtains_stream');
        assert.equal(handoffPayload.tool_call_handoff.pending_tool_calls[0].name, 'open_curtains');
        assert.deepEqual(handoffPayload.tool_call_handoff.pending_tool_calls[0].arguments, { side: 'left' });
        assert.equal(handoffPayload.tool_call_handoff.node_id, handoffPayload.tool_call_handoff.pending_tool_calls[0].node_id);

        // The pending node was ALREADY persisted server-side before the trailer was sent - not
        // something the client still needs to create.
        const branchAfterHandoff = await loadBranch(directories, ownerId, toolBranch);
        const toolMsg = branchAfterHandoff.messages[branchAfterHandoff.messages.length - 1];
        assert.equal(toolMsg.node_id, handoffPayload.tool_call_handoff.node_id);
        assert.equal(toolMsg.extra.tool_invocations[0].result, null, 'in-flight: not yet resolved by a tool_result follow-up');

        // (k-2) Mixed round-trip: resolve the streaming hand-off via the SAME non-streaming
        // `type: 'tool_result'` follow-up chunk (b)/(c) already uses - proving persisted shape/replay
        // is identical regardless of whether the round that CREATED the pending node was itself
        // streaming or not.
        const app2 = buildTestApp();
        const { status: status2, data: data2 } = await postGenerate(app2, {
            owner_id: ownerId, character_avatar: avatar, node_id: handoffPayload.tool_call_handoff.node_id, type: 'tool_result',
            tool_results: [{ id: 'call_curtains_stream', result: 'Curtains opened on the left.', error: false }],
        });
        assert.equal(status2, 502, 'no fake backend is listening any more for the follow-up round - a real, sane error (connection refused), not a hang or an unhandled crash');
        assert.ok(data2.error, 'a real error body, not a silent failure');

        const branchAfterFollowUp = await loadBranch(directories, ownerId, toolBranch);
        const resolvedToolMsg = branchAfterFollowUp.messages.find(m => m.node_id === handoffPayload.tool_call_handoff.node_id);
        assert.equal(resolvedToolMsg.extra.tool_invocations[0].result, 'Curtains opened on the left.', 'the in-place edit resolving the pending node still happened even though the follow-up round\'s own backend call then failed');
    }

    // --- stealth-tool parity (this task) --- see runServerToolRounds()'s own doc comment, step 2b,
    // for the full legacy-verified semantics this replicates: ANY client-only call in a round whose
    // name is in `stealth_tool_names` aborts the WHOLE round (unconditionally - not merely "every call
    // was stealth"), with NOTHING invoked or persisted for that round at all.

    // (m) NON-STREAMING, an all-client-stealth round: the one call in the round is both client-only
    // AND named in `stealth_tool_names` - the route must return the distinct `{aborted: true}` outcome
    // (not `pending_tool_calls`, not a normal generation result), and NOTHING beyond the user's own
    // message may be persisted - no tool-invocation node, no assistant reply.
    {
        const toolBranch = 'tool-branch-all-stealth-abort';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, all-stealth-abort branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, all-stealth-abort branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);
        const messageCountBefore = branchBefore.messages.length;

        const clientTools = [{
            type: 'function',
            function: { name: 'log_secret_thought', description: 'Silently records a thought (client-only, stealth).', parameters: { type: 'object', properties: {} } },
        }];

        let callCount = 0;
        const fakeBackend = await startFakeBackend((_req, res) => {
            callCount++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant', content: null,
                        tool_calls: [{ id: 'call_stealth_1', type: 'function', function: { name: 'log_secret_thought', arguments: '{}' } }],
                    },
                }],
            }));
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Think something.', stream: false,
                client_tools: clientTools,
                stealth_tool_names: ['log_secret_thought'],
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(callCount, 1, 'the backend is called exactly once - an aborted round never refetches');
        assert.equal(status, 200, 'an aborted round is a normal 200, not an error');
        assert.equal(data.error, undefined);
        assert.equal(data.aborted, true, 'the distinct aborted outcome is used instead of pending_tool_calls or a normal generation result');
        assert.equal(data.pending_tool_calls, undefined, 'never a hand-off for an all-stealth round');

        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user\'s own message was persisted - no tool-invocation node, no assistant reply, matching legacy\'s "nothing new appears"');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Think something.');
    }

    // (n) NON-STREAMING, a MIXED round: one stealth client-only call and one non-stealth client-only
    // call in the SAME backend response. This task's investigation (see runServerToolRounds()'s own
    // doc comment, step 2b) found legacy's real mechanics - not the narrower "every call was stealth"
    // reading the old doc comment implied - abort the WHOLE round whenever ANY call is stealth, even
    // discarding an already-succeeded non-stealth invocation from the same round
    // (`ToolManager.invokeFunctionTools()`'s `shouldStopGeneration` is a plain `||` on
    // `stealthCalls.length`, unconditional). So this mixed round must ALSO abort entirely - it must
    // NOT partially hand off the non-stealth call - matching that verified behavior exactly.
    {
        const toolBranch = 'tool-branch-mixed-stealth-abort';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, mixed-stealth-abort branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, mixed-stealth-abort branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);
        const messageCountBefore = branchBefore.messages.length;

        const clientTools = [
            { type: 'function', function: { name: 'log_secret_thought', description: 'Silently records a thought (client-only, stealth).', parameters: { type: 'object', properties: {} } } },
            { type: 'function', function: { name: 'open_curtains', description: 'Opens the curtains (client-only, not stealth).', parameters: { type: 'object', properties: {} } } },
        ];

        let callCount = 0;
        const fakeBackend = await startFakeBackend((_req, res) => {
            callCount++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant', content: null,
                        tool_calls: [
                            { id: 'call_stealth_2', type: 'function', function: { name: 'log_secret_thought', arguments: '{}' } },
                            { id: 'call_curtains_mixed', type: 'function', function: { name: 'open_curtains', arguments: '{}' } },
                        ],
                    },
                }],
            }));
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Think something and open the curtains.', stream: false,
                client_tools: clientTools,
                stealth_tool_names: ['log_secret_thought'],
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(callCount, 1);
        assert.equal(status, 200);
        assert.equal(data.aborted, true, 'a stealth call anywhere in the round aborts the WHOLE round, including the non-stealth call alongside it');
        assert.equal(data.pending_tool_calls, undefined, 'the non-stealth call is NOT partially handed off');

        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user\'s own message was persisted - the non-stealth call\'s own in-flight node was never created either');
    }

    // (o) STREAMING, an all-client-stealth round: the fake backend streams a `tool_calls` delta for a
    // stealth-only name - the server must send the `tool_call_aborted` SSE trailer (not
    // `tool_call_handoff`) and end the stream with no further content chunk, and must NOT have
    // persisted anything beyond the user's own message.
    {
        const toolBranch = 'stream-tool-branch-all-stealth-abort';
        await saveChatToTree(directories, ownerId, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, streaming all-stealth-abort branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, streaming all-stealth-abort branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, toolBranch);
        const messageCountBefore = branchBefore.messages.length;

        let callCount = 0;
        const fakeBackend = await startFakeBackend((_req, res) => {
            callCount++;
            const deltaChunks = [
                { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_stealth_stream', type: 'function', function: { name: 'log_secret_thought', arguments: '{}' } }] } }] },
            ];
            const sseBody = deltaChunks.map(json => `data: ${JSON.stringify(json)}\n\n`).join('') + 'data: [DONE]\n\n';
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(sseBody);
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, bodyText;
        try {
            ({ status, bodyText } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Think something, streamed.', stream: true,
                client_tools: [{ type: 'function', function: { name: 'log_secret_thought', description: 'Silently records a thought (client-only, stealth).', parameters: { type: 'object', properties: {} } } }],
                stealth_tool_names: ['log_secret_thought'],
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(callCount, 1, 'the backend is never re-called for an aborted round');
        assert.equal(status, 200);
        assert.ok(!bodyText.includes('"tool_calls"'), 'the raw tool_calls delta is never forwarded to the client');
        assert.ok(!bodyText.includes('tool_call_handoff'), 'an aborted round is NOT a hand-off');

        const abortedLine = bodyText.split('\n').map(line => line.trim()).find(line => line.startsWith('data:') && line.includes('tool_call_aborted'));
        assert.ok(abortedLine, 'a tool_call_aborted trailer event was sent before the stream closed');
        const abortedPayload = JSON.parse(abortedLine.slice(5).trim());
        assert.equal(abortedPayload.tool_call_aborted, true);
        assert.ok(bodyText.trim().endsWith('data: [DONE]'), 'the stream still ends with the normal [DONE] sentinel, with no further content chunk after the trailer');

        const branchAfter = await loadBranch(directories, ownerId, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user\'s own message was persisted - no tool-invocation node, no assistant reply');
    }

    // --- isSwipe/isContinue interleaved with a server tool-call round (this task: fixes the
    // previously-documented, out-of-scope limitation on runServerToolRounds()'s own doc comment -
    // see that function's "FORMERLY-DOCUMENTED LIMITATION, NOW FIXED" section for the full design) ---

    // (l) type: 'swipe' where the FIRST backend response is a tool call, not text: the tool-call turn
    // must claim the sibling-alternative slot alongside the ORIGINAL swiped message (not be buried as
    // a plain child of it), and the SECOND backend response's final text must land as the terminal
    // node of that same new alternative branch - proving a swipe-with-a-tool-call still produces "a
    // new alternative at the same tree position as the message being swiped", not a nested append.
    {
        const swipeToolBranch = 'swipe-tool-branch';
        await saveChatToTree(directories, ownerId, swipeToolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, swipe-with-tool branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, swipe-with-tool branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, swipeToolBranch);
        const swipedNodeId = branchBefore.branch.leaf_id;
        const swipedAncestry = await getAncestorPath(directories, swipedNodeId);
        const parentNodeId = swipedAncestry[swipedAncestry.length - 2].node_id;

        registerServerTool({
            id: 'test-tool:swipe_get_weather',
            name: 'get_weather',
            description: 'Gets the current weather for a city.',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            invoke: async (args) => `Sunny in ${args.city}`,
        });

        let callCount = 0;
        const requestBodies = [];
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            callCount++;
            requestBodies.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (callCount === 1) {
                res.end(JSON.stringify({
                    choices: [{
                        message: {
                            role: 'assistant', content: null,
                            tool_calls: [{ id: 'call_swipe_1', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Swiptown' }) } }],
                        },
                    }],
                }));
            } else {
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'General Kenobi! (checked: sunny in Swiptown)' } }] }));
            }
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: swipedNodeId,
                type: 'swipe', is_swipe: true, stream: false,
            }));
        } finally {
            fakeBackend.server.close();
            unregisterServerTool('test-tool:swipe_get_weather');
        }

        assert.equal(status, 200, 'the swipe-with-tool-call request completes normally');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'General Kenobi! (checked: sunny in Swiptown)' } }] });
        assert.equal(callCount, 2, 'backend called twice: once producing the tool call, once with the final swipe text');
        assert.ok(JSON.stringify(requestBodies[1].messages).includes('Sunny in Swiptown'), 'the second request\'s history really was re-resolved through the tool-call turn');

        // (a) the tool-call turn claimed the SIBLING-ALTERNATIVE slot alongside the swiped message -
        // not a plain child buried one level under it.
        const alternatives = await getAlternatives(directories, swipedNodeId);
        assert.equal(alternatives.total, 2, 'the swiped message and the tool-call turn are real siblings under the same parent');
        const toolAlt = alternatives.alternatives.find(a => a.node_id !== swipedNodeId);
        assert.ok(toolAlt, 'a second alternative alongside the swiped message exists');
        assert.ok(Array.isArray(toolAlt.extra?.tool_invocations), 'that second alternative IS the tool-call turn, not the final text');
        assert.equal(toolAlt.extra.tool_invocations[0].name, 'get_weather');
        assert.equal(toolAlt.extra.tool_invocations[0].result, 'Sunny in Swiptown');
        // Proof that the tool-call turn (not the original message) is now selected as current comes
        // from the branch's own leaf path below (`loadBranch()` follows `default_child_id`) -
        // `getAlternatives()`'s own `selected` field only ever reports the index of whichever
        // node_id was passed in, it does not read `default_child_id` itself.

        // (b) the original swiped message is completely unchanged.
        assert.ok(alternatives.alternatives.some(a => a.node_id === swipedNodeId && a.mes === 'Hello there, swipe-with-tool branch!'), 'the swiped message\'s own original content is untouched');

        // (c) the final swipe text is the TERMINAL node of that same new alternative branch (a child
        // of the tool-call turn), one level deeper than the tool-call turn itself - NOT a second
        // sibling under the tool-call turn's own parent (which would be the swiped message's parent,
        // already asserted to hold exactly 2 alternatives above).
        const branchAfter = await loadBranch(directories, ownerId, swipeToolBranch);
        const finalNodeId = branchAfter.branch.leaf_id;
        assert.notEqual(finalNodeId, toolAlt.node_id, 'the final text is its own node, not stored on the tool-call turn itself');
        const finalAncestry = await getAncestorPath(directories, finalNodeId);
        assert.equal(finalAncestry.length, swipedAncestry.length + 1, 'the final text sits exactly one level deeper than the swiped message\'s own depth - a child of the tool-call turn, which itself occupies the swiped message\'s sibling depth');
        assert.equal(finalAncestry[finalAncestry.length - 2].node_id, toolAlt.node_id, 'the final text\'s real parent is the tool-call turn');
        assert.equal(finalAncestry[finalAncestry.length - 3].node_id, parentNodeId, 'the tool-call turn\'s own parent is the SAME real parent the swiped message has - confirming the sibling relationship, not a nested-under-the-original-message one');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'General Kenobi! (checked: sunny in Swiptown)');
    }

    // (m) type: 'continue' where the FIRST backend response is a tool call: continuing "in place"
    // across a genuine intervening tool-call node isn't structurally meaningful (a real new tree node
    // now exists between "before" and "after"), so this degrades to a plain append - the ORIGINAL
    // message's own text must stay byte-for-byte unedited, the tool-call turn must persist as a real
    // child of it, and the final generated text must land as ITS OWN new node after the tool-call turn
    // (not merged/concatenated into any other node's text).
    {
        const continueToolBranch = 'continue-tool-branch';
        await saveChatToTree(directories, ownerId, continueToolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, continue-with-tool branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'The weather today is', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, continueToolBranch);
        const continuedNodeId = branchBefore.branch.leaf_id;
        const messageCountBefore = branchBefore.messages.length;

        registerServerTool({
            id: 'test-tool:continue_get_weather',
            name: 'get_weather',
            description: 'Gets the current weather for a city.',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            invoke: async (args) => `Sunny in ${args.city}`,
        });

        let callCount = 0;
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            callCount++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (callCount === 1) {
                res.end(JSON.stringify({
                    choices: [{
                        message: {
                            role: 'assistant', content: null,
                            tool_calls: [{ id: 'call_continue_1', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Continuetown' }) } }],
                        },
                    }],
                }));
            } else {
                void body;
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ' sunny, according to the tool.' } }] }));
            }
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: continuedNodeId,
                type: 'continue', is_continue: true, stream: false,
            }));
        } finally {
            fakeBackend.server.close();
            unregisterServerTool('test-tool:continue_get_weather');
        }

        assert.equal(status, 200);
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: ' sunny, according to the tool.' } }] });
        assert.equal(callCount, 2);

        const branchAfter = await loadBranch(directories, ownerId, continueToolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'two new nodes were appended (the tool-call turn and the final text) - continue-in-place across a real tool call degrades to append, it does not silently drop the tool-call record');

        const originalNode = (await getAlternatives(directories, continuedNodeId)).alternatives.find(a => a.node_id === continuedNodeId);
        assert.equal(originalNode.mes, 'The weather today is', 'the original message the user asked to continue is completely UNEDITED - it was never a valid edit target once a real tool call intervened');

        const [toolMsg, finalMsg] = branchAfter.messages.slice(-2);
        assert.equal(toolMsg.is_system, true, 'the tool-call turn is a real child of the original message');
        assert.equal(toolMsg.extra.tool_invocations[0].result, 'Sunny in Continuetown');
        assert.equal(finalMsg.is_user, false);
        assert.equal(finalMsg.mes, ' sunny, according to the tool.', 'the final generated text is its own new node, holding just the newly generated text - not concatenated onto the original message\'s text, and not lost');
        assert.equal(finalMsg.name, 'Rex');
    }

    // --- json_schema threading (this task): a raw-action `type: 'quiet'` request carrying a
    // `json_schema` field must actually reach the backend as a real `response_format`/`json_schema`
    // constraint, exactly like the legacy client-assembled path already produces via
    // `createGenerationParameters()`'s own `jsonSchema` support (src/chat-completion-generation-data.js) -
    // see `buildRawActionChatCompletionRequest()`'s own `jsonSchema` param doc comment. Default fixture
    // settings use `chat_completion_source: 'custom'` (buildSettingsFixture() above), which is served by
    // the generic/default dispatch branch (chat-completions.js, the `request.body.json_schema` handling
    // right before `requestBody` is assembled) - not one of the ~12 provider-`switch` cases.
    {
        const jsonSchemaBranch = 'json-schema-branch';
        await saveChatToTree(directories, ownerId, jsonSchemaBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, json-schema branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, json-schema branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, jsonSchemaBranch);

        const requestBodies = [];
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            requestBodies.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"mood": "happy"}' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'quiet', user_message: '', stream: false,
                json_schema: { name: 'mood_schema', description: 'The character\'s mood.', strict: true, value: { type: 'object', properties: { mood: { type: 'string' } }, required: ['mood'] } },
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(status, 200, 'the raw-action route accepted a json_schema-bearing quiet request instead of falling through/erroring');
        assert.equal(data.choices[0].message.content, '{"mood": "happy"}');

        assert.equal(requestBodies.length, 1);
        const sentBody = requestBodies[0];
        assert.ok(sentBody.response_format, 'the backend request actually carries a response_format constraint, not an unconstrained completion');
        assert.equal(sentBody.response_format.type, 'json_schema');
        assert.equal(sentBody.response_format.json_schema.name, 'mood_schema');
        assert.equal(sentBody.response_format.json_schema.strict, true);
        assert.deepEqual(sentBody.response_format.json_schema.schema, { type: 'object', properties: { mood: { type: 'string' } }, required: ['mood'] }, 'the schema value forwarded is the exact object the client sent, not a re-derived one');

        // quiet generations never touch the visible tree on either side (see the route handler's own
        // `skipPersistence` comment) - confirm the json_schema plumbing didn't accidentally change that.
        const branchAfter = await loadBranch(directories, ownerId, jsonSchemaBranch);
        assert.equal(branchAfter.messages.length, branchBefore.messages.length, 'a quiet generation persists neither the user nor the assistant side, json_schema or not');
    }

    console.log('chat-completions.test.js: all assertions passed');
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
