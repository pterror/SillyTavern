import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
import { setConfigFilePath } from '../../util.js';
import { streamAsSetting } from '../../../tests/util/stream-as-setting.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

const { router, buildRawActionKoboldRequest } = await import('./kobold.js');
const { forwardAndPersistCompactStream } = await import('./text-completions.js');
const { CompactStreamDecoder } = await import('../../../public/scripts/llamacpp-compact-stream.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { writeBack } = await import('../../token-count-store.js');
const { tokenizers } = await import('../../tokenizer-ids.js');
const { resolveTokenizer, tokenizerIdentity } = await import('../../tokenizer-resolve.js');

const { SESSION_HEADER } = await import('../../request-session.js');
const { convertedUser, writeLibraryCard, saveBranch, loadBranch, sessionAt, chatContextOf } = await import('../../../tests/converted-user.fixture.js');

const { newSessionKey } = await import('../../chat-engine.js');

const user = await convertedUser('st-kobold-raw-action-test-');

/**
 * @param {string} avatar
 * @param {unknown} nodeId
 */
async function chatOf(avatar, nodeId) {
    return chatContextOf(user.store, { avatar }, (await sessionAt(user.store, nodeId)) ?? newSessionKey());
}
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

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
    const cardJson = JSON.stringify(card);
    const buffer = writeCard(baseImage, cardJson);
    await writeLibraryCard(user, avatar, cardJson, buffer);
    return avatar;
}

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
            api_server: '',
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

const fakeTokenizerOptions = {
    encodeLocal: async (_key, text) => Array.from(String(text ?? '')).map(ch => ch.codePointAt(0)),
};

/** What a KoboldCpp that streams, and takes nothing newer, answers when asked its versions. */
const VERSIONS = {
    '/v1/info/version': { result: '1.0.0' },
    '/extra/version': { result: '1.30' },
    '/v1/model': { result: 'koboldcpp/test-model' },
};

async function startFakeBackend(handler) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            if (Object.hasOwn(VERSIONS, req.url ?? '')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(VERSIONS[req.url]));
            }
            return handler(req, res, body);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: 'u' } };
        if (req.get(SESSION_HEADER)) return next();
        sessionAt(user.store, req.body?.node_id).then(session => {
            req.headers[SESSION_HEADER.toLowerCase()] = session ?? 'none';
            next();
        }, next);
    });
    app.use(streamAsSetting());
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

async function postGenerateStreamBytes(app, body) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const bytes = Buffer.from(await res.arrayBuffer());
        return { status: res.status, headers: res.headers, bytes };
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

