import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import nodeFetch from 'node-fetch';

import { write as writeCard } from '../../character-card-parser.js';
// kobold.js -> text-completion-generation-input.js pulls in src/endpoints/characters.js (via
// readCardContent), which (via character-shallow.js) reads process-wide config at import time -
// the config path must be set before that import chain runs, same as
// text-completions.test.js/text-completion-generation-input.test.js.
import { setConfigFilePath } from '../../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

// This is a route-level Express-integration test for kobold.js's own raw-action /generate branch
// (see `git show 341d1dead` for the commit that added it), mirroring
// text-completions.test.js's established convention exactly: a real express app mounting the real
// router, a real node:http fake backend standing in for the actual KoboldAI/KoboldCpp server, real
// on-disk fixtures (writeCharacter/buildSettingsFixture/saveChatToTree/writeAllSettings), and
// loadBranch()-based tree-persistence assertions.
//
// JUDGMENT CALL (read this before the streaming tests below): Kobold's own backend URL IS
// genuinely settings-driven, unlike NovelAI - CONFIRMED, not assumed, by reading
// src/text-completion-generation-input.js's own `apiServer: mainApi === 'kobold' ?
// (koboldSettings.api_server ?? '') : undefined` (koboldSettings === kai_settings, the top-level
// settings.json key) and src/text-completion-prompt-orchestrator.js's own
// `createKoboldGenerationData({ ..., apiServer, ... })` call, whose own `api_server: apiServer`
// wire field (src/kobold-generation-data.js) becomes `built.params.api_server` -
// buildRawActionKoboldRequest()'s returned params - which kobold.js's router then dispatches to
// completely unmodified (`request.body = built.params`, then `fetch(request.body.api_server + ...)`).
// So `kai_settings.api_server` in the settings.json fixture below can point directly at this
// file's own fake `node:http` backend, exactly like text-completions.test.js's own
// `textgenerationwebui_settings.server_urls.generic` - no `mock.module()` reroute needed here.
//
// SEPARATE, MORE IMPORTANT JUDGMENT CALL (updated - a real, verified gap was found AND FIXED in a
// follow-up task; this comment is corrected accordingly, and test (b) below now proves the FIX
// works, not the original bug): raw-action Kobold /generate requests could NOT actually stream as
// originally shipped in 341d1dead. Proof, read directly from the real code (as it stood then):
// - src/kobold-generation-data.js's createKoboldGenerationData() computes
//   `streaming: koboldSettings.streaming_kobold && koboldFlags.can_use_streaming && type !== 'quiet'`
//   - BOTH koboldSettings.streaming_kobold AND koboldFlags.can_use_streaming must be truthy.
// - koboldFlags defaults to `{}` in src/text-completion-prompt-orchestrator.js's own
//   assembleTextCompletionPrompt() destructure (`koboldFlags = {}`), so `can_use_streaming` is
//   `undefined` unless the caller supplies an override.
// - src/text-completion-generation-input.js's resolveTextCompletionGenerationInput() (verified by
//   reading its ENTIRE returned object) never sets `koboldFlags` at all - its own doc comment
//   explicitly says this is deliberate ("koboldFlags is left to the caller (via macroExtras),
//   defaulting (via the orchestrator's own default) to all-false" - because kai_flags is a LIVE,
//   version-probed capability the resolver refuses to fetch as a side effect of pure
//   request-building).
// - kobold.js's own buildRawActionKoboldRequest() never passes a `macroExtras` override for
//   `koboldFlags` either - there is no live capability probe available server-side, so
//   `built.params.streaming` (the return value of buildRawActionKoboldRequest() itself, in
//   isolation) is STILL unconditionally `false` today - see the `built.params.streaming === false`
//   assertion a bit further down, which remains correct and is unchanged by the fix.
// THE FIX (in the route handler, not in buildRawActionKoboldRequest() itself - see kobold.js's
// `/generate` route): the client (public/script.js's `rawActionGenerateData` construction) now
// computes `streaming` itself, client-side, the exact same real way getKoboldGenerationData() does
// (`kai_settings.streaming_kobold && kai_flags.can_use_streaming && type !== 'quiet'` - using the
// client's own LIVE `kai_flags.can_use_streaming` capability probe, which has no server-side
// equivalent), and sends it as a real `streaming` field on the raw-action request body. The route
// handler captures that ORIGINAL client-requested value (`streamingRequested`) BEFORE it replaces
// `request.body` with `built.params`, then re-applies it: `request.body = { ...built.params,
// streaming: !!streamingRequested };` - the exact same "trust the client's own streaming
// preference" pattern text-completions.js's own raw-action branch already uses for
// `stream: !!request.body.stream`. So the SSE branch (`forwardAndPersistSseText()`,
// `/extra/generate/stream`) IS reachable for a real raw-action request that asks for it. Test (b)
// below now proves this positively (a request with `streaming: true` really reaches
// `/extra/generate/stream` and its SSE response is correctly relayed/persisted), and a separate,
// clearly-labeled unit-level test still directly exercises the real `forwardAndPersistSseText()` +
// the route's own literal `json => json?.token` extractor lambda (copied verbatim from kobold.js)
// against a real SSE stream, for extra coverage of the per-chunk accumulation/persistence logic in
// isolation.
const { router, buildRawActionKoboldRequest } = await import('./kobold.js');
const { forwardAndPersistSseText } = await import('./text-completions.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { saveChatToTree, loadBranch, getAlternatives, disposeMessageTreeStores } = await import('../../message-tree-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-kobold-raw-action-test-'));
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

/** Real settings.json fixture - only the keys resolveTokenizerType()/resolveTextCompletionGenerationInput()/createKoboldGenerationData() actually read, plus a real kai_settings shape matching src/kobold-generation-data.test.js's own baseArgs().koboldSettings field names. */
function buildSettingsFixture() {
    return {
        username: 'Tester',
        amount_gen: 100,
        max_context: 4096,
        power_user: {
            tokenizer: undefined,
            instruct: { enabled: false },
            context: {},
            reasoning: {},
            sysprompt: {},
        },
        world_info: { globalSelect: [], charLore: [] },
        world_info_settings: {},
        kai_settings: {
            api_server: '', // overridden per-test via pointKoboldBackendAt()
            rep_pen: 1.1,
            rep_pen_range: 320,
            rep_pen_slope: 0.9,
            temp: 0.8,
            tfs: 1,
            top_a: 0,
            top_k: 0,
            top_p: 0.9,
            min_p: 0.05,
            typical: 1,
            mirostat: 2,
            mirostat_tau: 5,
            mirostat_eta: 0.1,
            use_default_badwordsids: true,
            grammar: '',
            seed: -1,
            streaming_kobold: false,
            sampler_order: [6, 0, 1, 3, 4, 2, 5],
        },
        extension_settings: { note: {}, cfg: {} },
    };
}

/** Deterministic fake local encoder, injected via tokenizerOptions so no real tokenizer model files or network calls are needed. */
const fakeTokenizerOptions = {
    encodeLocal: async (_key, text) => Array.from(String(text ?? '')).map(ch => ch.codePointAt(0)),
};

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
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

/** Like postGenerate(), but reads the raw response body as text instead of parsing it as JSON - for the streaming (SSE) case, where the response is `text/event-stream`, not JSON. */
async function postGenerateRaw(app, body) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        return { status: res.status, headers: res.headers, text };
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

/** Polls `check()` until it returns truthy or `timeoutMs` elapses - persistence for the non-streaming path happens synchronously (awaited before `response_generate.send()`), but this is kept for symmetry/robustness with the direct forwardAndPersistSseText() unit test below. */
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

function pointKoboldBackendAt(url) {
    const settings = buildSettingsFixture();
    settings.kai_settings.api_server = url;
    writeAllSettings(directories, settings);
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

    // --- buildRawActionKoboldRequest(): basic real assembly, including the settings-driven api_server ---
    {
        pointKoboldBackendAt('http://127.0.0.1:9/unused-in-this-assertion');
        const built = await buildRawActionKoboldRequest(directories, {
            characterAvatar: avatar, ownerId, branchName,
            type: 'normal', userMessageText: 'What happens next, Rex?',
            tokenizerOptions: fakeTokenizerOptions,
        });
        assert.equal(built.name1, 'Tester');
        assert.equal(built.name2, 'Rex');
        assert.ok(built.anchorNodeId);
        assert.equal(built.params.api_server, 'http://127.0.0.1:9/unused-in-this-assertion', 'api_server is resolved for real from kai_settings.api_server, via the orchestrator\'s own apiServer input - CONFIRMED settings-driven, not hardcoded');
        assert.equal(typeof built.params.prompt, 'string');
        assert.ok(built.params.prompt.includes('Hello there, traveler.'));
        assert.ok(built.params.prompt.includes('What happens next, Rex?'));
        assert.equal(built.params.streaming, false, 'streaming is unconditionally false for a raw-action-built request - see this file\'s own top-of-file doc comment on why (koboldFlags always defaults to {}, with no way to override it from buildRawActionKoboldRequest()\'s own params)');
    }

    // --- error handling: missing owner_id ---
    await assert.rejects(
        () => buildRawActionKoboldRequest(directories, {
            characterAvatar: avatar, branchName,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /owner_id is required/,
    );

    // --- error handling: unknown character ---
    await assert.rejects(
        () => buildRawActionKoboldRequest(directories, {
            characterAvatar: 'NoSuchCharacter.png', ownerId, branchName,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Character not found/,
    );

    // --- error handling: unknown branch ---
    await assert.rejects(
        () => buildRawActionKoboldRequest(directories, {
            characterAvatar: avatar, ownerId, branchName: 'no-such-branch',
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Chat branch not found/,
    );

    // (a) route-level: non-streaming raw-action /generate success - real Kobold `/v1/generate`
    // response shape `{results: [{text: "..."}]}`, verified against kobold.js's own comment citing
    // public/script.js's `data.results[0].text` read of this exact endpoint (`git show
    // 341d1dead:src/endpoints/backends/kobold.js`, the persistAssistantReply() call site comment).
    {
        const fakeBackend = await startFakeBackend((req, res) => {
            assert.equal(req.url, '/v1/generate', 'the non-streaming raw-action request really hits Kobold\'s real /v1/generate endpoint');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [{ text: 'Rex says hello back.' }] }));
        });
        pointKoboldBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
            type: 'normal', user_message: 'One more time, Rex?',
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.deepEqual(data, { results: [{ text: 'Rex says hello back.' }] }, 'the real Kobold response body reaches the client byte-for-byte unmodified');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply were appended');
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'One more time, Rex?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back.', 'the assistant reply text was extracted from data.results[0].text and appended');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex', 'the assistant message uses name2 (the character\'s display name)');

        // chained, not a sibling: the assistant message is a direct child of the just-appended user
        // message (real ancestry depth check via getAlternatives on the user node - it should have
        // no siblings, and the assistant node is one level deeper).
        const userAlternatives = await getAlternatives(directories, userMsg.node_id ?? branchAfter.messages[branchAfter.messages.length - 2].node_id);
        assert.equal(userAlternatives.total, 1, 'the persisted user message has no siblings - it is a genuine new child, not a swipe alternative');
    }

    // (b) STREAMING raw-action: proves the FIX (see this file's top-of-file doc comment) actually
    // works - a raw-action request that sets `streaming: true` (the real field name the client now
    // sends, computed the same way getKoboldGenerationData() computes its own `streaming` field)
    // really reaches Kobold's STREAMING endpoint (`/extra/generate/stream`), never the non-streaming
    // `/v1/generate`, and the real SSE response is correctly relayed back to the client (raw bytes,
    // `text/event-stream`) AND persisted as the assistant's reply via forwardAndPersistSseText().
    {
        const settings = buildSettingsFixture();
        settings.kai_settings.streaming_kobold = true; // matches what a real client would have used to compute `streaming: true`
        let sawNonStreamRequest = false;
        const sseTokens = ['Rex ', 'streams ', 'for ', 'real.'];
        const fakeBackend = await startFakeBackend((req, res) => {
            if (req.url === '/extra/generate/stream') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end(sseTokens.map(token => `data: ${JSON.stringify({ token })}\n\n`).join('') + 'data: [DONE]\n\n');
                return;
            }
            sawNonStreamRequest = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [{ text: 'Should not be reached - streaming was requested.' }] }));
        });
        settings.kai_settings.api_server = fakeBackend.url;
        writeAllSettings(directories, settings);

        const streamBranch = 'kobold-stream-attempt-chat';
        await saveChatToTree(directories, ownerId, streamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);
        // NOTE: `ownerId` (the character avatar) has ONE shared underlying message tree across all
        // branches created against it in this file (branches are just named leaf pointers into that
        // same tree) - `loadBranch()`'s own `messages` is the full ancestor path from root to that
        // leaf, so it already includes every message from every earlier test section that shares
        // this same `ownerId` (verified directly: a debug run showed `main-chat`'s own prior
        // messages present here too). So growth must be measured relative to a captured
        // messageCountBefore, exactly like tests (a)/(c) below do - NOT asserted against an absolute
        // count.
        const messageCountBefore = (await loadBranch(directories, ownerId, streamBranch)).messages.length;

        const app = buildTestApp();
        const { status, headers, text } = await postGenerateRaw(app, {
            owner_id: ownerId, character_avatar: avatar, branch_name: streamBranch,
            type: 'normal', user_message: 'Try to stream, Rex.', streaming: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(sawNonStreamRequest, false, '/v1/generate was never requested - the streaming request correctly reached /extra/generate/stream instead');
        // Note: forwardFetchResponse() (src/util.js) - the function that ultimately pipes this
        // response - forwards the upstream body/status but does NOT copy the upstream's
        // Content-Type header (verified by reading it: it only ever sets `to.statusCode`/
        // `to.statusMessage`, never a header), so the response is genuinely headerless here rather
        // than lying about being `text/event-stream` - not asserted on for that reason. The raw SSE
        // body bytes (checked below) are what actually distinguishes this from the JSON path.
        void headers;
        assert.equal(text, sseTokens.map(token => `data: ${JSON.stringify({ token })}\n\n`).join('') + 'data: [DONE]\n\n', 'the raw SSE bytes from the fake Kobold backend reach the client byte-for-byte unmodified');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, streamBranch);
            return branch.messages.length === messageCountBefore + 2 ? branch : null;
        });
        const [, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(assistantMsg.mes, sseTokens.join(''), 'the assistant reply was accumulated from the real SSE stream (via forwardAndPersistSseText()) and persisted correctly');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex');

        // Direct, unit-level exercise of the REAL forwardAndPersistSseText() function together with
        // the route's own literal extractor lambda (`json => json?.token`, copied verbatim from
        // kobold.js's real /generate handler - `git show 341d1dead:src/endpoints/backends/kobold.js`)
        // against a REAL SSE HTTP response from a real node:http server (the same fake backend
        // pattern used everywhere else in this file) - proves the real per-chunk accumulation and
        // persistence logic for Kobold's real `{"token": "..."}` streaming shape works correctly,
        // even though the full HTTP route currently cannot reach this branch for raw-action requests
        // (see this file's top-of-file doc comment).
        const sseChunks = ['Rex ', 'streams ', 'a ', 'reply.'];
        const sseBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(sseChunks.map(token => `data: ${JSON.stringify({ token })}\n\n`).join('') + 'data: [DONE]\n\n');
        });
        const directStreamBranch = 'kobold-direct-forward-persist-chat';
        await saveChatToTree(directories, ownerId, directStreamBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Say hi via the direct SSE path.', send_date: 1, extra: {} },
        ]);
        const branchBeforeDirect = await loadBranch(directories, ownerId, directStreamBranch);
        const anchorNodeId = branchBeforeDirect.branch.leaf_id;

        // Uses `node-fetch` (NOT the global web-standard `fetch`) - forwardAndPersistSseText()
        // requires the real node-fetch Response whose `.body` is a node Readable stream (`.on(...)`),
        // exactly what the real route's own `import fetch from 'node-fetch'` provides - the global
        // fetch's body is a web ReadableStream with no `.on()` method.
        const fetchResponse = await nodeFetch(sseBackend.url);
        /** Minimal fake Express response, capturing exactly what forwardFetchResponse()/forwardAndPersistSseText() write to it. */
        const chunks = [];
        const fakeExpressResponse = {
            statusCode: 200,
            writableEnded: false,
            status(code) { this.statusCode = code; return this; },
            set() { return this; },
            setHeader() {},
            write(chunk) { chunks.push(chunk); return true; },
            end(chunk) { if (chunk) chunks.push(chunk); this.writableEnded = true; },
            on() {},
        };
        await forwardAndPersistSseText(fetchResponse, fakeExpressResponse, {
            directories, ownerId, anchorNodeId, name2: 'Rex', isSwipe: false, isContinue: false, anchorContent: null,
        }, json => json?.token);
        sseBackend.server.close();

        const branchAfterDirect = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, directStreamBranch);
            return branch.messages.length === 2 ? branch : null;
        });
        assert.equal(branchAfterDirect.messages[1].mes, 'Rex streams a reply.', 'the real forwardAndPersistSseText() + the route\'s own {"token":...} extractor correctly accumulated and persisted every chunk');
        assert.equal(branchAfterDirect.messages[1].name, 'Rex');
        assert.equal(branchAfterDirect.messages[1].is_user, false);
    }

    // (c) failed backend response: only the user message is persisted, no spurious assistant reply.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: { msg: 'backend exploded' } }));
        });
        pointKoboldBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
            type: 'normal', user_message: 'Are you there, Rex?',
        });
        fakeBackend.server.close();

        assert.equal(status, 400, 'Kobold\'s own error-response branch replies with 400, not a thrown exception');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was appended - no assistant reply for a failed generation');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Are you there, Rex?');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].is_user, true);
    }

    // (d) already covered above (missing owner_id / unknown character / unknown branch), matching
    // this session's "at least one error-path test for buildRawAction*Request()'s own validation"
    // requirement.

    // (e) a non-raw-action (legacy) request is completely unaffected: no owner_id/character_avatar,
    // so the raw-action branch never runs, request.body is dispatched unchanged (api_server taken
    // directly from the request body, exactly as before 341d1dead), and no persistence is attempted.
    {
        const fakeBackend = await startFakeBackend((req, res) => {
            assert.equal(req.url, '/v1/generate');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [{ text: 'Legacy, unmanaged reply.' }] }));
        });

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            // No owner_id/character_avatar/group_id - legacy shape: api_server/prompt are sent
            // directly in the body, exactly as the pre-341d1dead client always did.
            api_server: fakeBackend.url,
            prompt: 'Legacy raw prompt, no raw-action fields.',
            max_length: 50,
            max_context_length: 2048,
            gui_settings: true,
            streaming: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.deepEqual(data, { results: [{ text: 'Legacy, unmanaged reply.' }] }, 'the legacy response is forwarded to the client completely unmodified');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no persistence was attempted for a non-raw-action request');
    }

    console.log('kobold.test.js: all assertions passed');
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
