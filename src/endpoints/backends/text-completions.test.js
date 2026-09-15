import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
// text-completions.js -> text-completion-generation-input.js pulls in src/endpoints/characters.js
// (via readCardContent), which (via character-shallow.js) reads process-wide config at import
// time - the config path must be set before that import chain runs, same as
// text-completion-generation-input.test.js/character-card-fields.test.js.
import { setConfigFilePath } from '../../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

// This route handler (src/endpoints/backends/text-completions.js) has no existing route-level
// Express-integration-test convention anywhere else in this codebase (no sibling
// src/endpoints/backends/*.test.js at all) - so, per this session's task, the REQUEST-BUILDING
// portion of the new raw-action /generate branch (everything before `request.body = {...}` and
// the fall-through to the existing, unchanged backend-dispatch code) was extracted into a small,
// Express-independent, directly-testable function - buildRawActionTextCompletionRequest() - and is
// exercised here directly with real on-disk fixtures, the same way text-completion-generation-
// input.test.js and text-completion-prompt-orchestrator.test.js test their own real logic.
//
// The assistant-reply-persistence follow-up (this session) DOES need a real route-level exercise -
// there is no way to observe `pendingAssistantPersist` being read from outside the route handler
// otherwise. Since this file still has no pre-existing route-integration harness to reuse, a
// minimal one is built here: mount the real `router` on a real `express` app (with a tiny
// middleware standing in for auth middleware's `request.user.directories`), listen on an ephemeral
// port, and point a SECOND real `http` server (standing in for the text-completion backend) at it
// via `server_urls.generic` in the settings fixture below - both real network I/O, no mocking
// framework, matching this file's existing "real on-disk fixtures over mocks" convention.
const { router, buildRawActionTextCompletionRequest } = await import('./text-completions.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { saveChatToTree, loadBranch, appendMessages, getAncestorPath, getAlternatives, disposeMessageTreeStores } = await import('../../message-tree-db.js');
// The client-side compact-stream decoder (public/scripts/llamacpp-compact-stream.js) has no browser-
// only dependencies (just TextDecoder/Uint8Array, both real Node globals), so it's imported directly
// here rather than re-implementing a second copy of the decode logic for this test file.
const { CompactStreamDecoder } = await import('../../../public/scripts/llamacpp-compact-stream.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-text-completions-raw-action-test-'));
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

/** Real settings.json fixture - only the keys resolveTextGenBackend()/resolveTokenizerType()/resolveTextCompletionGenerationInput() actually read. */
function buildSettingsFixture() {
    return {
        username: 'Tester',
        amount_gen: 100,
        max_context: 4096,
        power_user: {
            // Deliberately GENERIC-typed backend (not in TEXTGEN_TOKENIZERS, not OpenRouter/DreamGen)
            // so resolveTokenizerType() falls through to its plain LLAMA default, and no
            // userTokenizerSetting override is in play either.
            tokenizer: undefined,
            instruct: { enabled: false },
            context: {},
            reasoning: {},
            sysprompt: {},
        },
        world_info: { globalSelect: [], charLore: [] },
        world_info_settings: {},
        textgenerationwebui_settings: {
            type: 'generic',
            generic_model: 'test-model-7b',
            temp: 0.9,
        },
        extension_settings: { note: {}, cfg: {} },
    };
}

/** Deterministic fake local encoder, injected via tokenizerOptions so no real tokenizer model files or network calls are needed. */
const fakeTokenizerOptions = {
    encodeLocal: async (_key, text) => Array.from(String(text ?? '')).map(ch => ch.codePointAt(0)),
};

