import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
// chat-completions.js -> chat-completion-generation-input.js pulls in src/endpoints/characters.js
// (via readCardContent) and src/endpoints/tokenizers.js, both of which read process-wide config at
// import time - the config path must be set before that import chain runs, same as
// chat-completion-generation-input.test.js/text-completions.test.js.
import { setConfigFilePath } from '../../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

// JUDGMENT CALL: sendAI21Request (chat-completions.js) is the ONLY one of the four provider
// functions covered by this task with NO override for its target host at all - verified by reading
// its full body: it always calls `fetch(API_AI21 + '/chat/completions', options)`, a hardcoded
// `https://api.ai21.com/studio/v1` constant, completely unlike sendClaudeRequest/
// sendMakerSuiteRequest/sendMistralAIRequest (all of which honor `request.body.reverse_proxy`) - and
// AI21 is confirmed absent from chat-completion-generation-data.js's own `proxySupportedSources`
// list too. So there is no way, via any REQUEST-BUILDING field, to route a real raw-action AI21 call
// at this route to a local fake backend - the only two options are (a) add reverse-proxy support to
// sendAI21Request, which is explicitly out of scope (touches this task's four functions' own
// request-building logic, not just persistence), or (b) intercept the `node-fetch` module itself for
// the duration of the AI21-specific tests below, using Node's built-in (currently experimental)
// `node:test` `mock.module()` - real network is never touched: the mock rewrites ONLY requests whose
// origin is `https://api.ai21.com` to instead hit this session's own local fake HTTP backend (a REAL
// `node-fetch` call still runs against that local server - the mock is a thin reroute, not a
// hand-built fake Response, so `.ok`/`.status`/`.json()`/`.text()`/`.body` streaming semantics are
// all genuinely real), and passes every other URL straight through to the real, unmodified
// `node-fetch` (captured via its own file path below, bypassing the mock) - which is exactly what
// every other test in this file already relies on (the 'custom'/'claude'/'makersuite'/'mistralai'
// fake-backend tests all still go through this same indirection, unaffected, since none of their
// URLs are ever `https://api.ai21.com`).
//
// `mock.module()` only exists when Node is launched with `--experimental-test-module-mocks` (not
// otherwise enabled anywhere in this repo's tooling) - feature-detected below so this file still runs
// to completion under a plain `node chat-completions.test.js` invocation exactly as before; the
// AI21-specific tests further down skip themselves (with a clear console.log, not a silent no-op)
// when the feature isn't available, and only then. Must run before `chat-completions.js` is first
// imported below (its own top-level `import fetch from 'node-fetch'` needs to resolve to the mock).
const canMockAi21Backend = typeof mock.module === 'function';
/** @type {string|null} Set by pointAI21BackendAt() below; read by the node-fetch reroute mock. */
let ai21FakeBackendUrl = null;
if (canMockAi21Backend) {
    const realNodeFetch = (await import(path.join(__dirname, '..', '..', '..', 'node_modules', 'node-fetch', 'src', 'index.js'))).default;
    mock.module('node-fetch', {
        defaultExport: async (url, opts) => {
            const target = new URL(url);
            if (ai21FakeBackendUrl && target.origin === 'https://api.ai21.com') {
                return realNodeFetch(new URL(target.pathname + target.search, ai21FakeBackendUrl), opts);
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-completions-raw-action-test-'));
const charactersDir = path.join(root, 'characters');
const groupsDir = path.join(root, 'groups');
const worldsDir = path.join(root, 'worlds');
fs.mkdirSync(charactersDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(worldsDir, { recursive: true });

const directories = { root, characters: charactersDir, groups: groupsDir, worlds: worldsDir };
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
    const branchName = 'main-chat';
    await saveChatToTree(directories, ownerId, branchName, [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        { name: 'Tester', is_user: true, mes: 'Hi Rex, nice to meet you.', send_date: 2, extra: {} },
        { name: 'Rex', is_user: false, mes: 'Likewise!', send_date: 3, extra: {} },
    ]);

    // --- happy path: a new user message on an existing branch ---
    const built = await buildRawActionChatCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, branchName,
        type: 'normal', userMessageText: 'What happens next, Rex?',
    });

    assert.equal(built.settings.chat_completion_source, 'custom', 'settings resolves for real from oai_settings');
    assert.equal(built.name1, 'Tester', 'name1 resolves from settings.json username, same as the orchestrator input');
    assert.equal(built.name2, 'Rex');
    assert.ok(built.anchorNodeId, 'anchorNodeId resolves to the real leaf of the loaded branch');

    const branchBeforeAppend = await loadBranch(directories, ownerId, branchName);
    assert.equal(built.anchorNodeId, branchBeforeAppend.branch.leaf_id, 'anchorNodeId is exactly the loaded branch\'s real leaf_id');

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

    // --- continue: no userMessageText, still resolves and assembles from the real history ---
    const continued = await buildRawActionChatCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, branchName, type: 'continue', isContinue: true,
    });
    const continuedJoined = continued.params.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.ok(continuedJoined.includes('Likewise!'), 'continue resolves from the real existing history with no new message appended');
    assert.equal(continued.anchorNodeId, branchAfterAppend.branch.leaf_id, 'the continue anchor is the real current leaf');
    assert.equal(continued.anchorContent?.mes, 'What happens next, Rex?', 'anchorContent is the anchor\'s real, current, unmodified content (the real leaf at this point in the test, appended above) - exactly what the route\'s is_continue edit needs as "oldText"');

    // --- error handling: missing owner_id ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, branchName,
        }),
        /owner_id is required/,
    );

    // --- error handling: unknown character ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: 'NoSuchCharacter.png', ownerId, branchName,
        }),
        /Character not found/,
    );

    // --- error handling: unknown branch ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, ownerId, branchName: 'no-such-branch',
        }),
        /Chat branch not found/,
    );

    // --- error handling: missing branch/node identity ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, ownerId,
        }),
        /branch_name or node_id is required/,
    );

    // --- error handling: missing character/group ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            ownerId, branchName,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: swipeBranch,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: regenBranch,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: continueBranch,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: continueWithUserTextBranch,
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

        // --- assembly: buildRawActionChatCompletionRequest() with BOTH characterAvatar (Nova, the
        // member actually responding this turn) AND groupId (the group) set together. ---
        const builtGroup = await buildRawActionChatCompletionRequest(directories, {
            characterAvatar: nova, groupId, ownerId: groupId, branchName: groupChatId,
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
            owner_id: groupId, character_avatar: nova, group_id: groupId, branch_name: groupChatId,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: streamBranch,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: streamSwipeBranch,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: streamContinueBranch,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: claudeBranch,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: claudeStreamBranch,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: makerSuiteBranch,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: makerSuiteStreamBranch,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: mistralBranch,
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

        const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via Mistral.']);
        pointMistralBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, branch_name: mistralStreamBranch,
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

    // (m)/(m-2) sendAI21Request, non-streaming AND streaming - see the `canMockAi21Backend` comment
    // near the top of this file for exactly why this needs `node:test`'s `mock.module()` (unlike the
    // three functions above, sendAI21Request has NO reverse-proxy override at all) and why these two
    // tests skip themselves, loudly, when that (currently experimental, opt-in-flag-gated) capability
    // isn't available in the running Node process - every other test in this file (including the
    // three provider tests directly above) runs identically either way.
    if (!canMockAi21Backend) {
        console.log('chat-completions.test.js: skipping sendAI21Request persistence tests - run with `node --experimental-test-module-mocks` to include them (see the canMockAi21Backend comment near the top of this file)');
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
                owner_id: ownerId, character_avatar: avatar, branch_name: ai21Branch,
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

            const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via AI21.']);
            pointAI21BackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyText } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, branch_name: ai21StreamBranch,
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
    }

    // The remaining ~8 provider-`switch` cases (Cohere/DeepSeek/Aimlapi/Xai/Chutes/Minimax/
    // ElectronHub/AzureOpenAI) are intentionally NOT exercised here - see the code comments at
    // `pendingAssistantPersist`'s declaration in chat-completions.js for the full, explicit, by-name
    // list of what remains deferred (for BOTH streaming and non-streaming). Proving the assistant
    // reply is untouched for them is trivial (they never take/read a `persist` parameter at all -
    // each function returns from its own, completely untouched `forwardFetchResponse()` call site
    // before reaching this route's shared dispatch code at all), but actually driving real
    // provider-specific traffic through this harness would be exercising existing, unmodified
    // plumbing - out of scope here.

    // --- error handling (route-level): missing owner_id falls through as an ordinary (non-raw-action)
    // request - it is NOT gated into the raw-action branch at all (the gate itself requires owner_id),
    // so it reaches the default dispatch code below with whatever fields the client actually sent.
    // Not asserted further here - this is the same "not a raw action" byte-for-byte-unchanged path the
    // connection_profile_id branch and legacy default path already exercise elsewhere.

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
