import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
import { setConfigFilePath } from '../../util.js';
import { streamAsSetting } from '../../../tests/util/stream-as-setting.js';
import { routerWithGenerate } from '../../../tests/util/router-with-generate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

/** @type {string|null} */
let openRouterFakeBackendUrl = null;
{
    const realFetch = globalThis.fetch;
    globalThis.fetch = /** @type {typeof fetch} */ (async (url, opts) => {
        const target = new URL(url);
        if (openRouterFakeBackendUrl && target.origin === 'https://openrouter.ai') {
            return realFetch(new URL(target.pathname + target.search, openRouterFakeBackendUrl), opts);
        }
        return realFetch(url, opts);
    });
}

const { router: textCompletionsRouter, generateTextCompletion, buildRawActionTextCompletionRequest } = await import('./text-completions.js');
const router = routerWithGenerate(textCompletionsRouter, generateTextCompletion);
const { writeAllSettings } = await import('../../settings-store.js');
const { importWorldInfoFromRaw } = await import('../worldinfo.js');
const { writeSecret, deleteSecret, SECRET_KEYS } = await import('../secrets.js');
const { writeBack, tokenKeyHash } = await import('../../token-count-store.js');
const { CompactStreamDecoder } = await import('../../../public/scripts/llamacpp-compact-stream.js');
const { SentencePieceProcessor } = await import('@agnai/sentencepiece-js');

const sentencepieceEncodes = [];
{
    const load = SentencePieceProcessor.prototype.load;
    SentencePieceProcessor.prototype.load = async function (modelPath, ...rest) {
        this.modelPathForTest = String(modelPath);
        return load.call(this, modelPath, ...rest);
    };
    const encodeIds = SentencePieceProcessor.prototype.encodeIds;
    SentencePieceProcessor.prototype.encodeIds = function (...args) {
        sentencepieceEncodes.push(this.modelPathForTest);
        return encodeIds.apply(this, args);
    };
}
const llamaEncodes = () => sentencepieceEncodes.filter(file => /[\\/]llama\.model$/.test(file ?? ''));

const { SESSION_HEADER } = await import('../../request-session.js');
const { convertedUser, writeLibraryCard, saveBranch, loadBranch, sessionAt, chatContextOf, seedMessages, treeOf, editMessage } = await import('../../../tests/converted-user.fixture.js');

const user = await convertedUser('st-text-completions-raw-action-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

const { newSessionKey } = await import('../../chat-engine.js');

/**
 * @param {string} avatar
 * @param {unknown} nodeId
 */
async function chatOf(avatar, nodeId) {
    return chatContextOf(user.store, { avatar }, (await sessionAt(user.store, nodeId)) ?? newSessionKey());
}

/**
 * @param {string} avatar
 * @param {string | null} after
 * @param {Record<string, any>[]} contents
 */
async function appendThrough(avatar, after, contents) {
    const session = (await sessionAt(user.store, after)) ?? newSessionKey();
    return { ok: true, node_ids: await seedMessages(user.store, { avatar }, after, contents, { session }) };
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
        textgenerationwebui_settings: {
            type: 'generic',
            generic_model: 'test-model-7b',
            temp: 0.9,
        },
        extension_settings: { note: {}, cfg: {} },
    };
}

