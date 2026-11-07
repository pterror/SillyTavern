import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
import { setConfigFilePath } from '../util.js';
import { streamAsSetting } from '../../tests/util/stream-as-setting.js';
import { routerWithGenerate } from '../../tests/util/router-with-generate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

/** @type {string|null} */
let novelFakeBackendUrl = null;
{
    const realFetch = globalThis.fetch;
    globalThis.fetch = /** @type {typeof fetch} */ (async (url, opts) => {
        const target = new URL(url);
        if (novelFakeBackendUrl && (target.origin === 'https://api.novelai.net' || target.origin === 'https://text.novelai.net')) {
            return realFetch(new URL(target.pathname + target.search, novelFakeBackendUrl), opts);
        }
        return realFetch(url, opts);
    });
}

const { router: novelRouter, generateNovel, buildRawActionNovelRequest } = await import('./novelai.js');
const router = routerWithGenerate(novelRouter, generateNovel);
const { writeAllSettings } = await import('../settings-store.js');
const { writeSecret, SECRET_KEYS } = await import('./secrets.js');
const { forwardAndPersistCompactStream } = await import('./backends/text-completions.js');
const { CompactStreamDecoder } = await import('../../public/scripts/llamacpp-compact-stream.js');
const { tokenizers } = await import('../tokenizer-ids.js');
const { writeBack } = await import('../token-count-store.js');
const { resolveTokenizer, tokenizerIdentity } = await import('../tokenizer-resolve.js');

const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, writeLibraryCard, saveBranch, loadBranch, sessionAt, chatContextOf } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-novelai-raw-action-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

const { newSessionKey } = await import('../chat-engine.js');

/**
 * @param {string} avatar
 * @param {unknown} nodeId
 */
async function chatOf(avatar, nodeId) {
    return chatContextOf(user.store, { avatar }, (await sessionAt(user.store, nodeId)) ?? newSessionKey());
}


const baseImage = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));

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