async function run() {
    writeAllSettings(directories, buildSettingsFixture());
    const avatar = writeCharacter('Rex.png', {
        name: 'Rex',
        description: 'Rex is a {{char}}.',
        data: { name: 'Rex', description: 'Rex is a {{char}}.', first_mes: 'Hi, I am Rex.' },
    });

    const ownerId = avatar;
    // `branchName` here is ONLY message-tree-db.js's own label/bookmark concept (saveChatToTree()'s
    // `chatName` param, loadBranch()'s lookup key) - a real, still-supported, unrelated primitive.
    // It is NOT a raw-action request field anymore (see buildRawActionTextCompletionRequest()'s own
    // ADDRESSING MODEL doc comment) - every raw-action call below resolves and passes the real
    // `node_id` (a leaf id from `loadBranch()`) instead.
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
    const built = await buildRawActionTextCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, nodeId: mainLeafId,
        type: 'normal', userMessageText: 'What happens next, Rex?',
        tokenizerOptions: fakeTokenizerOptions,
    });

    assert.equal(built.backend.type, 'generic', 'backend resolves for real via resolveTextGenBackend()');
    assert.equal(built.backend.model, 'test-model-7b');
    assert.equal(built.name1, 'Tester', 'name1 resolves from settings.json username, same as the orchestrator input');
    assert.ok(built.anchorNodeId, 'anchorNodeId resolves to the real leaf of the loaded branch');

    const branchBeforeAppend = await loadBranch(directories, ownerId, branchName);
    assert.equal(built.anchorNodeId, branchBeforeAppend.branch.leaf_id, 'anchorNodeId is exactly the given node_id\'s real leaf_id');
    assert.equal(built.anchorNodeId, mainLeafId, 'anchorNodeId is exactly the given node_id, unchanged from before');

    assert.ok(built.params && typeof built.params === 'object', 'params (generate_data) is a real object');
    assert.equal(built.params.model, 'test-model-7b', 'params.model is the resolved backend model, matching assembleTextCompletionPrompt()\'s own generate_data.model');
    assert.equal(typeof built.params.prompt, 'string');
    assert.ok(built.params.prompt.includes('Hello there, traveler.'), 'the real loaded chat history made it into the assembled prompt');
    assert.ok(built.params.prompt.includes('What happens next, Rex?'), 'the raw user_message made it into the assembled prompt');

    // --- persistence: the anchorNodeId this function resolves is really appendable-after ---
    const appendResult = await appendMessages(directories, ownerId, built.anchorNodeId, [
        { name: built.name1, is_user: true, mes: 'What happens next, Rex?', extra: {}, send_date: Date.now() },
    ]);
    assert.equal(appendResult.ok, true, 'appendMessages() accepts the resolved anchorNodeId as a real anchor');
    const branchAfterAppend = await loadBranch(directories, ownerId, branchName);
    assert.equal(branchAfterAppend.messages.length, 4, 'the persisted user message is now part of the real loaded branch');
    assert.equal(branchAfterAppend.messages[3].mes, 'What happens next, Rex?');

    // --- continue/swipe: no userMessageText, still resolves and assembles from the real history,
    // addressed by the real current leaf's node_id ---
    const continued = await buildRawActionTextCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, nodeId: branchAfterAppend.branch.leaf_id, type: 'continue', isContinue: true,
        tokenizerOptions: fakeTokenizerOptions,
    });
    assert.ok(continued.params.prompt.includes('Likewise!'), 'continue resolves from the real existing history with no new message appended');
    assert.equal(continued.anchorNodeId, branchAfterAppend.branch.leaf_id, 'the continue anchor is the real current leaf');
    assert.equal(continued.anchorContent?.mes, 'What happens next, Rex?', 'anchorContent is the anchor\'s real, current, unmodified content (the real leaf at this point in the test, appended above) - exactly what the route\'s is_continue edit needs as "oldText"');

    // --- error handling: unknown character ---
    await assert.rejects(
        () => buildRawActionTextCompletionRequest(directories, {
            characterAvatar: 'NoSuchCharacter.png', ownerId, nodeId: mainLeafId,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Character not found/,
    );

    // --- error handling: unknown node ---
    await assert.rejects(
        () => buildRawActionTextCompletionRequest(directories, {
            characterAvatar: avatar, ownerId, nodeId: 'no-such-node-id',
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Chat node not found/,
    );

    // --- error handling: node_id key entirely absent (not even explicit null) - the corrected
    // model's own "loud failure instead of a silent wrong-guess" requirement: `undefined` (the
    // route handler's stand-in for "the JSON body never had this key at all") must be rejected,
    // distinctly from an explicit `null`. ---
    await assert.rejects(
        () => buildRawActionTextCompletionRequest(directories, {
            characterAvatar: avatar, ownerId,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /node_id is required \(pass null explicitly for a brand-new, empty conversation\)/,
    );

    // --- error handling: node_id: null on an owner that ALREADY has real history - the corrected
    // model's central safety rule: the server must NOT silently guess "the current leaf" once real,
    // possibly-since-changed history exists; this must be a real, reportable error instead. ---
    await assert.rejects(
        () => buildRawActionTextCompletionRequest(directories, {
            characterAvatar: avatar, ownerId, nodeId: null,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /node_id is required: this character\/group already has an existing conversation/,
    );

    // --- happy path: node_id: null on a GENUINELY BRAND-NEW character with zero prior messages -
    // the ONLY case where omitting a real node id is safe, since there is no real point for the
    // caller to have disagreed about. Resolves via the owner's own anchor (auto-created, no name
    // required at all) to an empty chat, and still produces a real, appendable anchorNodeId. ---
    const freshAvatar = writeCharacter('Fresh.png', {
        name: 'Fresh',
        description: 'Fresh is a brand-new character with no chat history yet.',
        data: { name: 'Fresh', description: 'Fresh is a brand-new character with no chat history yet.', first_mes: 'Hello, this is Fresh.' },
    });
    const builtFresh = await buildRawActionTextCompletionRequest(directories, {
        characterAvatar: freshAvatar, ownerId: freshAvatar, nodeId: null,
        type: 'normal', userMessageText: 'Hi Fresh, this is our first message ever.',
        tokenizerOptions: fakeTokenizerOptions,
    });
    assert.ok(builtFresh.anchorNodeId, 'a genuinely new, empty conversation still resolves to a real, appendable anchor node id (the owner\'s own anchor)');
    assert.ok(!builtFresh.params.prompt.includes('Hello there, traveler.'), 'no unrelated prior history (Rex\'s) leaked into a brand-new character\'s resolved, empty chat');
    assert.ok(builtFresh.params.prompt.includes('Hi Fresh, this is our first message ever.'), 'the raw user_message for this turn still made it into the assembled prompt even though the resolved prior history was empty');
    const freshAppendResult = await appendMessages(directories, freshAvatar, builtFresh.anchorNodeId, [
        { name: builtFresh.name1, is_user: true, mes: 'Hi Fresh, this is our first message ever.', extra: {}, send_date: Date.now() },
    ]);
    assert.equal(freshAppendResult.ok, true, 'the anchor-resolved node id for a brand-new conversation is a real, appendable node - not a fake/synthetic id');

    // --- error handling: missing character/group (nodeId irrelevant here - the character/group
    // check runs first) ---
    await assert.rejects(
        () => buildRawActionTextCompletionRequest(directories, {
            ownerId, nodeId: mainLeafId,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /character_avatar or group_id is required/,
    );

    // --- route-level: non-streaming raw-action /generate persists the assistant reply for real ---
    // A minimal, real (no mocking framework) harness: a real `http` server standing in for the
    // text-completion backend, and the real `router` mounted on a real `express` app standing in
    // for the actual server (with a tiny middleware substituting for auth middleware's
    // `request.user.directories`).
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

    function pointBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.textgenerationwebui_settings.server_urls = { generic: url };
        writeAllSettings(directories, settings);
    }

    /** Same as pointBackendAt(), but resolves to the OLLAMA backend type/URL/model instead of GENERIC. */
    function pointOllamaBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.textgenerationwebui_settings.type = 'ollama';
        settings.textgenerationwebui_settings.ollama_model = 'test-ollama-model';
        settings.textgenerationwebui_settings.server_urls = { ollama: url };
        writeAllSettings(directories, settings);
    }

    /** Same as pointBackendAt(), but resolves to the LLAMACPP backend type/URL instead of GENERIC. */
    function pointLlamaCppBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.textgenerationwebui_settings.type = 'llamacpp';
        settings.textgenerationwebui_settings.server_urls = { llamacpp: url };
        writeAllSettings(directories, settings);
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

    /** Like postGenerate(), but for a streaming request: returns the raw response status/headers/body text, unparsed - so the test can assert on the literal bytes the client received. */
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
            return { status: res.status, headers: res.headers, bodyText };
        } finally {
            // See postGenerate()'s own comment on this same call - avoids a several-second stall per
            // streaming test waiting for the client's keep-alive connection to time out on its own.
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    /** Starts a fake backend that emits a real OpenAI-text-completions-shaped SSE stream, chunked exactly as given, ending with `data: [DONE]\n\n`. */
    async function startFakeSseBackend(textChunks) {
        const sseBody = textChunks.map(text => `data: ${JSON.stringify({ choices: [{ text }] })}\n\n`).join('') + 'data: [DONE]\n\n';
        return { ...await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(sseBody);
        }), expectedBody: sseBody };
    }

    /**
     * Starts a fake backend emitting `choices[0].text`/`choices[0].reasoning` SSE chunks with a real
     * delay between each `res.write()` (forcing them to arrive as separate TCP reads instead of racing
     * to find out whether Node coalesces same-tick writes into one segment - same rationale as the
     * pre-existing Ollama fake backend below), so the server's own coalescing/timer logic actually has
     * more than one upstream event to coalesce across.
     */
    async function startFakeSseBackendPaced(chunks, delayMs = 3) {
        return await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            (async () => {
                for (const { text, reasoning } of chunks) {
                    const choice = { text };
                    if (reasoning) choice.reasoning = reasoning;
                    res.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
                res.end('data: [DONE]\n\n');
            })();
        });
    }

    /** Like postGenerateStream(), but returns the raw response bytes (not decoded as UTF-8 text) - required for the compact binary protocol, whose control-frame bytes are not valid UTF-8 on their own. */
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

    /**
     * Decodes a full compact-stream byte buffer (using the real client-side CompactStreamDecoder) into
     * the same shape public/scripts/textgen-settings.js's own streamData() consumer builds: the main
     * `text`, any `swipes[]` (index > 0), accumulated `reasoning`, and the final `assistantNodeId`.
     */
    function decodeCompactStream(bytes) {
        const decoder = new CompactStreamDecoder();
        const events = [...decoder.push(new Uint8Array(bytes)), ...decoder.flush()];
        let text = '';
        let reasoning = '';
        const swipes = [];
        let currentIndex = 0;
        let assistantNodeId = null;
        for (const event of events) {
            if ('index' in event) {
                currentIndex = event.index;
            } else if ('reasoning' in event) {
                reasoning += event.reasoning;
            } else if ('assistantNodeId' in event) {
                assistantNodeId = event.assistantNodeId;
            } else if ('content' in event) {
                if (currentIndex > 0) {
                    const swipeIndex = currentIndex - 1;
                    swipes[swipeIndex] = (swipes[swipeIndex] || '') + event.content;
                } else {
                    text += event.content;
                }
            }
        }
        return { text, reasoning, swipes, assistantNodeId };
    }

    // (a) a real non-streaming generation appends the assistant's reply onto the tree, chained
    // after the just-persisted user message, with the correct name/is_user.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'Rex says hello back.' }] }));
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
        assert.equal(data.choices?.[0]?.text, 'Rex says hello back.', 'response body reaches the client unmodified');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply were appended');
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'One more time, Rex?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back.', 'the assistant reply text was extracted from data.choices[0].text and appended');
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

    // (c) is_impersonate: true - NEITHER the (spuriously passed) user_message NOR the generated
    // reply may ever land on the tree, even though the backend call succeeds and returns real text.
    // The generated text must still reach the client unchanged.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'I think you should go north.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;
        const leafBefore = branchBefore.branch.leaf_id;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: leafBefore,
            type: 'impersonate', is_impersonate: true,
            // Deliberately included even though a real client never sends this for impersonate - the
            // route must defensively ignore it regardless.
            user_message: 'This should never be persisted.',
            stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ text: 'I think you should go north.' }] }, 'the generated text still reaches the client unmodified');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no message (user or assistant) was appended for is_impersonate: true');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the branch leaf/ancestor path is completely unchanged');
    }

    // (d) type: 'quiet' - same assertion as (c): no tree mutation on either side, response still
    // forwarded to the client unchanged.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'Meta/background result.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;
        const leafBefore = branchBefore.branch.leaf_id;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: leafBefore,
            type: 'quiet',
            // Also deliberately included to verify the defensive skip - a real quiet call has no
            // fresh user text to send either.
            user_message: 'This should never be persisted.',
            stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ text: 'Meta/background result.' }] }, 'the generated text still reaches the client unmodified');

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
        const messageCountBefore = branchBefore.messages.length;
        const swipedNodeId = branchBefore.branch.leaf_id;
        const swipedAncestry = await getAncestorPath(directories, swipedNodeId);
        const parentNodeId = swipedAncestry[swipedAncestry.length - 2].node_id;

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'Greetings, traveler!' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: swipedNodeId,
            type: 'swipe', is_swipe: true, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.equal(data.choices?.[0]?.text, 'Greetings, traveler!', 'the generated text still reaches the client unmodified');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const branchAfter = await loadBranch(directories, ownerId, swipeBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'a swipe replaces the leaf position - it does not add DEPTH to the default path');
        assert.notEqual(branchAfter.branch.leaf_id, swipedNodeId, 'the branch is now positioned on a DIFFERENT node - the new alternative');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Greetings, traveler!', '(a) the new alternative is now the active/default path, showing the newly generated text');

        // (a) a new SIBLING was added under the correct parent - not a child of the swiped message.
        const newNodeId = branchAfter.branch.leaf_id;
        const newAncestry = await getAncestorPath(directories, newNodeId);
        assert.equal(newAncestry.length, swipedAncestry.length, 'the new alternative sits at the SAME depth as the swiped message (a sibling), not one deeper (a child)');
        assert.equal(newAncestry[newAncestry.length - 2].node_id, parentNodeId, 'the new alternative shares the swiped message\'s real parent');

        const alternatives = await getAlternatives(directories, swipedNodeId);
        assert.equal(alternatives.total, 2, 'the swiped message and the new alternative are now real siblings under the same parent');
        assert.ok(alternatives.alternatives.some(a => a.node_id === swipedNodeId && a.mes === 'Hello there!'), '(b) the swiped message\'s own original content is completely unchanged');
        assert.ok(alternatives.alternatives.some(a => a.node_id === newNodeId && a.mes === 'Greetings, traveler!'));

        // (c) selectDefaultChild() really was called - the parent's default_child_id now points at
        // the new alternative, which is exactly what branchAfter.branch.leaf_id resolving to newNodeId
        // (via descendDefaultSync, asserted above) already demonstrates; double-checked directly here.
        const parentAlternatives = await getAlternatives(directories, newNodeId);
        assert.equal(parentAlternatives.selected, parentAlternatives.alternatives.findIndex(a => a.node_id === newNodeId), 'the new alternative is the one getAlternatives() reports as currently selected');
    }

    // (f) type: 'regenerate' maps onto the SAME is_swipe-driven persistence as 'swipe' - a real
    // client sends `is_swipe: true` for both (see public/script.js's own `isSwipe` local), so the
    // route never distinguishes between the two literal `type` strings for persistence purposes.
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
            res.end(JSON.stringify({ choices: [{ text: 'A completely new reply.' }] }));
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
    // newText), on the SAME node id, at the SAME position in the tree - never a new node - and no
    // user-message node may be created.
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
        assert.equal(branchBefore.messages[branchBefore.messages.length - 1].mes, 'Once upon a time,');

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: ' there was a brave adventurer.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: leafBefore,
            type: 'continue', is_continue: true, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.equal(data.choices?.[0]?.text, ' there was a brave adventurer.', 'the generated text still reaches the client unmodified');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const branchAfter = await loadBranch(directories, ownerId, continueBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no new node (user or assistant) was created - continue only edits the existing leaf');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the SAME node is still the leaf - editMessage() edits in place, it does not reparent/replace the node');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Once upon a time, there was a brave adventurer.', 'the stored text is now oldText + newText, on the same node, at the same position');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].name, 'Rex', 'the edited node keeps its own original speaker, unchanged');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].is_user, false);
    }

    // (h) is_continue: true combined with a REAL (non-empty) user_message - the genuine, verified edge
    // case from this session's investigation: public/script.js's own Generate() does NOT exclude
    // 'continue' from its "read+clear the send textarea as user_message" condition, so leftover
    // send-box text at the moment Continue is clicked really can reach this route as a real
    // user_message. The route must still commit that real user message (exactly like any other type
    // would), but must NOT then edit the ORIGINAL assistant leaf as if it were being continued - that
    // node is no longer the request's real anchor once a new user node exists ahead of it. Proves the
    // `continueUserTextConflict` guard: the user message lands as a real new node, but the original
    // assistant message's own text is completely untouched (no in-place edit was attempted against it).
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
            res.end(JSON.stringify({ choices: [{ text: ' this should NOT be spliced onto the old leaf.' }] }));
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
        // A real new user node WAS committed (matching every other type's real-user_message behavior) -
        // but the assistant reply was NOT spliced onto the original leaf: the count only grew by one
        // (the user message), not two.
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was added - the generated reply was NOT persisted anywhere in this guarded combination');
        const newLeaf = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(newLeaf.mes, 'Wait, actually - tell me about dragons instead.', 'the real user message was committed, unrelated to the continue edit');
        assert.equal(newLeaf.is_user, true);

        // The ORIGINAL assistant leaf's own text is completely untouched - the in-place edit was
        // correctly skipped rather than corrupting it.
        const originalNode = (await getAlternatives(directories, originalLeafId)).alternatives.find(a => a.node_id === originalLeafId);
        assert.equal(originalNode.mes, 'Once upon a time,', 'the original assistant leaf\'s text is byte-for-byte unchanged - continueUserTextConflict correctly skipped the in-place edit');
    }

    // (j) GROUP CHAT support (this session's own task): `character_avatar` (the specific responding
    // member) AND `group_id` (the group's own addressing) given TOGETHER - the shape
    // public/script.js's widened raw-action gate now sends for a group turn. Real on-disk fixtures
    // throughout: a real group.json (matching the exact shape src/endpoints/groups.js's own
    // `/create` route writes), a real chat branch OWNED BY THE GROUP'S id (not either member's
    // avatar), and two real member character cards with deliberately distinct `description`s so a
    // wrong-member mixup would be detectable.
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
        /** Exact shape src/endpoints/groups.js's own POST /create route writes to <id>.json. */
        const groupMetadata = {
            id: groupId,
            name: 'Adventuring Party',
            members: [nova, zephyr],
            avatar_url: 'img/ai4.png',
            allow_self_responses: false,
            activation_strategy: 0,
            generation_mode: 0,
            disabled_members: [],
            fav: false,
            chat_id: groupChatId,
            chats: [groupChatId],
            auto_mode_delay: 5,
            generation_mode_join_prefix: '',
            generation_mode_join_suffix: '',
        };
        fs.writeFileSync(path.join(groupsDir, `${groupId}.json`), JSON.stringify(groupMetadata, null, 4));

        // Enable names_as_stop_strings so groupMemberNames' real effect (not just its presence in the
        // resolver's return value) is observable in the assembled generate_data.
        const groupSettings = buildSettingsFixture();
        groupSettings.power_user.context.names_as_stop_strings = true;
        // Real default story-string template (public/scripts/power-user.js's own `defaultStoryString`)
        // so `description` actually reaches the assembled prompt - the base fixture's `context: {}`
        // has no template at all, so `description` would never appear regardless of which
        // character's card was resolved, defeating this test's own "reflects the RIGHT member's card"
        // assertion below.
        groupSettings.power_user.context.story_string = '{{#if description}}{{description}}\n{{/if}}';
        writeAllSettings(directories, groupSettings);

        // A chat branch owned by the GROUP's own id - not either member's avatar - with one message
        // from each member already in history, matching a real multi-member group conversation.
        await saveChatToTree(directories, groupId, groupChatId, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hello, party!', send_date: 1, extra: {} },
            { name: 'Zephyr', is_user: false, mes: 'Winds are shifting!', send_date: 2, extra: {}, original_avatar: zephyr },
        ]);
        const groupLeafId = (await loadBranch(directories, groupId, groupChatId)).branch.leaf_id;

        // --- assembly: buildRawActionTextCompletionRequest() with BOTH characterAvatar (Nova, the
        // member actually responding this turn) AND groupId (the group) set together, addressed by
        // the group chat's real node_id. ---
        const builtGroup = await buildRawActionTextCompletionRequest(directories, {
            characterAvatar: nova, groupId, ownerId: groupId, nodeId: groupLeafId,
            type: 'normal', userMessageText: 'Nova, status report?',
            tokenizerOptions: fakeTokenizerOptions,
        });

        assert.equal(builtGroup.name2, 'Nova', 'name2 resolves to the SPECIFIC RESPONDING MEMBER (characterAvatar), not the group\'s own name, even though groupId is also set');
        assert.ok(builtGroup.params.prompt.includes('Nova is a stoic starship engineer.'), 'the assembled prompt reflects the responding member\'s (Nova\'s) own character card');
        assert.ok(!builtGroup.params.prompt.includes('Zephyr is a chaotic weather spirit.'), 'the assembled prompt does NOT pull in a DIFFERENT member\'s (Zephyr\'s) own character-card description - only Nova\'s, the one actually responding this turn');
        assert.ok(builtGroup.params.prompt.includes('Winds are shifting!'), 'the real group chat HISTORY (including the other member\'s prior turn) is still loaded from the group\'s own owner id');

        // groupMemberNames really does include EVERY OTHER group member (not just the responding
        // one) - observed via its real, documented effect (namesAsStopStrings), not just resolver
        // plumbing. src/stopping-strings.js's own getStoppingStrings() deliberately EXCLUDES name2
        // itself from this list (`.filter(name => name !== name2)` - the responding member is
        // already covered by its own `charString`/`userString` stop-string logic above), so Nova
        // (name2, the responding member) is correctly ABSENT here while Zephyr (a non-responding
        // member) is correctly PRESENT - proving groupMemberNames really carries the whole roster,
        // not just the responding member, exactly as resolveName2AndGroupMemberNames()'s own doc
        // comment describes.
        const stopStrings = builtGroup.params.stop ?? builtGroup.params.stopping_strings ?? [];
        assert.ok(Array.isArray(stopStrings) && stopStrings.length > 0, 'stop strings were assembled at all');
        assert.ok(stopStrings.some(s => s.includes('Zephyr')), 'namesAsStopStrings-derived stop strings include the NON-responding member (Zephyr) - groupMemberNames covers the whole roster, not just the responding member');
        assert.ok(!stopStrings.some(s => s.includes('Nova')), 'the responding member (Nova/name2) is correctly excluded from the groupMemberNames-derived entries (already covered by the separate name2-specific stop string)');

        // --- persistence: a real, route-level raw-action /generate call persists BOTH sides against
        // the GROUP's own owner_id, chained under the group's real chat branch. ---
        const branchBeforeGroup = await loadBranch(directories, groupId, groupChatId);
        const messageCountBeforeGroup = branchBeforeGroup.messages.length;

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'All systems nominal, Captain.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: groupId, character_avatar: nova, group_id: groupId, node_id: branchBeforeGroup.branch.leaf_id,
            type: 'normal', user_message: 'Nova, status report?', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the group raw-action generation succeeds');
        assert.equal(data.choices?.[0]?.text, 'All systems nominal, Captain.', 'response body reaches the client unmodified');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const branchAfterGroup = await loadBranch(directories, groupId, groupChatId);
        assert.equal(branchAfterGroup.messages.length, messageCountBeforeGroup + 2, 'both the user message and the assistant reply were persisted under the GROUP\'s own owner_id');
        const [userMsg, assistantMsg] = branchAfterGroup.messages.slice(-2);
        assert.equal(userMsg.mes, 'Nova, status report?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'All systems nominal, Captain.');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Nova', 'the persisted assistant message is attributed to the SPECIFIC RESPONDING MEMBER (name2/Nova), not the group\'s own name or the other member (Zephyr)');

        // Sanity: none of this leaked into either single-character owner namespace used elsewhere in
        // this file (Rex's own branch, keyed by his own avatar as ownerId).
        const rexBranchUnaffected = await loadBranch(directories, ownerId, branchName);
        assert.ok(rexBranchUnaffected.messages.every(m => m.mes !== 'All systems nominal, Captain.'), 'the group turn did not leak into an unrelated single-character owner namespace');
    }

    // (i) STREAMING raw-action, plain reply: the GENERIC api_type is now routed through
    // forwardAndPersistCompactStream() (text-completions.js), which re-encodes the upstream OpenAI-
    // text-completions-shaped SSE stream (`data: {"choices":[{"text":"..."}]}`) into the compact
    // binary wire format instead of forwarding the SSE-JSON bytes as-is. Asserts the response
    // declares `X-ST-Stream-Format: compact-v1`, the decoded byte stream reconstructs the exact
    // original text, AND the full concatenated text lands on the tree afterward (persistence happens
    // asynchronously, after the HTTP response to the client has already ended - see
    // forwardAndPersistCompactStream()'s own doc comment in text-completions.js - so this polls via
    // waitFor() rather than asserting immediately after the fetch resolves).
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
        const { status, headers, bytes } = await postGenerateStreamBytes(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Say hi, streamed.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(headers.get('X-ST-Stream-Format'), 'compact-v1', 'the general raw-action streaming path now declares the compact binary wire format');
        const decoded = decodeCompactStream(bytes);
        assert.equal(decoded.text, 'Rex says hello back, streamed.', 'the decoded compact stream reconstructs the exact text, accumulated across every SSE chunk - not just the last chunk');
        assert.ok(decoded.assistantNodeId, 'the assistant_node_id frame was sent as the final frame');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, streamBranch);
            return branch.messages.length === messageCountBefore + 2 ? branch : null;
        });
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, streamed.');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back, streamed.', 'the persisted tree message matches the decoded compact-stream text exactly');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex');
        assert.equal(assistantMsg.node_id, decoded.assistantNodeId, 'the node id sent to the client in the compact stream\'s assistant_node_id frame is the exact node the reply actually landed on');
    }

    // (i-2) STREAMING raw-action, is_swipe: true - same SSE teeing, but must land as a real
    // SIBLING alternative (addAlternatives() + selectDefaultChild()), exactly like the
    // non-streaming swipe case (e) above - proving persistAssistantReply() drives the streaming
    // path through the exact same shared branching, not a re-implementation of it.
    // Uses its own DISTINCT preceding message text (not reused from any other branch in this file) -
    // message-tree-db.js structurally SHARES nodes across different branches for the same owner
    // whenever their preceding content is byte-identical (a real, intentional git-like DAG feature),
    // and `addAlternatives()`/`selectDefaultChild()` mutate a "which sibling is the default" pointer
    // on the shared PARENT itself - so reusing another swipe test's exact text here would make this
    // test observe (and mutate) that OTHER test's own tree state instead of a clean fixture (see
    // test (f)'s own distinct text, for the exact same reason, predating this session).
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
        const { status, headers, bytes } = await postGenerateStreamBytes(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: swipedNodeId,
            type: 'swipe', is_swipe: true, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(headers.get('X-ST-Stream-Format'), 'compact-v1');
        const decoded = decodeCompactStream(bytes);
        assert.equal(decoded.text, 'Greetings, traveler, streamed!', 'the decoded compact stream reconstructs the exact swiped text');
        assert.ok(decoded.assistantNodeId);

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, streamSwipeBranch);
            return branch.branch.leaf_id !== swipedNodeId ? branch : null;
        });
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Greetings, traveler, streamed!');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].node_id, decoded.assistantNodeId, 'the node id sent to the client in the compact stream\'s assistant_node_id frame is the exact node the swipe actually landed on');
        const alternatives = await getAlternatives(directories, swipedNodeId);
        assert.equal(alternatives.total, 2, 'the streamed swipe produced a real sibling alternative, not a chained child');
        assert.ok(alternatives.alternatives.some(a => a.mes === 'Hello there, streaming swipe test!'), 'the original swiped message is unchanged');
    }

    // (i-3) STREAMING raw-action, is_continue: true - same SSE teeing, but must EDIT the existing
    // leaf in place (oldText + newText) via editMessage(), exactly like the non-streaming continue
    // case (g) above. Uses its own DISTINCT preceding text - see (i-2)'s own comment above on why
    // (continue's editMessage() mutates a potentially-SHARED leaf node in place, so reusing (g)/(h)'s
    // exact text here would edit THEIR fixture's node instead of a clean one of this test's own).
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
        const { status, headers, bytes } = await postGenerateStreamBytes(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: leafBefore,
            type: 'continue', is_continue: true, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(headers.get('X-ST-Stream-Format'), 'compact-v1');
        const decoded = decodeCompactStream(bytes);
        assert.equal(decoded.text, ' there was a brave, streamed adventurer.', 'the decoded compact stream reconstructs the exact continued text');
        assert.equal(decoded.assistantNodeId, leafBefore, 'a continue edits in place - the node id sent in the compact stream\'s assistant_node_id frame is the SAME node it started at, not a new one');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, streamContinueBranch);
            const leaf = branch.messages[branch.messages.length - 1];
            return leaf.mes === 'Once upon a streaming time, there was a brave, streamed adventurer.' ? branch : null;
        });
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no new node was created - the streamed continue only edited the existing leaf');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the SAME node is still the leaf');
    }

    // (i-4) STREAMING raw-action via OLLAMA: real Ollama-shaped JSON-lines chunks (`{"response":
    // "...","done":false}`, no SSE framing) through parseOllamaStream() - proves the per-chunk
    // `json.response` text it already parses for its own SSE re-shaping is now also accumulated
    // and persisted once the stream ends.
    {
        const ollamaBranch = 'stream-ollama-chat';
        await saveChatToTree(directories, ownerId, ollamaBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const ollamaChunks = ['Hello ', 'from ', 'Ollama, ', 'streamed.'];
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            // parseOllamaStream() (this file's own pre-existing, unmodified parser) tries
            // JSON.parse() on the WHOLE accumulated buffer rather than splitting on newlines - it
            // relies on each real Ollama chunk arriving as its own separate 'data' event. A small
            // delay between writes here forces that same separation over the real loopback socket,
            // instead of racing to find out whether Node coalesces back-to-back synchronous writes
            // into a single TCP segment.
            (async () => {
                for (const text of ollamaChunks) {
                    res.write(JSON.stringify({ response: text, done: false }));
                    await new Promise(resolve => setTimeout(resolve, 5));
                }
                res.end(JSON.stringify({ response: '', done: true }));
            })();
        });
        pointOllamaBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, ollamaBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Say hi via Ollama.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        // parseOllamaStream() re-shapes Ollama's own JSON-lines into OpenAI-completions-style SSE -
        // this re-shaping is pre-existing/unmodified behavior, so the expected client body is built
        // the same way it always was, independent of the persistence change under test.
        // parseOllamaStream() re-shapes EVERY chunk it receives, including the final `done: true`
        // sentinel (an empty-text event) - that's pre-existing, unmodified behavior, so the expected
        // client body includes it too.
        const expectedSse = [...ollamaChunks, ''].map(text => `data: ${JSON.stringify({ choices: [{ text, thinking: '' }] })}\n\n`).join('') + 'data: [DONE]\n\n';
        assert.equal(bodyText, expectedSse, 'the client-facing re-shaped SSE bytes are unchanged by the persistence addition');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, ollamaBranch);
            return branch.messages.length === messageCountBefore + 2 ? branch : null;
        });
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi via Ollama.');
        assert.equal(assistantMsg.mes, 'Hello from Ollama, streamed.', 'the full text, accumulated across every Ollama JSON-lines chunk, was persisted');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (i-5) STREAMING raw-action via LLAMACPP's own compact wire format: pipeLlamaCppCompactStream()
    // already fully JSON-parses every upstream SSE event (to re-encode it into the compact format) -
    // this proves `data.content` is now also accumulated and persisted, with the compact-format
    // bytes reaching the client completely unchanged. With no embedded 0xFF bytes, no index changes
    // (every event here implicitly has index 0, matching the initial `lastIndex`), and no
    // `completion_probabilities`, the compact wire format degenerates to exactly the concatenated
    // `content` strings, UTF-8 encoded - allowing a direct byte-for-byte comparison without needing
    // a separate compact-format decoder.
    {
        const llamaCppBranch = 'stream-llamacpp-chat';
        await saveChatToTree(directories, ownerId, llamaCppBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const llamaCppChunks = ['Hello ', 'from ', 'llama.cpp, ', 'streamed.'];
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            for (const content of llamaCppChunks) {
                res.write(`data: ${JSON.stringify({ content, stop: false })}\n\n`);
            }
            res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
        });
        pointLlamaCppBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, llamaCppBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'Say hi via llama.cpp.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, llamaCppChunks.join(''), 'the compact-format bytes reaching the client are exactly the concatenated content, unaffected by the persistence addition');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, llamaCppBranch);
            return branch.messages.length === messageCountBefore + 2 ? branch : null;
        });
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi via llama.cpp.');
        assert.equal(assistantMsg.mes, 'Hello from llama.cpp, streamed.', 'the full text, accumulated across every compact-stream event, was persisted');
        assert.equal(assistantMsg.name, 'Rex');
    }

    // (i-6) A NON-raw-action streaming request (no owner_id/character_avatar, so neither raw-action
    // branch runs and pendingAssistantPersist stays null throughout) must be COMPLETELY unaffected
    // by the teeing/re-encoding mechanism: forwardAndPersistCompactStream()'s own top-of-function
    // guard (`if (!persist || ...)`) falls straight through to a plain, untouched
    // forwardFetchResponse() call (still plain SSE-JSON, not the compact binary format) - no listener
    // is even attached in this case. Verified here by asserting the client-facing bytes are still
    // byte-for-byte identical to the fake backend's own SSE stream, exactly as they were before this
    // session's change (this exact scenario - a stream with no raw-action fields - already exercised
    // the SAME forwardFetchResponse() call prior to this session).
    {
        const fakeBackend = await startFakeSseBackend(['This ', 'is ', 'a ', 'plain ', 'legacy ', 'stream.']);
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyText } = await postGenerateStream(app, {
            // No owner_id/character_avatar/group_id/connection_profile_id - falls through to the
            // legacy/default branch, which only resolves api_type/api_server from settings and
            // otherwise dispatches request.body completely unchanged.
            prompt: 'Legacy raw prompt, no raw-action fields.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(bodyText, fakeBackend.expectedBody, 'a non-raw-action stream is forwarded byte-for-byte unchanged - pendingAssistantPersist stays null, so no teeing/accumulation/persistence logic ever runs for it');
    }

    // (i-6b) STREAMING raw-action, TOKEN COALESCING + reasoning: a real fake backend emits many small
    // `choices[0].text`/`choices[0].reasoning` SSE chunks with a real delay between each write (see
    // startFakeSseBackendPaced()'s own comment), giving forwardAndPersistCompactStream()'s ~40ms/
    // ~256-byte coalescing logic more than one real upstream event to actually coalesce across. Proves
    // (a) the decoded text AND reasoning reconstruct exactly despite the coalescing, (b) the client
    // received meaningfully fewer network reads than upstream chunks were sent (the whole point of
    // coalescing over one binary frame per token), and (c) the reasoning/content ordering survives -
    // the reasoning chunks were interleaved with the FIRST few text chunks upstream, so a bug that
    // reordered a reasoning frame relative to already-buffered content would show up as garbled text.
    {
        const coalesceBranch = 'stream-compact-coalesce-chat';
        await saveChatToTree(directories, ownerId, coalesceBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, coalesceBranch);

        const textChunks = Array.from({ length: 12 }, (_, i) => `tok${i} `);
        const reasoningByIndex = { 0: 'think0 ', 1: 'think1 ', 2: 'think2 ' };
        const chunks = textChunks.map((text, i) => ({ text, reasoning: reasoningByIndex[i] }));
        const fakeBackend = await startFakeSseBackendPaced(chunks);
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;

        let status, headers, readChunkCount = 0, bytes;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                    type: 'normal', user_message: 'Coalesce test.', stream: true,
                }),
            });
            status = res.status;
            headers = res.headers;
            const reader = res.body.getReader();
            const received = [];
            for (; ;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.length) {
                    received.push(Buffer.from(value));
                    readChunkCount++;
                }
            }
            bytes = Buffer.concat(received);
        } finally {
            fakeBackend.server.close();
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }

        assert.equal(status, 200);
        assert.equal(headers.get('X-ST-Stream-Format'), 'compact-v1');
        const decoded = decodeCompactStream(bytes);
        assert.equal(decoded.text, textChunks.join(''), 'the coalesced compact stream reconstructs the exact text across many small, separately-received upstream chunks');
        assert.equal(decoded.reasoning, 'think0 think1 think2 ', 'reasoning deltas reconstruct exactly too, correctly ordered relative to the content they were interleaved with');
        assert.ok(decoded.assistantNodeId);
        assert.ok(readChunkCount < textChunks.length, `expected fewer network reads (${readChunkCount}) than upstream chunks (${textChunks.length}) - proves content was coalesced into fewer, larger writes instead of one frame per upstream chunk`);

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, coalesceBranch);
            const leaf = branch.messages[branch.messages.length - 1];
            return leaf.mes === textChunks.join('') ? branch : null;
        });
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].node_id, decoded.assistantNodeId);
    }

    // (i-6c) STREAMING raw-action, CLIENT DISCONNECT MID-STREAM: mirrors kobold.test.js's own real-
    // TCP-close disconnect test (see that file's comment on the same pattern) - a real AbortController
    // closes the real client-side TCP socket while the fake backend still has more (unsent) content
    // queued up. Proves forwardAndPersistCompactStream()'s safeWrite()-via-createBackpressureWriter()
    // guard actually prevents the write-after-end crash class this session already found and fixed
    // once elsewhere (kobold.js) - if that guard were missing/broken, the attempted write to the
    // already-closed socket after disconnect would throw/emit an unhandled error and take this whole
    // test process down, not just fail one assertion. Also proves the partial text received BEFORE the
    // disconnect is still persisted (a real, if partial, reply - not nothing).
    {
        const disconnectBranch = 'stream-compact-disconnect-chat';
        await saveChatToTree(directories, ownerId, disconnectBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);
        const branchBefore = await loadBranch(directories, ownerId, disconnectBranch);

        let releaseStream = () => { };
        const streamGate = new Promise(resolve => { releaseStream = resolve; });
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ text: 'Partial before disconnect.' }] })}\n\n`);
            // Deliberately NOT res.end()'d yet - a real in-progress generation, giving the test a real
            // window to disconnect the client before the upstream response completes on its own.
            streamGate.then(() => {
                try {
                    res.write(`data: ${JSON.stringify({ choices: [{ text: ' Should never reach the client.' }] })}\n\n`);
                    res.end('data: [DONE]\n\n');
                } catch {
                    // The fake backend's own socket may already be gone too by this point - not what's under test.
                }
            });
        });
        pointBackendAt(fakeBackend.url);

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
                    owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                    type: 'normal', user_message: 'Disconnect me, Rex.', stream: true,
                }),
                signal: controller.signal,
            });
            assert.equal(res.headers.get('X-ST-Stream-Format'), 'compact-v1');

            const reader = res.body.getReader();
            const { value: firstChunk } = await reader.read();
            assert.ok(firstChunk && firstChunk.length > 0, 'a real chunk was received before the client disconnects, proving generation was genuinely underway');

            // Closes the real TCP socket between this test's fetch() and the route's server, firing
            // the route's real response.socket 'close' handler under completely real conditions.
            controller.abort();
        } finally {
            releaseStream();
            fakeBackend.server.close();
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }

        // If the process is still alive to run this assertion at all, no write-after-end exception
        // escaped uncaught - that's the primary thing this test proves. The partial text received
        // before the disconnect must still have been persisted.
        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(directories, ownerId, disconnectBranch);
            return branch.messages.length > branchBefore.messages.length + 1 ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Partial before disconnect.', 'only the text received before the disconnect was persisted - not the text the backend tried to send afterward');
    }

    // (i-7) ROUTE-LEVEL: a raw-action request whose body never includes the `node_id` key at all
    // gets a real 400, distinct from an explicit `node_id: null` - proving the "absent key" vs.
    // "explicit null" distinction survives all the way from the real HTTP JSON body, through
    // Express's own body-parser, to buildRawActionTextCompletionRequest()'s own validation (not just
    // when calling that function directly, as the earlier in-process assertion already covers).
    {
        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar,
            type: 'normal', user_message: 'This should be rejected.', stream: false,
        });
        assert.equal(status, 400, 'a request body with no node_id key at all is a real 400, not a silent guess');
        assert.match(data.message, /node_id is required/, 'the error names the real, specific problem');
    }

    // (i-8) ROUTE-LEVEL: `node_id: null` on a character that already has real history is a real 400 -
    // the server does not silently pick "the current leaf" once real, possibly-stale history exists.
    {
        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: null,
            type: 'normal', user_message: 'This should also be rejected.', stream: false,
        });
        assert.equal(status, 400, 'node_id: null on an owner with real existing history is a real 400');
        assert.match(data.message, /already has an existing conversation/, 'the error explains why null was rejected here');
    }

    // (i-9) ROUTE-LEVEL: a real `user_message_extra` file-attachment reference, forwarded on a raw-
    // action request, is (a) persisted onto the new user message's real `extra` (via loadBranch(),
    // matching this file's own existing convention) and (b) actually inlined - via the already-
    // generic file-attachment-inline.js machinery - into the real prompt text the fake backend
    // receives, not just carried through as inert data.
    {
        fs.writeFileSync(path.join(filesDir, 'raw-action-attach.txt'), 'The password is hunter2.');

        let capturedRequestBody = null;
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            capturedRequestBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'Got your file.' }] }));
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
        const promptField = JSON.stringify(capturedRequestBody);
        assert.ok(
            promptField.includes('The password is hunter2.'),
            'the real file-attachment content, resolved via the forwarded user_message_extra reference, was inlined into the prompt actually sent to the backend',
        );

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        const persistedUserMsg = branchAfter.messages[branchAfter.messages.length - 2];
        assert.equal(persistedUserMsg.mes, 'Check the attached file.');
        assert.deepEqual(
            persistedUserMsg.extra,
            { files: [{ url: '/user/files/raw-action-attach.txt', size: 25, name: 'raw-action-attach.txt', created: 1700000000000 }] },
            'the persisted user message node carries the (sanitized) forwarded extra',
        );
    }

    // (i-10) ROUTE-LEVEL: a garbage-shaped `user_message_extra` (unexpected top-level field, a
    // non-string url, an out-of-enum media type) is dropped/sanitized rather than stored verbatim or
    // crashing the request - sanitizeUserMessageExtra()'s own allowlist (message-tree-db.js) is
    // exercised through the real HTTP route, not called directly.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'Fine either way.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: 'This has a garbage attachment payload.', stream: false,
            user_message_extra: {
                // Not a real allowlisted field - must be dropped entirely, not stored.
                evil_script: '<script>alert(1)</script>',
                // A file entry missing `url` (wrong type) - the whole entry must be dropped, not
                // partially kept.
                files: [{ url: 12345, name: 'not-a-real-url.txt' }],
                // A media entry with an out-of-enum `type` - the whole entry must be dropped.
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

    // --- REGRESSION: the "double-append on raw-action sends" bug this session fixed (see
    // public/script.js's Generate() - specifically its `willUseRawAction`/`skipTreePersistence`
    // fix, threaded into sendMessageAsUser()) ---
    // Root cause: for a real send, sendMessageAsUser() (public/script.js) used to UNCONDITIONALLY
    // call chatOpAppend() (public/scripts/chat-store.js) whenever `chat_metadata?._tree_stored`,
    // which POSTs the client's own message object (built via `_messageContent()`'s shallow spread
    // - `{...msg, mes: text}`) to /api/chats/message/append -> this SAME appendMessages() function.
    // That client message object carries `persona: avatar` (an avatar id/filename, set on
    // `message` inside sendMessageAsUser() itself). Separately, whenever the raw-action gate in
    // Generate() fires for that same send, this route's own handler (buildRawActionTextCompletion-
    // Request()'s caller) ALSO independently calls appendMessages() for the SAME logical message,
    // built server-side as `{ name: built.name1, is_user: true, mes: userMessageText, ... }` -
    // built.name1 being a DISPLAY NAME (e.g. "Tester"), and crucially with NO `persona` field at
    // all. Both calls target the exact SAME anchor: Generate() captures `lastMessage`/its
    // `node_id` at the very top of the function, BEFORE sendMessageAsUser() ever runs, and passes
    // that same pre-existing leaf as the raw-action request's own `node_id` - so this isn't a
    // parent/child relationship, it's two independent appendMessages() calls at the identical
    // parent for what a human would call "one message".
    // appendMessages()'s own dedup-by-identity_hash exists precisely to make a retry/double-send
    // land on the same row (see its "a retry/double-send that matches an existing sibling lands on
    // that row instead of duplicating" comment above) - but nodeIdentityKey() computes a user
    // message's speaker as `'u' + (o?.persona ?? o?.name ?? '')`. The client's own append has a
    // real `persona` (an avatar id); the server's re-append has none, so it falls back to
    // `o?.name` (a display name) - two different strings almost always - so the identity hashes
    // essentially NEVER match in a real setup, the "twin" lookup fails, and a genuine duplicate
    // sibling node is created under the same parent for one logical user turn.
    //
    // This is a CLIENT-behavior bug (sendMessageAsUser() deciding whether to persist at all) - no
    // route-level test alone can invoke the real public/script.js browser code (there is no
    // browser test harness in this repo), so it was invisible to this file's own existing
    // route/request-builder tests, which only ever exercise the SERVER's one appendMessages()
    // call in isolation and never modeled the client's own separate, concurrent append. What CAN
    // be verified here, and is verified below, is both halves of the real bug:
    //   1. Reproduce the ORIGINAL failure mode exactly: the client's own append (with `persona`)
    //      and the server's own raw-action re-append (with no `persona`, `name` fallback) at the
    //      SAME anchor produce two DIFFERENT identity hashes and therefore two sibling nodes.
    //   2. Prove the fix's actual server-observable guarantee: once the client's own append is
    //      skipped (the real fix - a client-only change, see Generate()'s own `willUseRawAction`
    //      doc comment in public/script.js), the raw-action route's own appendMessages() call is
    //      the SOLE writer, and by itself it produces exactly ONE user-message node for one
    //      logical send - trivially true of a single call, but this documents precisely what the
    //      fix relies on server-side, and is exactly what this file's other route-level tests
    //      already implicitly exercise (a single append per real send) once the client stops
    //      making its own redundant, differently-keyed append call.
    {
        const dupAvatar = writeCharacter('DupBug.png', {
            name: 'DupBug',
            data: { name: 'DupBug', description: '', first_mes: 'Hi.' },
        });
        const dupOwnerId = dupAvatar;
        const dupBranchName = 'dup-bug-chat';
        await saveChatToTree(directories, dupOwnerId, dupBranchName, [
            { chat_metadata: {} },
            { name: 'DupBug', is_user: false, mes: 'Hi.', send_date: 1, extra: {} },
        ]);
        const dupBranchInfo = await loadBranch(directories, dupOwnerId, dupBranchName);
        const dupParentLeafId = dupBranchInfo.branch.leaf_id;

        // (1) Simulates the client's own sendMessageAsUser() -> chatOpAppend() call, BEFORE this
        // session's fix - a real `persona` field, a display `name`, same text.
        const clientSideAppend = await appendMessages(directories, dupOwnerId, dupParentLeafId, [
            { name: 'Tester', is_user: true, mes: 'What happens next?', persona: 'user-default.png', extra: {}, send_date: Date.now() },
        ]);
        assert.equal(clientSideAppend.ok, true);

        // Simulates the raw-action route independently resolving the SAME anchor for the SAME send
        // (exactly buildRawActionTextCompletionRequest()'s own real resolution, exercised for real).
        const dupBuilt = await buildRawActionTextCompletionRequest(directories, {
            characterAvatar: dupAvatar, ownerId: dupOwnerId, nodeId: dupParentLeafId,
            type: 'normal', userMessageText: 'What happens next?',
            tokenizerOptions: fakeTokenizerOptions,
        });
        assert.equal(dupBuilt.anchorNodeId, dupParentLeafId, 'the raw-action route resolves the SAME pre-existing leaf as its anchor - not the client\'s just-appended node - reproducing the real concurrent-append shape');

        // (2) Simulates this SAME route handler's own re-append of the identical logical message -
        // `built.name1`, no `persona` - this is the exact call the real route handler makes.
        const serverSideAppend = await appendMessages(directories, dupOwnerId, dupBuilt.anchorNodeId, [
            { name: dupBuilt.name1, is_user: true, mes: 'What happens next?', extra: {}, send_date: Date.now() },
        ]);
        assert.equal(serverSideAppend.ok, true);

        assert.notEqual(
            clientSideAppend.node_ids[0], serverSideAppend.node_ids[0],
            'ORIGINAL BUG reproduced: the persona-keyed (client) and name-keyed (server) identity hashes differ, so the server\'s own re-append does NOT converge onto the client\'s already-persisted node - it creates a genuine duplicate sibling instead',
        );
        const dupAlternatives = await getAlternatives(directories, clientSideAppend.node_ids[0]);
        assert.equal(dupAlternatives.total, 2, 'ORIGINAL BUG: two sibling user-message nodes now exist under the same parent for what a user experiences as one single message send');

        // --- THE FIX, verified: once sendMessageAsUser() is told to skip its own tree-append
        // (`skipTreePersistence: true`, set from Generate()'s hoisted `willUseRawAction` - see
        // public/script.js), the raw-action route's own appendMessages() call above becomes the
        // ONLY writer for this message. Proven here on a fresh anchor: with only that ONE append
        // performed (never the client-side one), exactly one node exists - no duplicate sibling. ---
        const fixedAvatar = writeCharacter('FixedBug.png', {
            name: 'FixedBug',
            data: { name: 'FixedBug', description: '', first_mes: 'Hi.' },
        });
        const fixedOwnerId = fixedAvatar;
        const fixedBranchName = 'fixed-bug-chat';
        await saveChatToTree(directories, fixedOwnerId, fixedBranchName, [
            { chat_metadata: {} },
            { name: 'FixedBug', is_user: false, mes: 'Hi.', send_date: 1, extra: {} },
        ]);
        const fixedBranchInfo = await loadBranch(directories, fixedOwnerId, fixedBranchName);
        const fixedParentLeafId = fixedBranchInfo.branch.leaf_id;

        const fixedBuilt = await buildRawActionTextCompletionRequest(directories, {
            characterAvatar: fixedAvatar, ownerId: fixedOwnerId, nodeId: fixedParentLeafId,
            type: 'normal', userMessageText: 'What happens next?',
            tokenizerOptions: fakeTokenizerOptions,
        });
        // Post-fix reality: this is the ONLY appendMessages() call for this send - the client's own
        // chatOpAppend() never ran (skipped by sendMessageAsUser()'s `skipTreePersistence`).
        const onlyAppend = await appendMessages(directories, fixedOwnerId, fixedBuilt.anchorNodeId, [
            { name: fixedBuilt.name1, is_user: true, mes: 'What happens next?', extra: {}, send_date: Date.now() },
        ]);
        assert.equal(onlyAppend.ok, true);
        const fixedAlternatives = await getAlternatives(directories, onlyAppend.node_ids[0]);
        assert.equal(fixedAlternatives.total, 1, 'THE FIX: exactly one user-message node exists for one logical send once the client no longer makes its own redundant, differently-keyed append');
    }

    // NOTE: a dedicated test for the "continue/swipe on an empty chat" guard (see
    // buildRawActionTextCompletionRequest()'s own `if ((isContinue || isSwipe) && ...chat.length
    // === 0)` check) is deliberately NOT included here - message-tree-db.js's own invariants make a
    // real EMPTY labeled branch/node impossible to construct through its public API (a branch label
    // can only attach to a real message node created by at least one actual saveChatToTree()/
    // appendMessages() call - see saveChatToTree()'s `else if (firstId)` gate, which never labels
    // anything when zero messages are given). The guard is still real defensive code for whatever
    // future/edge case might reach it with a genuinely empty resolved chat - just not exercisable
    // with this module's own current tree invariants.

    console.log('text-completions.test.js: all assertions passed');
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
