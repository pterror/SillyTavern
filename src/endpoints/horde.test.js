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
let hordeFakeBackendUrl = null;
{
    const realFetch = globalThis.fetch;
    globalThis.fetch = /** @type {typeof fetch} */ (async (url, opts) => {
        const target = new URL(url);
        if (hordeFakeBackendUrl && target.origin === 'https://aihorde.net') {
            return realFetch(new URL(target.pathname + target.search, hordeFakeBackendUrl), opts);
        }
        return realFetch(url, opts);
    });
}

const { router: hordeRoutes, generateHorde, _setHordePollingConfigForTests } = await import('./horde.js');
const hordeRouter = routerWithGenerate(hordeRoutes, generateHorde, '/generate-text');
const { handleGenerationStop } = await import('../generation-stop.js');
const { handleGenerationResume } = await import('./backends/llamacpp-compact-stream.js');
const { buildRawActionKoboldRequest } = await import('./backends/kobold.js');
const { writeAllSettings } = await import('../settings-store.js');
const { CompactStreamDecoder } = await import('../../public/scripts/llamacpp-compact-stream.js');

_setHordePollingConfigForTests({ pollIntervalMs: 30, maxRetries: 50, keepaliveIntervalMs: 25 });

const { SESSION_HEADER } = await import('../request-session.js');
const { convertedUser, writeLibraryCard, saveBranch, loadBranch, sessionAt, chatContextOf } = await import('../../tests/converted-user.fixture.js');

const user = await convertedUser('st-horde-raw-action-test-');
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

function startFakeHordeCoordinator({ jobId, pendingReplies, finalText, onDelete }) {
    const calls = { submit: 0, status: 0, delete: 0 };
    let statusCallCount = 0;
    const server = http.createServer((req, res) => {
        req.on('data', () => { });
        req.on('end', () => {
            if (req.method === 'POST' && req.url === '/api/v2/generate/text/async') {
                calls.submit++;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: jobId }));
                return;
            }
            if (req.method === 'GET' && req.url === `/api/v2/generate/text/status/${jobId}`) {
                calls.status++;
                statusCallCount++;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (statusCallCount <= pendingReplies) {
                    res.end(JSON.stringify({ done: false, faulted: false, is_possible: true, queue_position: pendingReplies - statusCallCount + 1, generations: [] }));
                } else {
                    res.end(JSON.stringify({ done: true, faulted: false, generations: [{ text: finalText, worker_name: 'fake-worker', model: 'fake-model' }] }));
                }
                return;
            }
            if (req.method === 'DELETE' && req.url === `/api/v2/generate/text/status/${jobId}`) {
                calls.delete++;
                onDelete?.();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ done: false }));
                return;
            }
            res.writeHead(404);
            res.end();
        });
    });
    const listenPromise = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return listenPromise.then(() => ({ server, url: `http://127.0.0.1:${server.address().port}`, calls }));
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
    app.use('/api/horde', hordeRouter);
    app.post('/api/generation/generate/stop/:id', handleGenerationStop);
    app.get('/api/generation/generate/resume/:id', handleGenerationResume);
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

