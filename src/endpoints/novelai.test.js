import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
// novelai.js -> text-completion-generation-input.js pulls in src/endpoints/characters.js (via
// readCardContent), which (via character-shallow.js) reads process-wide config at import time -
// the config path must be set before that import chain runs, same as
// text-completions.test.js/text-completion-generation-input.test.js.
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Route-level Express-integration test for novelai.js's own raw-action /generate branch (see
// `git show 341d1dead` for the commit that added it), mirroring
// src/endpoints/backends/text-completions.test.js's established convention: a real express app
// mounting the real router, a real on-disk fixture set (writeCharacter/buildSettingsFixture/
// saveChatToTree/writeAllSettings), and loadBranch()-based tree-persistence assertions - plus this
// file's own `mock.module()` node-fetch reroute (below), since NovelAI genuinely needs it.
//
// JUDGMENT CALL: unlike Kobold (kai_settings.api_server, a real settings-driven URL),
// NovelAI's backend URL is CONFIRMED hardcoded, not assumed - verified by reading novelai.js's own
// /generate handler in full: `const baseURL = (req.body.model.includes('kayra') ||
// req.body.model.includes('erato')) ? TEXT_NOVELAI : API_NOVELAI;` where both `TEXT_NOVELAI`
// (`https://text.novelai.net`) and `API_NOVELAI` (`https://api.novelai.net`) are hardcoded
// module-level constants - there is no settings.json field, request field, or raw-action-resolved
// value that can override this for either the raw-action OR the legacy request shape. So this file
// uses this repo's own established technique for exactly this case (see
// src/endpoints/backends/chat-completions.test.js's own `canMockAi21Backend`/`mock.module()`
// comment, used there for AI21/Cohere/AI-ML-API/Chutes/MiniMax/Electron Hub - the same "no
// caller-supplied endpoint override at all" situation): `node:test`'s `mock.module()` reroutes ONLY
// requests whose origin is `https://api.novelai.net` or `https://text.novelai.net` to this
// session's own local fake `node:http` backend - a REAL `node-fetch` call still runs against that
// local server (the mock is a thin reroute, not a hand-built fake Response), and every other URL
// passes straight through to the real, unmodified `node-fetch`. Must run before novelai.js is
// first imported (its own top-level `import fetch from 'node-fetch'` needs to resolve to the mock).
const canMockNovelBackend = typeof mock.module === 'function';
/** @type {string|null} Set by pointNovelBackendAt() below; read by the node-fetch reroute mock. */
let novelFakeBackendUrl = null;
if (canMockNovelBackend) {
    const realNodeFetch = (await import(path.join(__dirname, '..', '..', 'node_modules', 'node-fetch', 'src', 'index.js'))).default;
    mock.module('node-fetch', {
        defaultExport: async (url, opts) => {
            const target = new URL(url);
            if (novelFakeBackendUrl && (target.origin === 'https://api.novelai.net' || target.origin === 'https://text.novelai.net')) {
                return realNodeFetch(new URL(target.pathname + target.search, novelFakeBackendUrl), opts);
            }
            return realNodeFetch(url, opts);
        },
        namedExports: {},
    });
} else {
    console.log('novelai.test.js: node:test mock.module() is unavailable (run with --experimental-test-module-mocks) - skipping all raw-action /generate route tests, which need it to redirect NovelAI\'s hardcoded API host to a local fake backend');
}

const { default: nodeFetch } = await import('node-fetch');
const { router, buildRawActionNovelRequest } = await import('./novelai.js');
const { writeAllSettings } = await import('../settings-store.js');
const { writeSecret, SECRET_KEYS } = await import('./secrets.js');
const { saveChatToTree, loadBranch, getAlternatives, disposeMessageTreeStores } = await import('../message-tree-db.js');
const { forwardAndPersistSseText } = await import('./backends/text-completions.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-novelai-raw-action-test-'));
const charactersDir = path.join(root, 'characters');
const groupsDir = path.join(root, 'groups');
const worldsDir = path.join(root, 'worlds');
fs.mkdirSync(charactersDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(worldsDir, { recursive: true });

const directories = { root, characters: charactersDir, groups: groupsDir, worlds: worldsDir };
globalThis.DATA_ROOT = root;

const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));

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

