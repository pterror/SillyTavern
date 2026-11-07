import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
import '../../fetch-patch.js';
import { Jimp, JimpMime } from '../../jimp.js';
import { setConfigFilePath } from '../../util.js';
import { CompactStreamDecoder } from '../../../public/scripts/llamacpp-compact-stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

const canMockAi21Backend = typeof mock.module === 'function';
/** @type {string|null} */
let ai21FakeBackendUrl = null;
/** @type {string|null} */
let cohereFakeBackendUrl = null;
/** @type {string|null} */
let aimlapiFakeBackendUrl = null;
/** @type {string|null} */
let chutesFakeBackendUrl = null;
/** @type {string|null} */
let minimaxFakeBackendUrl = null;
/** @type {string|null} */
let electronhubFakeBackendUrl = null;
/** @type {string[]} */
const tokenizerDownloadRequests = [];
if (canMockAi21Backend) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = /** @type {typeof fetch} */ (async (url, opts) => {
        if (String(url).startsWith('https://github.com/SillyTavern/SillyTavern-Tokenizers/')) {
            tokenizerDownloadRequests.push(String(url));
            return new Response('unavailable', { status: 503, statusText: 'Service Unavailable' });
        }
        const target = new URL(url);
        if (ai21FakeBackendUrl && target.origin === 'https://api.ai21.com') {
            return realFetch(new URL(target.pathname + target.search, ai21FakeBackendUrl), opts);
        }
        if (cohereFakeBackendUrl && target.origin === 'https://api.cohere.ai') {
            return realFetch(new URL(target.pathname + target.search, cohereFakeBackendUrl), opts);
        }
        if (aimlapiFakeBackendUrl && target.origin === 'https://api.aimlapi.com') {
            return realFetch(new URL(target.pathname + target.search, aimlapiFakeBackendUrl), opts);
        }
        if (chutesFakeBackendUrl && target.origin === 'https://llm.chutes.ai') {
            return realFetch(new URL(target.pathname + target.search, chutesFakeBackendUrl), opts);
        }
        if (minimaxFakeBackendUrl && (target.origin === 'https://api.minimax.io' || target.origin === 'https://api.minimaxi.com')) {
            return realFetch(new URL(target.pathname + target.search, minimaxFakeBackendUrl), opts);
        }
        if (electronhubFakeBackendUrl && target.origin === 'https://api.electronhub.ai') {
            return realFetch(new URL(target.pathname + target.search, electronhubFakeBackendUrl), opts);
        }
        return realFetch(url, opts);
    });
}

