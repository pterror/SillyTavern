import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
// Same process-wide config-path requirement as text-completions.test.js/kobold.test.js (the import
// chain through text-completion-generation-input.js -> characters.js -> character-shallow.js reads
// config at import time).
import { setConfigFilePath } from '../../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

// Real end-to-end resumability test: a real client (fetch + AbortController) genuinely disconnects
// mid-stream from a real Express app (the real router, listening on a real ephemeral TCP port),
// while a real `http` fake backend (standing in for the actual text-completion server) is still
// mid-generation, then reconnects via the real GET /generate/resume/:id route and is served the
// live continuation. This exercises the SAME real-socket-disconnect mechanism as kobold.test.js's
// own "abort-on-disconnect" test (a real AbortController.abort() closing the real client socket,
// firing the route's real `response.socket.on('close', ...)` handler) - not a mocked function call
// standing in for a drop.
const { router } = await import('./text-completions.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { saveChatToTree, loadBranch, disposeMessageTreeStores } = await import('../../message-tree-db.js');
const { CompactStreamDecoder } = await import('../../../public/scripts/llamacpp-compact-stream.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-resume-stream-test-'));
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
            name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            alternate_greetings: [], extensions: {},
        },
        ...overrides,
    };
    const buffer = writeCard(baseImage, JSON.stringify(card));
    fs.writeFileSync(path.join(charactersDir, avatar), buffer);
    return avatar;
}

function buildSettingsFixture(backendUrl) {
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
            server_urls: { generic: backendUrl },
        },
        extension_settings: { note: {}, cfg: {} },
    };
}

async function startFakeBackend(handler) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => handler(req, res, body));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Fake OpenAI-text-completions-shaped SSE backend that writes `chunks` with a real delay between
 * each `res.write()` - so there is a genuine window, after the first chunk, during which the client
 * can disconnect while the backend is still actively producing more content the server has not sent
 * yet. Resolves `done` once the backend has finished writing everything (for the test to assert the
 * eventual persisted state without racing it).
 */