/** Real settings.json fixture - only the keys resolveTextCompletionGenerationInput()/createNovelGenerationData() actually read, plus a real nai_settings shape matching src/novel-generation-data.test.js's own baseSettings() field names.
 *
 * JUDGMENT CALL: model_novel is 'llama-3-erato-v1' (an Erato-family model), NOT clio/kayra -
 * verified by reading src/tokenizer-resolve.js's own ENCODE_TOKENIZERS/TOKENIZER_TYPE_KEYS: clio
 * maps to tokenizers.NERD and kayra to tokenizers.NERD2 (via getTokenizerTypeForModel()), and BOTH
 * are real, deliberately unsupported by encodeWithTokenizerType()'s local-encode path ("NERD/NERD2
 * are deliberately excluded... because no weights have been released for them yet" - that file's
 * own comment) - it throws `Unsupported tokenizer type for encoding` for either, with no local
 * fallback, regardless of any injected `encodeLocal`. Erato maps to tokenizers.LLAMA3, which IS in
 * both lists, so the same fakeTokenizerOptions.encodeLocal technique used everywhere else in this
 * repo's test suite works here too. This also exercises the OTHER real baseURL branch
 * (`TEXT_NOVELAI`, not `API_NOVELAI` - novelai.js's own `(model.includes('kayra') ||
 * model.includes('erato')) ? TEXT_NOVELAI : API_NOVELAI`), verified below by the fake-backend
 * `mock.module()` reroute matching BOTH real hardcoded hosts.
 */
function buildSettingsFixture() {
    return {
        username: 'Tester',
        amount_gen: 100,
        max_context: 2048,
        power_user: {
            tokenizer: undefined,
            instruct: { enabled: false },
            context: {},
            reasoning: {},
            sysprompt: {},
        },
        world_info: { globalSelect: [], charLore: [] },
        world_info_settings: {},
        nai_settings: {
            model_novel: 'llama-3-erato-v1',
            temperature: 1.5,
            min_length: 1,
            tail_free_sampling: 0.975,
            repetition_penalty: 2.25,
            repetition_penalty_range: 2048,
            repetition_penalty_slope: 0.09,
            repetition_penalty_frequency: 0,
            repetition_penalty_presence: 0.005,
            top_a: 0.08,
            top_p: 0.75,
            top_k: 10,
            min_p: 0,
            math1_temp: 1,
            math1_quad: 0,
            math1_quad_entropy_scale: 0,
            typical_p: 0.975,
            mirostat_lr: 1,
            mirostat_tau: 0,
            phrase_rep_pen: 'aggressive',
            banned_tokens: '',
            logit_bias: [],
            prefix: 'vanilla',
            order: undefined,
        },
        extension_settings: { note: {}, cfg: {} },
    };
}

/** Deterministic fake local encoder, injected via tokenizerOptions so no real tokenizer model files or network calls are needed - same technique as text-completions.test.js/kobold.test.js. */
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

function pointNovelBackendAt(url) {
    novelFakeBackendUrl = url;
}