const { router, buildRawActionChatCompletionRequest } = await import('./chat-completions.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { writeSecret, SECRET_KEYS } = await import('../secrets.js');
const { encodeTextByLocalTokenizerType, getTiktokenTokenizer } = await import('../tokenizers.js');
const { tokenKeyHash, TOKEN_KEY_KINDS } = await import('../../token-count-store.js');
const { resolveTokenizer, tokenizerIdentity } = await import('../../tokenizer-resolve.js');

const { SESSION_HEADER } = await import('../../request-session.js');
const { convertedUser, writeLibraryCard, saveBranch, loadBranch, sessionAt, chatContextOf, seedMessages, treeOf } = await import('../../../tests/converted-user.fixture.js');

const user = await convertedUser('st-chat-completions-raw-action-test-');
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

    const built = await buildRawActionChatCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
        type: 'normal', userMessageText: 'What happens next, Rex?',
    });

    assert.equal(built.settings.chat_completion_source, 'custom', 'settings resolves for real from oai_settings');
    assert.equal(built.name1, 'Tester', 'name1 resolves from settings.json username, same as the orchestrator input');
    assert.equal(built.name2, 'Rex');
    assert.ok(built.anchorNodeId, 'anchorNodeId resolves to the real leaf of the loaded branch');

    const branchBeforeAppend = await loadBranch(user.store, { avatar: ownerId }, branchName);
    assert.equal(built.anchorNodeId, branchBeforeAppend.branch.leaf_id, 'anchorNodeId is exactly the given node_id\'s real leaf_id');
    assert.equal(built.anchorNodeId, mainLeafId, 'anchorNodeId is exactly the given node_id, unchanged from before');

    assert.ok(built.params && typeof built.params === 'object', 'params (generate_data) is a real object');
    assert.equal(built.params.model, 'test-model', 'params.model is the resolved chat-completion model, matching getChatCompletionModel()');
    assert.equal(built.params.chat_completion_source, 'custom');
    assert.ok(Array.isArray(built.params.messages), 'params.messages is the real, prepared chat-completion message array');
    const joined = built.params.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.ok(joined.includes('Hello there, traveler.'), 'the real loaded chat history made it into the prepared messages');
    assert.ok(joined.includes('What happens next, Rex?'), 'the raw user_message made it into the prepared messages');

    const appendResult = await appendThrough(ownerId, built.anchorNodeId, [
        { name: built.name1, is_user: true, mes: 'What happens next, Rex?', extra: {}, send_date: Date.now() },
    ]);
    assert.equal(appendResult.ok, true, 'appendMessages() accepts the resolved anchorNodeId as a real anchor');
    const branchAfterAppend = await loadBranch(user.store, { avatar: ownerId }, branchName);
    assert.equal(branchAfterAppend.messages.length, 4, 'the persisted user message is now part of the real loaded branch');
    assert.equal(branchAfterAppend.messages[3].mes, 'What happens next, Rex?');

    const continued = await buildRawActionChatCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, chat: await chatOf(avatar, branchAfterAppend.branch.leaf_id), nodeId: branchAfterAppend.branch.leaf_id, type: 'continue', isContinue: true,
    });
    const continuedJoined = continued.params.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.ok(continuedJoined.includes('Likewise!'), 'continue resolves from the real existing history with no new message appended');
    assert.equal(continued.anchorNodeId, branchAfterAppend.branch.leaf_id, 'the continue anchor is the real current leaf');
    assert.equal(continued.anchorContent?.mes, 'What happens next, Rex?', 'anchorContent is the anchor\'s real, current, unmodified content (the real leaf at this point in the test, appended above) - exactly what the route\'s is_continue edit needs as "oldText"');

    const quietLeafId = branchAfterAppend.branch.leaf_id;
    const quiet = await buildRawActionChatCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, chat: await chatOf(avatar, quietLeafId), nodeId: quietLeafId, type: 'quiet',
        quiet: { quietPrompt: 'Summarize the scene in one line.' },
    });
    const quietLast = quiet.params.messages[quiet.params.messages.length - 1];
    assert.deepEqual([quietLast?.role, quietLast?.content], ['system', 'Summarize the scene in one line.'], 'the quiet prompt is the last message, from the system');

    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, nodeId: mainLeafId,
        }),
        /owner_id is required/,
    );

    await assert.rejects(
        async () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: 'NoSuchCharacter.png', ownerId, chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
        }),
        /Character not found/,
    );

    await assert.rejects(
        async () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, ownerId, chat: await chatOf(avatar, 'no-such-node-id'), nodeId: 'no-such-node-id',
        }),
        /Chat node not found/,
    );

    await assert.rejects(
        async () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, ownerId, chat: await chatOf(avatar, undefined),
        }),
        /node_id is required \(pass null explicitly for a brand-new, empty conversation\)/,
    );

    await assert.rejects(
        async () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, ownerId, chat: await chatOf(avatar, null), nodeId: null,
        }),
        /node_id is required: this chat is not at its start/,
    );

    const freshAvatar = await writeCharacter('Fresh.png', {
        name: 'Fresh',
        description: 'Fresh is a brand-new character with no chat history yet.',
        data: { name: 'Fresh', description: 'Fresh is a brand-new character with no chat history yet.', first_mes: 'Hello, this is Fresh.' },
    });
    const builtFresh = await buildRawActionChatCompletionRequest(directories, {
        characterAvatar: freshAvatar, ownerId: freshAvatar, chat: await chatOf(freshAvatar, null), nodeId: null,
        type: 'normal', userMessageText: 'Hi Fresh, this is our first message ever.',
    });
    assert.equal(builtFresh.anchorNodeId, null, 'a new, empty conversation is at its tree\'s root: the reply opens it');
    const freshJoined = builtFresh.params.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.ok(!freshJoined.includes('Hello there, traveler.'), 'no unrelated prior history (Rex\'s) leaked into a brand-new character\'s resolved, empty chat');
    assert.ok(freshJoined.includes('Hi Fresh, this is our first message ever.'), 'the raw user_message for this turn still made it into the prepared messages even though the resolved prior history was empty');
    const freshAppendResult = await appendThrough(freshAvatar, builtFresh.anchorNodeId, [
        { name: builtFresh.name1, is_user: true, mes: 'Hi Fresh, this is our first message ever.', extra: {}, send_date: Date.now() },
    ]);
    assert.equal(freshAppendResult.ok, true, 'the anchor-resolved node id for a brand-new conversation is a real, appendable node');

    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            ownerId, nodeId: mainLeafId,
        }),
        /character_avatar or group_id is required/,
    );

    async function startFakeBackend(handler, { answersProps = false } = {}) {
        const server = http.createServer((req, res) => {
            if (req.method === 'GET' && req.url === '/props' && !answersProps) {
                res.writeHead(404);
                res.end();
                return;
            }
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
                if (session) req.headers[SESSION_HEADER.toLowerCase()] = session;
                next();
            }, next);
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
            const bodyBytes = Buffer.from(await res.arrayBuffer());
            return { status: res.status, bodyBytes, bodyText: bodyBytes.toString('utf-8') };
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

    async function startFakeSseBackend(textChunks) {
        const sseBody = textChunks.map(text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
        return { ...await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(sseBody);
        }), expectedBody: sseBody, expectedText: textChunks.join('') };
    }

    function assertStreamCarriesAssistantNodeId(bodyBytes, expectedText, { expectedReasoning } = {}) {
        const decoder = new CompactStreamDecoder();
        const events = [...decoder.push(new Uint8Array(bodyBytes)), ...decoder.flush()];

        const content = events.filter(event => 'content' in event).map(event => event.content).join('');
        assert.equal(content, expectedText, 'every real content frame reassembles, in order, to the expected text');

        if (expectedReasoning !== undefined) {
            const reasoning = events.filter(event => 'reasoning' in event).map(event => event.reasoning).join('');
            assert.equal(reasoning, expectedReasoning, 'every reasoning frame reassembles, in order, to the expected reasoning text');
        }

        const nodeIdEventIndex = events.findIndex(event => 'assistantNodeId' in event);
        assert.notEqual(nodeIdEventIndex, -1, 'the compact stream carries an assistantNodeId frame');
        assert.equal(nodeIdEventIndex, events.length - 1, 'the assistantNodeId frame is the LAST decoded event - persistence only completes once the full text is known');
        return events[nodeIdEventIndex].assistantNodeId;
    }

    function decodeCompactToolStream(bodyBytes) {
        const decoder = new CompactStreamDecoder();
        const events = [...decoder.push(new Uint8Array(bodyBytes)), ...decoder.flush()];
        const content = events.filter(event => 'content' in event).map(event => event.content).join('');
        const toolCallDeltas = events.filter(event => 'toolCallDelta' in event).map(event => event.toolCallDelta);
        const controlEvents = events.filter(event => 'control' in event).map(event => event.control);
        const assistantNodeIdEvent = events.find(event => 'assistantNodeId' in event);
        return {
            content, toolCallDeltas,
            control: controlEvents.length ? controlEvents[controlEvents.length - 1] : null,
            assistantNodeId: assistantNodeIdEvent ? assistantNodeIdEvent.assistantNodeId : null,
        };
    }

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

    function pointAI21BackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'ai21';
        settings.oai_settings.ai21_model = 'jamba-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.AI21, 'test-ai21-key');
        ai21FakeBackendUrl = url;
    }

    function pointDeepSeekBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'deepseek';
        settings.oai_settings.deepseek_model = 'deepseek-test-model';
        settings.oai_settings.reverse_proxy = url;
        settings.oai_settings.proxy_password = 'test-deepseek-proxy-password';
        writeAllSettings(directories, settings);
    }

    function pointXaiBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'xai';
        settings.oai_settings.xai_model = 'grok-test-model';
        settings.oai_settings.reverse_proxy = url;
        settings.oai_settings.proxy_password = 'test-xai-proxy-password';
        writeAllSettings(directories, settings);
    }

    function pointCohereBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'cohere';
        settings.oai_settings.cohere_model = 'command-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.COHERE, 'test-cohere-key');
        cohereFakeBackendUrl = url;
    }

    function pointAimlapiBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'aimlapi';
        settings.oai_settings.aimlapi_model = 'aimlapi-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.AIMLAPI, 'test-aimlapi-key');
        aimlapiFakeBackendUrl = url;
    }

    function pointChutesBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'chutes';
        settings.oai_settings.chutes_model = 'chutes-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.CHUTES, 'test-chutes-key');
        chutesFakeBackendUrl = url;
    }

    function pointMinimaxBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'minimax';
        settings.oai_settings.minimax_model = 'minimax-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.MINIMAX, 'test-minimax-key');
        minimaxFakeBackendUrl = url;
    }

    function pointElectronHubBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'electronhub';
        settings.oai_settings.electronhub_model = 'electronhub-test-model';
        writeAllSettings(directories, settings);
        writeSecret(directories, SECRET_KEYS.ELECTRONHUB, 'test-electronhub-key');
        electronhubFakeBackendUrl = url;
    }

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

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Rex says hello back.' } }] }));
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
        assert.equal(data.choices?.[0]?.message?.content, 'Rex says hello back.', 'response body reaches the client unmodified');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply were appended');
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'One more time, Rex?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back.', 'the assistant reply text was extracted from data.choices[0].message.content and appended');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex', 'the assistant message uses name2 (the character\'s display name), not name1');
    }

    {
        const { lib } = await (await import('../../user-stores.js')).userStore(directories);
        await lib.books.write('ReplyLore', { entries: { 0: { uid: 0, key: ['lantern'], keysecondary: [], comment: 'The lantern', content: 'The lantern never goes out.', position: 0, order: 10, disable: false } } });
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'It hangs by the door.' } }] }));
        });
        const settings = buildSettingsFixture();
        settings.oai_settings.custom_url = fakeBackend.url;
        settings.world_info_settings = { world_info: { globalSelect: ['ReplyLore'] } };
        writeAllSettings(directories, settings);
        const chatName = 'activation-record-chat';
        await saveBranch(user.store, { avatar: ownerId }, chatName, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Welcome in.', send_date: 1, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, chatName);
        try {
            const { status, data } = await postGenerate(buildTestApp(), {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Where is the lantern?' }, stream: false,
            });
            assert.equal(status, 200);
            const [userMsg, reply] = (await loadBranch(user.store, { avatar: ownerId }, chatName)).messages.slice(-2);
            const found = await lib.books.entryOf('ReplyLore', 0);
            assert.equal(typeof found, 'object');
            const ref = { book: String(/** @type {any} */ (found).book), entry: String(/** @type {any} */ (found).id) };
            const { getStringHash } = await import('../../../public/scripts/hash-utils.js');
            assert.deepEqual(reply.extra.activations, {
                entries: [{ ref, why: 'key', step: 1, keys: [{ key: 'lantern', in: [{ node: userMsg.node_id, spans: [[13, 20]], of: getStringHash(userMsg.mes) }] }], via: [], position: 0, depth: null, role: null }],
                cut: [],
            }, 'the reply is stored with what came up for it, the match placed in the user message stored in the same request');
            assert.deepEqual(data.assistant_message.extra.activations, reply.extra.activations, 'and the answer carries the same record, so the page needs no other request');
            assert.equal(userMsg.extra?.activations, undefined, 'only the reply carries a record');
        } finally {
            fakeBackend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    {
        const requestedPaths = [];
        const fakeBackend = await startFakeBackend((req, res) => {
            requestedPaths.push((req.url ?? '').split('?')[0]);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ text: 'Rex answers as an instruct model.' }] }));
        });
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'openai';
        settings.oai_settings.openai_model = 'gpt-3.5-turbo-instruct';
        settings.oai_settings.reverse_proxy = `${fakeBackend.url}/v1`;
        writeAllSettings(directories, settings);

        const chatName = 'nonstream-instruct-model-chat';
        await saveBranch(user.store, { avatar: ownerId }, chatName, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: `Hello there, ${chatName}.`, send_date: 1, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, chatName);

        try {
            const { status, data } = await postGenerate(buildTestApp(), {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Instruct question, Rex?' }, stream: false,
            });

            assert.equal(status, 200);
            assert.deepEqual(requestedPaths, ['/v1/completions'], 'a text-completion model is sent to /completions');
            assert.equal(data.choices?.[0]?.text, 'Rex answers as an instruct model.', 'the backend\'s reply reaches the page');
            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, chatName);
            assert.deepEqual(
                branchAfter.messages.slice(branchBefore.messages.length).map(m => ({ is_user: m.is_user, mes: m.mes })),
                [{ is_user: true, mes: 'Instruct question, Rex?' }, { is_user: false, mes: 'Rex answers as an instruct model.' }],
                'the user message and the reply are both stored when the answer returns',
            );
            assert.equal(data.assistant_node_id, branchAfter.branch.leaf_id, 'the answer names the node the reply is stored at');
        } finally {
            fakeBackend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ unexpected_field: 'Secret unreadable reply.' }));
        });
        pointBackendAt(fakeBackend.url);

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
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Unreadable question, Rex?' }, stream: false,
            });
        } finally {
            console.warn = realWarn;
            fakeBackend.server.close();
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
            [{ is_user: true, mes: 'Unreadable question, Rex?' }],
        );
    }

    {
        const backendBodies = [];
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            backendBodies.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
        });
        const settings = buildSettingsFixture();
        settings.oai_settings.custom_url = fakeBackend.url;
        settings.oai_settings.custom_model = 'some-unheard-of-model';
        settings.oai_settings.bias_preset_selected = 'Drop';
        settings.oai_settings.bias_presets = { Drop: [{ id: 'a', text: 'hello', value: -5 }, { id: 'b', text: '[11, 12]', value: 2 }] };
        writeAllSettings(directories, settings);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const app = buildTestApp();
        const rawAction = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Bias, Rex?' }, stream: false,
        });
        fakeBackend.server.close();
        writeAllSettings(directories, buildSettingsFixture());

        assert.equal(rawAction.status, 200);
        assert.deepEqual(rawAction.data.warnings, [{
            kind: 'dropped',
            key: `openai|custom|${fakeBackend.url}|some-unheard-of-model|none`,
            message: 'Left out 1 entry that need token ids, because no tokenizer is known for this model: hello',
            entries: ['hello'],
        }], 'the dropped entry is listed');
        assert.deepEqual(backendBodies.map(body => body.logit_bias), [{ 11: 2, 12: 2 }], 'raw-id entries still go through');
    }

    if (canMockAi21Backend) {
        const backendBodies = [];
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            backendBodies.push(JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
        });
        const settings = buildSettingsFixture();
        settings.oai_settings.custom_url = fakeBackend.url;
        settings.oai_settings.custom_model = 'Mistral-Nemo-Instruct-2407';
        settings.oai_settings.bias_preset_selected = 'Drop';
        settings.oai_settings.bias_presets = { Drop: [{ id: 'a', text: 'hello', value: -5 }, { id: 'b', text: '[11, 12]', value: 2 }] };
        writeAllSettings(directories, settings);

        tokenizerDownloadRequests.length = 0;
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const app = buildTestApp();
        const rawAction = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Bias with Nemo, Rex?' }, stream: false,
        });
        fakeBackend.server.close();
        writeAllSettings(directories, buildSettingsFixture());

        const dropped = model => ({
            kind: 'dropped',
            key: `openai|custom|${fakeBackend.url}|${model}|nemo`,
            message: 'Left out 1 entry that need token ids, because the Mistral Nemo tokenizer failed: hello',
            entries: ['hello'],
        });
        assert.equal(rawAction.status, 200, 'raw-action');
        assert.deepEqual(rawAction.data.warnings, [{
            kind: 'trim-estimate',
            key: `openai|custom|${fakeBackend.url}|Mistral-Nemo-Instruct-2407|nemo`,
            message: 'The Mistral Nemo tokenizer failed, so the prompt was fitted to the context by an estimated token count.',
        }, dropped('Mistral-Nemo-Instruct-2407')], 'raw-action: the estimate trim and the dropped entry are reported');
        assert.deepEqual(backendBodies.map(body => body.logit_bias), [{ 11: 2, 12: 2 }], 'raw-id entries still go through');
        assert.equal(tokenizerDownloadRequests.filter(url => url.endsWith('/nemo.json.gz')).length, 1, 'one download request');
    } else {
        console.log('chat-completions.test.js: skipping the downloadable-tokenizer failure case - run with `node --experimental-test-module-mocks`, which it needs to stub the download');
    }

    {
        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const postBias = async (model, entries) => {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/bias?model=${encodeURIComponent(model)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entries),
            });
            return { status: res.status, headers: res.headers, data: await res.json() };
        };
        const entries = [{ text: 'hello', value: -5 }, { text: '[11, 12]', value: 2 }];
        const expectedFor = ids => ({ ...Object.fromEntries(ids.map(id => [id, -5])), 11: 2, 12: 2 });
        try {
            const unknown = await postBias('some-unheard-of-model', entries);
            assert.equal(unknown.status, 200);
            assert.deepEqual(unknown.data, expectedFor(Array.from(getTiktokenTokenizer('gpt-3.5-turbo').encode('hello'))), 'an unknown name: gpt-3.5-turbo');
            assert.deepEqual([...unknown.headers.keys()].filter(name => name.startsWith('x-st-')), [], 'no tokenizer header yet');

            const mistral = await postBias('mistral-7b-instruct', entries);
            assert.deepEqual(mistral.data, expectedFor(await encodeTextByLocalTokenizerType('mistral', 'hello')), 'a mistral name: mistral');

            const claude = await postBias('claude', entries);
            assert.deepEqual(claude.data, {}, 'claude: no bias');
        } finally {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    {
        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const postBias = async (state, entries, query = '') => {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/bias${query}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-ST-Connection-State': state },
                body: JSON.stringify(entries),
            });
            return { status: res.status, headers: res.headers, text: await res.text() };
        };
        const asciiJson = value => JSON.stringify(value).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
        const entries = [{ text: 'hello', value: -5 }, { text: '[11, 12]', value: 2 }, { text: 'こんにちは', value: 1 }];
        try {
            const unmapped = await postBias(asciiJson({ api: 'openai', source: 'custom', model: 'some-unheard-of-model' }), entries, '?model=gpt-4o');
            assert.equal(unmapped.status, 200);
            assert.deepEqual(JSON.parse(unmapped.text), { 11: 2, 12: 2 }, 'unmapped: raw ids only, ?model= ignored');
            assert.deepEqual(JSON.parse(unmapped.headers.get('x-st-tokenizer-dropped') ?? 'null'), ['hello', 'こんにちは'], 'unmapped: the entries needing ids are listed');

            const mapped = await postBias(asciiJson({ api: 'openai', source: 'openai', model: 'gpt-4o' }), entries, '?model=some-unheard-of-model');
            const gpt4o = getTiktokenTokenizer('gpt-4o');
            const expected = { 11: 2, 12: 2 };
            for (const id of gpt4o.encode('hello')) expected[id] = -5;
            for (const id of gpt4o.encode('こんにちは')) expected[id] = 1;
            assert.deepEqual(JSON.parse(mapped.text), expected, 'gpt-4o state: encoded with gpt-4o, not the query');
            assert.deepEqual(JSON.parse(mapped.headers.get('x-st-tokenizer-dropped') ?? 'null'), [], 'gpt-4o state: nothing left out');

            assert.equal((await postBias('{not json', entries)).status, 400, 'an unreadable state: 400');
            assert.equal((await postBias(asciiJson({ api: 'textgenerationwebui', model: 'gpt-4o' }), entries)).status, 400, 'a state that is not chat completion: 400');
        } finally {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    {
        const requests = [];
        const fakeLlamaCpp = await startFakeBackend((req, res, body) => {
            requests.push({ method: req.method, path: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (req.url.split('?')[0] === '/props') {
                return res.end(JSON.stringify({ default_generation_settings: { n_ctx: 4096 }, total_slots: 1, build_info: 'b1-abc' }));
            }
            if (req.url === '/tokenize') {
                const bytes = Array.from(Buffer.from(String(JSON.parse(body).content)));
                return res.end(JSON.stringify({ tokens: bytes.map(byte => 1000 + byte) }));
            }
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
        }, { answersProps: true });
        writeSecret(directories, SECRET_KEYS.CUSTOM, 'custom-key');
        writeSecret(directories, SECRET_KEYS.LLAMACPP, 'textgen-llamacpp-key');
        const settings = buildSettingsFixture();
        settings.oai_settings.custom_url = fakeLlamaCpp.url;
        settings.oai_settings.custom_model = 'some-unheard-of-model';
        settings.oai_settings.custom_include_headers = 'X-User: "{{user}}"';
        settings.oai_settings.bias_preset_selected = 'Bias';
        settings.oai_settings.bias_presets = { Bias: [{ id: 'a', text: 'hi', value: -5 }] };
        writeAllSettings(directories, settings);

        const app = buildTestApp();
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const sent = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Count me, Rex.' }, stream: false,
        });
        const sendRequests = requests.slice();

        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        let biasWithMacroHeaders;
        let biasWithPlainHeaders;
        try {
            const postBias = () => fetch(`http://127.0.0.1:${server.address().port}/bias`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-ST-Connection-State': JSON.stringify({ api: 'openai', source: 'custom', url: fakeLlamaCpp.url, model: 'some-unheard-of-model' }) },
                body: JSON.stringify([{ text: 'hi', value: 3 }]),
            });
            const requestsBefore = requests.length;
            const macroReply = await postBias();
            biasWithMacroHeaders = { body: await macroReply.json(), dropped: JSON.parse(macroReply.headers.get('x-st-tokenizer-dropped') ?? 'null'), asked: requests.length - requestsBefore };
            settings.oai_settings.custom_include_headers = 'X-User: plain';
            writeAllSettings(directories, settings);
            const plainReply = await postBias();
            biasWithPlainHeaders = { body: await plainReply.json(), dropped: JSON.parse(plainReply.headers.get('x-st-tokenizer-dropped') ?? 'null') };
        } finally {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
            fakeLlamaCpp.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }

        assert.equal(sent.status, 200);
        const tokenizes = sendRequests.filter(r => r.path === '/tokenize');
        assert.ok(sendRequests.some(r => r.method === 'GET' && r.path === '/props'), 'the send asked whether the URL is llama.cpp');
        const propsForSend = sendRequests.filter(r => r.path === '/props?model=some-unheard-of-model');
        assert.equal(propsForSend.length, 1, 'one /props for every count and encode of the send, with ?model= for its model setting');
        assert.ok(tokenizes.length > 0, 'the send counted with llama.cpp\'s /tokenize');
        for (const request of sendRequests.filter(r => r.path.startsWith('/props') || r.path === '/tokenize')) {
            assert.equal(request.headers['x-user'], 'Tester', `${request.path}: the custom headers, substituted with the send's macros`);
            assert.equal(request.headers.authorization, 'Bearer custom-key', request.path);
            assert.equal(JSON.stringify(request.headers).includes('textgen-llamacpp-key'), false, request.path);
        }
        assert.equal(tokenizes.some(r => 'add_special' in r.body), false, 'chat-completion counts ask for no BOS');
        const generation = sendRequests.find(r => r.path === '/chat/completions');
        assert.deepEqual(generation.body.logit_bias, { 1104: -5, 1105: -5 }, 'the bias ids came from /tokenize');
        assert.equal(sent.data.warnings, undefined, 'nothing was dropped or estimated');

        assert.deepEqual(biasWithMacroHeaders, { body: {}, dropped: ['hi'], asked: 0 }, '/bias, saved headers with a macro: nothing asked, the map (unmapped model)');
        assert.deepEqual(biasWithPlainHeaders, { body: { 1104: 3, 1105: 3 }, dropped: [] }, '/bias, plain saved headers: /tokenize ids');
    }

    {
        const tokenizes = [];
        const fakeLlamaCpp = await startFakeBackend((req, res, body) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (req.url.split('?')[0] === '/props') {
                return res.end(JSON.stringify({ default_generation_settings: { n_ctx: 4096 }, total_slots: 1, build_info: 'b1-abc', model_path: '/models/stub.gguf' }));
            }
            if (req.url === '/tokenize') {
                const content = String(JSON.parse(body).content);
                tokenizes.push(content);
                return res.end(JSON.stringify({ tokens: Array.from(Buffer.from(content)).map(byte => 1000 + byte) }));
            }
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
        }, { answersProps: true });
        const settings = buildSettingsFixture();
        settings.oai_settings.custom_url = fakeLlamaCpp.url;
        settings.oai_settings.custom_model = 'some-unheard-of-model';
        settings.oai_settings.bias_preset_selected = 'Bias';
        settings.oai_settings.bias_presets = { Bias: [{ id: 'a', text: 'hi', value: -5 }] };
        writeAllSettings(directories, settings);
        let built;
        try {
            const branch = await loadBranch(user.store, { avatar: ownerId }, branchName);
            built = await buildRawActionChatCompletionRequest(directories, {
                characterAvatar: avatar, ownerId, chat: await chatOf(avatar, branch.branch.leaf_id), nodeId: branch.branch.leaf_id,
                type: 'normal', userMessageText: 'Store me, Rex.',
            });
        } finally {
            fakeLlamaCpp.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }

        const identity = `llamacpp:${JSON.stringify(['/models/stub.gguf', 'b1-abc'])}`;
        const { tokenCountRows } = built;
        assert.deepEqual(built.params.logit_bias, { 1104: -5, 1105: -5 });
        assert.equal(tokenizes.filter(content => content === 'hi').length, 1, 'the bias entry encoded once');
        assert.ok(tokenCountRows.counts.length > 0, 'the message counts are in tokenCountRows');
        assert.equal(tokenCountRows.counts.length, tokenizes.filter(content => content !== 'hi').length, 'one count row per message count sent to /tokenize');
        assert.ok(tokenCountRows.counts.every(row => row.identity === identity), 'counts under the llama.cpp identity');
        assert.deepEqual(
            tokenCountRows.ids.map(row => ({ ...row, ids: Array.from(row.ids) })),
            [{ identity, hash: tokenKeyHash(TOKEN_KEY_KINDS.IDS, 'hi'), ids: [1104, 1105] }],
            'the bias entry\'s ids are in the same tokenCountRows',
        );
    }

    const written = new Map();
    const realWriteBack = user.store.tokens.writeBack.bind(user.store.tokens);
    user.store.tokens.writeBack = async (pending, now) => {
        for (const [table, rows] of [[0, pending.counts ?? []], [1, pending.ids ?? []]]) {
            for (const { identity, hash } of rows) {
                if (!written.has(identity)) written.set(identity, new Map());
                written.get(identity).set(`${table}:${hash}`, [table, hash]);
            }
        }
        return realWriteBack(pending, now);
    };
    /**
     * @param {number} table
     * @param {string} identity
     * @param {string} hash
     */
    const cached = (table, identity, hash) => user.store.chats.store.chatRead('tokenCache', { table, identity, hash: Buffer.from(hash, 'hex') });
    async function storedRowsUnder(identity) {
        let rows = 0;
        let newest = 0;
        for (const [table, hash] of written.get(identity)?.values() ?? []) {
            const found = await cached(table, identity, hash);
            if (!found) continue;
            rows++;
            newest = Math.max(newest, found.used);
        }
        return { rows, newest };
    }

    let writeBackChats = 0;
    async function setUpLlamaCppWriteBack(onChat) {
        const n = ++writeBackChats;
        const modelPath = `/models/write-back-${n}.gguf`;
        const chat = `write-back-chat-${n}`;
        await saveBranch(user.store, { avatar: ownerId }, chat, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: `Welcome to the orchard, visitor ${n}.`, send_date: 1, extra: {} },
        ]);
        const leafId = (await loadBranch(user.store, { avatar: ownerId }, chat)).branch.leaf_id;
        const backend = await startFakeBackend((req, res, body) => {
            if (req.url === '/chat/completions') return onChat(req, res, body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (req.url.split('?')[0] === '/props') {
                return res.end(JSON.stringify({ default_generation_settings: { n_ctx: 4096 }, total_slots: 1, build_info: 'b1-abc', model_path: modelPath }));
            }
            if (req.url === '/tokenize') {
                return res.end(JSON.stringify({ tokens: Array.from(Buffer.from(String(JSON.parse(body).content))).map(byte => 1000 + byte) }));
            }
            res.end('{}');
        }, { answersProps: true });
        const settings = buildSettingsFixture();
        settings.oai_settings.custom_url = backend.url;
        settings.oai_settings.bias_preset_selected = 'Bias';
        settings.oai_settings.bias_presets = { Bias: [{ id: 'a', text: 'pear', value: -5 }] };
        writeAllSettings(directories, settings);
        return {
            backend,
            identity: `llamacpp:${JSON.stringify([modelPath, 'b1-abc'])}`,
            body: { owner_id: ownerId, character_avatar: avatar, node_id: leafId, type: 'normal', user_message: { is_user: true, name: 'User', mes: `Any pears, Rex? (${n})` }, stream: false },
        };
    }

    {
        let whenReceived = null;
        let identityForCase = null;
        const { backend, identity, body } = await setUpLlamaCppWriteBack(async (_req, res) => {
            whenReceived = await storedRowsUnder(identityForCase);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Soon.' } }] }));
        });
        identityForCase = identity;
        try {
            const { status } = await postGenerate(buildTestApp(), body);
            assert.equal(status, 200);
            assert.ok(whenReceived, 'the backend received the generation');
            assert.equal(whenReceived.rows, 0, 'nothing stored when the backend received its request');
            await waitFor(async () => (await storedRowsUnder(identity)).rows > 0);
            assert.ok(await cached(1, identity, tokenKeyHash(TOKEN_KEY_KINDS.IDS, 'pear')), 'the bias entry\'s ids are stored');
        } finally {
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    {
        let received = 0;
        const { backend, identity, body } = await setUpLlamaCppWriteBack((_req, res) => {
            received++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Soon.' } }] }));
        });
        const realFetch = globalThis.fetch;
        let refused = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (async (url, ...rest) => {
            if (String(url).endsWith('/chat/completions')) {
                refused++;
                throw new TypeError('fetch failed', { cause: new Error('refused before sending') });
            }
            return realFetch(url, ...rest);
        });
        try {
            const { status } = await postGenerate(buildTestApp(), body);
            assert.equal(status, 502, 'the generation failed');
            assert.equal(refused, 1, 'the backend request threw');
            assert.equal(received, 0, 'the backend never received the generation');
            await new Promise(resolve => setTimeout(resolve, 200));
            assert.equal((await storedRowsUnder(identity)).rows, 0, 'nothing stored');
        } finally {
            globalThis.fetch = realFetch;
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    {
        const claudeChat = 'write-back-claude-chat';
        await saveBranch(user.store, { avatar: ownerId }, claudeChat, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'The Claude orchard is open.', send_date: 1, extra: {} },
        ]);
        const leafId = (await loadBranch(user.store, { avatar: ownerId }, claudeChat)).branch.leaf_id;
        const identity = await tokenizerIdentity(await resolveTokenizer({ api: 'openai', source: 'claude', model: 'gpt-4o' }, { directories }));
        assert.ok(identity, 'gpt-4o has a tokenizer identity');
        let whenReceived = null;
        const backend = await startFakeBackend(async (_req, res) => {
            whenReceived = await storedRowsUnder(identity);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ content: [{ type: 'text', text: 'Open all day.' }] }));
        });
        const settings = buildSettingsFixture();
        Object.assign(settings.oai_settings, { chat_completion_source: 'claude', claude_model: 'gpt-4o', reverse_proxy: backend.url, proxy_password: 'test-claude-proxy-password' });
        writeAllSettings(directories, settings);
        try {
            const before = await storedRowsUnder(identity);
            const { status } = await postGenerate(buildTestApp(), {
                owner_id: ownerId, character_avatar: avatar, node_id: leafId,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'When does the Claude orchard close?' }, stream: false,
            });
            assert.equal(status, 200);
            assert.ok(whenReceived, 'the backend received the generation');
            assert.equal(whenReceived.rows, before.rows, 'nothing stored when the backend received its request');
            await waitFor(async () => (await storedRowsUnder(identity)).rows > before.rows);
        } finally {
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    {
        const sent = [];
        const { backend, body } = await setUpLlamaCppWriteBack((_req, res, requestBody) => {
            sent.push(JSON.parse(requestBody));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Soon.' } }] }));
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
            assert.equal(sent.length, 2, 'token table reads failing: the backend received both generations');
            assert.deepEqual(sent[1].messages, sent[0].messages, 'token table reads failing: the same messages');
            assert.deepEqual(sent[1].logit_bias, sent[0].logit_bias, 'token table reads failing: the same bias');
            assert.ok(sent[0].logit_bias && Object.keys(sent[0].logit_bias).length > 0, 'the bias was encoded');
        } finally {
            tokens.read = realRead;
            backend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
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

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'I think you should go north.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;
        const leafBefore = branchBefore.branch.leaf_id;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'impersonate', is_impersonate: true,
            user_message: { is_user: true, name: 'User', mes: 'This should never be persisted.' },
            stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'I think you should go north.' } }] }, 'the generated text still reaches the client unmodified');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no message (user or assistant) was appended for is_impersonate: true');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the branch leaf/ancestor path is completely unchanged');
    }

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Meta/background result.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;
        const leafBefore = branchBefore.branch.leaf_id;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'quiet',
            user_message: { is_user: true, name: 'User', mes: 'This should never be persisted.' },
            stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'Meta/background result.' } }] }, 'the generated text still reaches the client unmodified');

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
        const swipedNodeId = branchBefore.branch.leaf_id;
        const swipedAncestry = (await user.store.chats.load({ tree: await treeOf(user.store, { avatar: ownerId }), at: swipedNodeId })).messages;
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
        assert.equal(data.choices?.[0]?.message?.content, 'Greetings, traveler!', 'the generated text still reaches the client unmodified');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, swipeBranch);
        assert.notEqual(branchAfter.branch.leaf_id, swipedNodeId, 'the branch is now positioned on a DIFFERENT node - the new alternative');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Greetings, traveler!', 'the new alternative is now the active/default path');

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
        assert.equal(data.choices?.[0]?.message?.content, ' there was a brave adventurer.', 'the generated text still reaches the client unmodified');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, continueBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no new node (user or assistant) was created - continue only edits the existing leaf');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the SAME node is still the leaf - editMessage() edits in place, it does not reparent/replace the node');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Once upon a time, there was a brave adventurer.', 'the stored text is now oldText + newText, on the same node, at the same position');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].name, 'Rex');
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
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ' And elves too.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
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
        assert.equal(newLeaf.mes, 'Wait, actually - tell me about dragons instead. And elves too.');
        assert.equal(newLeaf.is_user, true);
        assert.equal(data.assistant_node_id, branchAfter.branch.leaf_id);

        const originalNode = (await user.store.chats.alternatives({ node_id: originalLeafId })).alternatives.find(a => a.node_id === originalLeafId);
        assert.equal(originalNode.mes, 'Once upon a time,', 'the assistant message before it is unchanged');
    }

    {
        const nova = await writeCharacter('Nova.png', {
            name: 'Nova',
            description: 'Nova is a stoic starship engineer.',
            data: { name: 'Nova', description: 'Nova is a stoic starship engineer.', first_mes: 'Systems nominal.' },
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
            generation_mode: 1,
            disabled_members: [],
            fav: false,
            chat_id: groupChatId,
            chats: [groupChatId],
            auto_mode_delay: 5,
            generation_mode_join_prefix: '',
            generation_mode_join_suffix: '',
        };
        await user.store.lib.writeGroup(groupMetadata);

        await saveBranch(user.store, { group: groupId }, groupChatId, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hello, party!', send_date: 1, extra: {} },
            { name: 'Zephyr', is_user: false, mes: 'Winds are shifting!', send_date: 2, extra: {} },
        ]);

        const groupLeafId = (await loadBranch(user.store, { group: groupId }, groupChatId)).branch.leaf_id;

        const builtGroup = await buildRawActionChatCompletionRequest(directories, {
            characterAvatar: nova, groupId, ownerId: groupId, chat: await chatContextOf(user.store, { group: groupId }, await sessionAt(user.store, groupLeafId)), nodeId: groupLeafId,
            type: 'normal', userMessageText: 'Nova, status report?',
        });

        assert.equal(builtGroup.name2, 'Nova', 'name2 resolves to the SPECIFIC RESPONDING MEMBER (characterAvatar), not the group\'s own name, even though groupId is also set');
        assert.ok(Array.isArray(builtGroup.params.messages), 'params.messages is the real, prepared chat-completion message array');
        const groupJoined = builtGroup.params.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
        assert.ok(groupJoined.includes('Nova is a stoic starship engineer.'), 'the assembled messages reflect the COMBINED group cards (Nova\'s own description)');
        assert.ok(groupJoined.includes('Zephyr is a chaotic weather spirit.'), 'the assembled messages ALSO reflect the OTHER member\'s combined-card description - proving real combining, not just the responding member\'s own uncombined card');
        assert.ok(groupJoined.includes('Zephyr: Winds are shifting!'), 'the real group chat HISTORY is name-prefixed for the non-responding member, per real isGroup-driven name-prefixing');
        assert.ok(groupJoined.includes('Nova, status report?'), 'the raw user_message made it into the prepared messages');

        const branchBeforeGroup = await loadBranch(user.store, { group: groupId }, groupChatId);
        const messageCountBeforeGroup = branchBeforeGroup.messages.length;

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'All systems nominal, Captain.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: groupId, character_avatar: nova, group_id: groupId, node_id: branchBeforeGroup.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Nova, status report?' }, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the group raw-action generation succeeds');
        assert.equal(data.choices?.[0]?.message?.content, 'All systems nominal, Captain.', 'response body reaches the client unmodified');
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
        const { status, bodyBytes } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed.' }, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assertStreamCarriesAssistantNodeId(bodyBytes, fakeBackend.expectedText);

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, streamBranch);
            return branch.messages.length === messageCountBefore + 2 ? branch : null;
        });
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, streamed.');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back, streamed.', 'the full text, accumulated across every SSE chunk, was persisted - not just the last chunk');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex');
    }

    {
        const chatName = 'stream-instruct-model-chat';
        await saveBranch(user.store, { avatar: ownerId }, chatName, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: `Hello there, ${chatName}.`, send_date: 1, extra: {} },
        ]);

        const chunks = ['Rex ', 'answers ', 'as an ', 'instruct model, ', 'streamed.'];
        const requestedPaths = [];
        const fakeBackend = await startFakeBackend((req, res) => {
            requestedPaths.push((req.url ?? '').split('?')[0]);
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(chunks.map(text => `data: ${JSON.stringify({ choices: [{ text, index: 0 }] })}\n\n`).join('') + 'data: [DONE]\n\n');
        });
        const settings = buildSettingsFixture();
        settings.oai_settings.chat_completion_source = 'openai';
        settings.oai_settings.openai_model = 'gpt-3.5-turbo-instruct';
        settings.oai_settings.reverse_proxy = `${fakeBackend.url}/v1`;
        writeAllSettings(directories, settings);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, chatName);
        try {
            const { status, bodyBytes } = await postGenerateStream(buildTestApp(), {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Instruct question, streamed?' }, stream: true,
            });

            assert.equal(status, 200);
            assert.deepEqual(requestedPaths, ['/v1/completions'], 'a text-completion model is sent to /completions');
            const nodeId = assertStreamCarriesAssistantNodeId(bodyBytes, chunks.join(''));
            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, chatName);
            assert.deepEqual(
                branchAfter.messages.slice(branchBefore.messages.length).map(m => ({ is_user: m.is_user, mes: m.mes })),
                [{ is_user: true, mes: 'Instruct question, streamed?' }, { is_user: false, mes: chunks.join('') }],
                'the user message and the streamed reply are both stored',
            );
            assert.equal(nodeId, branchAfter.branch.leaf_id, 'the stream names the node the reply is stored at');
        } finally {
            fakeBackend.server.close();
            writeAllSettings(directories, buildSettingsFixture());
        }
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
        const { status, bodyBytes } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'swipe', is_swipe: true, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assertStreamCarriesAssistantNodeId(bodyBytes, fakeBackend.expectedText);

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, streamSwipeBranch);
            return branch.branch.leaf_id !== swipedNodeId ? branch : null;
        });
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Greetings, traveler, streamed!');
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
        const { status, bodyBytes } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'continue', is_continue: true, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assertStreamCarriesAssistantNodeId(bodyBytes, fakeBackend.expectedText);

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, streamContinueBranch);
            const leaf = branch.messages[branch.messages.length - 1];
            return leaf.mes === 'Once upon a streaming time, there was a brave, streamed adventurer.' ? branch : null;
        });
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no new node was created - the streamed continue only edited the existing leaf');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the SAME node is still the leaf');
    }

    {
        const fakeBackend = await startFakeSseBackend(['This ', 'is ', 'a ', 'plain ', 'legacy ', 'stream.']);
        pointBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, bodyBytes } = await postGenerateStream(app, {
            messages: [{ role: 'user', content: 'Legacy raw prompt, no raw-action fields.' }],
            model: 'test-model', chat_completion_source: 'custom', custom_url: fakeBackend.url, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        const decoder = new CompactStreamDecoder();
        const events = [...decoder.push(new Uint8Array(bodyBytes)), ...decoder.flush()];
        const content = events.filter(event => 'content' in event).map(event => event.content).join('');
        assert.equal(content, fakeBackend.expectedText, 'a non-raw-action stream is now also re-encoded into the compact binary wire format');
        assert.equal(events.some(event => 'assistantNodeId' in event), false, 'nothing is persisted for a non-raw-action stream, so no assistant_node_id frame is emitted');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'nothing was persisted onto any tree for a non-raw-action stream');
    }

    {
        const claudeBranch = 'claude-plain-chat';
        await saveBranch(user.store, { avatar: ownerId }, claudeBranch, [
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

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, claudeBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, Claude.' }, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        {
            const { assistant_node_id, assistant_message, ...rest } = data;
            assert.deepEqual(rest, { choices: [{ message: { content: claudeContent[0].text ?? '' } }], content: claudeContent }, 'the client-facing reply shape is exactly this function\'s own pre-existing (unmodified) content[0]-only wrapping');
            assert.deepEqual(assistant_message, {
                mes: 'Rex says hello back, Claude-style.',
                extra: { api: 'claude', model: 'claude-test-model', reasoning: 'The user wants a greeting back.', reasoning_duration: null, reasoning_signature: null, has_itemized_prompt: true },
            }, 'the reply as stored is sent too: its thinking block is its reasoning, as upstream\'s page stored it');
            assert.equal(typeof assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
            const stored = /** @type {any} */ ((await user.store.chats.readItemization({ node_id: assistant_node_id }))?.entry);
            assert.equal(stored?.api, 'openai', 'the server stores the itemization of the prompt it built');
            assert.equal(stored.rawPrompt.at(-1).role, 'user', 'with the messages it sent');
            assert.ok(JSON.stringify(stored.rawPrompt.at(-1).content).includes('Say hi, Claude.'));
            const history = stored.parts.find((/** @type {any} */ p) => p.part === 'chat_history');
            assert.equal(stored.parts.some((/** @type {any} */ p) => p.part === 'post_history'), false, 'no post-history instructions were set, so none is listed');
            assert.ok(history?.tokens > 0 && stored.total >= history.tokens, 'with the counts it budgeted with');
            assert.equal(stored.messages_count, 2);
        }

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, claudeBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, Claude.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, Claude-style.', 'only the real type: \'text\' block was persisted - the type: \'thinking\' block is completely absent from the persisted text');
        assert.equal(assistantMsg.extra?.reasoning, 'The user wants a greeting back.', 'the thinking block is stored as the reply\'s reasoning');
        assert.equal(assistantMsg.name, 'Rex');
    }

    {
        const claudeStreamBranch = 'claude-stream-chat';
        await saveBranch(user.store, { avatar: ownerId }, claudeStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, claudeStreamBranch)).branch.leaf_id;

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
        const { status, bodyBytes } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed Claude.' }, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assertStreamCarriesAssistantNodeId(bodyBytes, 'Rex says hi, streamed via Claude.', { expectedReasoning: 'Thinking about a greeting...' });

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, claudeStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Claude.', 'only text_delta chunks were accumulated - the thinking_delta event never contributed to the persisted text');
        assert.equal(assistantMsg.name, 'Rex');
    }

    {
        const makerSuiteBranch = 'makersuite-plain-chat';
        await saveBranch(user.store, { avatar: ownerId }, makerSuiteBranch, [
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

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, makerSuiteBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, Gemini.' }, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(data?.choices?.[0]?.message?.content, 'Rex says hello back, Gemini-style.', 'the client-facing reply already excluded the thought part - this function\'s own pre-existing, unmodified behavior');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, makerSuiteBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, Gemini.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, Gemini-style.', 'only the real, non-thought part was persisted');
        assert.equal(assistantMsg.name, 'Rex');
    }

    {
        const makerSuiteStreamBranch = 'makersuite-stream-chat';
        await saveBranch(user.store, { avatar: ownerId }, makerSuiteStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, makerSuiteStreamBranch)).branch.leaf_id;

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
        const { status, bodyBytes } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed Gemini.' }, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assertStreamCarriesAssistantNodeId(bodyBytes, 'Rex says hi, streamed via Gemini.', { expectedReasoning: 'Thinking about a greeting...' });

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, makerSuiteStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Gemini.', 'the thought-only chunk never contributed to the persisted text');
        assert.equal(assistantMsg.name, 'Rex');
    }

    {
        const mistralBranch = 'mistral-plain-chat';
        await saveBranch(user.store, { avatar: ownerId }, mistralBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const mistralBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, Mistral-style.' } }] };
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mistralBody));
        });
        pointMistralBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, mistralBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, Mistral.' }, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        {
            const { assistant_node_id, assistant_message, ...rest } = data;
            assert.equal(typeof assistant_message?.mes, 'string', 'the stored reply is sent with the answer');
            assert.deepEqual(rest, mistralBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');
            assert.equal(typeof assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
        }

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, mistralBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, Mistral.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, Mistral-style.');
        assert.equal(assistantMsg.name, 'Rex');
    }

    {
        const mistralStreamBranch = 'mistral-stream-chat';
        await saveBranch(user.store, { avatar: ownerId }, mistralStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, mistralStreamBranch)).branch.leaf_id;

        const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via Mistral.']);
        pointMistralBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyBytes } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed Mistral.' }, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assertStreamCarriesAssistantNodeId(bodyBytes, fakeBackend.expectedText);

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, mistralStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Mistral.');
        assert.equal(assistantMsg.name, 'Rex');
    }

    {
        const deepseekBranch = 'deepseek-plain-chat';
        await saveBranch(user.store, { avatar: ownerId }, deepseekBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const deepseekBody = { choices: [{ message: { role: 'assistant', reasoning_content: 'The user wants a greeting back.', content: 'Rex says hello back, DeepSeek-style.' } }] };
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(deepseekBody));
        });
        pointDeepSeekBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, deepseekBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, DeepSeek.' }, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        {
            const { assistant_node_id, assistant_message, ...rest } = data;
            assert.equal(typeof assistant_message?.mes, 'string', 'the stored reply is sent with the answer');
            assert.deepEqual(rest, deepseekBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');
            assert.equal(typeof assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
        }

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, deepseekBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, DeepSeek.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, DeepSeek-style.', 'only the real content field was persisted - reasoning_content is completely absent from the persisted text');
        assert.equal(assistantMsg.name, 'Rex');
    }

    {
        const deepseekStreamBranch = 'deepseek-stream-chat';
        await saveBranch(user.store, { avatar: ownerId }, deepseekStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, deepseekStreamBranch)).branch.leaf_id;

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
        const { status, bodyBytes } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed DeepSeek.' }, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assertStreamCarriesAssistantNodeId(bodyBytes, 'Rex says hi, streamed via DeepSeek.', { expectedReasoning: 'Thinking about a greeting...' });

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, deepseekStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via DeepSeek.', 'only delta.content chunks were accumulated - the reasoning_content-only chunk never contributed to the persisted text');
        assert.equal(assistantMsg.name, 'Rex');
    }

    {
        const xaiBranch = 'xai-plain-chat';
        await saveBranch(user.store, { avatar: ownerId }, xaiBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const xaiBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, xAI-style.' } }] };
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(xaiBody));
        });
        pointXaiBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, xaiBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, xAI.' }, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        {
            const { assistant_node_id, assistant_message, ...rest } = data;
            assert.equal(typeof assistant_message?.mes, 'string', 'the stored reply is sent with the answer');
            assert.deepEqual(rest, xaiBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');
            assert.equal(typeof assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
        }

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, xaiBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, xAI.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, xAI-style.');
        assert.equal(assistantMsg.name, 'Rex');
    }

    {
        const xaiStreamBranch = 'xai-stream-chat';
        await saveBranch(user.store, { avatar: ownerId }, xaiStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, xaiStreamBranch)).branch.leaf_id;

        const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via xAI.']);
        pointXaiBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyBytes } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed xAI.' }, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assertStreamCarriesAssistantNodeId(bodyBytes, fakeBackend.expectedText);

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, xaiStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via xAI.');
        assert.equal(assistantMsg.name, 'Rex');
    }

    if (!canMockAi21Backend) {
        console.log('chat-completions.test.js: skipping sendAI21Request/sendCohereRequest/sendAimlapiRequest persistence tests - run with `node --experimental-test-module-mocks` to include them (see the canMockAi21Backend comment near the top of this file)');
    } else {
        {
            const ai21Branch = 'ai21-plain-chat';
            await saveBranch(user.store, { avatar: ownerId }, ai21Branch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const ai21Body = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, AI21-style.' } }] };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(ai21Body));
            });
            pointAI21BackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(user.store, { avatar: ownerId }, ai21Branch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, AI21.' }, stream: false,
            });
            fakeBackend.server.close();
            ai21FakeBackendUrl = null;

            assert.equal(status, 200);
            {
                const { assistant_node_id, assistant_message, ...rest } = data;
                assert.equal(typeof assistant_message?.mes, 'string', 'the stored reply is sent with the answer');
                assert.deepEqual(rest, ai21Body, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');
                assert.equal(typeof assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
            }

            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, ai21Branch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, AI21.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, AI21-style.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const ai21StreamBranch = 'ai21-stream-chat';
            await saveBranch(user.store, { avatar: ownerId }, ai21StreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, ai21StreamBranch)).branch.leaf_id;

            const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via AI21.']);
            pointAI21BackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyBytes } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed AI21.' }, stream: true,
            });
            fakeBackend.server.close();
            ai21FakeBackendUrl = null;

            assert.equal(status, 200);
            assertStreamCarriesAssistantNodeId(bodyBytes, fakeBackend.expectedText);

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(user.store, { avatar: ownerId }, ai21StreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via AI21.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const ai21CoalesceBranch = 'ai21-coalesce-stream-chat';
            await saveBranch(user.store, { avatar: ownerId }, ai21CoalesceBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, ai21CoalesceBranch)).branch.leaf_id;

            const fullText = 'Rex says hi in fifty tiny streamed pieces, one at a time!!';
            const fakeBackend = await startFakeSseBackend(fullText.split(''));
            pointAI21BackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyBytes } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, coalesced AI21.' }, stream: true,
            });
            fakeBackend.server.close();
            ai21FakeBackendUrl = null;

            assert.equal(status, 200);
            assertStreamCarriesAssistantNodeId(bodyBytes, fullText);

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(user.store, { avatar: ownerId }, ai21CoalesceBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, fullText, 'the persisted reply exactly matches the reassembled coalesced stream');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const cohereBranch = 'cohere-plain-chat';
            await saveBranch(user.store, { avatar: ownerId }, cohereBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const cohereBody = { message: { role: 'assistant', tool_plan: 'I will just greet the user.', content: [{ type: 'text', text: 'Rex says hello back, Cohere-style.' }] } };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(cohereBody));
            });
            pointCohereBackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(user.store, { avatar: ownerId }, cohereBranch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, Cohere.' }, stream: false,
            });
            fakeBackend.server.close();
            cohereFakeBackendUrl = null;

            assert.equal(status, 200);
            {
                const { assistant_node_id, assistant_message, ...rest } = data;
                assert.equal(typeof assistant_message?.mes, 'string', 'the stored reply is sent with the answer');
                assert.deepEqual(rest, cohereBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');
                assert.equal(typeof assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
            }

            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, cohereBranch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, Cohere.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, Cohere-style.', 'the real type: \'text\' content block was persisted, NOT the tool_plan fallback (which is only used when there is no real text content)');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const cohereStreamBranch = 'cohere-stream-chat';
            await saveBranch(user.store, { avatar: ownerId }, cohereStreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, cohereStreamBranch)).branch.leaf_id;

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
            const { status, bodyBytes } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed Cohere.' }, stream: true,
            });
            fakeBackend.server.close();
            cohereFakeBackendUrl = null;

            assert.equal(status, 200);
            assertStreamCarriesAssistantNodeId(bodyBytes, 'Rex says hi, streamed via Cohere.');

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(user.store, { avatar: ownerId }, cohereStreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Cohere.', 'only content-delta events\' own delta.message.content.text were accumulated');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const aimlapiBranch = 'aimlapi-plain-chat';
            await saveBranch(user.store, { avatar: ownerId }, aimlapiBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const aimlapiBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, AI/ML-API-style.' } }] };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(aimlapiBody));
            });
            pointAimlapiBackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(user.store, { avatar: ownerId }, aimlapiBranch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, AI/ML API.' }, stream: false,
            });
            fakeBackend.server.close();
            aimlapiFakeBackendUrl = null;

            assert.equal(status, 200);
            {
                const { assistant_node_id, assistant_message, ...rest } = data;
                assert.equal(typeof assistant_message?.mes, 'string', 'the stored reply is sent with the answer');
                assert.deepEqual(rest, aimlapiBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');
                assert.equal(typeof assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
            }

            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, aimlapiBranch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, AI/ML API.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, AI/ML-API-style.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const aimlapiStreamBranch = 'aimlapi-stream-chat';
            await saveBranch(user.store, { avatar: ownerId }, aimlapiStreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, aimlapiStreamBranch)).branch.leaf_id;

            const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via AI/ML API.']);
            pointAimlapiBackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyBytes } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed AI/ML API.' }, stream: true,
            });
            fakeBackend.server.close();
            aimlapiFakeBackendUrl = null;

            assert.equal(status, 200);
            assertStreamCarriesAssistantNodeId(bodyBytes, fakeBackend.expectedText);

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(user.store, { avatar: ownerId }, aimlapiStreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via AI/ML API.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const chutesBranch = 'chutes-plain-chat';
            await saveBranch(user.store, { avatar: ownerId }, chutesBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const chutesBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, Chutes-style.' } }] };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(chutesBody));
            });
            pointChutesBackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(user.store, { avatar: ownerId }, chutesBranch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, Chutes.' }, stream: false,
            });
            fakeBackend.server.close();
            chutesFakeBackendUrl = null;

            assert.equal(status, 200);
            {
                const { assistant_node_id, assistant_message, ...rest } = data;
                assert.equal(typeof assistant_message?.mes, 'string', 'the stored reply is sent with the answer');
                assert.deepEqual(rest, chutesBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');
                assert.equal(typeof assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
            }

            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, chutesBranch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, Chutes.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, Chutes-style.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const chutesStreamBranch = 'chutes-stream-chat';
            await saveBranch(user.store, { avatar: ownerId }, chutesStreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, chutesStreamBranch)).branch.leaf_id;

            const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via Chutes.']);
            pointChutesBackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyBytes } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed Chutes.' }, stream: true,
            });
            fakeBackend.server.close();
            chutesFakeBackendUrl = null;

            assert.equal(status, 200);
            assertStreamCarriesAssistantNodeId(bodyBytes, fakeBackend.expectedText);

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(user.store, { avatar: ownerId }, chutesStreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Chutes.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const minimaxBranch = 'minimax-plain-chat';
            await saveBranch(user.store, { avatar: ownerId }, minimaxBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const minimaxBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, MiniMax-style.' } }] };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(minimaxBody));
            });
            pointMinimaxBackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(user.store, { avatar: ownerId }, minimaxBranch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, MiniMax.' }, stream: false,
            });
            fakeBackend.server.close();
            minimaxFakeBackendUrl = null;

            assert.equal(status, 200);
            {
                const { assistant_node_id, assistant_message, ...rest } = data;
                assert.equal(typeof assistant_message?.mes, 'string', 'the stored reply is sent with the answer');
                assert.deepEqual(rest, minimaxBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');
                assert.equal(typeof assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
            }

            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, minimaxBranch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, MiniMax.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, MiniMax-style.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const minimaxStreamBranch = 'minimax-stream-chat';
            await saveBranch(user.store, { avatar: ownerId }, minimaxStreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, minimaxStreamBranch)).branch.leaf_id;

            const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via MiniMax.']);
            pointMinimaxBackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyBytes } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed MiniMax.' }, stream: true,
            });
            fakeBackend.server.close();
            minimaxFakeBackendUrl = null;

            assert.equal(status, 200);
            assertStreamCarriesAssistantNodeId(bodyBytes, fakeBackend.expectedText);

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(user.store, { avatar: ownerId }, minimaxStreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via MiniMax.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const electronhubBranch = 'electronhub-plain-chat';
            await saveBranch(user.store, { avatar: ownerId }, electronhubBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const electronhubBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, Electron-Hub-style.' } }] };
            const fakeBackend = await startFakeBackend((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(electronhubBody));
            });
            pointElectronHubBackendAt(fakeBackend.url);

            const branchBefore = await loadBranch(user.store, { avatar: ownerId }, electronhubBranch);
            const messageCountBefore = branchBefore.messages.length;

            const app = buildTestApp();
            const { status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, Electron Hub.' }, stream: false,
            });
            fakeBackend.server.close();
            electronhubFakeBackendUrl = null;

            assert.equal(status, 200);
            {
                const { assistant_node_id, assistant_message, ...rest } = data;
                assert.equal(typeof assistant_message?.mes, 'string', 'the stored reply is sent with the answer');
                assert.deepEqual(rest, electronhubBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');
                assert.equal(typeof assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
            }

            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, electronhubBranch);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2);
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'Say hi, Electron Hub.');
            assert.equal(assistantMsg.mes, 'Rex says hello back, Electron-Hub-style.');
            assert.equal(assistantMsg.name, 'Rex');
        }

        {
            const electronhubStreamBranch = 'electronhub-stream-chat';
            await saveBranch(user.store, { avatar: ownerId }, electronhubStreamBranch, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
            ]);

            const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, electronhubStreamBranch)).branch.leaf_id;

            const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via Electron Hub.']);
            pointElectronHubBackendAt(fakeBackend.url);

            const app = buildTestApp();
            const { status, bodyBytes } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed Electron Hub.' }, stream: true,
            });
            fakeBackend.server.close();
            electronhubFakeBackendUrl = null;

            assert.equal(status, 200);
            assertStreamCarriesAssistantNodeId(bodyBytes, fakeBackend.expectedText);

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(user.store, { avatar: ownerId }, electronhubStreamBranch);
                return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
            });
            const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
            assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Electron Hub.');
            assert.equal(assistantMsg.name, 'Rex');
        }
    }

    {
        const azureBranch = 'azure-openai-plain-chat';
        await saveBranch(user.store, { avatar: ownerId }, azureBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const azureBody = { choices: [{ message: { role: 'assistant', content: 'Rex says hello back, Azure-style.' } }] };
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(azureBody));
        });
        pointAzureOpenAIBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, azureBranch);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, Azure.' }, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        {
            const { assistant_node_id, assistant_message, ...rest } = data;
            assert.equal(typeof assistant_message?.mes, 'string', 'the stored reply is sent with the answer');
            assert.deepEqual(rest, azureBody, 'the client-facing response body is byte-for-byte/structurally identical to what the fake backend sent - unchanged from before this task');
            assert.equal(typeof assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
        }

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, azureBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2);
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'Say hi, Azure.');
        assert.equal(assistantMsg.mes, 'Rex says hello back, Azure-style.');
        assert.equal(assistantMsg.name, 'Rex');
    }

    {
        const azureStreamBranch = 'azure-openai-stream-chat';
        await saveBranch(user.store, { avatar: ownerId }, azureStreamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);

        const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, azureStreamBranch)).branch.leaf_id;

        const fakeBackend = await startFakeSseBackend(['Rex ', 'says hi, ', 'streamed via Azure.']);
        pointAzureOpenAIBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, bodyBytes } = await postGenerateStream(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Say hi, streamed Azure.' }, stream: true,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assertStreamCarriesAssistantNodeId(bodyBytes, fakeBackend.expectedText);

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, azureStreamBranch);
            return branch.messages.length > 1 && branch.messages[branch.messages.length - 1].mes ? branch : null;
        });
        const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(assistantMsg.mes, 'Rex says hi, streamed via Azure.');
        assert.equal(assistantMsg.name, 'Rex');
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
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Got your file.' } }] }));
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

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const persistedUserMsg = branchAfter.messages[branchAfter.messages.length - 2];
        assert.equal(persistedUserMsg.mes, 'Check the attached file.', 'the persisted node keeps the ORIGINAL (non-inlined) message text - inlining only affects the outgoing prompt, not what is stored');
        assert.deepEqual(
            persistedUserMsg.extra,
            { files: [{ url: '/user/files/raw-action-attach.txt', size: 25, name: 'raw-action-attach.txt', created: 1700000000000 }] },
            'the persisted user message node carries the (sanitized) forwarded extra unchanged',
        );
    }

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

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', stream: false,
            user_message: { is_user: true, name: 'User', mes: 'Look at this.', extra: { media: [{ url: dataUrl, type: 'image', source: 'upload' }], media_index: 0 } },
        });
        fakeBackend.server.close();
        pointBackendAt(fakeBackend.url);

        assert.equal(status, 200);
        assert.ok(capturedRequestBody, 'the fake backend actually received a request');
        const outgoingMessages = capturedRequestBody.messages;
        assert.ok(Array.isArray(outgoingMessages), 'the outgoing request carries a real messages array');
        const turnWithImage = outgoingMessages.find(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
        assert.ok(
            turnWithImage,
            `expected an outgoing message with a real image_url content part, got: ${JSON.stringify(outgoingMessages)}`,
        );

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const persistedUserMsg = branchAfter.messages[branchAfter.messages.length - 2];
        assert.equal(persistedUserMsg.mes, 'Look at this.');
        assert.deepEqual(persistedUserMsg.extra, { media: [{ url: dataUrl, type: 'image', source: 'upload' }], media_index: 0 });
    }

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Fine either way.' } }] }));
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
        let capturedBody = null;
        const fakeBackend = await startFakeBackend((_req, res, body) => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'No tools here.' } }] }));
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const toolBranch = 'tool-branch-no-tools-registered';
        await saveBranch(user.store, { avatar: ownerId }, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, no-tools-registered branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, no-tools-registered branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, toolBranch);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Anything new?' }, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200);
        assert.equal(data.choices?.[0]?.message?.content, 'No tools here.');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');
        assert.ok(capturedBody, 'the fake backend actually received a request');
        assert.equal(capturedBody.tools, undefined, 'no `tools` field is sent when no tools are advertised');
        assert.equal(capturedBody.tool_choice, undefined);

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'No tools here.', 'plain-text persistence');
    }

    {
        const toolBranch = 'tool-branch-client-only-pending';
        await saveBranch(user.store, { avatar: ownerId }, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, client-only-pending branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, client-only-pending branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
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
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Open the curtains.' }, stream: false,
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

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'user message + one in-flight tool-invocation node were persisted (no final reply yet)');
        const toolMsg = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(toolMsg.node_id, data.pending_tool_calls[0].node_id, 'the response names the exact node that was persisted');
        assert.ok(Array.isArray(toolMsg.extra?.tool_invocations));
        assert.equal(toolMsg.extra.tool_invocations.length, 1);
        assert.equal(toolMsg.extra.tool_invocations[0].id, 'call_curtains');
        assert.equal(toolMsg.extra.tool_invocations[0].result, null, 'in-flight: not yet resolved by a tool_result follow-up');
        assert.equal(toolMsg.extra.tool_invocations[0].error, null);
    }

    {
        const toolBranch = 'tool-branch-tool-result-followup';
        await saveBranch(user.store, { avatar: ownerId }, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, tool-result-followup branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, tool-result-followup branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
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
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'What time is it?' }, stream: false,
            client_tools: clientTools,
        });
        assert.equal(status1, 200);
        assert.equal(data1.pending_tool_calls.length, 1);
        const pendingNodeId = data1.pending_tool_calls[0].node_id;

        const midBranch = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
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
        assert.equal(data2.choices?.[0]?.message?.content, 'It is currently 3pm where you are.');
        assert.equal(typeof data2.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const secondRequestDump = JSON.stringify(requestBodies[1].messages);
        assert.ok(secondRequestDump.includes('get_local_time'), 'second request history includes the tool call by name');
        assert.ok(secondRequestDump.includes('15:00'), 'second request history includes the submitted result text');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 3, 'exactly ONE new node was added by the tool_result follow-up (the final reply) - the pending node was edited in place, not duplicated');
        const [, toolMsg, finalMsg] = branchAfter.messages.slice(-3);
        assert.equal(toolMsg.node_id, pendingNodeId, 'the SAME node id - editMessage() edited it in place rather than appending a new one');
        assert.equal(toolMsg.extra.tool_invocations[0].result, '15:00', 'the pending invocation was filled in with the real submitted result');
        assert.equal(toolMsg.extra.tool_invocations[0].error, false);
        assert.equal(finalMsg.mes, 'It is currently 3pm where you are.');
        assert.equal(finalMsg.is_user, false);
    }

    {
        const toolBranch = 'tool-branch-neither-known';
        await saveBranch(user.store, { avatar: ownerId }, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, neither-known branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, neither-known branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
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
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Call something imaginary.' }, stream: false,
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

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was appended - no tool-call turn for a wholly-unrecognized round');
    }

    {
        const toolBranch = 'stream-tool-branch-client-only';
        await saveBranch(user.store, { avatar: ownerId }, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, streaming client-tool branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, streaming client-tool branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, toolBranch);

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
        let status, bodyBytes;
        try {
            ({ status, bodyBytes } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Open the curtains, streamed.' }, stream: true,
                client_tools: [{ type: 'function', function: { name: 'open_curtains', description: 'Opens the curtains.', parameters: { type: 'object', properties: { side: { type: 'string' } } } } }],
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(status, 200);
        assert.equal(callCount, 1, 'the backend is never re-called for a client-only hand-off - there is nothing left for the server to resolve');

        const decoded = decodeCompactToolStream(bodyBytes);
        assert.deepEqual(decoded.toolCallDeltas, [
            { index: 0, id: 'call_curtains_stream', type: 'function', function: { name: 'open_curtains', arguments: '' } },
            { index: 0, function: { arguments: '{"side": "left"}' } },
        ], 'the real tool_calls deltas ARE forwarded as 0x05 frames (the compact-stream client never runs the legacy accumulation those used to have to be hidden from)');

        const handoffPayload = decoded.control;
        assert.ok(handoffPayload?.tool_call_handoff, 'a tool_call_handoff control (0x08) frame was sent before the stream closed');
        assert.ok(Array.isArray(handoffPayload.tool_call_handoff.pending_tool_calls) && handoffPayload.tool_call_handoff.pending_tool_calls.length === 1);
        assert.equal(handoffPayload.tool_call_handoff.pending_tool_calls[0].tool_call_id, 'call_curtains_stream');
        assert.equal(handoffPayload.tool_call_handoff.pending_tool_calls[0].name, 'open_curtains');
        assert.deepEqual(handoffPayload.tool_call_handoff.pending_tool_calls[0].arguments, { side: 'left' });
        assert.equal(handoffPayload.tool_call_handoff.node_id, handoffPayload.tool_call_handoff.pending_tool_calls[0].node_id);

        const branchAfterHandoff = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
        const toolMsg = branchAfterHandoff.messages[branchAfterHandoff.messages.length - 1];
        assert.equal(toolMsg.node_id, handoffPayload.tool_call_handoff.node_id);
        assert.equal(toolMsg.extra.tool_invocations[0].result, null, 'in-flight: not yet resolved by a tool_result follow-up');

        const app2 = buildTestApp();
        const { status: status2, data: data2 } = await postGenerate(app2, {
            owner_id: ownerId, character_avatar: avatar, node_id: handoffPayload.tool_call_handoff.node_id, type: 'tool_result',
            tool_results: [{ id: 'call_curtains_stream', result: 'Curtains opened on the left.', error: false }],
        });
        assert.equal(status2, 502, 'no fake backend is listening any more for the follow-up round - a real, sane error (connection refused), not a hang or an unhandled crash');
        assert.ok(data2.error, 'a real error body, not a silent failure');

        const branchAfterFollowUp = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
        const resolvedToolMsg = branchAfterFollowUp.messages.find(m => m.node_id === handoffPayload.tool_call_handoff.node_id);
        assert.equal(resolvedToolMsg.extra.tool_invocations[0].result, 'Curtains opened on the left.', 'the in-place edit resolving the pending node still happened even though the follow-up round\'s own backend call then failed');
    }

    {
        const toolBranch = 'tool-branch-all-stealth-abort';
        await saveBranch(user.store, { avatar: ownerId }, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, all-stealth-abort branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, all-stealth-abort branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
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
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Think something.' }, stream: false,
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

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user\'s own message was persisted - no tool-invocation node, no assistant reply, matching legacy\'s "nothing new appears"');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Think something.');
    }

    {
        const toolBranch = 'tool-branch-mixed-stealth-abort';
        await saveBranch(user.store, { avatar: ownerId }, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, mixed-stealth-abort branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, mixed-stealth-abort branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
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
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Think something and open the curtains.' }, stream: false,
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

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user\'s own message was persisted - the non-stealth call\'s own in-flight node was never created either');
    }

    {
        const toolBranch = 'stream-tool-branch-all-stealth-abort';
        await saveBranch(user.store, { avatar: ownerId }, toolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, streaming all-stealth-abort branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, streaming all-stealth-abort branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
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
        let status, bodyBytes;
        try {
            ({ status, bodyBytes } = await postGenerateStream(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Think something, streamed.' }, stream: true,
                client_tools: [{ type: 'function', function: { name: 'log_secret_thought', description: 'Silently records a thought (client-only, stealth).', parameters: { type: 'object', properties: {} } } }],
                stealth_tool_names: ['log_secret_thought'],
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(callCount, 1, 'the backend is never re-called for an aborted round');
        assert.equal(status, 200);

        const decoded = decodeCompactToolStream(bodyBytes);
        assert.deepEqual(decoded.toolCallDeltas, [
            { index: 0, id: 'call_stealth_stream', type: 'function', function: { name: 'log_secret_thought', arguments: '{}' } },
        ], 'the real tool_calls delta is forwarded as a 0x05 frame');
        assert.equal(decoded.content, '', 'no further content chunk after the round was aborted');
        assert.deepEqual(decoded.control, { tool_call_aborted: true }, 'a tool_call_aborted control frame was sent - an aborted round is NOT a hand-off');
        assert.equal(decoded.assistantNodeId, null, 'nothing was persisted, so no assistant_node_id frame either');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, toolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user\'s own message was persisted - no tool-invocation node, no assistant reply');
    }

    {
        const swipeToolBranch = 'swipe-tool-branch';
        await saveBranch(user.store, { avatar: ownerId }, swipeToolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, swipe-with-tool branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, swipe-with-tool branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, swipeToolBranch);
        const swipedNodeId = branchBefore.branch.leaf_id;
        const swipedAncestry = (await user.store.chats.load({ tree: await treeOf(user.store, { avatar: ownerId }), at: swipedNodeId })).messages;
        const parentNodeId = swipedAncestry[swipedAncestry.length - 2].node_id;

        const clientTools = [{
            type: 'function',
            function: { name: 'get_weather', description: 'Gets the current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
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
        let status1, data1, status2, data2;
        try {
            ({ status: status1, data: data1 } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: swipedNodeId,
                type: 'swipe', is_swipe: true, stream: false, client_tools: clientTools,
            }));
            assert.equal(status1, 200);
            assert.equal(data1.pending_tool_calls?.length, 1, 'the swipe\'s tool call is handed to the page');

            ({ status: status2, data: data2 } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: data1.pending_tool_calls[0].node_id, type: 'tool_result',
                tool_results: [{ id: 'call_swipe_1', result: 'Sunny in Swiptown', error: false }],
                client_tools: clientTools,
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(status2, 200, 'the tool_result follow-up completes normally');
        assert.equal(data2.choices?.[0]?.message?.content, 'General Kenobi! (checked: sunny in Swiptown)');
        assert.equal(typeof data2.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back');
        assert.equal(callCount, 2, 'backend called twice: once producing the tool call, once with the final swipe text');
        assert.ok(JSON.stringify(requestBodies[1].messages).includes('Sunny in Swiptown'), 'the second request\'s history goes through the tool-call turn');

        const alternatives = await user.store.chats.alternatives({ node_id: swipedNodeId });
        assert.equal(alternatives.total, 2, 'the swiped message and the tool-call turn are siblings under the same parent');
        const toolAlt = alternatives.alternatives.find(a => a.node_id !== swipedNodeId);
        assert.ok(toolAlt, 'a second alternative alongside the swiped message exists');
        assert.equal(toolAlt.node_id, data1.pending_tool_calls[0].node_id, 'that second alternative is the tool-call turn, not the final text');
        assert.equal(toolAlt.extra.tool_invocations[0].name, 'get_weather');
        assert.equal(toolAlt.extra.tool_invocations[0].result, 'Sunny in Swiptown');

        assert.ok(alternatives.alternatives.some(a => a.node_id === swipedNodeId && a.mes === 'Hello there, swipe-with-tool branch!'), 'the swiped message\'s own content is untouched');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, swipeToolBranch);
        const finalNodeId = branchAfter.branch.leaf_id;
        assert.notEqual(finalNodeId, toolAlt.node_id, 'the final text is its own node, not stored on the tool-call turn');
        const finalAncestry = (await user.store.chats.load({ tree: await treeOf(user.store, { avatar: ownerId }), at: finalNodeId })).messages;
        assert.equal(finalAncestry.length, swipedAncestry.length + 1, 'the final text is a child of the tool-call turn, which sits at the swiped message\'s depth');
        assert.equal(finalAncestry[finalAncestry.length - 2].node_id, toolAlt.node_id, 'the final text\'s parent is the tool-call turn');
        assert.equal(finalAncestry[finalAncestry.length - 3].node_id, parentNodeId, 'the tool-call turn\'s parent is the swiped message\'s parent');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'General Kenobi! (checked: sunny in Swiptown)');
    }

    {
        const continueToolBranch = 'continue-tool-branch';
        await saveBranch(user.store, { avatar: ownerId }, continueToolBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, continue-with-tool branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'The weather today is', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, continueToolBranch);
        const continuedNodeId = branchBefore.branch.leaf_id;
        const messageCountBefore = branchBefore.messages.length;

        const clientTools = [{
            type: 'function',
            function: { name: 'get_weather', description: 'Gets the current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
        }];

        let callCount = 0;
        const fakeBackend = await startFakeBackend((_req, res) => {
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
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ' sunny, according to the tool.' } }] }));
            }
        });
        pointBackendAtWithToolsEnabled(fakeBackend.url);

        const app = buildTestApp();
        let status, data;
        try {
            const { data: pending } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: continuedNodeId,
                type: 'continue', is_continue: true, stream: false, client_tools: clientTools,
            });
            assert.equal(pending.pending_tool_calls?.length, 1, 'the continue\'s tool call is handed to the page');
            ({ status, data } = await postGenerate(app, {
                owner_id: ownerId, character_avatar: avatar, node_id: pending.pending_tool_calls[0].node_id, type: 'tool_result',
                tool_results: [{ id: 'call_continue_1', result: 'Sunny in Continuetown', error: false }],
                client_tools: clientTools,
            }));
        } finally {
            fakeBackend.server.close();
        }

        assert.equal(status, 200);
        assert.equal(data.choices?.[0]?.message?.content, ' sunny, according to the tool.');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back');
        assert.equal(callCount, 2);

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, continueToolBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'the tool-call turn and the final text were appended: a continue across a tool call becomes an append');

        const originalNode = (await user.store.chats.alternatives({ node_id: continuedNodeId })).alternatives.find(a => a.node_id === continuedNodeId);
        assert.equal(originalNode.mes, 'The weather today is', 'the continued message is unedited');

        const [toolMsg, finalMsg] = branchAfter.messages.slice(-2);
        assert.equal(toolMsg.is_system, true, 'the tool-call turn is a child of the continued message');
        assert.equal(toolMsg.extra.tool_invocations[0].result, 'Sunny in Continuetown');
        assert.equal(finalMsg.is_user, false);
        assert.equal(finalMsg.mes, 'sunny, according to the tool.', 'the final text is its own node, trimmed, not concatenated onto the continued message');
        assert.equal(finalMsg.name, 'Rex');
    }

    {
        const jsonSchemaBranch = 'json-schema-branch';
        await saveBranch(user.store, { avatar: ownerId }, jsonSchemaBranch, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hi Rex, json-schema branch.', send_date: 1, extra: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, json-schema branch!', send_date: 2, extra: {} },
        ]);
        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, jsonSchemaBranch);

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
                type: 'quiet', user_message: { is_user: true, name: 'User', mes: '' }, stream: false,
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

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, jsonSchemaBranch);
        assert.equal(branchAfter.messages.length, branchBefore.messages.length, 'a quiet generation persists neither the user nor the assistant side, json_schema or not');
    }

    {
        const failures = [];
        const chatSse = (text) => (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
        };
        const jsonAnswer = (value) => (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(value));
        };
        const unusedClientTools = [{ type: 'function', function: { name: 'stored_ref', description: 'Never called.', parameters: { type: 'object', properties: {} } } }];
        const cases = [
            { name: 'default block, non-streaming', stream: false, point: pointBackendAt, handler: jsonAnswer({ choices: [{ message: { role: 'assistant', content: 'Stored reply.' } }] }) },
            { name: 'default block, streaming', stream: true, point: pointBackendAt, handler: chatSse('Stored reply.') },
            { name: 'default block with a client tool, streaming', stream: true, point: pointBackendAtWithToolsEnabled, handler: chatSse('Stored reply.'), tool: true },
            { name: 'Claude, non-streaming', stream: false, point: pointClaudeBackendAt, handler: jsonAnswer({ content: [{ type: 'text', text: 'Stored reply.' }] }) },
            {
                name: 'Claude, streaming', stream: true, point: pointClaudeBackendAt,
                handler: (_req, res) => {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.end(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Stored reply.' } })}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                },
            },
        ];
        for (const { name, stream, point, handler, tool } of cases) {
            const chatName = `cc-stored-ref-${name.replace(/\W+/g, '-')}`;
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
                    ...(tool ? { client_tools: unusedClientTools } : {}),
                };
                let stored;
                if (stream) {
                    const { bodyBytes } = await postGenerateStream(buildTestApp(), body);
                    const decoder = new CompactStreamDecoder();
                    const events = [...decoder.push(new Uint8Array(bodyBytes)), ...decoder.flush()];
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
                assert.deepEqual(stored, [{ ref, node_id: userNode.node_id }], 'the user message\'s ref is echoed with the node it was stored at');
                console.log(`  pass: ${name}`);
            } catch (error) {
                failures.push(name);
                console.log(`  FAIL: ${name}: ${error.message}`);
            } finally {
                backend.server.close();
                writeAllSettings(directories, buildSettingsFixture());
            }
        }
        assert.deepEqual(failures, [], 'stored ref cases');
    }

    {
        const failures = [];
        const backendError = (_req, res) => {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('backend exploded');
        };
        const unusedClientTools = [{ type: 'function', function: { name: 'stored_error', description: 'Never called.', parameters: { type: 'object', properties: {} } } }];
        const passedOn = (answer) => {
            assert.equal(answer.status, 500, 'the backend\'s status is kept');
            assert.equal(answer.text, 'backend exploded', 'the backend\'s body is kept exactly');
        };
        const cases = [
            {
                name: 'default block, non-streaming, backend error (200 error body)', stream: false, point: pointBackendAt, handler: backendError,
                expect: (answer, stored) => {
                    assert.equal(answer.status, 200);
                    assert.deepEqual(JSON.parse(answer.text), { error: { message: 'Internal Server Error' }, quota_error: false, stored });
                },
            },
            {
                name: 'default block, non-streaming, backend unreachable (catch-all)', stream: false, point: pointBackendAt,
                expect: (answer, stored) => assert.deepEqual(JSON.parse(answer.text).stored, stored),
            },
            { name: 'default block, streaming, backend error passed on', stream: true, point: pointBackendAt, handler: backendError, expect: passedOn },
            { name: 'default block with a client tool, streaming, backend error passed on', stream: true, point: pointBackendAtWithToolsEnabled, handler: backendError, expect: passedOn, tool: true },
            {
                name: 'Claude, non-streaming, backend error (500)', stream: false, point: pointClaudeBackendAt, handler: backendError,
                expect: (answer, stored) => {
                    assert.equal(answer.status, 500);
                    assert.deepEqual(JSON.parse(answer.text), { error: true, stored });
                },
            },
            { name: 'Claude, streaming, backend error passed on', stream: true, point: pointClaudeBackendAt, handler: backendError, expect: passedOn },
        ];
        for (const { name, stream, point, handler, expect, tool } of cases) {
            const chatName = `cc-stored-error-${name.replace(/\W+/g, '-')}`;
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
                        ...(tool ? { client_tools: unusedClientTools } : {}),
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
                failures.push(name);
                console.log(`  FAIL: ${name}: ${error.message}`);
            } finally {
                backend?.server.close();
                server.closeAllConnections?.();
                await new Promise(resolve => server.close(resolve));
                writeAllSettings(directories, buildSettingsFixture());
            }
        }
        assert.deepEqual(failures, [], 'stored error cases');
    }

    console.log('chat-completions.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => user.close());