function startFakeSseBackendPaced(chunks, delayMs = 40) {
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const startPromise = startFakeBackend((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        (async () => {
            for (const text of chunks) {
                res.write(`data: ${JSON.stringify({ choices: [{ text }] })}\n\n`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            res.end('data: [DONE]\n\n');
            resolveDone();
        })();
    });
    return startPromise.then(backend => ({ ...backend, done }));
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
    const avatar = writeCharacter('Rex.png', {
        name: 'Rex',
        description: 'Rex is a {{char}}.',
        data: { name: 'Rex', description: 'Rex is a {{char}}.', first_mes: 'Hi, I am Rex.' },
    });
    const ownerId = avatar;

    const branchName = 'resume-chat';
    await saveChatToTree(directories, ownerId, branchName, [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
    ]);
    const branchBefore = await loadBranch(directories, ownerId, branchName);

    const chunks = ['Once ', 'upon ', 'a ', 'time, ', 'the ', 'connection ', 'dropped ', 'but ', 'the ', 'story ', 'went ', 'on.'];
    const expectedText = chunks.join('');

    const fakeBackend = await startFakeSseBackendPaced(chunks, 40);
    writeAllSettings(directories, buildSettingsFixture(fakeBackend.url));

    const app = buildTestApp();
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;

    const controller = new AbortController();
    const decoder = new CompactStreamDecoder();
    let text = '';
    let assistantNodeId = null;
    let generationId = null;
    let bytesReceived = 0;

    function applyEvents(events) {
        for (const event of events) {
            if ('content' in event) text += event.content;
            else if ('assistantNodeId' in event) assistantNodeId = event.assistantNodeId;
        }
    }

    try {
        // --- Phase 1: start the real stream, read exactly one real chunk, then genuinely disconnect ---
        const res = await fetch(`http://127.0.0.1:${port}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.branch.leaf_id,
                type: 'normal', user_message: 'Tell me a story, then vanish.', stream: true,
            }),
            signal: controller.signal,
        });

        assert.equal(res.status, 200);
        assert.equal(res.headers.get('X-ST-Stream-Format'), 'compact-v1');
        generationId = res.headers.get('X-Generation-Id');
        assert.ok(generationId, 'a real X-Generation-Id header was sent for this raw-action stream, required for resume');

        const reader = res.body.getReader();
        const { value: firstChunk, done: firstDone } = await reader.read();
        assert.ok(!firstDone && firstChunk && firstChunk.length > 0, 'a real first chunk was received before disconnecting - proves the stream was genuinely underway');
        bytesReceived += firstChunk.length;
        applyEvents(decoder.push(firstChunk));
        assert.ok(text.length > 0 && expectedText.startsWith(text), 'the first real chunk decoded to a real prefix of the expected text');
        assert.ok(text.length < expectedText.length, 'the backend has more content still to send - the drop below is genuinely mid-generation, not after the fact');

        // Real socket-level disconnect: closes the actual TCP connection to the server, firing the
        // route's real `response.socket.on('close', ...)` handler (same mechanism as kobold.test.js's
        // own real-disconnect test).
        controller.abort();
        await assert.rejects(() => reader.read(), 'the original connection is genuinely dead after abort()');

        // --- Phase 2: reconnect via the real resume endpoint WHILE the backend is still actively
        // streaming further chunks the server has never sent to any client yet (see the delay in
        // startFakeSseBackendPaced) - this exercises the live-continuation path (case (a) in
        // llamacpp-compact-stream.js's streamGenerationResume() doc comment), not just a replay of a
        // finished buffer. ---
        const resumeRes = await fetch(`http://127.0.0.1:${port}/generate/resume/${encodeURIComponent(generationId)}?from=${bytesReceived}`);
        assert.equal(resumeRes.status, 200, 'the resume endpoint accepted the real generation id and byte offset');
        assert.equal(resumeRes.headers.get('X-ST-Stream-Format'), 'compact-v1');

        const resumeReader = resumeRes.body.getReader();
        for (; ;) {
            const { done, value } = await resumeReader.read();
            if (done) break;
            if (value && value.length) {
                bytesReceived += value.length;
                applyEvents(decoder.push(value));
            }
        }
        applyEvents(decoder.flush());
    } finally {
        await fakeBackend.done;
        fakeBackend.server.close();
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }

    // --- The central assertion: the SAME CompactStreamDecoder, fed the pre-drop bytes and then the
    // resumed bytes, reconstructs the complete, correct text exactly once - no loss, no duplication
    // across the resume boundary. ---
    assert.equal(text, expectedText, 'the resumed stream, spliced into the same decoder, reconstructs the exact complete text with nothing lost or duplicated across the disconnect/resume boundary');
    assert.ok(assistantNodeId, 'the assistant_node_id frame was received via the resume response - the generation completed and persisted for real, and the client learned about it through the resumed connection');

    const branchAfter = await waitFor(async () => {
        const branch = await loadBranch(directories, ownerId, branchName);
        return branch.messages.length === branchBefore.messages.length + 2 ? branch : null;
    });
    const assistantMsg = branchAfter.messages[branchAfter.messages.length - 1];
    assert.equal(assistantMsg.mes, expectedText, 'the real persisted tree message matches the resumed text exactly - the dropped connection did not truncate what got saved, because the upstream generation kept running/buffering in the background after the client disconnected');
    assert.equal(assistantMsg.node_id, assistantNodeId, 'the node id learned via resume is the exact node the reply actually landed on');

    // --- A second resume attempt for the same (now-finished) generation id, asking for bytes already
    // delivered, must NOT re-deliver or duplicate anything already seen - it should simply serve
    // whatever remains from that (earlier) offset, which by now is nothing, and close. ---
    {
        const server2 = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server2.once('listening', resolve));
        const port2 = server2.address().port;
        try {
            const secondResume = await fetch(`http://127.0.0.1:${port2}/generate/resume/${encodeURIComponent(generationId)}?from=${bytesReceived}`);
            assert.equal(secondResume.status, 200);
            const bytes = Buffer.from(await secondResume.arrayBuffer());
            assert.equal(bytes.length, 0, 'resuming again from the already-fully-received offset yields no further bytes (no duplication)');
        } finally {
            server2.closeAllConnections?.();
            await new Promise(resolve => server2.close(resolve));
        }
    }

    // --- An unknown generation id must fail clearly, so the client can give up rather than hang. ---
    {
        const server3 = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server3.once('listening', resolve));
        const port3 = server3.address().port;
        try {
            const unknownResume = await fetch(`http://127.0.0.1:${port3}/generate/resume/not-a-real-generation-id?from=0`);
            assert.equal(unknownResume.status, 404);
            const data = await unknownResume.json();
            assert.equal(data.error, 'unknown_generation');
        } finally {
            server3.closeAllConnections?.();
            await new Promise(resolve => server3.close(resolve));
        }
    }

    console.log('resume-stream.test.js: all assertions passed');
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