async function run() {
    writeAllSettings(directories, buildSettingsFixture());
    writeSecret(directories, SECRET_KEYS.NOVEL, 'test-novel-api-key');
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

    // --- buildRawActionNovelRequest(): basic real assembly ---
    {
        const built = await buildRawActionNovelRequest(directories, {
            characterAvatar: avatar, ownerId, branchName,
            type: 'normal', userMessageText: 'What happens next, Rex?',
            tokenizerOptions: fakeTokenizerOptions,
        });
        assert.equal(built.name1, 'Tester');
        assert.equal(built.name2, 'Rex');
        assert.ok(built.anchorNodeId);
        assert.equal(built.params.model, 'llama-3-erato-v1', 'params.model is nai_settings.model_novel, matching createNovelGenerationData()\'s own settings.model_novel wire field');
        assert.equal(typeof built.params.input, 'string');
        assert.ok(built.params.input.includes('Hello there, traveler.'));
        assert.ok(built.params.input.includes('What happens next, Rex?'));
        assert.equal(built.params.streaming, undefined, 'createNovelGenerationData()\'s own returned object has NO `streaming` field at all - CONFIRMED by reading its full return statement in src/novel-generation-data.js - so req.body.streaming after the raw-action body replacement is always undefined/falsy, regardless of what the client originally sent');
    }

    // --- error handling: missing owner_id ---
    await assert.rejects(
        () => buildRawActionNovelRequest(directories, {
            characterAvatar: avatar, branchName,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /owner_id is required/,
    );

    // --- error handling: unknown character ---
    await assert.rejects(
        () => buildRawActionNovelRequest(directories, {
            characterAvatar: 'NoSuchCharacter.png', ownerId, branchName,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Character not found/,
    );

    // --- error handling: unknown branch ---
    await assert.rejects(
        () => buildRawActionNovelRequest(directories, {
            characterAvatar: avatar, ownerId, branchName: 'no-such-branch',
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Chat branch not found/,
    );

    if (!canMockNovelBackend) {
        console.log('novelai.test.js: skipping all route-level /generate tests (a)-(e) - run with `node --experimental-test-module-mocks` to include them (see the canMockNovelBackend comment near the top of this file)');
        console.log('novelai.test.js: assembly/validation assertions passed (route-level tests skipped)');
        return;
    }

    // (a) route-level: non-streaming raw-action /generate success - real NovelAI `/ai/generate`
    // response shape `{output: "..."}`, verified against novelai.js's own comment citing
    // public/script.js's own `data.output` read of this exact endpoint (`git show
    // 341d1dead:src/endpoints/novelai.js`, the persistAssistantReply() call site comment).
    {
        const fakeBackend = await startFakeBackend((req, res) => {
            assert.equal(req.url, '/ai/generate', 'the non-streaming raw-action request really hits NovelAI\'s real /ai/generate endpoint (llama-3-erato-v1 routes to TEXT_NOVELAI, not API_NOVELAI, but the path is the same either way - the mock.module() reroute matches both real hardcoded hosts)');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: 'Rex says hello back.' }));
        });
        pointNovelBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
            type: 'normal', user_message: 'One more time, Rex?', stream: false,
        });
        fakeBackend.server.close();
        pointNovelBackendAt(null);

        assert.equal(status, 200);
        assert.deepEqual(data, { output: 'Rex says hello back.' }, 'the real NovelAI response body reaches the client byte-for-byte unmodified');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply were appended');
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'One more time, Rex?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back.', 'the assistant reply text was extracted from data.output and appended');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex');

        const userAlternatives = await getAlternatives(directories, userMsg.node_id);
        assert.equal(userAlternatives.total, 1, 'the persisted user message has no siblings - it is a genuine new child, not a swipe alternative');
    }

    // (b) STREAMING raw-action: proves the real, verified "raw-action requests never carry a
    // `streaming` field at all" constraint documented above - even with the client requesting
    // `stream: true`, req.body.streaming (built.params.streaming) is undefined, so the route
    // resolves to the non-streaming JSON path and the fake backend only ever receives a request at
    // /ai/generate, never /ai/generate-stream.
    {
        let sawStreamRequest = false;
        const fakeBackend = await startFakeBackend((req, res) => {
            if (req.url === '/ai/generate-stream') {
                sawStreamRequest = true;
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end('data: ' + JSON.stringify({ token: 'should not be reached' }) + '\n\n');
                return;
            }
            assert.equal(req.url, '/ai/generate', 'the request lands on the non-streaming endpoint, proving raw-action streaming is unreachable as shipped');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: 'Non-streamed despite stream:true.' }));
        });
        pointNovelBackendAt(fakeBackend.url);

        const streamBranch = 'novel-stream-attempt-chat';
        await saveChatToTree(directories, ownerId, streamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, branch_name: streamBranch,
            type: 'normal', user_message: 'Try to stream, Rex.', stream: true,
        });
        fakeBackend.server.close();
        pointNovelBackendAt(null);

        assert.equal(status, 200);
        assert.equal(sawStreamRequest, false, '/ai/generate-stream was never actually requested - built.params has no streaming field at all for raw-action requests');
        assert.deepEqual(data, { output: 'Non-streamed despite stream:true.' });

        const branchAfter = await loadBranch(directories, ownerId, streamBranch);
        const [, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(assistantMsg.mes, 'Non-streamed despite stream:true.', 'persistence still worked correctly via the (only reachable) non-streaming path');

        // Direct, unit-level exercise of the REAL forwardAndPersistSseText() function together with
        // the route's own literal extractor lambda (`json => json?.token`, copied verbatim from
        // novelai.js's real /generate handler - `git show 341d1dead:src/endpoints/novelai.js`)
        // against a REAL SSE HTTP response - proves the real per-chunk accumulation and persistence
        // logic for NovelAI's real `{"token": "...", "logprobs": {...}}` streaming shape (token is
        // already-decoded text, per novelai.js's own comment citing generateNovelWithStreaming() in
        // public/scripts/nai-settings.js) works correctly, even though the full HTTP route currently
        // cannot reach this branch for raw-action requests.
        const sseChunks = ['Rex ', 'streams ', 'a ', 'reply.'];
        const sseBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(sseChunks.map(token => `data: ${JSON.stringify({ token, logprobs: null })}\n\n`).join('') + 'data: [DONE]\n\n');
        });
        const directStreamBranch = 'novel-direct-forward-persist-chat';
        await saveChatToTree(directories, ownerId, directStreamBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Say hi via the direct SSE path.', send_date: 1, extra: {} },
        ]);
        const branchBeforeDirect = await loadBranch(directories, ownerId, directStreamBranch);
        const anchorNodeId = branchBeforeDirect.branch.leaf_id;

        // Uses `node-fetch` (NOT the global web-standard `fetch`) - forwardAndPersistSseText()
        // requires the real node-fetch Response whose `.body` is a node Readable stream (`.on(...)`),
        // exactly what the real route's own `import fetch from 'node-fetch'` provides.
        const fetchResponse = await nodeFetch(sseBackend.url);
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
        assert.equal(branchAfterDirect.messages[1].mes, 'Rex streams a reply.', 'the real forwardAndPersistSseText() + the route\'s own {"token":...} extractor correctly accumulated and persisted every chunk (ignoring the separate logprobs field, matching the route\'s own extractor)');
        assert.equal(branchAfterDirect.messages[1].name, 'Rex');
        assert.equal(branchAfterDirect.messages[1].is_user, false);
    }

    // (c) failed backend response: only the user message is persisted, no spurious assistant reply.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'backend exploded' }));
        });
        pointNovelBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
            type: 'normal', user_message: 'Are you there, Rex?', stream: false,
        });
        fakeBackend.server.close();
        pointNovelBackendAt(null);

        assert.equal(status, 500, 'NovelAI\'s own error-response branch replies with 500, not a thrown exception');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was appended - no assistant reply for a failed generation');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Are you there, Rex?');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].is_user, true);
    }

    // (e) a non-raw-action (legacy) request is completely unaffected: no owner_id/character_avatar,
    // so the raw-action branch never runs, req.body is dispatched through the existing (unchanged)
    // bad-words/logit-bias enrichment exactly as before 341d1dead, and no persistence is attempted.
    {
        const fakeBackend = await startFakeBackend((req, res) => {
            assert.equal(req.url, '/ai/generate');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: 'Legacy, unmanaged reply.' }));
        });
        pointNovelBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            // No owner_id/character_avatar/group_id - legacy shape: input/model/parameters are sent
            // directly in the body, exactly as the pre-341d1dead client always did.
            input: 'Legacy raw prompt, no raw-action fields.',
            model: 'clio-v1',
            temperature: 1,
            max_length: 40,
            streaming: false,
        });
        fakeBackend.server.close();
        pointNovelBackendAt(null);

        assert.equal(status, 200);
        assert.deepEqual(data, { output: 'Legacy, unmanaged reply.' }, 'the legacy response is forwarded to the client completely unmodified');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no persistence was attempted for a non-raw-action request');
    }

    console.log('novelai.test.js: all assertions passed');
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