function decodeCompactStream(bytes) {
    const decoder = new CompactStreamDecoder();
    const events = [...decoder.push(new Uint8Array(bytes)), ...decoder.flush()];
    let text = '';
    let assistantNodeId = null;
    const probabilities = [];
    for (const event of events) {
        if ('content' in event) {
            text += event.content;
        } else if ('assistantNodeId' in event) {
            assistantNodeId = event.assistantNodeId;
        } else if ('probabilities' in event) {
            probabilities.push(event.probabilities);
        }
    }
    return { text, assistantNodeId, probabilities };
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
        const built = await buildRawActionNovelRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
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
        assert.equal(built.params.streaming, false, 'the reply streams as the stored setting says, and it says not to');
    }

    await assert.rejects(
        async () => buildRawActionNovelRequest(directories, {
            characterAvatar: 'NoSuchCharacter.png', chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Character not found/,
    );

    await assert.rejects(
        async () => buildRawActionNovelRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, 'no-such-node-id'), nodeId: 'no-such-node-id',
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Chat node not found/,
    );

    await assert.rejects(
        async () => buildRawActionNovelRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, undefined),
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /node_id is required \(pass null explicitly for a brand-new, empty conversation\)/,
    );

    await assert.rejects(
        async () => buildRawActionNovelRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, null), nodeId: null,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /node_id is required: this chat is not at its start/,
    );

    {
        const freshAvatar = await writeCharacter('NovelFresh.png', {
            name: 'Fresh',
            description: 'Fresh is a brand-new character with no chat history yet.',
            data: { name: 'Fresh', description: 'Fresh is a brand-new character with no chat history yet.', first_mes: 'Hello, this is Fresh.' },
        });
        const builtFresh = await buildRawActionNovelRequest(directories, {
            characterAvatar: freshAvatar, chat: await chatOf(freshAvatar, null), nodeId: null,
            type: 'normal', userMessageText: 'Hi Fresh, this is our first message ever.',
            tokenizerOptions: fakeTokenizerOptions,
        });
        assert.equal(builtFresh.anchorNodeId, null, 'a new, empty conversation is at its tree\'s root: the reply opens it');
        assert.ok(builtFresh.params.input.includes('Hi Fresh, this is our first message ever.'), 'the raw user_message for this turn still made it into the prepared input even though the resolved prior history was empty');
        assert.ok(!builtFresh.params.input.includes('Hello there, traveler.'), 'no unrelated prior history (Rex\'s) leaked into a brand-new character\'s resolved, empty chat');
    }


    function tokenizerSettings(modelNovel, tokenizerSetting) {
        const settings = buildSettingsFixture();
        settings.power_user.tokenizer = tokenizerSetting;
        settings.power_user.custom_stopping_strings = JSON.stringify(['\nNarrator:']);
        settings.nai_settings.model_novel = modelNovel;
        settings.nai_settings.banned_tokens = 'dragon\n[5,6]';
        settings.nai_settings.logit_bias = [{ text: 'sword', value: 1 }, { text: '[7]', value: -1 }];
        return settings;
    }

    function recordingTokenizerOptions() {
        const keys = [];
        return {
            keys,
            options: {
                encodeLocal: async (key, text) => {
                    keys.push(key);
                    return Array.from(String(text ?? '')).map(ch => ch.codePointAt(0));
                },
            },
        };
    }

    const codePoints = (text) => Array.from(text).map(ch => ch.codePointAt(0));

    {
        writeAllSettings(directories, tokenizerSettings('clio-v1', undefined));
        const { keys, options } = recordingTokenizerOptions();
        const built = await buildRawActionNovelRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
            type: 'normal', userMessageText: 'Stop strings, Rex?',
            tokenizerOptions: options,
        });
        writeAllSettings(directories, buildSettingsFixture());

        assert.ok(keys.length > 0, 'the clio send encodes with a local tokenizer');
        assert.deepEqual([...new Set(keys)], ['nerdstash'], 'clio counts and ids use NERD (nerdstash), nothing else');
        assert.ok(built.params.stop_sequences.some(ids => JSON.stringify(ids) === JSON.stringify(codePoints('\nNarrator:'))), 'the custom stop string is sent as NERD ids');
        assert.ok(built.params.bad_words_ids.some(ids => JSON.stringify(ids) === JSON.stringify(codePoints('dragon'))), 'a text bad word is encoded');
        assert.ok(built.params.bad_words_ids.some(ids => JSON.stringify(ids) === JSON.stringify([5, 6])), 'a raw-id bad word goes through');
    }

    for (const [label, modelNovel, tokenizerSetting] of [
        ['explicit None setting', 'clio-v1', tokenizers.NONE],
        ['model the NovelAI list does not know', 'some-future-model', undefined],
    ]) {
        writeAllSettings(directories, tokenizerSettings(modelNovel, tokenizerSetting));
        const { keys, options } = recordingTokenizerOptions();
        const built = await buildRawActionNovelRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
            type: 'normal', userMessageText: 'No tokenizer, Rex?',
            tokenizerOptions: options,
        });
        writeAllSettings(directories, buildSettingsFixture());

        assert.deepEqual(keys, [], `${label}: no tokenizer is loaded, counts use the estimate`);
        assert.equal(built.params.stop_sequences, undefined, `${label}: stop strings need ids, so none are sent`);
        assert.deepEqual(built.params.bad_words_ids, [[5, 6]], `${label}: only the raw-id bad word goes through`);
        assert.deepEqual(built.params.logit_bias_exp.map(entry => entry.sequence), [[7]], `${label}: only the raw-id bias goes through`);

        assert.equal(built.warnings.length, 1, `${label}: one warning`);
        const [warning] = built.warnings;
        assert.equal(warning.kind, 'dropped');
        assert.ok(warning.entries.includes('\nNarrator:'), `${label}: the stop string is listed`);
        assert.ok(warning.entries.includes('dragon'), `${label}: the text bad word is listed`);
        assert.ok(warning.entries.includes('sword'), `${label}: the text bias is listed`);
        assert.ok(!warning.entries.includes('[5,6]') && !warning.entries.includes('[7]'), `${label}: raw-id entries are not listed`);
        assert.ok(warning.message.includes('dragon') && warning.message.includes('sword'), `${label}: the message names the entries`);
    }

    {
        writeAllSettings(directories, tokenizerSettings('clio-v1', undefined));
        const built = await buildRawActionNovelRequest(directories, {
            characterAvatar: avatar, chat: await chatOf(avatar, mainLeafId), nodeId: mainLeafId,
            type: 'normal', userMessageText: 'Broken tokenizer, Rex?',
            tokenizerOptions: { encodeLocal: async () => { throw new Error('Failed to load the tokenizer'); } },
        });
        writeAllSettings(directories, buildSettingsFixture());

        assert.ok(!(built.params.stop_sequences ?? []).includes(null), 'no stop sequence without ids');
        assert.deepEqual(built.params.bad_words_ids, [[5, 6]], 'only the raw-id bad word goes through');
        assert.deepEqual(built.params.logit_bias_exp.map(entry => entry.sequence), [[7]], 'only the raw-id bias goes through');
        assert.deepEqual(built.warnings.map(w => w.kind), ['trim-estimate', 'dropped']);
        const dropped = built.warnings[1];
        assert.ok(dropped.entries.includes('\nNarrator:') && dropped.entries.includes('dragon') && dropped.entries.includes('sword'), 'the entries needing ids are listed');
        assert.ok(dropped.message.includes('NerdStash'), dropped.message);
    }

    {
        const storeAvatar = await writeCharacter('NovelStore.png', {
            name: 'NovelStore',
            data: { name: 'NovelStore', description: 'NovelStore sells maps.', first_mes: 'Looking for a map?' },
        });
        await saveBranch(user.store, { avatar: storeAvatar }, 'store-chat', [
            { chat_metadata: {} },
            { name: 'NovelStore', is_user: false, mes: 'Looking for a map?', send_date: 1, extra: {} },
            { name: 'Tester', is_user: true, mes: 'One of the northern coast.', send_date: 2, extra: {} },
            { name: 'NovelStore', is_user: false, mes: 'That one is rare.', send_date: 3, extra: {} },
        ]);
        const storeLeafId = (await loadBranch(user.store, { avatar: storeAvatar }, 'store-chat')).branch.leaf_id;
        writeAllSettings(directories, tokenizerSettings('clio-v1', undefined));

        const build = async () => {
            const encoded = [];
            const built = await buildRawActionNovelRequest(directories, {
                characterAvatar: storeAvatar, chat: await chatOf(storeAvatar, storeLeafId), nodeId: storeLeafId, type: 'normal',
                tokenizerOptions: { encodeLocal: async (key, text) => { encoded.push(text); return fakeTokenizerOptions.encodeLocal(key, text); } },
            });
            return { built, encoded };
        };
        try {
            const first = await build();
            assert.ok(first.encoded.length > 0, 'the first build encodes with the local tokenizer');
            assert.ok(first.encoded.includes('dragon') && first.encoded.includes('\nNarrator:'), 'the bad word and stop string were encoded');
            await writeBack(directories, first.built.tokenCountRows);
            const second = await build();
            const firstTexts = new Set(first.encoded);
            assert.deepEqual(second.encoded.filter(text => firstTexts.has(text)), [], 'no text encoded in the first build is encoded again');
            assert.deepEqual(second.built.params, first.built.params);
        } finally {
            writeAllSettings(directories, buildSettingsFixture());
        }
    }


    {
        const fakeBackend = await startFakeBackend((req, res) => {
            assert.equal(req.url, '/ai/generate', 'the non-streaming raw-action request really hits NovelAI\'s real /ai/generate endpoint (llama-3-erato-v1 routes to TEXT_NOVELAI, not API_NOVELAI, but the path is the same either way - the mock.module() reroute matches both real hardcoded hosts)');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: 'Rex says hello back.' }));
        });
        pointNovelBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'One more time, Rex?' }, stream: false,
        });
        fakeBackend.server.close();
        pointNovelBackendAt(null);

        assert.equal(status, 200);
        assert.equal(data.output, 'Rex says hello back.', 'the real NovelAI response body reaches the client unmodified');
        assert.equal(typeof data.assistant_node_id, 'string', 'the node persistAssistantReply() wrote is echoed back so the client can mark it clean instead of re-persisting it itself');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply were appended');
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'One more time, Rex?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back.', 'the assistant reply text was extracted from data.output and appended');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex');

        const userAlternatives = await user.store.chats.alternatives({ node_id: userMsg.node_id });
        assert.equal(userAlternatives.total, 1, 'the persisted user message has no siblings - it is a genuine new child, not a swipe alternative');
    }

    {
        let sawStreamRequest = false;
        const fakeBackend = await startFakeBackend((req, res) => {
            assert.equal(req.url, '/ai/generate-stream', 'with streaming stored on, the request lands on the streaming endpoint');
            sawStreamRequest = true;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end('data: ' + JSON.stringify({ token: 'Streamed as stored.' }) + '\n\n');
        });
        pointNovelBackendAt(fakeBackend.url);

        const streamBranch = 'novel-stream-attempt-chat';
        await saveBranch(user.store, { avatar: ownerId }, streamBranch, [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        ]);
        const streamNodeId = (await loadBranch(user.store, { avatar: ownerId }, streamBranch)).branch.leaf_id;

        const server = buildTestApp().listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        let bytes;
        let status;
        let format;
        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner_id: ownerId, character_avatar: avatar, node_id: streamNodeId,
                    type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Try to stream, Rex.' }, stream: true,
                }),
            });
            status = res.status;
            format = res.headers.get('X-ST-Stream-Format');
            bytes = Buffer.from(await res.arrayBuffer());
        } finally {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
        fakeBackend.server.close();
        pointNovelBackendAt(null);

        assert.equal(status, 200);
        assert.equal(sawStreamRequest, true);
        assert.equal(format, 'compact-v1', 'the page gets the reply as it comes');
        const decoded = decodeCompactStream(bytes);
        assert.equal(decoded.text, 'Streamed as stored.');
        assert.equal(typeof decoded.assistantNodeId, 'string', 'the streamed reply is stored, and its node named in the stream');

        const branchAfter = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, streamBranch);
            return branch.messages.length === 3 ? branch : null;
        });
        assert.equal(branchAfter.messages[2].mes, 'Streamed as stored.');

        const sseChunks = ['Rex ', 'streams ', 'a ', 'reply.'];
        const sseLogprobs = { chosen: [['Rex', -0.1]] };
        const sseBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end(sseChunks.map((token, i) => `data: ${JSON.stringify({ token, logprobs: i === 0 ? sseLogprobs : null })}\n\n`).join('') + 'data: [DONE]\n\n');
        });
        const directStreamBranch = 'novel-direct-forward-persist-chat';
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
        }, json => json?.token, json => json?.logprobs);
        sseBackend.server.close();

        const decodedDirect = decodeCompactStream(Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c))));
        assert.equal(decodedDirect.text, sseChunks.join(''), 'the real forwardAndPersistCompactStream() + the route\'s own {"token":...} extractor correctly accumulated every chunk into the decoded compact stream');
        assert.deepEqual(decodedDirect.probabilities, [sseLogprobs], 'the route\'s own {"logprobs":...} extractor re-encoded NovelAI\'s per-token logprobs as a 0x02 probabilities frame');

        const branchAfterDirect = await waitFor(async () => {
            const branch = await loadBranch(user.store, { avatar: ownerId }, directStreamBranch);
            return branch.messages.length === 2 ? branch : null;
        });
        assert.equal(branchAfterDirect.messages[1].mes, 'Rex streams a reply.', 'the real forwardAndPersistCompactStream() + the route\'s own extractors correctly accumulated and persisted every chunk');
        assert.equal(branchAfterDirect.messages[1].name, 'Rex');
        assert.equal(branchAfterDirect.messages[1].is_user, false);
    }

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: 'Rex replies without stop strings.' }));
        });
        pointNovelBackendAt(fakeBackend.url);
        writeAllSettings(directories, tokenizerSettings('clio-v1', tokenizers.NONE));

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Warn me, Rex.' }, stream: false,
        });
        fakeBackend.server.close();
        pointNovelBackendAt(null);
        writeAllSettings(directories, buildSettingsFixture());

        assert.equal(status, 200);
        assert.equal(data.warnings?.length, 1);
        assert.equal(data.warnings[0].kind, 'dropped');
        assert.ok(data.warnings[0].entries.includes('dragon'));
    }

    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'backend exploded' }));
        });
        pointNovelBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
            type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Are you there, Rex?' }, stream: false,
        });
        fakeBackend.server.close();
        pointNovelBackendAt(null);

        assert.equal(status, 500, 'NovelAI\'s own error-response branch replies with 500, not a thrown exception');

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was appended - no assistant reply for a failed generation');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Are you there, Rex?');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].is_user, true);
    }

    {
        const fakeBackend = await startFakeBackend((req, res) => {
            assert.equal(req.url, '/ai/generate');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: 'Legacy, unmanaged reply.' }));
        });
        pointNovelBackendAt(fakeBackend.url);

        const branchBefore = await loadBranch(user.store, { avatar: ownerId }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
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

        const branchAfter = await loadBranch(user.store, { avatar: ownerId }, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no persistence was attempted for a non-raw-action request');
    }

    const written = new Map();
    const realWriteBack = user.store.tokens.writeBack.bind(user.store.tokens);
    user.store.tokens.writeBack = async (pending, now) => {
        for (const { identity, hash } of [...(pending.counts ?? []), ...(pending.ids ?? [])]) {
            if (!written.has(identity)) written.set(identity, new Set());
            written.get(identity).add(hash);
        }
        return realWriteBack(pending, now);
    };
    async function storedRowsUnder(identity) {
        return written.get(identity)?.size ?? 0;
    }

    let writeBackChats = 0;
    async function setUpWriteBackGeneration(onGenerate) {
        const name = `NovelWriteBack${++writeBackChats}`;
        const writeBackAvatar = await writeCharacter(`${name}.png`, { name, data: { name, description: `${name} keeps the orchard.`, first_mes: 'Welcome.' } });
        await saveBranch(user.store, { avatar: writeBackAvatar }, 'write-back-chat', [
            { chat_metadata: {} },
            { name, is_user: false, mes: 'Welcome.', send_date: 1, extra: {} },
            { name: 'Tester', is_user: true, mes: `Are the pears ripe, ${name}?`, send_date: 2, extra: {} },
            { name, is_user: false, mes: 'Nearly.', send_date: 3, extra: {} },
        ]);
        const leafId = (await loadBranch(user.store, { avatar: writeBackAvatar }, 'write-back-chat')).branch.leaf_id;
        const urls = [];
        const backend = await startFakeBackend((req, res, requestBody) => {
            urls.push(req.url);
            if (req.url === '/ai/generate') return onGenerate(req, res, requestBody);
            res.writeHead(404);
            res.end();
        });
        pointNovelBackendAt(backend.url);
        const settings = tokenizerSettings('clio-v1', undefined);
        writeAllSettings(directories, settings);
        const identity = await tokenizerIdentity(await resolveTokenizer({ api: 'novel', model: 'clio-v1', tokenizerSetting: undefined }, { directories }));
        assert.ok(identity, 'the bundled NerdStash tokenizer has an identity');
        return {
            backend, urls, identity,
            body: { owner_id: writeBackAvatar, character_avatar: writeBackAvatar, node_id: leafId, type: 'normal', user_message: { is_user: true, name: 'User', mes: `Any apples, ${name}?` }, stream: false },
        };
    }

    {
        let rowsWhenReceived = null;
        let identityForCase = null;
        const { backend, urls, identity, body } = await setUpWriteBackGeneration(async (_req, res) => {
            rowsWhenReceived = await storedRowsUnder(identityForCase);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: 'Soon.' }));
        });
        identityForCase = identity;
        try {
            const rowsBefore = await storedRowsUnder(identity);
            const { status } = await postGenerate(buildTestApp(), body);
            assert.equal(status, 200);
            assert.ok(urls.includes('/ai/generate'), 'the backend received the generation');
            assert.equal(rowsWhenReceived, rowsBefore, 'nothing stored when the backend received its request');
            await waitFor(async () => (await storedRowsUnder(identity)) > rowsBefore);
        } finally {
            backend.server.close();
            pointNovelBackendAt(null);
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    {
        const { backend, urls, identity, body } = await setUpWriteBackGeneration((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: 'Soon.' }));
        });
        const realFetch = globalThis.fetch;
        let refused = 0;
        globalThis.fetch = /** @type {typeof fetch} */ (async (url, ...rest) => {
            if (String(url).endsWith('/ai/generate')) {
                refused++;
                throw new TypeError('fetch failed', { cause: new Error('refused before sending') });
            }
            return realFetch(url, ...rest);
        });
        try {
            const rowsBefore = await storedRowsUnder(identity);
            const { data } = await postGenerate(buildTestApp(), body);
            assert.equal(data.error, true, 'the generation failed');
            assert.equal(refused, 1, 'the backend request threw');
            assert.ok(!urls.includes('/ai/generate'), 'the backend never received the generation');
            await new Promise(resolve => setTimeout(resolve, 200));
            assert.equal(await storedRowsUnder(identity), rowsBefore, 'nothing stored');
        } finally {
            globalThis.fetch = realFetch;
            backend.server.close();
            pointNovelBackendAt(null);
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    {
        const generates = [];
        const { backend, identity, body } = await setUpWriteBackGeneration((_req, res, requestBody) => {
            generates.push(JSON.parse(requestBody));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: 'Soon.' }));
        });
        const tokens = user.store.tokens;
        const realRead = tokens.read;
        try {
            tokens.read = async (table, id, hash) => (id === identity ? null : realRead.call(tokens, table, id, hash));
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
            pointNovelBackendAt(null);
            writeAllSettings(directories, buildSettingsFixture());
        }
    }

    {
        const chatName = 'novel-stored-ref-nonstream';
        const backend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ output: 'Stored reply.' }));
        });
        pointNovelBackendAt(backend.url);
        try {
            await saveBranch(user.store, { avatar: ownerId }, chatName, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: `Hello there, ${chatName}.`, send_date: 1, extra: {} },
            ]);
            const branchBefore = await loadBranch(user.store, { avatar: ownerId }, chatName);
            const ref = `ref-${chatName}`;
            const { data } = await postGenerate(buildTestApp(), {
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: `Question for ${chatName}?` }, user_message_ref: ref, stream: false,
            });
            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, chatName);
            const userNode = branchAfter.messages[branchBefore.messages.length];
            assert.equal(userNode?.mes, `Question for ${chatName}?`);
            assert.deepEqual(data.stored, [{ ref, node_id: userNode.node_id }], 'the user message\'s ref is echoed with the node it was stored at');
        } finally {
            backend.server.close();
            pointNovelBackendAt(null);
        }
    }

    {
        const chatName = 'novel-stored-error-nonstream';
        const backend = await startFakeBackend((_req, res) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'backend exploded' }));
        });
        pointNovelBackendAt(backend.url);
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
                    type: 'normal', user_message: { is_user: true, name: 'User', mes: `Question for ${chatName}?` }, user_message_ref: ref, stream: false,
                }),
            });
            const text = await res.text();
            const branchAfter = await loadBranch(user.store, { avatar: ownerId }, chatName);
            const added = branchAfter.messages.slice(branchBefore.messages.length);
            assert.deepEqual(added.map(m => m.mes), [`Question for ${chatName}?`], 'only the user message was stored');
            const stored = [{ ref, node_id: added[0].node_id }];
            assert.equal(res.status, 500);
            assert.deepEqual(JSON.parse(res.headers.get('X-ST-Stored') ?? 'null'), stored, `the X-ST-Stored header names the stored user message (body ${text})`);
            assert.deepEqual(JSON.parse(text), { error: { message: 'backend exploded' }, stored });
        } finally {
            backend.server.close();
            pointNovelBackendAt(null);
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    console.log('novelai.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => user.close());