function decodeCompactStream(bytes) {
    const decoder = new CompactStreamDecoder();
    const events = [...decoder.push(new Uint8Array(bytes)), ...decoder.flush()];
    let text = '';
    let assistantNodeId = null;
    for (const event of events) {
        if ('content' in event) {
            text += event.content;
        } else if ('assistantNodeId' in event) {
            assistantNodeId = event.assistantNodeId;
        }
    }
    return { text, assistantNodeId };
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

function pointKoboldBackendAt(url) {
    const settings = buildSettingsFixture();
    settings.kai_settings.api_server = url;
    writeAllSettings(directories, settings);
}

async function run() {
    writeAllSettings(directories, buildSettingsFixture());
    const avatar = await writeCharacter('Rex.png', {
        name: 'Rex',
        description: 'Rex is a {{char}}.',
        data: { name: 'Rex', description: 'Rex is a {{char}}.', first_mes: 'Hi, I am Rex.' },
    });

    const ownerId = avatar;
    const branchName = 'main-chat';
    await saveBranch(user.store, { avatar: ownerId }, branchName, [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        { name: 'Tester', is_user: true, mes: 'Hi Rex, nice to meet you.', send_date: 2, extra: {} },
        { name: 'Rex', is_user: false, mes: 'Likewise!', send_date: 3, extra: {} },
    ]);
    const mainLeafId = (await loadBranch(user.store, { avatar: ownerId }, branchName)).branch.leaf_id;

    {
        pointKoboldBackendAt('http://127.0.0.1:9/unused-in-this-assertion');
        const built = await buildRawActionKoboldRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
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
        assert.equal(built.params.streaming, false, 'a Kobold whose versions can\'t be read is not streamed from');
    }

    await assert.rejects(
        async () => buildRawActionKoboldRequest(directories, {
            characterAvatar: 'NoSuchCharacter.png', chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Character not found/,
    );

    await assert.rejects(
        async () => buildRawActionKoboldRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, 'no-such-node-id'), nodeId: 'no-such-node-id',
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Chat node not found/,
    );

    await assert.rejects(
        async () => buildRawActionKoboldRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, undefined),
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /node_id is required \(pass null explicitly for a brand-new, empty conversation\)/,
    );

    await assert.rejects(
        async () => buildRawActionKoboldRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, null), nodeId: null,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /node_id is required: this chat is not at its start/,
    );

    {
        pointKoboldBackendAt('http://127.0.0.1:9/unused-in-this-assertion');
        const freshAvatar = await writeCharacter('KoboldFresh.png', {
            name: 'Fresh',
            description: 'Fresh is a brand-new character with no chat history yet.',
            data: { name: 'Fresh', description: 'Fresh is a brand-new character with no chat history yet.', first_mes: 'Hello, this is Fresh.' },
        });
        const builtFresh = await buildRawActionKoboldRequest(directories, {
            characterAvatar: freshAvatar, chat: await chatOf(freshAvatar, null), nodeId: null,
            type: 'normal', userMessageText: 'Hi Fresh, this is our first message ever.',
            tokenizerOptions: fakeTokenizerOptions,
        });
        assert.equal(builtFresh.anchorNodeId, null, 'a new, empty conversation is at its tree\'s root: the reply opens it');
        assert.ok(builtFresh.params.prompt.includes('Hi Fresh, this is our first message ever.'), 'the raw user_message for this turn still made it into the prepared prompt even though the resolved prior history was empty');
        assert.ok(!builtFresh.params.prompt.includes('Hello there, traveler.'), 'no unrelated prior history (Rex\'s) leaked into a brand-new character\'s resolved, empty chat');
    }

    {
        const fakeBackend = await startFakeBackend((req, res) => {
            if (req.url === '/v1/model' || req.url === '/extra/version') {
                res.writeHead(404);
                return res.end();
            }
            assert.equal(req.url, '/v1/generate', 'the non-streaming raw-action request really hits Kobold\'s real /v1/generate endpoint');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [{ text: 'Rex says hello back.' }] }));
        });
        pointKoboldBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'One more time, Rex?' },
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(data.results?.[0]?.text, 'Rex says hello back.', 'the real Kobold response body reaches the client byte-for-byte unmodified');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply were appended');
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'One more time, Rex?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back.', 'the assistant reply text was extracted from data.results[0].text and appended');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex', 'the assistant message uses name2 (the character\'s display name)');

        const userAlternatives = await user.store.chats.alternatives({ node_id: userMsg.node_id ?? branchAfter.messages[branchAfter.messages.length - 2].node_id });
        assert.equal(userAlternatives.total, 1, 'the persisted user message has no siblings - it is a genuine new child, not a swipe alternative');
    }

    {
        const settings = buildSettingsFixture();
        settings.kai_settings.streaming_kobold = true;
        let sawNonStreamRequest = false;
        const sseTokens = ['Rex ', 'streams ', 'for ', 'real.'];
        const fakeBackend = await startFakeBackend((req, res) => {
            if (req.url === '/extra/generate/stream') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end(sseTokens.map(token => `data: ${JSON.stringify({ token })}\n\n`).join('') + 'data: [DONE]\n\n');
                return;
            }
            if (req.url === '/v1/model' || req.url === '/extra/version') {
                res.writeHead(404);
                return res.end();
            }
            sawNonStreamRequest = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [{ text: 'Should not be reached - streaming was requested.' }] }));
        });
        settings.kai_settings.api_server = fakeBackend.url;
        writeAllSettings(directories, settings);

        const streamBranch = 'kobold-stream-attempt-chat';
        await saveBranch(user.store, { avatar: ownerId }, streamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);
        const streamBranchInfo = await loadBranch(user.store, { avatar: ownerId }, streamBranch);
        const messageCountBefore = streamBranchInfo.messages.length;
        const streamNodeId = streamBranchInfo.branch.leaf_id;

        const app = buildTestApp();
        const { status, headers, bytes } = await postGenerateStreamBytes(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Try to stream, Rex.' }, streaming: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(sawNonStreamRequest, false, '/v1/generate was never requested - the streaming request correctly reached /extra/generate/stream instead');
        assert.equal(headers.get('X-ST-Stream-Format'), 'compact-v1', 'Kobold\'s raw-action stream now declares the same compact binary wire format every other raw-action streaming path uses');
        const decoded = decodeCompactStream(bytes);
        assert.equal(decoded.text, sseTokens.join(''), 'the decoded compact stream reconstructs the exact text, accumulated across every real {"token": "..."} SSE chunk');
        assert.ok(decoded.assistantNodeId, 'the assistant_node_id frame was sent as the final frame');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, streamBranch);
            return branch.messages.length === messageCountBefore + 2 ? branch : null;
        });
        const [, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(assistantMsg.mes, sseTokens.join(''), 'the assistant reply was accumulated from the real SSE stream (via forwardAndPersistCompactStream()) and persisted correctly');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.node_id, decoded.assistantNodeId, 'the node id sent to the client in the compact stream\'s assistant_node_id frame is the exact node the reply actually landed on');
        assert.equal(assistantMsg.name, 'Rex');

        const sseChunks = ['Rex ', 'streams ', 'a ', 'reply.'];
        const sseBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(sseChunks.map(token => `data: ${JSON.stringify({ token })}\n\n`).join('') + 'data: [DONE]\n\n');
        });
        const directStreamBranch = 'kobold-direct-forward-persist-chat';
        await saveBranch(user.store, { avatar: ownerId }, directStreamBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Say hi via the direct SSE path.', send_date: 1, extra: {} },
        ]);
        const branchBeforeDirect = await loadBranch(user.store, { avatar: ownerId }, directStreamBranch);
        const anchorNodeId = branchBeforeDirect.branch.leaf_id;

        const fetchResponse = await fetch(sseBackend.url);
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
        await forwardAndPersistCompactStream(fetchResponse, fakeExpressResponse, {
            directories, chat: await chatContextOf(user.store, { avatar: ownerId }, branchBeforeDirect.branch.session), anchorNodeId, name2: 'Rex', isSwipe: false, isContinue: false, anchorContent: null,
        }, json => json?.token);
        sseBackend.server.close();

        const branchAfterDirect = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, directStreamBranch);
            return branch.messages.length === 2 ? branch : null;
        });
        assert.equal(branchAfterDirect.messages[1].mes, 'Rex streams a reply.', 'the real forwardAndPersistCompactStream() + the route\'s own {"token":...} extractor correctly accumulated and persisted every chunk');
        assert.equal(branchAfterDirect.messages[1].name, 'Rex');
        assert.equal(branchAfterDirect.messages[1].is_user, false);
    }

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ detail: { msg: 'backend exploded' } }));
        });
        pointKoboldBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Are you there, Rex?' },
        });
        fakeBackend.server.close();

        assert.equal(status, 400, 'Kobold\'s own error-response branch replies with 400, not a thrown exception');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was appended - no assistant reply for a failed generation');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Are you there, Rex?');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].is_user, true);
    }

    {
        const fakeBackend = await startFakeBackend((req, res) => {
            assert.equal(req.url, '/v1/generate');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [{ text: 'Legacy, unmanaged reply.' }] }));
        });

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
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

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no persistence was attempted for a non-raw-action request');
    }

    {
        const settings = buildSettingsFixture();
        settings.kai_settings.streaming_kobold = true;
        let sawAbortCall = false;
        let releaseStream = () => { };
        const streamGate = new Promise(resolve => { releaseStream = resolve; });
        const fakeBackend = await startFakeBackend((req, res) => {
            if (req.url === '/extra/abort') {
                sawAbortCall = true;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            if (req.url === '/extra/generate/stream') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ token: 'Rex ' })}\n\n`);
                streamGate.then(() => res.end('data: [DONE]\n\n'));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [{ text: 'Should not be reached in this test.' }] }));
        });
        settings.kai_settings.api_server = fakeBackend.url;
        writeAllSettings(directories, settings);

        const abortBranch = 'kobold-abort-on-disconnect-chat';
        await saveBranch(user.store, { avatar: ownerId }, abortBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);
        const abortNodeId = (await loadBranch(user.store, { avatar: ownerId }, abortBranch)).branch.leaf_id;

        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;

        const controller = new AbortController();
        try {
            const res = await fetch(`http://127.0.0.1:${port}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner_id: ownerId, character_avatar: avatar, node_id: abortNodeId,
                    type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Abort me, Rex.' },
                    streaming: true, can_abort: true,
                }),
                signal: controller.signal,
            });

            const reader = res.body.getReader();
            const { value: firstChunk } = await reader.read();
            assert.ok(firstChunk && firstChunk.length > 0, 'a real SSE chunk was received before the client disconnects');

            controller.abort();
            await waitFor(() => sawAbortCall || null);
        } finally {
            releaseStream();
            fakeBackend.server.close();
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }

        assert.equal(sawAbortCall, true, 'the client disconnecting mid-stream triggered a real POST to the Kobold backend\'s /extra/abort endpoint - proving can_abort correctly reached `true` end-to-end for a raw-action request, not silently `false` as it was before this fix');
    }

    {
        const tokenCountPrompts = [];
        const paths = [];
        const fakeBackend = await startFakeBackend((req, res, body) => {
            paths.push(req.url);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (req.url === '/api/extra/version') return res.end(JSON.stringify({ result: 'KoboldCpp', version: '1.70' }));
            if (req.url === '/api/v1/model') return res.end(JSON.stringify({ result: 'koboldcpp/some-model' }));
            if (req.url === '/api/extra/tokencount') {
                const prompt = JSON.parse(body).prompt;
                tokenCountPrompts.push(prompt);
                const ids = Array.from(prompt).map(ch => ch.codePointAt(0));
                return res.end(JSON.stringify({ value: ids.length, ids }));
            }
            res.end('{}');
        });
        const settings = buildSettingsFixture();
        settings.kai_settings.api_server = `${fakeBackend.url}/api`;
        settings.textgenerationwebui_settings = {
            logit_bias: [{ id: 'z', text: 'zebra', value: -5 }],
            send_banned_tokens: true,
            banned_tokens: 'giraffe',
        };
        writeAllSettings(directories, settings);

        const localEncodes = [];
        try {
            await buildRawActionKoboldRequest(directories, {
                characterAvatar: avatar, chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
                type: 'normal', userMessageText: 'What happens next, Rex?',
                tokenizerOptions: { encodeLocal: async (key, text) => { localEncodes.push(text); return [1]; } },
            });
        } finally {
            fakeBackend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }

        assert.ok(paths.includes('/api/extra/version'), 'the KoboldCpp version was probed');
        assert.ok(tokenCountPrompts.length > 0, 'counted with the backend\'s own tokenizer');
        assert.deepEqual(localEncodes, [], 'no local tokenizer used');
        assert.ok(!tokenCountPrompts.includes(' zebra'), 'the textgen logit_bias is not encoded for kobold');
        assert.ok(!tokenCountPrompts.includes('giraffe'), 'the textgen banned tokens are not encoded for kobold');
    }

    for (const [model, expectedKinds, expectedLocalKeys] of [
        ['koboldcpp/gemma-2-9b-it', ['fallback-copy'], ['gemma']],
        ['koboldcpp/some-unheard-of-model', ['trim-estimate'], []],
    ]) {
        let tokenCountCalls = 0;
        const fakeBackend = await startFakeBackend((req, res) => {
            if (req.url === '/api/extra/tokencount') {
                tokenCountCalls++;
                res.writeHead(500);
                return res.end('tokencount failed');
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (req.url === '/api/extra/version') return res.end(JSON.stringify({ result: 'KoboldCpp', version: '1.70' }));
            if (req.url === '/api/v1/model') return res.end(JSON.stringify({ result: model }));
            res.end('{}');
        });
        const settings = buildSettingsFixture();
        settings.kai_settings.api_server = `${fakeBackend.url}/api`;
        writeAllSettings(directories, settings);

        const localKeys = new Set();
        let built;
        try {
            built = await buildRawActionKoboldRequest(directories, {
                characterAvatar: avatar, chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
                type: 'normal', userMessageText: 'What happens next, Rex?',
                tokenizerOptions: { encodeLocal: async (key) => { localKeys.add(key); return [1]; } },
            });
        } finally {
            fakeBackend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }

        assert.ok(tokenCountCalls > 1, `${model}: every count tried the backend again`);
        assert.deepEqual([...localKeys], expectedLocalKeys, `${model}: local encodes`);
        assert.deepEqual(built.warnings.map(w => w.kind), expectedKinds, `${model}: warnings`);
    }

    {
        const storeAvatar = await writeCharacter('KoboldStore.png', {
            name: 'KoboldStore',
            data: { name: 'KoboldStore', description: 'KoboldStore guards the bridge.', first_mes: 'Halt.' },
        });
        await saveBranch(user.store, { avatar: storeAvatar }, 'store-chat', [
            { chat_metadata: {} },
            { name: 'KoboldStore', is_user: false, mes: 'Halt.', send_date: 1, extra: {} },
            { name: 'Tester', is_user: true, mes: 'May I cross the bridge?', send_date: 2, extra: {} },
            { name: 'KoboldStore', is_user: false, mes: 'Only with the password.', send_date: 3, extra: {} },
        ]);
        const storeLeafId = (await loadBranch(user.store, { avatar: storeAvatar }, 'store-chat')).branch.leaf_id;
        const settings = buildSettingsFixture();
        settings.power_user.tokenizer = tokenizers.LLAMA;
        settings.kai_settings.api_server = 'http://127.0.0.1:9/api';
        writeAllSettings(directories, settings);

        const build = async () => {
            const encoded = [];
            const built = await buildRawActionKoboldRequest(directories, {
                characterAvatar: storeAvatar, chat: await chatOf(storeAvatar, storeLeafId), nodeId: storeLeafId, type: 'normal',
                tokenizerOptions: { encodeLocal: async (key, text) => { encoded.push(text); return fakeTokenizerOptions.encodeLocal(key, text); } },
            });
            return { built, encoded };
        };
        try {
            const first = await build();
            assert.ok(first.encoded.length > 0, 'the first build encodes with the local tokenizer');
            await writeBack(directories, first.built.tokenCountRows);
            const second = await build();
            const firstTexts = new Set(first.encoded);
            assert.deepEqual(second.encoded.filter(text => firstTexts.has(text)), [], 'no text encoded in the first build is encoded again');
            assert.deepEqual(second.built.params, first.built.params);
        } finally {
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    async function storedRows() {
        let n = 0;
        for (const table of [0, 1]) n += Number(await user.store.chats.store.chatRead('tokenCacheCount', { table }));
        return n;
    }

    let writeBackChats = 0;
    async function setUpWriteBackGeneration(onGenerate) {
        const name = `KoboldWriteBack${++writeBackChats}`;
        const writeBackAvatar = await writeCharacter(`${name}.png`, { name, data: { name, description: `${name} tends the lighthouse.`, first_mes: 'Ahoy.' } });
        await saveBranch(user.store, { avatar: writeBackAvatar }, 'write-back-chat', [
            { chat_metadata: {} },
            { name, is_user: false, mes: 'Ahoy.', send_date: 1, extra: {} },
            { name: 'Tester', is_user: true, mes: `Is the lamp lit, ${name}?`, send_date: 2, extra: {} },
            { name, is_user: false, mes: 'Every night.', send_date: 3, extra: {} },
        ]);
        const leafId = (await loadBranch(user.store, { avatar: writeBackAvatar }, 'write-back-chat')).branch.leaf_id;
        const urls = [];
        const backend = await startFakeBackend((req, res, requestBody) => {
            urls.push(req.url);
            if (req.url === '/v1/generate' || req.url === '/extra/generate/stream') return onGenerate(req, res, requestBody);
            res.writeHead(404);
            res.end();
        });
        const settings = buildSettingsFixture();
        settings.power_user.tokenizer = tokenizers.LLAMA;
        settings.kai_settings.api_server = backend.url;
        writeAllSettings(directories, settings);
        const identity = await tokenizerIdentity(await resolveTokenizer({ api: 'kobold', url: backend.url, model: '', tokenizerSetting: tokenizers.LLAMA }, { directories }));
        assert.ok(identity, 'the bundled LLaMA tokenizer has an identity');
        return {
            backend, urls, identity,
            body: { owner_id: writeBackAvatar, character_avatar: writeBackAvatar, node_id: leafId, type: 'normal', user_message: { is_user: true, name: 'User', mes: `Any ships tonight, ${name}?` } },
        };
    }

    for (const streaming of [false, true]) {
        let rowsWhenReceived = null;
        let rowsBefore = null;
        const { backend, urls, body } = await setUpWriteBackGeneration(async (_req, res) => {
            rowsWhenReceived = await storedRows();
            if (streaming) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                return res.end(`data: ${JSON.stringify({ token: 'Two.' })}\n\ndata: [DONE]\n\n`);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [{ text: 'Two.' }] }));
        });
        try {
            rowsBefore = await storedRows();
            const { status } = streaming
                ? await postGenerateStreamBytes(buildTestApp(), { ...body, streaming: true })
                : await postGenerate(buildTestApp(), body);
            assert.equal(status, 200);
            assert.ok(urls.includes(streaming ? '/extra/generate/stream' : '/v1/generate'), `${streaming ? 'stream' : 'non-stream'}: the backend received the generation`);
            assert.equal(rowsWhenReceived, rowsBefore, `${streaming ? 'stream' : 'non-stream'}: nothing stored when the backend received its request`);
            await waitFor(async () => (await storedRows()) > rowsBefore);
        } finally {
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    {
        const { backend, urls, body } = await setUpWriteBackGeneration((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [{ text: 'Two.' }] }));
        });
        const realFetch = globalThis.fetch;
        let refused = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (async (url, ...rest) => {
            if (String(url).endsWith('/v1/generate')) {
                refused++;
                throw new TypeError('fetch failed', { cause: new Error('refused before sending') });
            }
            return realFetch(url, ...rest);
        });
        try {
            const rowsBefore = await storedRows();
            const { data } = await postGenerate(buildTestApp(), body);
            assert.equal(data.error, true, 'the generation failed');
            assert.equal(refused, 1, 'the backend request threw');
            assert.ok(!urls.includes('/v1/generate'), 'the backend never received the generation');
            await new Promise(resolve => setTimeout(resolve, 200));
            assert.equal(await storedRows(), rowsBefore, 'nothing stored');
        } finally {
            globalThis.fetch = realFetch;
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    {
        const generates = [];
        const { backend, body } = await setUpWriteBackGeneration((_req, res, requestBody) => {
            generates.push(JSON.parse(requestBody));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ results: [{ text: 'Two.' }] }));
        });
        const tokens = user.store.tokens;
        const realRead = tokens.read;
        try {
            const fresh = await postGenerate(buildTestApp(), body);
            assert.equal(fresh.status, 200);
            tokens.read = async () => {
                throw new Error('token table read failed (test)');
            };
            const failing = await postGenerate(buildTestApp(), body);
            tokens.read = realRead;
            assert.equal(failing.status, 200, 'token table reads failing: the generation succeeds');
            assert.notEqual(failing.data?.error, true, 'token table reads failing: no error');
            assert.equal(generates.length, 2, 'token table reads failing: the backend received both generations');
            assert.deepEqual(generates[1], generates[0], 'token table reads failing: the same request as counted fresh');
        } finally {
            tokens.read = realRead;
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    for (const streaming of [false, true]) {
        const chatName = `kobold-stored-ref-${streaming ? 'stream' : 'nonstream'}`;
        const backend = await startFakeBackend((req, res) => {
            if (req.url === '/extra/generate/stream') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                return res.end(`data: ${JSON.stringify({ token: 'Stored reply.' })}\n\ndata: [DONE]\n\n`);
            }
            if (req.url === '/v1/generate') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ results: [{ text: 'Stored reply.' }] }));
            }
            res.writeHead(404);
            res.end();
        });
        const settings = buildSettingsFixture();
        settings.kai_settings.api_server = backend.url;
        settings.kai_settings.streaming_kobold = streaming;
        writeAllSettings(directories, settings);
        try {
            await saveBranch(user.store, { avatar: ownerId }, chatName, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: `Hello there, ${chatName}.`, send_date: 1, extra: {} },
            ]);
            const branchBefore = await loadBranch(user.store, { avatar: ownerId }, chatName);
            const ref = `ref-${chatName}`;
            const body = {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: `Question for ${chatName}?` }, user_message_ref: ref, streaming,
            };
            let stored;
            if (streaming) {
                const { bytes } = await postGenerateStreamBytes(buildTestApp(), body);
                const decoder = new CompactStreamDecoder();
                const events = [...decoder.push(new Uint8Array(bytes)), ...decoder.flush()];
                assert.ok('control' in events[0] && events[0].control.stored, `the first frame is the stored control frame: ${JSON.stringify(events[0])}`);
                stored = events[0].control.stored;
            } else {
                stored = (await postGenerate(buildTestApp(), body)).data.stored;
            }
            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(user.store, { avatar: ownerId }, chatName);
                return branch.messages.length === branchBefore.messages.length + 2 ? branch : null;
            });
            const userNode = branchAfter.messages[branchBefore.messages.length];
            assert.equal(userNode.mes, `Question for ${chatName}?`);
            assert.deepEqual(stored, [{ ref, node_id: userNode.node_id }], `${streaming ? 'streaming' : 'non-streaming'}: the user message's ref is echoed with the node it was stored at`);
        } finally {
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    for (const streaming of [false, true]) {
        const chatName = `kobold-stored-error-${streaming ? 'stream' : 'nonstream'}`;
        const backend = await startFakeBackend((req, res) => {
            if (req.url === '/extra/generate/stream' || req.url === '/v1/generate') {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                return res.end('backend exploded');
            }
            res.writeHead(404);
            res.end();
        });
        const settings = buildSettingsFixture();
        settings.kai_settings.api_server = backend.url;
        settings.kai_settings.streaming_kobold = streaming;
        writeAllSettings(directories, settings);
        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        try {
            await saveBranch(user.store, { avatar: ownerId }, chatName, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: `Hello there, ${chatName}.`, send_date: 1, extra: {} },
            ]);
            const branchBefore = await loadBranch(user.store, { avatar: ownerId }, chatName);
            const ref = `ref-${chatName}`;
            const res = await fetch(`http://127.0.0.1:${server.address().port}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                    type: 'normal', user_message: { is_user: true, name: 'User', mes: `Question for ${chatName}?` }, user_message_ref: ref, streaming,
                }),
            });
            const text = await res.text();
            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, chatName);
            const added = branchAfter.messages.slice(branchBefore.messages.length);
            assert.deepEqual(added.map(m => m.mes), [`Question for ${chatName}?`], 'only the user message was stored');
            const stored = [{ ref, node_id: added[0].node_id }];
            assert.deepEqual(JSON.parse(res.headers.get('X-ST-Stored') ?? 'null'), stored, `${streaming ? 'streaming' : 'non-streaming'}: the X-ST-Stored header names the stored user message (status ${res.status}, body ${text})`);
            if (streaming) {
                assert.equal(res.status, 500, 'the backend\'s status is kept');
                assert.equal(text, 'backend exploded', 'the backend\'s body is kept exactly');
            } else {
                assert.equal(res.status, 400);
                assert.deepEqual(JSON.parse(text), { error: { message: 'backend exploded' }, stored });
            }
        } finally {
            backend.server.close();
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    console.log('kobold.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => user.close());
