import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

import express from 'express';

import { write as writeCard } from '../character-card-parser.js';
// horde.js -> backends/kobold.js -> text-completion-generation-input.js pulls in
// src/endpoints/characters.js (via readCardContent), which (via character-shallow.js) reads
// process-wide config at import time - the config path must be set before that import chain runs,
// same as kobold.test.js/novelai.test.js/text-completions.test.js.
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Route-level Express-integration test for horde.js's own /generate-text route, now that it shims a
// real submit-then-poll Horde job onto the same compact-v1 wire protocol every other backend streams
// over (see this task's own report / streamHordeGeneration()'s doc comment for the full design).
//
// Uses this repo's own established `mock.module()` node-fetch reroute technique (same as
// novelai.test.js) to redirect ONLY `https://aihorde.net` traffic to a local fake coordinator that
// implements both the real submit endpoint (POST /api/v2/generate/text/async) and the real status
// endpoint (GET /api/v2/generate/text/status/:id) it now polls internally.
const canMockHordeBackend = typeof mock.module === 'function';
/** @type {string|null} Set per-test below; read by the node-fetch reroute mock. */
let hordeFakeBackendUrl = null;
if (canMockHordeBackend) {
    const realNodeFetch = (await import(path.join(__dirname, '..', '..', 'node_modules', 'node-fetch', 'src', 'index.js'))).default;
    mock.module('node-fetch', {
        defaultExport: async (url, opts) => {
            const target = new URL(url);
            if (hordeFakeBackendUrl && target.origin === 'https://aihorde.net') {
                return realNodeFetch(new URL(target.pathname + target.search, hordeFakeBackendUrl), opts);
            }
            return realNodeFetch(url, opts);
        },
        namedExports: {},
    });
} else {
    console.log('horde.test.js: node:test mock.module() is unavailable (run with --experimental-test-module-mocks) - skipping all /generate-text route tests, which need it to redirect AI Horde\'s hardcoded coordinator host to a local fake backend');
}

const { router: hordeRouter, _setHordePollingConfigForTests } = await import('./horde.js');
const { writeAllSettings } = await import('../settings-store.js');
const { saveChatToTree, loadBranch, getAlternatives, disposeMessageTreeStores } = await import('../message-tree-db.js');
const { CompactStreamDecoder } = await import('../../public/scripts/llamacpp-compact-stream.js');

// Real polling/keepalive timing sped way up for the test - see streamHordeGeneration()'s own
// `_setHordePollingConfigForTests()` doc comment. Small enough that a real "still processing" reply
// or two, plus at least one real keepalive frame, land well within a normal test timeout.
_setHordePollingConfigForTests({ pollIntervalMs: 30, maxRetries: 50, keepaliveIntervalMs: 25 });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-horde-raw-action-test-'));
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

/** Real settings.json fixture - only the keys resolveTokenizerType()/resolveTextCompletionGenerationInput()/createKoboldGenerationData() actually read, matching kobold.test.js's own fixture (this route reuses buildRawActionKoboldRequest() verbatim). `kai_settings.api_server` is left blank/unused - Horde never forwards it (this route strips it - see buildRawActionHordePayload()'s own comment). */
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