const fakeTokenizerOptions = {
    encodeLocal: async (_key, text) => Array.from(String(text ?? '')).map(ch => ch.codePointAt(0)),
};

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
    const mainBranchInfo = await loadBranch(user.store, { avatar: ownerId }, branchName);
    const mainLeafId = mainBranchInfo.branch.leaf_id;

    const built = await buildRawActionTextCompletionRequest(directories, {
        characterAvatar: avatar, chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
        type: 'normal', userMessageText: 'What happens next, Rex?',
        tokenizerOptions: fakeTokenizerOptions,
    });

    assert.equal(built.backend.type, 'generic', 'backend resolves for real via resolveTextGenBackend()');
    assert.equal(built.backend.model, 'test-model-7b');
    assert.equal(built.name1, 'Tester', 'name1 resolves from settings.json username, same as the orchestrator input');
    assert.ok(built.anchorNodeId, 'anchorNodeId resolves to the real leaf of the loaded branch');

    const branchBeforeAppend = await loadBranch(user.store, { avatar: ownerId }, branchName);
    assert.equal(built.anchorNodeId, branchBeforeAppend.branch.leaf_id, 'anchorNodeId is exactly the given node_id\'s real leaf_id');
    assert.equal(built.anchorNodeId, mainLeafId, 'anchorNodeId is exactly the given node_id, unchanged from before');

    assert.ok(built.params && typeof built.params === 'object', 'params (generate_data) is a real object');
    assert.equal(built.params.model, 'test-model-7b', 'params.model is the resolved backend model, matching buildTextCompletionPrompt()\'s own generate_data.model');
    assert.equal(typeof built.params.prompt, 'string');
    assert.ok(built.params.prompt.includes('Hello there, traveler.'), 'the real loaded chat history made it into the assembled prompt');
    assert.ok(built.params.prompt.includes('What happens next, Rex?'), 'the raw user_message made it into the assembled prompt');

    const appendResult = await appendThrough(ownerId, built.anchorNodeId, [
        { name: built.name1, is_user: true, mes: 'What happens next, Rex?', extra: {}, send_date: Date.now() },
    ]);
    assert.equal(appendResult.ok, true, 'appendMessages() accepts the resolved anchorNodeId as a real anchor');
    const branchAfterAppend = await loadBranch(user.store, { avatar: ownerId }, branchName);
    assert.equal(branchAfterAppend.messages.length, 4, 'the persisted user message is now part of the real loaded branch');
    assert.equal(branchAfterAppend.messages[3].mes, 'What happens next, Rex?');

    const continued = await buildRawActionTextCompletionRequest(directories, {
        characterAvatar: avatar, chat: await chatOf(avatar, branchAfterAppend.branch.leaf_id), nodeId: branchAfterAppend.branch.leaf_id, type: 'continue', isContinue: true,
        tokenizerOptions: fakeTokenizerOptions,
    });
    assert.ok(continued.params.prompt.includes('Likewise!'), 'continue resolves from the real existing history with no new message appended');
    assert.equal(continued.anchorNodeId, branchAfterAppend.branch.leaf_id, 'the continue anchor is the real current leaf');
    assert.equal(continued.anchorContent?.mes, 'What happens next, Rex?', 'anchorContent is the anchor\'s real, current, unmodified content (the real leaf at this point in the test, appended above) - exactly what the route\'s is_continue edit needs as "oldText"');

    const quietLeafId = branchAfterAppend.branch.leaf_id;
    const quiet = await buildRawActionTextCompletionRequest(directories, {
        characterAvatar: avatar, chat: await chatOf(avatar, quietLeafId), nodeId: quietLeafId, type: 'quiet',
        quiet: { quietPrompt: 'Summarize the scene in one line.' },
        tokenizerOptions: fakeTokenizerOptions,
    });
    assert.ok(quiet.params.prompt.endsWith('What happens next, Rex?\nSummarize the scene in one line.'), 'the quiet prompt ends the assembled prompt');
    const impersonated = await buildRawActionTextCompletionRequest(directories, {
        characterAvatar: avatar, chat: await chatOf(avatar, quietLeafId), nodeId: quietLeafId, type: 'impersonate', isImpersonate: true,
        quiet: { quietPrompt: 'Tester waves.', quietToLoud: true },
        tokenizerOptions: fakeTokenizerOptions,
    });
    assert.match(impersonated.params.prompt, /\nTester waves\.\nTester:$/, 'an /impersonate prompt goes in before the user\'s name line');

    await assert.rejects(
        async () => buildRawActionTextCompletionRequest(directories, {
            characterAvatar: 'NoSuchCharacter.png', chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Character not found/,
    );

    await assert.rejects(
        async () => buildRawActionTextCompletionRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, 'no-such-node-id'), nodeId: 'no-such-node-id',
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Chat node not found/,
    );

    await assert.rejects(
        async () => buildRawActionTextCompletionRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, undefined),
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /node_id is required \(pass null explicitly for a brand-new, empty conversation\)/,
    );

    await assert.rejects(
        async () => buildRawActionTextCompletionRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, null), nodeId: null,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /node_id is required: this chat is not at its start/,
    );

    const freshAvatar = await writeCharacter('Fresh.png', {
        name: 'Fresh',
        description: 'Fresh is a brand-new character with no chat history yet.',
        data: { name: 'Fresh', description: 'Fresh is a brand-new character with no chat history yet.', first_mes: 'Hello, this is Fresh.' },
    });
    const builtFresh = await buildRawActionTextCompletionRequest(directories, {
        characterAvatar: freshAvatar, chat: await chatOf(freshAvatar, null), nodeId: null,
        type: 'normal', userMessageText: 'Hi Fresh, this is our first message ever.',
        tokenizerOptions: fakeTokenizerOptions,
    });
    assert.equal(builtFresh.anchorNodeId, null, 'a new, empty conversation is at its tree\'s root: the reply opens it');
    assert.ok(!builtFresh.params.prompt.includes('Hello there, traveler.'), 'no unrelated prior history (Rex\'s) leaked into a brand-new character\'s resolved, empty chat');
    assert.ok(builtFresh.params.prompt.includes('Hi Fresh, this is our first message ever.'), 'the raw user_message for this turn still made it into the assembled prompt even though the resolved prior history was empty');
    const freshAppendResult = await appendThrough(freshAvatar, builtFresh.anchorNodeId, [
        { name: builtFresh.name1, is_user: true, mes: 'Hi Fresh, this is our first message ever.', extra: {}, send_date: Date.now() },
    ]);
    assert.equal(freshAppendResult.ok, true, 'the anchor-resolved node id for a brand-new conversation is a real, appendable node - not a fake/synthetic id');

    await assert.rejects(
        () => buildRawActionTextCompletionRequest(directories, {
            nodeId: mainLeafId,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /character_avatar or group_id is required/,
    );

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

    function pointBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.textgenerationwebui_settings.server_urls = { generic: url };
        writeAllSettings(directories, settings);
    }

    function pointOllamaBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.textgenerationwebui_settings.type = 'ollama';
        settings.textgenerationwebui_settings.ollama_model = 'test-ollama-model';
        settings.textgenerationwebui_settings.server_urls = { ollama: url };
        writeAllSettings(directories, settings);
    }

    function pointLlamaCppBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.textgenerationwebui_settings.type = 'llamacpp';
        settings.textgenerationwebui_settings.server_urls = { llamacpp: url };
        writeAllSettings(directories, settings);
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

    async function startFakeSseBackend(textChunks) {
        const sseBody = textChunks.map(text => `data: ${JSON.stringify({ choices: [{ text }] })}\n\n`).join('') + 'data: [DONE]\n\n';
        return { ...await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(sseBody);
        }), expectedBody: sseBody };
    }

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
        let reasoning = '';
        const swipes = [];
        let currentIndex = 0;
        let assistantNodeId = null;
        let itemization = null;
        const warnings = [];
        for (const event of events) {
            if ('index' in event) {
                currentIndex = event.index;
            } else if ('reasoning' in event) {
                reasoning += event.reasoning;
            } else if ('assistantNodeId' in event) {
                assistantNodeId = event.assistantNodeId;
            } else if ('control' in event && event.control?.itemization) {
                itemization = event.control.itemization;
            } else if ('control' in event && event.control?.warnings) {
                warnings.push(...event.control.warnings);
            } else if ('content' in event) {
                if (currentIndex > 0) {
                    const swipeIndex = currentIndex - 1;
                    swipes[swipeIndex] = (swipes[swipeIndex] || '') + event.content;
                } else {
                    text += event.content;
                }
            }
        }
        return { text, reasoning, swipes, assistantNodeId, itemization, warnings };
    }

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'Rex says hello back.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'One more time, Rex?' }, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.equal(data.choices?.[0]?.text, 'Rex says hello back.', 'response body reaches the client unmodified');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply were appended');
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'One more time, Rex?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back.', 'the assistant reply text was extracted from data.choices[0].text and appended');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex', 'the assistant message uses name2 (the character\'s display name), not name1');
    }

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'backend exploded' }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Are you there, Rex?' }, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the error branch still responds (with an error body), not a thrown exception');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was appended - no assistant reply for a failed generation');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Are you there, Rex?');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].is_user, true);
    }

    const nonStreamReplyFailures = [];
    async function nonStreamReplyCase(name, fn) {
        try {
            await fn();
            console.log(`  pass: ${name}`);
        } catch (error) {
            nonStreamReplyFailures.push(name);
            console.log(`  FAIL: ${name}: ${error.message}`);
        }
    }

    /**
     * @param {string} chatName
     * @param {string} replyText
     */
    async function assertNonStreamSendStored(chatName, replyText) {
        await saveBranch(user.store, { avatar: ownerId }, chatName, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: `Hello there, ${chatName}.`, send_date: 1, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, chatName);

        const { status, data } = await postGenerate(buildTestApp(), {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: `Question for ${chatName}?` }, stream: false,
        });

        assert.equal(status, 200);
        assert.ok(JSON.stringify(data).includes(replyText), `the backend's reply reaches the page: ${JSON.stringify(data)}`);
        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, chatName);
        assert.deepEqual(
            branchAfter.messages.slice(branchBefore.messages.length).map(m => ({ is_user: m.is_user, mes: m.mes })),
            [{ is_user: true, mes: `Question for ${chatName}?` }, { is_user: false, mes: replyText }],
            'the user message and the reply are both stored when the answer returns',
        );
        assert.equal(data.assistant_node_id, branchAfter.branch.leaf_id, 'the answer names the node the reply is stored at');
    }

    await nonStreamReplyCase('llama.cpp, non-streaming: `content` reply stored, assistant_node_id in the answer', async () => {
        const backend = await startFakeBackend((req, res, body) => {
            const json = (value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const route = (req.url ?? '').split('?')[0];
            if (route === '/props') return json({ model_path: '/models/nonstream.gguf', build_info: 'b-nonstream', default_generation_settings: { n_ctx: 8192 } });
            if (route === '/tokenize') return json({ tokens: String(JSON.parse(body || '{}').content ?? '').split(/(?=\s)/).filter(Boolean).map((_, i) => i) });
            if (route === '/completion') return json({ content: 'Rex answers through llama.cpp.' });
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
        pointLlamaCppBackendAt(backend.url);
        try {
            await assertNonStreamSendStored('nonstream-llamacpp-chat', 'Rex answers through llama.cpp.');
        } finally {
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    });

    {
        await nonStreamReplyCase('text-completion OpenRouter, non-streaming: `choices[0].message.content` reply stored, assistant_node_id in the answer', async () => {
            const backend = await startFakeBackend((req, res) => {
                const json = (value) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(value));
                };
                const route = (req.url ?? '').split('?')[0];
                if (route === '/api/v1/models') return json({ data: [] });
                if (route === '/api/v1/chat/completions') return json({ choices: [{ message: { role: 'assistant', content: 'Rex answers through OpenRouter.' } }] });
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end('{}');
            });
            const settings = buildSettingsFixture();
            settings.textgenerationwebui_settings.type = 'openrouter';
            settings.textgenerationwebui_settings.openrouter_model = 'test/openrouter-model';
            writeAllSettings(directories, settings);
            openRouterFakeBackendUrl = backend.url;
            try {
                await assertNonStreamSendStored('nonstream-openrouter-chat', 'Rex answers through OpenRouter.');
            } finally {
                openRouterFakeBackendUrl = null;
                backend.server.close();
                writeAllSettings(directories, buildSettingsFixture());
            }
        });
    }

    await nonStreamReplyCase('llama.cpp, non-streaming, an answer with no readable reply: a warning in the answer, its keys logged without its content', async () => {
        const backend = await startFakeBackend((req, res, body) => {
            const json = (value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const route = (req.url ?? '').split('?')[0];
            if (route === '/props') return json({ model_path: '/models/nonstream.gguf', build_info: 'b-nonstream', default_generation_settings: { n_ctx: 8192 } });
            if (route === '/tokenize') return json({ tokens: String(JSON.parse(body || '{}').content ?? '').split(/(?=\s)/).filter(Boolean).map((_, i) => i) });
            if (route === '/completion') return json({ unexpected_field: 'Secret unreadable reply.' });
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
        pointLlamaCppBackendAt(backend.url);
        const chatName = 'nonstream-unreadable-chat';
        await saveBranch(user.store, { avatar: ownerId }, chatName, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: `Hello there, ${chatName}.`, send_date: 1, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, chatName);
        const logged = [];
        const realWarn = console.warn;
        console.warn = (...args) => { logged.push(args.map(String).join(' ')); };
        let answer;
        try {
            answer = await postGenerate(buildTestApp(), {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: `Question for ${chatName}?` }, stream: false,
            });
        } finally {
            console.warn = realWarn;
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }

        const { status, data } = answer;
        assert.equal(status, 200);
        assert.equal(data.unexpected_field, 'Secret unreadable reply.', 'the answer still reaches the page unchanged');
        assert.equal(data.assistant_node_id, undefined, 'nothing was stored, so no node is named');
        assert.deepEqual(
            data.warnings?.filter(w => w.kind === 'unreadable-reply').map(w => w.message),
            ['The reply came back in a format SillyTavern can\'t read, so it wasn\'t saved.'],
            'the answer carries the unreadable-reply warning',
        );
        const keyLines = logged.filter(line => line.includes('unexpected_field'));
        assert.equal(keyLines.length, 1, `the answer's keys are logged once: ${JSON.stringify(logged)}`);
        assert.equal(logged.some(line => line.includes('Secret unreadable reply.')), false, 'the answer\'s content is never logged');
        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, chatName);
        assert.deepEqual(
            branchAfter.messages.slice(branchBefore.messages.length).map(m => ({ is_user: m.is_user, mes: m.mes })),
            [{ is_user: true, mes: `Question for ${chatName}?` }],
        );
    });

    assert.deepEqual(nonStreamReplyFailures, [], 'non-streaming reply storage cases');

    const storedRefFailures = [];
    /**
     * @param {string} name
     * @param {{ stream: boolean, point: (url: string) => void, handler: (req: any, res: any, body: string) => void }} options
     */
    async function storedRefCase(name, { stream, point, handler }) {
        const chatName = `stored-ref-${name.replace(/\W+/g, '-')}`;
        const backend = await startFakeBackend(handler);
        point(backend.url);
        try {
            await saveBranch(user.store, { avatar: ownerId }, chatName, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: `Hello there, ${chatName}.`, send_date: 1, extra: {} },
            ]);
            const branchBefore = await loadBranch(user.store, { avatar: ownerId }, chatName);
            const ref = `ref-${chatName}`;
            const body = {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: `Question for ${chatName}?` }, user_message_ref: ref, stream,
            };
            let stored;
            if (stream) {
                const { bytes } = await postGenerateStreamBytes(buildTestApp(), body);
                const decoder = new CompactStreamDecoder();
                const events = [...decoder.push(new Uint8Array(bytes)), ...decoder.flush()];
                assert.ok('control' in events[0] && events[0].control.stored, `the first frame is the stored control frame: ${JSON.stringify(events[0])}`);
                stored = events[0].control.stored;
            } else {
                const { data } = await postGenerate(buildTestApp(), body);
                stored = data.stored;
            }
            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(user.store, { avatar: ownerId }, chatName);
                return branch.messages.length === branchBefore.messages.length + 2 ? branch : null;
            });
            const userNode = branchAfter.messages[branchBefore.messages.length];
            assert.equal(userNode.mes, `Question for ${chatName}?`);
            assert.deepEqual(stored, [{ ref, node_id: userNode.node_id }], 'the user message\'s ref is echoed with the node it was stored at');
            console.log(`  pass: ${name}`);
        } catch (error) {
            storedRefFailures.push(name);
            console.log(`  FAIL: ${name}: ${error.message}`);
        } finally {
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    }
    const jsonReply = (value) => (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
    };
    const llamaCppBackend = (answer) => (req, res, body) => {
        const route = (req.url ?? '').split('?')[0];
        res.writeHead(200, { 'Content-Type': route === '/completion' && JSON.parse(body || '{}').stream ? 'text/event-stream' : 'application/json' });
        if (route === '/props') return res.end(JSON.stringify({ model_path: '/models/stored.gguf', build_info: 'b-stored', default_generation_settings: { n_ctx: 8192 } }));
        if (route === '/tokenize') return res.end(JSON.stringify({ tokens: String(JSON.parse(body || '{}').content ?? '').split(/(?=\s)/).filter(Boolean).map((_, i) => i) }));
        if (route === '/completion') return res.end(answer);
        res.end('{}');
    };

    await storedRefCase('generic, non-streaming', { stream: false, point: pointBackendAt, handler: jsonReply({ choices: [{ text: 'Stored reply.' }] }) });
    await storedRefCase('generic, streaming', {
        stream: true, point: pointBackendAt,
        handler: (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(`data: ${JSON.stringify({ choices: [{ text: 'Stored reply.' }] })}\n\ndata: [DONE]\n\n`);
        },
    });
    await storedRefCase('llama.cpp, non-streaming', { stream: false, point: pointLlamaCppBackendAt, handler: llamaCppBackend(JSON.stringify({ content: 'Stored reply.' })) });
    await storedRefCase('llama.cpp, streaming', {
        stream: true, point: pointLlamaCppBackendAt,
        handler: llamaCppBackend(`data: ${JSON.stringify({ content: 'Stored reply.', stop: false })}\n\ndata: ${JSON.stringify({ content: '', stop: true })}\n\n`),
    });
    await storedRefCase('Ollama, streaming', {
        stream: true, point: pointOllamaBackendAt,
        handler: (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            (async () => {
                res.write(JSON.stringify({ response: 'Stored reply.', done: false }));
                await new Promise(resolve => setTimeout(resolve, 5));
                res.end(JSON.stringify({ response: '', done: true }));
            })();
        },
    });

    assert.deepEqual(storedRefFailures, [], 'stored ref cases');

    const storedErrorFailures = [];
    /**
     * @param {string} name
     * @param {{ stream: boolean, point: (url: string) => void, handler?: (req: any, res: any, body: string) => void, expect: (answer: { status: number, headers: Headers, text: string }, stored: object[]) => void }} options
     */
    async function storedErrorCase(name, { stream, point, handler, expect }) {
        const chatName = `stored-error-${name.replace(/\W+/g, '-')}`;
        const backend = handler ? await startFakeBackend(handler) : null;
        point(backend ? backend.url : 'http://127.0.0.1:9');
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
                    type: 'normal', user_message: { is_user: true, name: 'User', mes: `Question for ${chatName}?` }, user_message_ref: ref, stream,
                }),
            });
            const answer = { status: res.status, headers: res.headers, text: await res.text() };
            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, chatName);
            const added = branchAfter.messages.slice(branchBefore.messages.length);
            assert.deepEqual(added.map(m => m.mes), [`Question for ${chatName}?`], 'only the user message was stored');
            const stored = [{ ref, node_id: added[0].node_id }];
            assert.deepEqual(JSON.parse(answer.headers.get('X-ST-Stored') ?? 'null'), stored, `the X-ST-Stored header names the stored user message (status ${answer.status}, body ${answer.text})`);
            expect(answer, stored);
            console.log(`  pass: ${name}`);
        } catch (error) {
            storedErrorFailures.push(name);
            console.log(`  FAIL: ${name}: ${error.message}`);
        } finally {
            backend?.server.close();
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
            writeAllSettings(directories, buildSettingsFixture());
        }
    }
    const backendError = (req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('backend exploded');
    };
    const llamaCppError = (req, res, body) => {
        const route = (req.url ?? '').split('?')[0];
        if (route === '/completion') return backendError(req, res);
        return llamaCppBackend('')(req, res, body);
    };

    await storedErrorCase('generic, non-streaming, backend error (200 error body)', {
        stream: false, point: pointBackendAt, handler: backendError,
        expect: (answer, stored) => {
            assert.equal(answer.status, 200);
            assert.deepEqual(JSON.parse(answer.text), { error: true, status: 500, response: 'backend exploded', stored });
        },
    });
    await storedErrorCase('generic, non-streaming, backend unreachable (catch-all)', {
        stream: false, point: pointBackendAt,
        expect: (answer, stored) => {
            const body = JSON.parse(answer.text);
            assert.equal(body.error, true);
            assert.deepEqual(body.stored, stored);
        },
    });
    await storedErrorCase('generic, streaming, backend error passed on', {
        stream: true, point: pointBackendAt, handler: backendError,
        expect: (answer) => {
            assert.equal(answer.status, 500, 'the backend\'s status is kept');
            assert.equal(answer.text, 'backend exploded', 'the backend\'s body is kept exactly');
        },
    });
    await storedErrorCase('llama.cpp, streaming, backend error passed on', {
        stream: true, point: pointLlamaCppBackendAt, handler: llamaCppError,
        expect: (answer) => {
            assert.equal(answer.status, 500, 'the backend\'s status is kept');
            assert.equal(answer.text, 'backend exploded', 'the backend\'s body is kept exactly');
        },
    });

    assert.deepEqual(storedErrorFailures, [], 'stored error cases');

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'I think you should go north.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;
        const leafBefore = branchBefore.branch.leaf_id;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: leafBefore,
            type: 'impersonate', is_impersonate: true,
            user_message: { is_user: true, name: 'User', mes: 'This should never be persisted.' },
            stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ text: 'I think you should go north.' }] }, 'the generated text still reaches the client unmodified');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no message (user or assistant) was appended for is_impersonate: true');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the branch leaf/ancestor path is completely unchanged');
    }

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'Meta/background result.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;
        const leafBefore = branchBefore.branch.leaf_id;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: leafBefore,
            type: 'quiet',
            user_message: { is_user: true, name: 'User', mes: 'This should never be persisted.' },
            stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ text: 'Meta/background result.' }] }, 'the generated text still reaches the client unmodified');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no message (user or assistant) was appended for type: \'quiet\'');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the branch leaf/ancestor path is completely unchanged');
    }

    {
        const swipeBranch = 'swipe-chat';
        await saveBranch(user.store, { avatar: ownerId }, swipeBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there!', send_date: 2, extra: {} },
        ]);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, swipeBranch);
        const messageCountBefore = branchBefore.messages.length;
        const swipedNodeId = branchBefore.branch.leaf_id;
        const swipedAncestry = (await user.store.chats.load({ tree: await treeOf(user.store, { avatar: ownerId }), at: swipedNodeId })).messages;
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

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, swipeBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'a swipe replaces the leaf position - it does not add DEPTH to the default path');
        assert.notEqual(branchAfter.branch.leaf_id, swipedNodeId, 'the branch is now positioned on a DIFFERENT node - the new alternative');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Greetings, traveler!', '(a) the new alternative is now the active/default path, showing the newly generated text');

        const newNodeId = branchAfter.branch.leaf_id;
        const newAncestry = (await user.store.chats.load({ tree: await treeOf(user.store, { avatar: ownerId }), at: newNodeId })).messages;
        assert.equal(newAncestry.length, swipedAncestry.length, 'the new alternative sits at the SAME depth as the swiped message (a sibling), not one deeper (a child)');
        assert.equal(newAncestry[newAncestry.length - 2].node_id, parentNodeId, 'the new alternative shares the swiped message\'s real parent');

        const alternatives = await user.store.chats.alternatives({ node_id: swipedNodeId });
        assert.equal(alternatives.total, 2, 'the swiped message and the new alternative are now real siblings under the same parent');
        assert.ok(alternatives.alternatives.some(a => a.node_id === swipedNodeId && a.mes === 'Hello there!'), '(b) the swiped message\'s own original content is completely unchanged');
        assert.ok(alternatives.alternatives.some(a => a.node_id === newNodeId && a.mes === 'Greetings, traveler!'));

        const parentAlternatives = await user.store.chats.alternatives({ node_id: newNodeId });
        assert.equal(parentAlternatives.selected, parentAlternatives.alternatives.findIndex(a => a.node_id === newNodeId), 'the new alternative is the one getAlternatives() reports as currently selected');
    }

    {
        const regenBranch = 'regenerate-chat';
        await saveBranch(user.store, { avatar: ownerId }, regenBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, regenerate test.', send_date: 101, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, regenerate test!', send_date: 102, extra: {} },
        ]);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, regenBranch);
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
        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, regenBranch);
        assert.notEqual(branchAfter.branch.leaf_id, swipedNodeId, 'regenerate also produced a sibling alternative, now selected as current');
        const alternatives = await user.store.chats.alternatives({ node_id: swipedNodeId });
        assert.equal(alternatives.total, 2, 'regenerate did not chain a child - the original message still has exactly one real sibling');
    }

    {
        const continueBranch = 'continue-chat';
        await saveBranch(user.store, { avatar: ownerId }, continueBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Tell me a story, Rex.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Once upon a time,', send_date: 2, extra: {} },
        ]);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, continueBranch);
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

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, continueBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no new node (user or assistant) was created - continue only edits the existing leaf');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the SAME node is still the leaf - editMessage() edits in place, it does not reparent/replace the node');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Once upon a time, there was a brave adventurer.', 'the stored text is now oldText + newText, on the same node, at the same position');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].name, 'Rex', 'the edited node keeps its own original speaker, unchanged');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].is_user, false);
    }

    {
        const continueWithUserTextBranch = 'continue-with-user-text-chat';
        await saveBranch(user.store, { avatar: ownerId }, continueWithUserTextBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Tell me a story, Rex.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Once upon a time,', send_date: 2, extra: {} },
        ]);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, continueWithUserTextBranch);
        const messageCountBefore = branchBefore.messages.length;
        const originalLeafId = branchBefore.branch.leaf_id;

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: ' And elves too.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data: body } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: originalLeafId,
            type: 'continue', is_continue: true,
            user_message: { is_user: true, name: 'User', mes: 'Wait, actually - tell me about dragons instead.' },
            stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, continueWithUserTextBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'one message added: the user message, continued in place');
        const newLeaf = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(newLeaf.is_user, true);
        assert.equal(newLeaf.mes, 'Wait, actually - tell me about dragons instead. And elves too.', 'the reply is stored as the continuation of the user message');
        assert.equal(body.assistant_node_id, branchAfter.branch.leaf_id, 'the page is told where the reply was stored');

        const originalNode = (await user.store.chats.alternatives({ node_id: originalLeafId })).alternatives.find(a => a.node_id === originalLeafId);
        assert.equal(originalNode.mes, 'Once upon a time,', 'the assistant message before it is unchanged');
    }

    {
        const nova = await writeCharacter('Nova.png', {
            name: 'Nova',
            description: 'Nova is a stoic starship engineer. Party: {{group}}; awake: {{groupNotMuted}}.',
            data: { name: 'Nova', description: 'Nova is a stoic starship engineer. Party: {{group}}; awake: {{groupNotMuted}}.', first_mes: 'Systems nominal.' },
        });
        const zephyr = await writeCharacter('Zephyr.png', {
            name: 'Zephyr',
            description: 'Zephyr is a chaotic weather spirit.',
            data: { name: 'Zephyr', description: 'Zephyr is a chaotic weather spirit.', first_mes: 'Winds are shifting!' },
        });

        const groupId = 'test-group-1';
        const groupChatId = 'test-group-1-chat';
        const groupMetadata = {
            id: groupId,
            name: 'Adventuring Party',
            members: [nova, zephyr],
            avatar_url: 'img/ai4.png',
            allow_self_responses: false,
            activation_strategy: 0,
            generation_mode: 0,
            disabled_members: [zephyr],
            fav: false,
            chat_id: groupChatId,
            chats: [groupChatId],
            auto_mode_delay: 5,
            generation_mode_join_prefix: '',
            generation_mode_join_suffix: '',
        };
        await user.store.lib.writeGroup(groupMetadata);

        const groupSettings = buildSettingsFixture();
        groupSettings.power_user.context.names_as_stop_strings = true;
        groupSettings.power_user.context.story_string = '{{#if description}}{{description}}\n{{/if}}';
        writeAllSettings(directories, groupSettings);

        await saveBranch(user.store, { group: groupId }, groupChatId, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hello, party!', send_date: 1, extra: {} },
            { name: 'Zephyr', is_user: false, mes: 'Winds are shifting!', send_date: 2, extra: {}, original_avatar: zephyr },
        ]);
        const groupLeafId = (await loadBranch(user.store, { group: groupId }, groupChatId)).branch.leaf_id;

        const builtGroup = await buildRawActionTextCompletionRequest(directories, {
            characterAvatar: nova, groupId, chat: await chatContextOf(user.store, { group: groupId }, await sessionAt(user.store, groupLeafId)), nodeId: groupLeafId,
            type: 'normal', userMessageText: 'Nova, status report?',
            tokenizerOptions: fakeTokenizerOptions,
        });

        assert.equal(builtGroup.name2, 'Nova', 'name2 resolves to the SPECIFIC RESPONDING MEMBER (characterAvatar), not the group\'s own name, even though groupId is also set');
        assert.ok(builtGroup.params.prompt.includes('Nova is a stoic starship engineer.'), 'the assembled prompt reflects the responding member\'s (Nova\'s) own character card');
        assert.ok(builtGroup.params.prompt.includes('Party: Nova, Zephyr; awake: Nova.'), 'the group macros give the members\' names, the muted one only in {{group}}');
        assert.ok(!builtGroup.params.prompt.includes('Zephyr is a chaotic weather spirit.'), 'the assembled prompt does NOT pull in a DIFFERENT member\'s (Zephyr\'s) own character-card description - only Nova\'s, the one actually responding this turn');
        assert.ok(builtGroup.params.prompt.includes('Winds are shifting!'), 'the real group chat HISTORY (including the other member\'s prior turn) is still loaded from the group\'s own owner id');

        const stopStrings = builtGroup.params.stop ?? builtGroup.params.stopping_strings ?? [];
        assert.ok(Array.isArray(stopStrings) && stopStrings.length > 0, 'stop strings were assembled at all');
        assert.ok(stopStrings.some(s => s.includes('Zephyr')), 'namesAsStopStrings-derived stop strings include the NON-responding member (Zephyr) - groupMemberNames covers the whole roster, not just the responding member');
        assert.ok(!stopStrings.some(s => s.includes('Nova')), 'the responding member (Nova/name2) is correctly excluded from the groupMemberNames-derived entries (already covered by the separate name2-specific stop string)');

        const branchBeforeGroup = await loadBranch(user.store, { group: groupId }, groupChatId);
        const messageCountBeforeGroup = branchBeforeGroup.messages.length;

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'All systems nominal, Captain.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: groupId, character_avatar: nova, group_id: groupId, node_id: branchBeforeGroup.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Nova, status report?' }, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the group raw-action generation succeeds');
        assert.equal(data.choices?.[0]?.text, 'All systems nominal, Captain.', 'response body reaches the client unmodified');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const branchAfterGroup = await loadBranch(user.store, { group: groupId }, groupChatId);
        assert.equal(branchAfterGroup.messages.length, messageCountBeforeGroup + 2, 'both the user message and the assistant reply were persisted under the GROUP\'s own owner_id');
        const [userMsg, assistantMsg] = branchAfterGroup.messages.slice(-2);
        assert.equal(userMsg.mes, 'Nova, status report?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'All systems nominal, Captain.');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Nova', 'the persisted assistant message is attributed to the SPECIFIC RESPONDING MEMBER (name2/Nova), not the group\'s own name or the other member (Zephyr)');

        const rexBranchUnaffected = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.ok(rexBranchUnaffected.messages.every(m => m.mes !== 'All systems nominal, Captain.'), 'the group turn did not leak into an unrelated single-character owner namespace');
    }

    {
        const streamBranch = 'stream-plain-chat';
        await saveBranch(user.store, { avatar: ownerId }, streamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const fakeBackend = await startFakeSseBackend(['Rex ', 'says ', 'hello ', 'back, ', 'streamed.']);
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, streamBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, headers, bytes } = await postGenerateStreamBytes(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed.' }, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(headers.get('X-ST-Stream-Format'), 'compact-v1', 'the general raw-action streaming path now declares the compact binary wire format');
        const decoded = decodeCompactStream(bytes);
        assert.equal(decoded.text, 'Rex says hello back, streamed.', 'the decoded compact stream reconstructs the exact text, accumulated across every SSE chunk - not just the last chunk');
        assert.ok(decoded.assistantNodeId, 'the assistant_node_id frame was sent as the final frame');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, streamBranch);
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

    {
        const streamSwipeBranch = 'stream-swipe-chat';
        await saveBranch(user.store, { avatar: ownerId }, streamSwipeBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, streaming swipe test.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, streaming swipe test!', send_date: 2, extra: {} },
        ]);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, streamSwipeBranch);
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
            const branch = await loadBranch(user.store, { avatar: ownerId }, streamSwipeBranch);
            return branch.branch.leaf_id !== swipedNodeId ? branch : null;
        });
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Greetings, traveler, streamed!');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].node_id, decoded.assistantNodeId, 'the node id sent to the client in the compact stream\'s assistant_node_id frame is the exact node the swipe actually landed on');
        const alternatives = await user.store.chats.alternatives({ node_id: swipedNodeId });
        assert.equal(alternatives.total, 2, 'the streamed swipe produced a real sibling alternative, not a chained child');
        assert.ok(alternatives.alternatives.some(a => a.mes === 'Hello there, streaming swipe test!'), 'the original swiped message is unchanged');
    }

    {
        const streamContinueBranch = 'stream-continue-chat';
        await saveBranch(user.store, { avatar: ownerId }, streamContinueBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Tell me a streaming story, Rex.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Once upon a streaming time,', send_date: 2, extra: {} },
        ]);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, streamContinueBranch);
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
            const branch = await loadBranch(user.store, { avatar: ownerId }, streamContinueBranch);
            const leaf = branch.messages[branch.messages.length - 1];
            return leaf.mes === 'Once upon a streaming time, there was a brave, streamed adventurer.' ? branch : null;
        });
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no new node was created - the streamed continue only edited the existing leaf');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the SAME node is still the leaf');
    }

    {
        const ollamaBranch = 'stream-ollama-chat';
        await saveBranch(user.store, { avatar: ownerId }, ollamaBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const ollamaChunks = ['Hello ', 'from ', 'Ollama, ', 'streamed.'];
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            (async () => {
                for (const text of ollamaChunks) {
                    res.write(JSON.stringify({ response: text, done: false }));
                    await new Promise(resolve => setTimeout(resolve, 5));
                }
                res.end(JSON.stringify({ response: '', done: true }));
            })();
        });
        pointOllamaBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, ollamaBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, headers, bytes } = await postGenerateStreamBytes(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi via Ollama.' }, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(headers.get('X-ST-Stream-Format'), 'compact-v1', 'Ollama\'s raw-action stream now declares the same compact binary wire format as every other backend');
        const decoded = decodeCompactStream(bytes);
        assert.equal(decoded.text, ollamaChunks.join(''), 'the compact-format content frames reaching the client are exactly the concatenated Ollama chunks, with no empty trailing frame for the final done:true sentinel');
        assert.ok(decoded.assistantNodeId, 'the assistant_node_id frame was sent as the final frame');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, ollamaBranch);
            return branch.messages.length === messageCountBefore + 2 ? branch : null;
        });
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi via Ollama.');
        assert.equal(assistantMsg.mes, 'Hello from Ollama, streamed.', 'the full text, accumulated across every Ollama JSON-lines chunk, was persisted');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex');
        assert.equal(assistantMsg.node_id, decoded.assistantNodeId, 'the node id sent to the client in the compact stream\'s assistant_node_id frame is the exact node the reply actually landed on');
    }

    {
        const llamaCppBranch = 'stream-llamacpp-chat';
        await saveBranch(user.store, { avatar: ownerId }, llamaCppBranch, [
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

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, llamaCppBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, bytes } = await postGenerateStreamBytes(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi via llama.cpp.' }, stream: true, itemization: { presetName: 'Page preset', rawPrompt: 'page' },
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        const decoded = decodeCompactStream(bytes);
        assert.equal(decoded.text, llamaCppChunks.join(''), 'the decoded compact stream reconstructs the exact concatenated content, unaffected by the persistence addition');
        assert.equal(decoded.itemization, null, 'the itemization isn\'t sent down the stream');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, llamaCppBranch);
            return branch.messages.length === messageCountBefore + 2 ? branch : null;
        });
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi via llama.cpp.');
        assert.equal(assistantMsg.mes, 'Hello from llama.cpp, streamed.', 'the full text, accumulated across every compact-stream event, was persisted');
        assert.equal(assistantMsg.name, 'Rex');
        const stored = /** @type {any} */ (await user.store.chats.readItemization({ node_id: assistantMsg.node_id }));
        assert.equal(stored?.entry.api, 'textgenerationwebui', 'the server stores the itemization of the prompt it built');
        assert.equal(stored.entry.presetName, undefined, 'none of what the page sends is stored');
        assert.ok(String(stored.entry.rawPrompt).includes('Say hi via llama.cpp.'), 'its prompt as sent');
        assert.equal(stored.entry.sampler_config.prompt, undefined, 'its parameters without the prompt');
        assert.ok(stored.entry.total > 0 && stored.entry.parts.some((/** @type {any} */ p) => p.part === 'chat_history' && p.tokens > 0), 'its parts counted');
        assert.equal(stored.entry.parts.some((/** @type {any} */ p) => p.part === 'post_history'), false, 'no post-history instructions were set, so none is listed');
    }

    {
        const fakeBackend = await startFakeSseBackend(['This ', 'is ', 'a ', 'plain ', 'legacy ', 'stream.']);
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, headers, bytes } = await postGenerateStreamBytes(app, {
            prompt: 'Legacy raw prompt, no raw-action fields.', stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(headers.get('x-st-stream-format'), 'compact-v1', 'a non-raw-action stream is now also re-encoded into the compact binary wire format');
        const decoded = decodeCompactStream(bytes);
        assert.equal(decoded.text, 'This is a plain legacy stream.');
        assert.equal(decoded.assistantNodeId, null, 'nothing is persisted for a non-raw-action stream, so no assistant_node_id frame is emitted');
    }

    {
        const coalesceBranch = 'stream-compact-coalesce-chat';
        await saveBranch(user.store, { avatar: ownerId }, coalesceBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, coalesceBranch);

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
                    type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Coalesce test.' }, stream: true,
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
            const branch = await loadBranch(user.store, { avatar: ownerId }, coalesceBranch);
            const leaf = branch.messages[branch.messages.length - 1];
            return leaf.mes === textChunks.join('').trim() ? branch : null;
        });
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].node_id, decoded.assistantNodeId);
    }

    {
        const disconnectBranch = 'stream-compact-disconnect-chat';
        await saveBranch(user.store, { avatar: ownerId }, disconnectBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, disconnectBranch);

        let releaseStream = () => { };
        const streamGate = new Promise(resolve => { releaseStream = resolve; });
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ choices: [{ text: 'Partial before disconnect.' }] })}\n\n`);
            streamGate.then(() => {
                try {
                    res.write(`data: ${JSON.stringify({ choices: [{ text: ' Still generated after disconnect.' }] })}\n\n`);
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
                    type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Disconnect me, Rex.' }, stream: true,
                }),
                signal: controller.signal,
            });
            assert.equal(res.headers.get('X-ST-Stream-Format'), 'compact-v1');

            const reader = res.body.getReader();
            const { value: firstChunk } = await reader.read();
            assert.ok(firstChunk && firstChunk.length > 0, 'a real chunk was received before the client disconnects, proving generation was genuinely underway');

            controller.abort();
            releaseStream();
        } finally {
            fakeBackend.server.close();
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, disconnectBranch);
            const leaf = branch.messages[branch.messages.length - 1];
            return leaf?.mes === 'Partial before disconnect. Still generated after disconnect.' ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Partial before disconnect. Still generated after disconnect.', 'the full text - including what the backend generated AFTER the client disconnected - was persisted, since the upstream generation is no longer aborted on disconnect');
    }

    {
        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'This should be rejected.' }, stream: false,
        });
        assert.equal(status, 400, 'a request body with no node_id key at all is a real 400, not a silent guess');
        assert.match(data.message, /node_id is required/, 'the error names the real, specific problem');
    }

    {
        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: null,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'This should also be rejected.' }, stream: false,
        });
        assert.equal(status, 400, 'node_id: null on an owner with real existing history is a real 400');
        assert.match(data.message, /is not at its start/, 'the error explains why null was rejected here');
    }

    {
        fs.writeFileSync(path.join(directories.files, 'raw-action-attach.txt'), 'The password is hunter2.');

        let capturedRequestBody = null;
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            capturedRequestBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'Got your file.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', stream: false,
            user_message: { is_user: true, name: 'User', mes: 'Check the attached file.', extra: { files: [{ url: '/user/files/raw-action-attach.txt', size: 25, name: 'raw-action-attach.txt', created: 1700000000000 }] } },
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.ok(capturedRequestBody, 'the fake backend actually received a request');
        const promptField = JSON.stringify(capturedRequestBody);
        assert.ok(
            promptField.includes('The password is hunter2.'),
            'the real file-attachment content, resolved via the forwarded user_message_extra reference, was inlined into the prompt actually sent to the backend',
        );

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const persistedUserMsg = branchAfter.messages[branchAfter.messages.length - 2];
        assert.equal(persistedUserMsg.mes, 'Check the attached file.');
        assert.deepEqual(
            persistedUserMsg.extra,
            { files: [{ url: '/user/files/raw-action-attach.txt', size: 25, name: 'raw-action-attach.txt', created: 1700000000000 }] },
            'the persisted user message node carries the (sanitized) forwarded extra',
        );
    }

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'Fine either way.' }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', stream: false,
            user_message: { is_user: true, name: 'User', mes: 'This has a garbage attachment payload.', extra: {
                evil_script: '<script>alert(1)</script>',
                files: [{ url: 12345, name: 'not-a-real-url.txt' }],
                media: [{ url: '/user/files/whatever.png', type: 'application/x-not-a-real-media-type' }],
                media_index: 'not-a-number',
                inline_image: 'yes',
            } },
        });
        fakeBackend.server.close();
        assert.equal(status, 200, 'a garbage-shaped extra does not crash the request');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const persistedUserMsg = branchAfter.messages[branchAfter.messages.length - 2];
        assert.equal(persistedUserMsg.mes, 'This has a garbage attachment payload.');
        assert.equal(persistedUserMsg.extra.evil_script, '<script>alert(1)</script>', 'the message is stored as the page sent it; only the prompt reads its attachments, through the allowlist');
    }

    {
        const dupAvatar = await writeCharacter('DupBug.png', {
            name: 'DupBug',
            data: { name: 'DupBug', description: '', first_mes: 'Hi.' },
        });
        const dupOwnerId = dupAvatar;
        const dupBranchName = 'dup-bug-chat';
        await saveBranch(user.store, { avatar: dupOwnerId }, dupBranchName, [
            { chat_metadata: {} },
            { name: 'DupBug', is_user: false, mes: 'Hi.', send_date: 1, extra: {} },
        ]);
        const dupBranchInfo = await loadBranch(user.store, { avatar: dupOwnerId }, dupBranchName);
        const dupParentLeafId = dupBranchInfo.branch.leaf_id;

        const clientSideAppend = await appendThrough(dupOwnerId, dupParentLeafId, [
            { name: 'Tester', is_user: true, mes: 'What happens next?', persona: 'user-default.png', extra: {}, send_date: Date.now() },
        ]);
        assert.equal(clientSideAppend.ok, true);

        const dupBuilt = await buildRawActionTextCompletionRequest(directories, {
            characterAvatar: dupAvatar, chat: await chatOf(dupAvatar, dupParentLeafId), nodeId: dupParentLeafId,
            type: 'normal', userMessageText: 'What happens next?',
            tokenizerOptions: fakeTokenizerOptions,
        });
        assert.equal(dupBuilt.anchorNodeId, dupParentLeafId, 'the raw-action route resolves the SAME pre-existing leaf as its anchor - not the client\'s just-appended node - reproducing the real concurrent-append shape');

        const serverSideAppend = await appendThrough(dupOwnerId, dupBuilt.anchorNodeId, [
            { name: dupBuilt.name1, is_user: true, mes: 'What happens next?', extra: {}, send_date: Date.now() },
        ]);
        assert.equal(serverSideAppend.ok, true);

        assert.notEqual(
            clientSideAppend.node_ids[0], serverSideAppend.node_ids[0],
            'ORIGINAL BUG reproduced: the persona-keyed (client) and name-keyed (server) identity hashes differ, so the server\'s own re-append does NOT converge onto the client\'s already-persisted node - it creates a genuine duplicate sibling instead',
        );
        const dupAlternatives = await user.store.chats.alternatives({ node_id: clientSideAppend.node_ids[0] });
        assert.equal(dupAlternatives.total, 2, 'ORIGINAL BUG: two sibling user-message nodes now exist under the same parent for what a user experiences as one single message send');

        const fixedAvatar = await writeCharacter('FixedBug.png', {
            name: 'FixedBug',
            data: { name: 'FixedBug', description: '', first_mes: 'Hi.' },
        });
        const fixedOwnerId = fixedAvatar;
        const fixedBranchName = 'fixed-bug-chat';
        await saveBranch(user.store, { avatar: fixedOwnerId }, fixedBranchName, [
            { chat_metadata: {} },
            { name: 'FixedBug', is_user: false, mes: 'Hi.', send_date: 1, extra: {} },
        ]);
        const fixedBranchInfo = await loadBranch(user.store, { avatar: fixedOwnerId }, fixedBranchName);
        const fixedParentLeafId = fixedBranchInfo.branch.leaf_id;

        const fixedBuilt = await buildRawActionTextCompletionRequest(directories, {
            characterAvatar: fixedAvatar, chat: await chatOf(fixedAvatar, fixedParentLeafId), nodeId: fixedParentLeafId,
            type: 'normal', userMessageText: 'What happens next?',
            tokenizerOptions: fakeTokenizerOptions,
        });
        const onlyAppend = await appendThrough(fixedOwnerId, fixedBuilt.anchorNodeId, [
            { name: fixedBuilt.name1, is_user: true, mes: 'What happens next?', extra: {}, send_date: Date.now() },
        ]);
        assert.equal(onlyAppend.ok, true);
        const fixedAlternatives = await user.store.chats.alternatives({ node_id: onlyAppend.node_ids[0] });
        assert.equal(fixedAlternatives.total, 1, 'THE FIX: exactly one user-message node exists for one logical send once the client no longer makes its own redundant, differently-keyed append');
    }

    const tokenizerCaseFailures = [];
    async function tokenizerCase(name, fn) {
        try {
            await fn();
            console.log(`  pass: ${name}`);
        } catch (error) {
            tokenizerCaseFailures.push(name);
            console.log(`  FAIL: ${name}: ${error.message}`);
        }
    }

    await tokenizerCase('raw-action generation, unmapped model: bans and bias needing ids dropped and listed', async () => {
        const entryAvatar = await writeCharacter('EntryDrop.png', { name: 'EntryDrop', data: { name: 'EntryDrop', first_mes: 'Hi.' } });
        await saveBranch(user.store, { avatar: entryAvatar }, 'entry-drop-chat', [
            { chat_metadata: {} },
            { name: 'EntryDrop', is_user: false, mes: 'Hi.', send_date: 1, extra: {} },
        ]);
        const entryBranch = await loadBranch(user.store, { avatar: entryAvatar }, 'entry-drop-chat');

        let backendBody = null;
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            backendBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'ok' }] }));
        });
        const settings = buildSettingsFixture();
        settings.power_user.tokenizer = 99;
        Object.assign(settings.textgenerationwebui_settings, {
            server_urls: { generic: fakeBackend.url },
            send_banned_tokens: true,
            banned_tokens: 'forbidden\n"quoted phrase"\n[7,8]',
            logit_bias: [{ id: 'a', text: 'hello', value: -5 }, { id: 'b', text: '[11]', value: 2 }],
        });
        writeAllSettings(directories, settings);

        const llamaBefore = llamaEncodes().length;
        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: entryAvatar, character_avatar: entryAvatar, node_id: entryBranch.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Go on.' }, stream: false,
        });
        fakeBackend.server.close();
        const built = await buildRawActionTextCompletionRequest(directories, {
            characterAvatar: entryAvatar, chat: await chatOf(entryAvatar, entryBranch.branch.leaf_id), nodeId: entryBranch.branch.leaf_id,
            type: 'continue', isContinue: true,
        });
        writeAllSettings(directories, buildSettingsFixture());

        assert.equal(status, 200);
        assert.equal(llamaEncodes().length, llamaBefore, 'no llama encode');
        assert.deepEqual(backendBody.logit_bias, { 11: 2 });
        assert.equal(built.params.custom_token_bans, '7,8');
        assert.deepEqual(built.params.banned_strings, ['quoted phrase']);
        const dropped = (data.warnings ?? []).filter(w => w.kind === 'dropped');
        assert.equal(dropped.length, 1);
        assert.deepEqual(dropped[0].entries, ['forbidden', 'hello']);
        assert.deepEqual(built.warnings.map(w => w.entries), [['forbidden', 'hello']]);
    });

    await tokenizerCase('over budget on an unmapped model: trimmed by the estimate, silently', async () => {
        const trimAvatar = await writeCharacter('TrimEst.png', { name: 'TrimEst', data: { name: 'TrimEst', first_mes: 'Hi.' } });
        const line = 'abcdefghij'.repeat(20);
        const history = Array.from({ length: 40 }, (_, i) => ({ name: i % 2 ? 'Tester' : 'TrimEst', is_user: i % 2 === 1, mes: `m${String(i).padStart(2, '0')} ${line}`, send_date: i + 1, extra: {} }));
        await saveBranch(user.store, { avatar: trimAvatar }, 'trim-chat', [{ chat_metadata: {} }, ...history]);
        const trimBranch = await loadBranch(user.store, { avatar: trimAvatar }, 'trim-chat');

        const settings = buildSettingsFixture();
        settings.power_user.tokenizer = 99;
        settings.max_context = 1400;
        writeAllSettings(directories, settings);

        let localEncodes = 0;
        const built = await buildRawActionTextCompletionRequest(directories, {
            characterAvatar: trimAvatar, chat: await chatOf(trimAvatar, trimBranch.branch.leaf_id), nodeId: trimBranch.branch.leaf_id,
            type: 'continue', isContinue: true,
            tokenizerOptions: { encodeLocal: async (_key, text) => { localEncodes++; return Array.from(String(text)); } },
        });
        writeAllSettings(directories, buildSettingsFixture());

        const kept = history.filter(m => built.params.prompt.includes(m.mes.slice(0, 4)));
        assert.equal(localEncodes, 0, 'counted without a tokenizer');
        assert.ok(!built.params.prompt.includes('m00 '), 'the oldest message is trimmed');
        assert.ok(built.params.prompt.includes('m39 '), 'the newest message is kept');
        assert.ok(kept.length >= 15, `trimmed by the estimate, not per character (kept ${kept.length})`);
        assert.deepEqual((built.warnings ?? null), [], 'no warnings: estimate trims are silent');
    });

    async function startFailingTokenizeLlamaCpp(reply) {
        const paths = [];
        const backend = await startFakeBackend((req, res) => {
            paths.push(req.url);
            if (req.url === '/tokenize') {
                res.writeHead(500);
                res.end('tokenize failed');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ content: reply, stop: false })}\n\n`);
            res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
        });
        return { ...backend, paths };
    }

    await tokenizerCase('raw-action stream, /tokenize failing, gemma-2 model: gemma copy for single fields, the estimate for counts that begin the prompt, no llama', async () => {
        const failAvatar = await writeCharacter('TokenizeFail.png', { name: 'TokenizeFail', data: { name: 'TokenizeFail', first_mes: 'Hi.' } });
        await saveBranch(user.store, { avatar: failAvatar }, 'tokenize-fail-chat', [
            { chat_metadata: {} },
            { name: 'TokenizeFail', is_user: false, mes: 'Hi.', send_date: 1, extra: {} },
        ]);
        const failBranch = await loadBranch(user.store, { avatar: failAvatar }, 'tokenize-fail-chat');

        const backend = await startFailingTokenizeLlamaCpp('ok');
        const settings = buildSettingsFixture();
        settings.power_user.tokenizer = 99;
        Object.assign(settings.textgenerationwebui_settings, {
            type: 'llamacpp',
            llamacpp_model: 'gemma-2-9b-it',
            server_urls: { llamacpp: backend.url },
            logit_bias: [{ id: 'a', text: 'hello', value: -5 }],
        });
        writeAllSettings(directories, settings);

        const llamaBefore = llamaEncodes().length;
        const gemmaBefore = sentencepieceEncodes.filter(file => /[\\/]gemma\.model$/.test(file ?? '')).length;
        const { status, bytes } = await postGenerateStreamBytes(buildTestApp(), {
            owner_id: failAvatar, character_avatar: failAvatar, node_id: failBranch.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Go on.' }, stream: true,
        });
        backend.server.close();
        writeAllSettings(directories, buildSettingsFixture());

        assert.equal(status, 200);
        assert.ok(backend.paths.includes('/tokenize'), 'the remote tokenizer was tried');
        assert.equal(llamaEncodes().length, llamaBefore, 'no llama encode');
        assert.ok(sentencepieceEncodes.filter(file => /[\\/]gemma\.model$/.test(file ?? '')).length > gemmaBefore, 'encoded with the gemma copy');
        const decoded = decodeCompactStream(bytes);
        assert.equal(decoded.text, 'ok');
        assert.deepEqual(decoded.warnings.map(w => w.kind), ['fallback-copy', 'trim-estimate']);
        assert.ok(decoded.warnings[0].message.includes('Gemma'), decoded.warnings[0].message);
    });

    await tokenizerCase('raw-action stream, /tokenize failing, unmapped model over budget: trim-estimate and dropped in the control frame', async () => {
        const trimAvatar = await writeCharacter('TokenizeFailTrim.png', { name: 'TokenizeFailTrim', data: { name: 'TokenizeFailTrim', first_mes: 'Hi.' } });
        const line = 'abcdefghij'.repeat(20);
        const history = Array.from({ length: 40 }, (_, i) => ({ name: i % 2 ? 'Tester' : 'TokenizeFailTrim', is_user: i % 2 === 1, mes: `m${String(i).padStart(2, '0')} ${line}`, send_date: i + 1, extra: {} }));
        await saveBranch(user.store, { avatar: trimAvatar }, 'tokenize-fail-trim-chat', [{ chat_metadata: {} }, ...history]);
        const trimBranch = await loadBranch(user.store, { avatar: trimAvatar }, 'tokenize-fail-trim-chat');

        const backend = await startFailingTokenizeLlamaCpp('ok');
        const settings = buildSettingsFixture();
        settings.power_user.tokenizer = 99;
        settings.max_context = 1400;
        Object.assign(settings.textgenerationwebui_settings, {
            type: 'llamacpp',
            llamacpp_model: 'some-unheard-of-model',
            server_urls: { llamacpp: backend.url },
            logit_bias: [{ id: 'a', text: 'hello', value: -5 }],
        });
        writeAllSettings(directories, settings);

        const llamaBefore = llamaEncodes().length;
        const { status, bytes } = await postGenerateStreamBytes(buildTestApp(), {
            owner_id: trimAvatar, character_avatar: trimAvatar, node_id: trimBranch.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Go on.' }, stream: true,
        });
        backend.server.close();
        writeAllSettings(directories, buildSettingsFixture());

        assert.equal(status, 200);
        assert.equal(llamaEncodes().length, llamaBefore, 'no llama encode');
        const decoded = decodeCompactStream(bytes);
        assert.deepEqual(decoded.warnings.map(w => w.kind), ['trim-estimate', 'dropped']);
        assert.deepEqual(decoded.warnings[1].entries, ['hello']);
    });

    await tokenizerCase('raw-action on llama.cpp: the count of what\'s always sent begins the prompt and sends add_special: true, a message counts upstream\'s request', async () => {
        const bosAvatar = await writeCharacter('BosCount.png', { name: 'BosCount', data: { name: 'BosCount', description: 'BosCount tells stories.', first_mes: 'Hi.' } });
        await saveBranch(user.store, { avatar: bosAvatar }, 'bos-chat', [
            { chat_metadata: {} },
            { name: 'BosCount', is_user: false, mes: 'Hi.', send_date: 1, extra: {} },
            { name: 'Tester', is_user: true, mes: 'Tell me one.', send_date: 2, extra: {} },
        ]);
        const bosBranch = await loadBranch(user.store, { avatar: bosAvatar }, 'bos-chat');

        const tokenizeBodies = [];
        const backend = await startFakeBackend((req, res, body) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (req.url === '/tokenize') {
                const parsed = JSON.parse(body);
                tokenizeBodies.push(parsed);
                return res.end(JSON.stringify({ tokens: Array.from(Buffer.from(parsed.content), (_, i) => i) }));
            }
            res.end('{}');
        });
        const settings = buildSettingsFixture();
        settings.power_user.tokenizer = 99;
        Object.assign(settings.textgenerationwebui_settings, {
            type: 'llamacpp',
            llamacpp_model: 'gemma-2-9b-it',
            server_urls: { llamacpp: backend.url },
        });
        writeAllSettings(directories, settings);

        const built = await buildRawActionTextCompletionRequest(directories, {
            request: /** @type {any} */ ({ body: { api_type: 'llamacpp' }, user: { directories } }),
            characterAvatar: bosAvatar, chat: await chatOf(bosAvatar, bosBranch.branch.leaf_id), nodeId: bosBranch.branch.leaf_id,
            type: 'continue', isContinue: true,
        });
        backend.server.close();
        writeAllSettings(directories, buildSettingsFixture());

        const promptStart = tokenizeBodies.filter(body => body.add_special === true);
        const fields = tokenizeBodies.filter(body => !('add_special' in body));
        assert.equal(promptStart.length + fields.length, tokenizeBodies.length, 'add_special is only ever true');
        assert.deepEqual(promptStart.map(body => body.content), ['Tester: Tell me one.'], 'what\'s always sent (here the message being continued) is counted once, as the prompt\'s start');
        assert.deepEqual(fields, [{ model: 'gemma-2-9b-it', content: 'BosCount: Hi.\n' }], 'a message is counted with upstream\'s { model, content }');
        assert.ok(built.params.prompt.endsWith('Tell me one.'));
        assert.deepEqual(built.warnings ?? [], []);
    });

    async function startPropsLlamaCpp({ props, modelsId = 'from-v1-models', failTokenize = false }) {
        const requests = [];
        const backend = await startFakeBackend((req, res, body) => {
            requests.push({ url: req.url, headers: req.headers, body });
            if (req.url.startsWith('/props')) {
                res.writeHead(props ? 200 : 500, { 'Content-Type': 'application/json' });
                return res.end(props ? JSON.stringify(props) : '{}');
            }
            if (req.url === '/v1/models') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ data: [{ id: modelsId }] }));
            }
            if (req.url === '/tokenize' && !failTokenize) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ tokens: Array.from(Buffer.from(JSON.parse(body).content), (_, i) => i) }));
            }
            res.writeHead(500);
            res.end('no');
        });
        return { ...backend, requests, urls: () => requests.map(r => r.url) };
    }

    let propsChats = 0;
    async function buildOnPropsLlamaCpp(backend, model) {
        const name = `PropsCheck${++propsChats}`;
        const avatar = await writeCharacter(`${name}.png`, { name, data: { name, first_mes: 'Hi.' } });
        await saveBranch(user.store, { avatar: avatar }, 'props-chat', [
            { chat_metadata: {} },
            { name, is_user: false, mes: 'Hi.', send_date: 1, extra: {} },
            { name: 'Tester', is_user: true, mes: 'Tell me one.', send_date: 2, extra: {} },
        ]);
        const branch = await loadBranch(user.store, { avatar: avatar }, 'props-chat');
        const settings = buildSettingsFixture();
        settings.power_user.tokenizer = 99;
        Object.assign(settings.textgenerationwebui_settings, {
            type: 'llamacpp',
            llamacpp_model: model,
            server_urls: { llamacpp: backend.url },
        });
        writeAllSettings(directories, settings);
        try {
            return await buildRawActionTextCompletionRequest(directories, {
                request: /** @type {any} */ ({ body: { api_type: 'llamacpp' }, user: { directories } }),
                characterAvatar: avatar, chat: await chatOf(avatar, branch.branch.leaf_id), nodeId: branch.branch.leaf_id,
                type: 'continue', isContinue: true,
            });
        } finally {
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    await tokenizerCase('raw-action on llama.cpp, /props with model_alias: one /props, no /v1/models, identity from model_path and build_info', async () => {
        const props = { model_alias: 'gemma-2-9b-it', model_path: '/models/gemma-2-9b-it-Q4_K_M.gguf', build_info: 'b4000-abc' };
        const backend = await startPropsLlamaCpp({ props });
        const built = await buildOnPropsLlamaCpp(backend, '');
        assert.deepEqual(backend.urls().filter(url => url.startsWith('/props') || url === '/v1/models'), ['/props']);
        assert.equal(built.tokenizerIdentity, `llamacpp:${JSON.stringify([props.model_path, props.build_info])}`);
    });

    await tokenizerCase('raw-action on llama.cpp, a model setting (router mode): one /props?model=, with the llama.cpp key, no /v1/models', async () => {
        writeSecret(directories, SECRET_KEYS.LLAMACPP, 'props-llamacpp-key');
        const backend = await startPropsLlamaCpp({ props: { model_path: '/m/a.gguf', build_info: 'b1' } });
        try {
            await buildOnPropsLlamaCpp(backend, 'gemma 2');
        } finally {
            deleteSecret(directories, SECRET_KEYS.LLAMACPP);
        }
        const asked = backend.requests.filter(r => r.url.startsWith('/props') || r.url === '/v1/models');
        assert.deepEqual(asked.map(r => r.url), ['/props?model=gemma%202']);
        assert.equal(asked[0].headers.authorization, 'Bearer props-llamacpp-key');
    });

    await tokenizerCase('raw-action on llama.cpp, /props without model_alias: /v1/models too, and the map gets its name', async () => {
        const backend = await startPropsLlamaCpp({ props: { model_path: '/models/x.gguf', build_info: 'b1' }, modelsId: 'gemma-2-9b-it', failTokenize: true });
        const built = await buildOnPropsLlamaCpp(backend, '');
        assert.deepEqual(backend.urls().filter(url => url.startsWith('/props') || url === '/v1/models'), ['/props', '/v1/models']);
        const copy = built.warnings.find(w => w.kind === 'fallback-copy');
        assert.ok(copy?.message.includes('Gemma'), 'the gemma copy, from the /v1/models name');
    });

    await tokenizerCase('raw-action on llama.cpp, model_alias equal to model_path: the map gets the file name after the last /', async () => {
        const modelPath = '/models/Meta-Llama-3-8B-Instruct/gemma-2-9b-it.gguf';
        const backend = await startPropsLlamaCpp({ props: { model_alias: modelPath, model_path: modelPath, build_info: 'b1' }, failTokenize: true });
        const built = await buildOnPropsLlamaCpp(backend, '');
        assert.deepEqual(backend.urls().filter(url => url.startsWith('/props') || url === '/v1/models'), ['/props']);
        const copy = built.warnings.find(w => w.kind === 'fallback-copy');
        assert.ok(copy?.message.includes('Gemma'), 'the gemma copy, from gemma-2-9b-it.gguf');
    });

    await tokenizerCase('raw-action on llama.cpp, /props failing: no identity, so nothing stored is read or written', async () => {
        const backend = await startPropsLlamaCpp({ props: null });
        const built = await buildOnPropsLlamaCpp(backend, 'gemma-2-9b-it');
        assert.deepEqual(backend.urls().filter(url => url.startsWith('/props')), ['/props?model=gemma-2-9b-it']);
        assert.equal(built.tokenizerIdentity, null);
        assert.ok(backend.urls().includes('/tokenize'), 'counts still go to /tokenize');
    });

    await tokenizerCase('raw-action on llama.cpp: stored counts and ids answer an unchanged chat, an edit recounts only its text, a new build_info recounts everything', async () => {
        const name = 'StoreCheck';
        const avatar = await writeCharacter(`${name}.png`, {
            name,
            data: {
                name, description: 'StoreCheck keeps the old lighthouse.', first_mes: 'Welcome.',
                mes_example: '<START>\n{{user}}: What do you keep?\n{{char}}: The light, always.',
            },
        });
        importWorldInfoFromRaw(directories, 'StoreLore', JSON.stringify({
            entries: {
                1: { uid: 1, key: ['lighthouse'], keysecondary: [], comment: '', content: 'The lighthouse stands on a black rock.', constant: false, selective: false, order: 10, position: 0, disable: false },
            },
        }));
        const lines = [
            [name, 'Welcome.'],
            ['Tester', 'Is this the lighthouse?'],
            [name, 'It is, and it has stood for a century.'],
            ['Tester', 'Who built it?'],
            [name, 'My grandfather, stone by stone.'],
            ['Tester', 'Does the lamp still turn?'],
            [name, 'Every night, without fail.'],
            ['Tester', 'May I climb the stairs?'],
            [name, 'Mind the loose step near the top.'],
            ['Tester', 'I will be careful.'],
        ];
        await saveBranch(user.store, { avatar: avatar }, 'store-chat', [
            { chat_metadata: {} },
            ...lines.map(([speaker, mes], i) => ({ name: speaker, is_user: speaker === 'Tester', mes, send_date: i + 1, extra: {} })),
        ]);
        const branch = await loadBranch(user.store, { avatar: avatar }, 'store-chat');
        assert.equal(branch.messages.length, 10);

        const props = { model_alias: 'tokenstore-model', model_path: '/models/tokenstore-model.gguf', build_info: 'b1-store' };
        const backend = await startPropsLlamaCpp({ props });
        const tokenizeBodies = () => backend.requests.filter(r => r.url === '/tokenize').map(r => JSON.parse(r.body));
        const settings = buildSettingsFixture();
        settings.power_user.tokenizer = 99;
        settings.power_user.context = { story_string: '{{wiBefore}}\n{{description}}\n{{wiAfter}}' };
        settings.world_info_settings = {
            world_info: { globalSelect: ['StoreLore'], charLore: [] },
            world_info_depth: 10,
            world_info_budget: 100,
        };
        Object.assign(settings.textgenerationwebui_settings, {
            type: 'llamacpp',
            llamacpp_model: '',
            server_urls: { llamacpp: backend.url },
            send_banned_tokens: true,
            banned_tokens: 'forbidden\nbanished',
            logit_bias: [{ id: 'a', text: 'hello', value: -5 }],
        });
        writeAllSettings(directories, settings);

        const keyOf = body => JSON.stringify([body.content, body.add_special ?? null]);
        const generate = async () => {
            const start = tokenizeBodies().length;
            const leaf = (await loadBranch(user.store, { avatar: avatar }, 'store-chat')).branch.leaf_id;
            const built = await buildRawActionTextCompletionRequest(directories, {
                request: /** @type {any} */ ({ body: { api_type: 'llamacpp' }, user: { directories } }),
                characterAvatar: avatar, chat: await chatOf(avatar, leaf), nodeId: leaf, type: 'normal',
            });
            return { built, sent: tokenizeBodies().slice(start) };
        };

        try {
            const first = await generate();
            assert.ok(first.sent.length > 0, 'the first generation tokenizes');
            assert.ok(first.built.params.prompt.includes('The lighthouse stands on a black rock.'), 'the world info entry activated');
            assert.ok(first.built.params.prompt.includes('The light, always.'), 'the example messages are in the prompt');
            assert.ok(first.sent.some(body => body.content.includes('forbidden')), 'a banned string was encoded');
            assert.ok(first.sent.some(body => body.content.includes('hello')), 'the bias entry was encoded');
            await writeBack(directories, first.built.tokenCountRows);

            const firstKeys = new Set(first.sent.map(keyOf));
            const second = await generate();
            assert.deepEqual(second.sent.filter(body => firstKeys.has(keyOf(body))), [], 'no text tokenized in the first generation is tokenized again');
            assert.deepEqual(second.built.params, first.built.params, 'the same prompt, banned token ids and logit bias');

            props.build_info = 'b2-store';
            const rebuilt = await generate();
            assert.deepEqual(new Set(rebuilt.sent.map(keyOf)), firstKeys, 'the same (content, add_special) as the first generation');
            assert.deepEqual(rebuilt.built.params, first.built.params);
            props.build_info = 'b1-store';

            await writeBack(directories, second.built.tokenCountRows);
            const edited = branch.messages[4];
            const newText = 'My grandmother, stone by patient stone.';
            const editResult = await editMessage(user.store, { avatar: avatar }, edited.node_id, { ...edited, mes: newText });
            assert.equal(editResult.ok, true, editResult.reason);
            const afterEdit = await generate();
            assert.ok(afterEdit.sent.length > 0, 'the edited text is tokenized');
            assert.deepEqual(afterEdit.sent.filter(body => !body.content.includes(newText)).map(body => body.content), [],
                'every /tokenize holds the edited message\'s new text');
        } finally {
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    });

    const written = new Map();
    const realWriteBack = user.store.tokens.writeBack.bind(user.store.tokens);
    user.store.tokens.writeBack = async (pending, now) => {
        for (const [table, rows] of [['token_counts', pending.counts ?? []], ['token_ids', pending.ids ?? []]]) {
            for (const { identity, hash } of rows) {
                if (!written.has(identity)) written.set(identity, { token_counts: new Set(), token_ids: new Set() });
                written.get(identity)[table].add(hash);
            }
        }
        return realWriteBack(pending, now);
    };
    async function storedRowsUnder(identity) {
        const w = written.get(identity);
        return w ? w.token_counts.size + w.token_ids.size : 0;
    }

    let writeBackChats = 0;
    async function setUpWriteBackGeneration(props, onCompletion) {
        const name = `WriteBack${++writeBackChats}`;
        const avatar = await writeCharacter(`${name}.png`, { name, data: { name, description: `${name} tends the garden.`, first_mes: 'Hello.' } });
        await saveBranch(user.store, { avatar: avatar }, 'write-back-chat', [
            { chat_metadata: {} },
            { name, is_user: false, mes: 'Hello.', send_date: 1, extra: {} },
            { name: 'Tester', is_user: true, mes: 'What grows here?', send_date: 2, extra: {} },
            { name, is_user: false, mes: 'Roses, mostly.', send_date: 3, extra: {} },
        ]);
        const branch = await loadBranch(user.store, { avatar: avatar }, 'write-back-chat');
        const urls = [];
        const requests = [];
        const backend = await startFakeBackend((req, res, body) => {
            urls.push(req.url);
            requests.push({ url: req.url, body });
            if (req.url.startsWith('/props')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(props));
            }
            if (req.url === '/tokenize') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ tokens: Array.from(Buffer.from(JSON.parse(body).content), (_, i) => i) }));
            }
            if (req.url === '/completion') return onCompletion(req, res, body);
            res.writeHead(500);
            res.end('no');
        });
        const settings = buildSettingsFixture();
        settings.power_user.tokenizer = 99;
        Object.assign(settings.textgenerationwebui_settings, {
            type: 'llamacpp',
            llamacpp_model: '',
            server_urls: { llamacpp: backend.url },
            logit_bias: [{ id: 'a', text: 'thorn', value: -5 }],
        });
        writeAllSettings(directories, settings);
        return {
            backend, urls, requests,
            body: { owner_id: avatar, character_avatar: avatar, node_id: branch.branch.leaf_id, type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Any tulips?' } },
        };
    }

    for (const stream of [false, true]) {
        await tokenizerCase(`raw-action /generate on llama.cpp (${stream ? 'stream' : 'non-stream'}): the counts and ids are stored only after the backend has received its request`, async () => {
            const props = { model_alias: 'write-back-model', model_path: '/models/write-back-model.gguf', build_info: `b-write-back-${stream}` };
            let rowsWhenReceived = null;
            const identity = `llamacpp:${JSON.stringify([props.model_path, props.build_info])}`;
            const { backend, urls, body } = await setUpWriteBackGeneration(props, async (_req, res) => {
                rowsWhenReceived = await storedRowsUnder(identity);
                if (stream) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ content: 'Yes.', stop: false })}\n\n`);
                    return res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ content: 'Yes.', choices: [{ text: 'Yes.' }] }));
            });
            try {
                const { status } = stream
                    ? await postGenerateStreamBytes(buildTestApp(), { ...body, stream: true })
                    : await postGenerate(buildTestApp(), body);
                assert.equal(status, 200);
                assert.ok(urls.includes('/tokenize'), 'the generation tokenized');
                assert.ok(urls.includes('/completion'), 'the backend received the generation');
                assert.equal(rowsWhenReceived, 0, 'nothing stored when the backend received its request');
                await waitFor(async () => (await storedRowsUnder(identity)) > 0);
            } finally {
                backend.server.close();
                writeAllSettings(directories, buildSettingsFixture());
            }
        });
    }

    await tokenizerCase('raw-action /generate on llama.cpp: a backend request that throws before sending stores nothing', async () => {
        const props = { model_alias: 'write-back-model', model_path: '/models/write-back-model.gguf', build_info: 'b-write-back-throws' };
        const identity = `llamacpp:${JSON.stringify([props.model_path, props.build_info])}`;
        const { backend, urls, body } = await setUpWriteBackGeneration(props, (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ content: 'Yes.', choices: [{ text: 'Yes.' }] }));
        });
        const realFetch = globalThis.fetch;
        let refused = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (async (url, ...rest) => {
            if (String(url).endsWith('/completion')) {
                refused++;
                throw new TypeError('fetch failed', { cause: new Error('refused before sending') });
            }
            return realFetch(url, ...rest);
        });
        try {
            const { data } = await postGenerate(buildTestApp(), body);
            assert.equal(data.error, true, 'the generation failed');
            assert.equal(refused, 1, 'the backend request threw');
            assert.ok(urls.includes('/tokenize'), 'the generation tokenized');
            assert.ok(!urls.includes('/completion'), 'the backend never received the generation');
            await new Promise(resolve => setTimeout(resolve, 200));
            assert.equal(await storedRowsUnder(identity), 0, 'nothing stored');
        } finally {
            globalThis.fetch = realFetch;
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    });

    await tokenizerCase('raw-action /generate on llama.cpp with the token tables failing to read: the same prompt and bias as counted fresh, and the generation succeeds', async () => {
        const props = { model_alias: 'write-back-model', model_path: '/models/write-back-model.gguf', build_info: 'b-read-fails' };
        const identity = `llamacpp:${JSON.stringify([props.model_path, props.build_info])}`;
        const completions = [];
        const { backend, urls, body } = await setUpWriteBackGeneration(props, (_req, res, completionBody) => {
            completions.push(JSON.parse(completionBody));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ content: 'Yes.', choices: [{ text: 'Yes.' }] }));
        });
        const tokens = user.store.tokens;
        const realRead = tokens.read;
        try {
            const fresh = await postGenerate(buildTestApp(), body);
            assert.equal(fresh.status, 200);
            await waitFor(async () => (await storedRowsUnder(identity)) > 0);
            const freshTokenizes = urls.filter(url => url === '/tokenize').length;
            urls.length = 0;

            tokens.read = async () => {
                throw new Error('token table read failed (test)');
            };
            const failing = await postGenerate(buildTestApp(), body);
            tokens.read = realRead;
            assert.equal(failing.status, 200);
            assert.notEqual(failing.data?.error, true, 'the generation succeeded');
            assert.equal(completions.length, 2, 'the backend received both generations');
            assert.equal(completions[1].prompt, completions[0].prompt, 'the same prompt');
            assert.deepEqual(completions[1].logit_bias, completions[0].logit_bias, 'the same bias');
            assert.equal(urls.filter(url => url === '/tokenize').length, freshTokenizes, 'everything counted and encoded fresh again');
        } finally {
            tokens.read = realRead;
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    });

    await tokenizerCase('raw-action /generate on llama.cpp, a stored chat and one new user message: one /props, no /v1/models, /tokenize only for texts not stored', async () => {
        const props = { model_alias: 'write-back-model', model_path: '/models/write-back-model.gguf', build_info: 'b-request-log' };
        const identity = `llamacpp:${JSON.stringify([props.model_path, props.build_info])}`;
        const { backend, requests, body } = await setUpWriteBackGeneration(props, (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ content: 'Yes.', choices: [{ text: 'Yes.' }] }));
        });
        const storedHashes = table => new Set(written.get(identity)?.[table] ?? []);
        try {
            const cold = await postGenerate(buildTestApp(), body);
            assert.equal(cold.status, 200);
            await waitFor(async () => (await storedRowsUnder(identity)) > 0);
            const counts = storedHashes('token_counts');
            const ids = storedHashes('token_ids');

            const from = requests.length;
            const warm = await postGenerate(buildTestApp(), { ...body, user_message: { is_user: true, name: 'User', mes: 'Any daisies?' } });
            assert.equal(warm.status, 200);
            const sent = requests.slice(from);
            assert.equal(sent.filter(r => r.url.startsWith('/props')).length, 1, 'one /props');
            assert.equal(sent.filter(r => r.url === '/v1/models').length, 0, 'no /v1/models');
            const wasStored = ({ content, add_special }) => add_special === true
                ? counts.has(tokenKeyHash('prompt', content))
                : counts.has(tokenKeyHash('text', content)) && ids.has(tokenKeyHash('ids', content));
            const tokenized = sent.filter(r => r.url === '/tokenize').map(r => JSON.parse(r.body));
            assert.deepEqual(tokenized.filter(wasStored), [], 'no /tokenize for a text already stored');
        } finally {
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    });

    assert.deepEqual(tokenizerCaseFailures, [], 'tokenizer resolution cases');

    console.log('text-completions.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => user.close());