async function run() {
    writeAllSettings(directories, buildSettingsFixture());
    const avatar = await writeCharacter('Rex.png', {
        name: 'Rex',
        description: 'Rex is a {{char}}.',
        data: { name: 'Rex', description: 'Rex is a {{char}}.', first_mes: 'Hi, I am Rex.' },
    });

    const ownerId = avatar.replace(/\.png$/, '');
    const branchName = 'main-chat';
    await saveBranch(user.store, { avatar }, branchName, [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        { name: 'Tester', is_user: true, mes: 'Hi Rex, nice to meet you.', send_date: 2, extra: {} },
        { name: 'Rex', is_user: false, mes: 'Likewise!', send_date: 3, extra: {} },
    ]);

    {
        const { leaf_id: leafId } = (await loadBranch(user.store, { avatar }, branchName)).branch;

        /**
         * @param {string[]|undefined} hordeModels
         */
        async function buildHordeSend(hordeModels) {
            const settings = buildSettingsFixture();
            if (hordeModels !== undefined) {
                settings.horde_settings = { models: hordeModels };
            }
            writeAllSettings(directories, settings);
            const keys = [];
            try {
                await buildRawActionKoboldRequest(directories, {
                    characterAvatar: avatar, chat: await chatOf(avatar, leafId), nodeId: leafId,
                    type: 'normal', userMessageText: 'Which tokenizer, Rex?',
                    macroExtras: { isHorde: true },
                    tokenizerOptions: {
                        encodeLocal: async (key, text) => {
                            keys.push(key);
                            return Array.from(String(text ?? '')).map(ch => ch.codePointAt(0));
                        },
                    },
                });
            } finally {
                writeAllSettings(directories, buildSettingsFixture());
            }
            return keys;
        }

        const llama3Keys = await buildHordeSend(['koboldcpp/Meta-Llama-3-8B-Instruct', 'aphrodite/NousResearch/Hermes-2-Pro-Llama-3-8B']);
        assert.ok(llama3Keys.length > 0, 'two LLAMA3 models: the send counts with a local tokenizer');
        assert.deepEqual([...new Set(llama3Keys)], ['llama3'], 'two LLAMA3 models: the send counts with llama3, nothing else');

        for (const [label, hordeModels] of [
            ['mixed models', ['koboldcpp/Meta-Llama-3-8B-Instruct', 'koboldcpp/gemma-2-9b-it']],
            ['no model selected', []],
            ['no saved Horde settings', undefined],
        ]) {
            const keys = await buildHordeSend(hordeModels);
            assert.deepEqual(keys, [], `${label}: the send counts by the estimate and loads no local tokenizer`);
        }
    }


    {
        const fakeCoordinator = await startFakeHordeCoordinator({
            jobId: 'task-abc-123', pendingReplies: 3, finalText: 'Rex says hello back.',
        });
        hordeFakeBackendUrl = fakeCoordinator.url;

        const branchBefore = await loadBranch(user.store, { avatar }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;

        let res;
        try {
            res = await fetch(`http://127.0.0.1:${port}/api/horde/generate-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                    type: 'normal', user_message: { is_user: true, name: 'User', mes: 'One more time, Rex?' },
                    trusted_workers: true, models: ['some-horde-model'],
                }),
            });

            assert.equal(res.status, 200);
            assert.equal(res.headers.get('X-ST-Stream-Format'), 'compact-v1', 'Horde is now shimmed onto the same wire format as every other backend');
            const generationId = res.headers.get('X-Generation-Id');
            assert.match(generationId ?? '', /^[0-9a-f-]{36}$/, 'the stream is named by its generation, which a stop and a resume name too');

            const decoder = new CompactStreamDecoder();
            let text = '';
            let assistantNodeId = null;
            let sawKeepalive = false;
            const reader = res.body.getReader();
            for (; ;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value || !value.length) continue;
                if (value.length === 2 && value[0] === 0xFF && value[1] === 0x09) sawKeepalive = true;
                for (const event of decoder.push(value)) {
                    if ('content' in event) text += event.content;
                    else if ('assistantNodeId' in event) assistantNodeId = event.assistantNodeId;
                }
            }
            for (const event of decoder.flush()) {
                if ('content' in event) text += event.content;
            }

            assert.ok(sawKeepalive, 'at least one real 0x09 keepalive frame was received while waiting on the still-processing polls');
            assert.equal(text, 'Rex says hello back.', 'the real completed generation text was received as content frame(s)');
            assert.ok(assistantNodeId, 'an assistant_node_id frame was received - real server-side persistence happened');
            assert.ok(fakeCoordinator.calls.status >= 4, 'the server polled Horde\'s own status endpoint internally, not the client');

            const branchAfter = await loadBranch(user.store, { avatar }, branchName);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply are now persisted');
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'One more time, Rex?');
            assert.equal(assistantMsg.mes, 'Rex says hello back.');
            assert.equal(assistantMsg.node_id, assistantNodeId, 'the node id received via the stream is exactly where the reply landed');

            const userAlternatives = await user.store.chats.alternatives({ node_id: userMsg.node_id });
            assert.equal(userAlternatives.total, 1, 'the persisted user message is a genuine new child, not a swipe alternative');
        } finally {
            fakeCoordinator.server.close();
            hordeFakeBackendUrl = null;
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    {
        hordeFakeBackendUrl = null;
        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/horde/generate-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner_id: 'NoSuchCharacter.png', character_avatar: 'NoSuchCharacter.png',
                    node_id: null, type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Hello?' },
                    trusted_workers: false, models: [],
                }),
            });
            assert.equal(res.status, 400);
            assert.equal(res.headers.get('X-ST-Stream-Format'), null, 'a validation failure never enters stream mode');
            const data = await res.json();
            assert.match(data.message, /Character not found/);
        } finally {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    {
        const fakeCoordinator = await startFakeHordeCoordinator({
            jobId: 'legacy-task-456', pendingReplies: 1, finalText: 'Legacy generated text.',
        });
        hordeFakeBackendUrl = fakeCoordinator.url;

        const branchBefore = await loadBranch(user.store, { avatar }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/horde/generate-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: 'Legacy client-assembled prompt.',
                    params: { max_length: 100, max_context_length: 2048 },
                    trusted_workers: false,
                    models: ['some-model'],
                }),
            });
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('X-ST-Stream-Format'), 'compact-v1');

            const decoder = new CompactStreamDecoder();
            let text = '';
            let assistantNodeId = null;
            const reader = res.body.getReader();
            for (; ;) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const event of decoder.push(value)) {
                    if ('content' in event) text += event.content;
                    else if ('assistantNodeId' in event) assistantNodeId = event.assistantNodeId;
                }
            }

            assert.equal(text, 'Legacy generated text.');
            assert.equal(assistantNodeId, null, 'no persistence happens for a non-raw-action request');

            const branchAfter = await loadBranch(user.store, { avatar }, branchName);
            assert.equal(branchAfter.messages.length, messageCountBefore, 'no persistence was attempted for a non-raw-action request');
        } finally {
            fakeCoordinator.server.close();
            hordeFakeBackendUrl = null;
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    {
        const fakeCoordinator = await startFakeHordeCoordinator({
            jobId: 'cancel-task-789', pendingReplies: 1000, finalText: 'Should never be seen.',
        });
        hordeFakeBackendUrl = fakeCoordinator.url;

        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/horde/generate-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'Cancel me.', params: {}, trusted_workers: false, models: [] }),
            });
            assert.equal(res.status, 200);
            const generationId = res.headers.get('X-Generation-Id');

            const reader = res.body.getReader();
            await waitFor(() => fakeCoordinator.calls.status >= 1);

            const stopRes = await fetch(`http://127.0.0.1:${port}/api/generation/generate/stop/${encodeURIComponent(generationId)}`, { method: 'POST' });
            assert.equal(stopRes.status, 200);
            await waitFor(() => fakeCoordinator.calls.delete === 1);
            assert.equal(fakeCoordinator.calls.delete, 1, 'stopping the generation withdrew the job from the Horde');

            const decoder = new CompactStreamDecoder();
            let text = '';
            let assistantNodeId = null;
            for (; ;) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const event of decoder.push(value)) {
                    if ('content' in event) text += event.content;
                    else if ('assistantNodeId' in event) assistantNodeId = event.assistantNodeId;
                }
            }

            assert.equal(text, '', 'no content was emitted for a cancelled generation');
            assert.equal(assistantNodeId, null, 'no assistant_node_id frame was emitted for a cancelled generation');

            const statusCallsAtCancel = fakeCoordinator.calls.status;
            await new Promise(resolve => setTimeout(resolve, 150));
            assert.equal(fakeCoordinator.calls.status, statusCallsAtCancel, 'no further Horde status polls happened after cancellation');
        } finally {
            fakeCoordinator.server.close();
            hordeFakeBackendUrl = null;
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    {
        const fakeCoordinator = await startFakeHordeCoordinator({
            jobId: 'disconnect-task-321', pendingReplies: 3, finalText: 'Still here after you left.',
        });
        hordeFakeBackendUrl = fakeCoordinator.url;

        const branchBefore = await loadBranch(user.store, { avatar }, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;
        try {
            const controller = new AbortController();
            const res = await fetch(`http://127.0.0.1:${port}/api/horde/generate-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                    type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Then I vanish.' },
                    trusted_workers: false, models: [],
                }),
                signal: controller.signal,
            });
            const generationId = res.headers.get('X-Generation-Id');

            const reader = res.body.getReader();
            await reader.read();
            controller.abort();
            await assert.rejects(() => reader.read());

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(user.store, { avatar }, branchName);
                return branch.messages.length === messageCountBefore + 2 ? branch : null;
            });
            const [, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(assistantMsg.mes, 'Still here after you left.', 'the poll loop kept running server-side after the client disconnected, and persisted the real final reply');

            const resumeRes = await fetch(`http://127.0.0.1:${port}/api/generation/generate/resume/${encodeURIComponent(generationId)}?from=0`);
            assert.equal(resumeRes.status, 200);
            const decoder = new CompactStreamDecoder();
            let text = '';
            let assistantNodeId = null;
            const resumeReader = resumeRes.body.getReader();
            for (; ;) {
                const { done, value } = await resumeReader.read();
                if (done) break;
                for (const event of decoder.push(value)) {
                    if ('content' in event) text += event.content;
                    else if ('assistantNodeId' in event) assistantNodeId = event.assistantNodeId;
                }
            }
            assert.equal(text, 'Still here after you left.', 'a resume call after disconnect gets the eventual result');
            assert.equal(assistantNodeId, assistantMsg.node_id);
        } finally {
            fakeCoordinator.server.close();
            hordeFakeBackendUrl = null;
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    {
        const chatName = 'horde-stored-ref';
        const fakeCoordinator = await startFakeHordeCoordinator({ jobId: 'task-stored-ref', pendingReplies: 0, finalText: 'Stored reply.' });
        hordeFakeBackendUrl = fakeCoordinator.url;
        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        try {
            await saveBranch(user.store, { avatar }, chatName, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: `Hello there, ${chatName}.`, send_date: 1, extra: {} },
            ]);
            const branchBefore = await loadBranch(user.store, { avatar }, chatName);
            const ref = `ref-${chatName}`;
            const res = await fetch(`http://127.0.0.1:${server.address().port}/api/horde/generate-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                    type: 'normal', user_message: { is_user: true, name: 'User', mes: `Question for ${chatName}?` }, user_message_ref: ref,
                    trusted_workers: true, models: ['some-horde-model'],
                }),
            });
            const decoder = new CompactStreamDecoder();
            const events = [...decoder.push(new Uint8Array(await res.arrayBuffer())), ...decoder.flush()];
            assert.ok('control' in events[0] && events[0].control.stored, `the first frame is the stored control frame: ${JSON.stringify(events[0])}`);
            const branchAfter = await loadBranch(user.store, { avatar }, chatName);
            const userNode = branchAfter.messages[branchBefore.messages.length];
            assert.equal(userNode?.mes, `Question for ${chatName}?`);
            assert.deepEqual(events[0].control.stored, [{ ref, node_id: userNode.node_id }], 'the user message\'s ref is echoed with the node it was stored at');
        } finally {
            fakeCoordinator.server.close();
            hordeFakeBackendUrl = null;
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    {
        const chatName = 'horde-stored-error';
        const failingCoordinator = http.createServer((req, res) => {
            req.on('data', () => { });
            req.on('end', () => {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('horde exploded');
            });
        });
        await new Promise(resolve => failingCoordinator.listen(0, '127.0.0.1', resolve));
        hordeFakeBackendUrl = `http://127.0.0.1:${failingCoordinator.address().port}`;
        const app = buildTestApp();
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        try {
            await saveBranch(user.store, { avatar }, chatName, [
                { chat_metadata: {} },
                { name: 'Rex', is_user: false, mes: `Hello there, ${chatName}.`, send_date: 1, extra: {} },
            ]);
            const branchBefore = await loadBranch(user.store, { avatar }, chatName);
            const ref = `ref-${chatName}`;
            const res = await fetch(`http://127.0.0.1:${server.address().port}/api/horde/generate-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                    type: 'normal', user_message: { is_user: true, name: 'User', mes: `Question for ${chatName}?` }, user_message_ref: ref,
                    trusted_workers: true, models: ['some-horde-model'],
                }),
            });
            const text = await res.text();
            const branchAfter = await loadBranch(user.store, { avatar }, chatName);
            const added = branchAfter.messages.slice(branchBefore.messages.length);
            assert.deepEqual(added.map(m => m.mes), [`Question for ${chatName}?`], 'only the user message was stored');
            const stored = [{ ref, node_id: added[0].node_id }];
            assert.deepEqual(JSON.parse(res.headers.get('X-ST-Stored') ?? 'null'), stored, `the X-ST-Stored header names the stored user message (status ${res.status}, body ${text})`);
            assert.deepEqual(JSON.parse(text), { error: { message: 'horde exploded' }, stored });
        } finally {
            failingCoordinator.close();
            hordeFakeBackendUrl = null;
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    console.log('horde.test.js: all assertions passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => user.close());