/**
 * Fake AI Horde coordinator: accepts one submit call, returns `jobId`; responds "still processing"
 * to the first `pendingReplies` status polls, then a real completed generation carrying `finalText`.
 * `onDelete` is invoked for a real DELETE .../status/:id (cancellation) call. Every call is logged so
 * tests can assert on how many status polls actually happened (e.g. "no further calls after cancel").
 */
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
        req.user = { directories, profile: { handle: 'tester' } };
        next();
    });
    app.use('/api/horde', hordeRouter);
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
    if (!canMockHordeBackend) {
        console.log('horde.test.js: skipping all route-level /generate-text tests - run with `node --experimental-test-module-mocks` to include them (see the canMockHordeBackend comment near the top of this file)');
        return;
    }

    writeAllSettings(directories, buildSettingsFixture());
    const avatar = writeCharacter('Rex.png', {
        name: 'Rex',
        description: 'Rex is a {{char}}.',
        data: { name: 'Rex', description: 'Rex is a {{char}}.', first_mes: 'Hi, I am Rex.' },
    });

    // NOT `avatar` verbatim: the real client (public/script.js's own `rawActionGenerateData`
    // construction) always strips the `.png` extension before sending `owner_id`.
    const ownerId = avatar.replace(/\.png$/, '');
    const branchName = 'main-chat';
    await saveChatToTree(directories, ownerId, branchName, [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        { name: 'Tester', is_user: true, mes: 'Hi Rex, nice to meet you.', send_date: 2, extra: {} },
        { name: 'Rex', is_user: false, mes: 'Likewise!', send_date: 3, extra: {} },
    ]);

    // (a) real end-to-end raw-action generation: submit -> a few "still processing" polls (with real
    // keepalive frames received meanwhile) -> a completed generation -> real content frame(s) ->
    // real server-side persistence -> assistant_node_id frame, last.
    {
        const fakeCoordinator = await startFakeHordeCoordinator({
            jobId: 'task-abc-123', pendingReplies: 3, finalText: 'Rex says hello back.',
        });
        hordeFakeBackendUrl = fakeCoordinator.url;

        const branchBefore = await loadBranch(directories, ownerId, branchName);
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
                    type: 'normal', user_message: 'One more time, Rex?',
                    trusted_workers: true, models: ['some-horde-model'],
                }),
            });

            assert.equal(res.status, 200);
            assert.equal(res.headers.get('X-ST-Stream-Format'), 'compact-v1', 'Horde is now shimmed onto the same wire format as every other backend');
            const generationId = res.headers.get('X-Generation-Id');
            assert.equal(generationId, 'task-abc-123', 'Horde\'s own job id is reused as the X-Generation-Id');

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

            const branchAfter = await loadBranch(directories, ownerId, branchName);
            assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply are now persisted');
            const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(userMsg.mes, 'One more time, Rex?');
            assert.equal(assistantMsg.mes, 'Rex says hello back.');
            assert.equal(assistantMsg.node_id, assistantNodeId, 'the node id received via the stream is exactly where the reply landed');

            const userAlternatives = await getAlternatives(directories, userMsg.node_id);
            assert.equal(userAlternatives.total, 1, 'the persisted user message is a genuine new child, not a swipe alternative');
        } finally {
            fakeCoordinator.server.close();
            hordeFakeBackendUrl = null;
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    // (b) validation error: unknown character - buildRawActionKoboldRequest() throws for real, the
    // route surfaces it as a plain 400 JSON error (never switches into stream mode), and never
    // attempts to reach the real Horde coordinator at all.
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
                    node_id: null, type: 'normal', user_message: 'Hello?',
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

    // (c) legacy, non-raw-action (quiet/impersonate-preview) requests also go through the shimmed
    // streaming path now, with no persistence and no assistant_node_id frame.
    {
        const fakeCoordinator = await startFakeHordeCoordinator({
            jobId: 'legacy-task-456', pendingReplies: 1, finalText: 'Legacy generated text.',
        });
        hordeFakeBackendUrl = fakeCoordinator.url;

        const branchBefore = await loadBranch(directories, ownerId, branchName);
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

            const branchAfter = await loadBranch(directories, ownerId, branchName);
            assert.equal(branchAfter.messages.length, messageCountBefore, 'no persistence was attempted for a non-raw-action request');
        } finally {
            fakeCoordinator.server.close();
            hordeFakeBackendUrl = null;
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    }

    // (d) cancellation via /cancel-task actually stops the in-flight server-side poll loop: no
    // further status polls happen after cancellation, and the streaming response ends cleanly
    // without a content or assistant_node_id frame.
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
            assert.equal(generationId, 'cancel-task-789');

            const reader = res.body.getReader();
            // Let at least one real status poll happen before cancelling.
            await waitFor(() => fakeCoordinator.calls.status >= 1);

            const cancelRes = await fetch(`http://127.0.0.1:${port}/api/horde/cancel-task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: generationId }),
            });
            assert.equal(cancelRes.status, 200);
            assert.equal(fakeCoordinator.calls.delete, 1, 'the real DELETE cancel call reached the fake coordinator');

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

    // (e) client disconnect mid-poll does NOT kill the server-side poll loop - matching every other
    // backend's "persisted generations survive a client disconnect" behavior - and a subsequent
    // resume call gets the eventual result.
    {
        const fakeCoordinator = await startFakeHordeCoordinator({
            jobId: 'disconnect-task-321', pendingReplies: 3, finalText: 'Still here after you left.',
        });
        hordeFakeBackendUrl = fakeCoordinator.url;

        const branchBefore = await loadBranch(directories, ownerId, branchName);
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
                    type: 'normal', user_message: 'Then I vanish.',
                    trusted_workers: false, models: [],
                }),
                signal: controller.signal,
            });
            const generationId = res.headers.get('X-Generation-Id');
            assert.equal(generationId, 'disconnect-task-321');

            const reader = res.body.getReader();
            await reader.read();
            controller.abort();
            await assert.rejects(() => reader.read());

            const branchAfter = await waitFor(async () => {
                const branch = await loadBranch(directories, ownerId, branchName);
                return branch.messages.length === messageCountBefore + 2 ? branch : null;
            });
            const [, assistantMsg] = branchAfter.messages.slice(-2);
            assert.equal(assistantMsg.mes, 'Still here after you left.', 'the poll loop kept running server-side after the client disconnected, and persisted the real final reply');

            const resumeRes = await fetch(`http://127.0.0.1:${port}/api/horde/generate/resume/${encodeURIComponent(generationId)}?from=0`);
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

    console.log('horde.test.js: all assertions passed');
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
