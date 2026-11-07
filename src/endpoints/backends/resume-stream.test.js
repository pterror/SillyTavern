import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
import { setConfigFilePath } from '../../util.js';
import { streamAsSetting } from '../../../tests/util/stream-as-setting.js';
import { handleGenerationStop } from '../../generation-stop.js';
import { handleGenerationResume } from './llamacpp-compact-stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

const { router } = await import('./text-completions.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { CompactStreamDecoder } = await import('../../../public/scripts/llamacpp-compact-stream.js');
const { newSessionKey } = await import('../../chat-engine.js');
const { SESSION_HEADER } = await import('../../request-session.js');
const { convertedUser, writeLibraryCard, seedMessages, sessionPath } = await import('../../../tests/converted-user.fixture.js');

const user = await convertedUser('st-resume-stream-test-');
const { directories } = user;
globalThis.DATA_ROOT = user.dataRoot;

let branches = 0;

/**
 * @param {string} avatar
 */
async function newBranch(avatar) {
    const session = newSessionKey();
    const [greeting] = await seedMessages(user.store, { avatar }, null, [{ name: 'Rex', is_user: false, mes: `Hello there, traveler. (${++branches})`, send_date: 1, extra: {} }], { session });
    return { session, leaf: greeting, messages: await sessionPath(user.store, { avatar }, session) };
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
            name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            alternate_greetings: [], extensions: {},
        },
        ...overrides,
    };
    const cardJson = JSON.stringify(card);
    const buffer = writeCard(baseImage, cardJson);
    await writeLibraryCard(user, avatar, cardJson, buffer);
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

function startFakeSseBackendPaced(chunks, delayMs = 40) {
    let resolveDone;
    let handlerStarted = false;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const startPromise = startFakeBackend((_req, res) => {
        handlerStarted = true;
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
    return startPromise.then(backend => ({ ...backend, done, handlerStarted: () => handlerStarted }));
}

function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: 'u' } };
        next();
    });
    app.use(streamAsSetting());
    app.post('/generate/stop/:id', handleGenerationStop);
    app.get('/generate/resume/:id', handleGenerationResume);
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
    const avatar = await writeCharacter('Rex.png', {
        name: 'Rex',
        description: 'Rex is a {{char}}.',
        data: { name: 'Rex', description: 'Rex is a {{char}}.', first_mes: 'Hi, I am Rex.' },
    });
    const ownerId = avatar;

    const branchBefore = await newBranch(avatar);

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
        const res = await fetch(`http://127.0.0.1:${port}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: branchBefore.session },
            body: JSON.stringify({
                owner_id: ownerId, character_avatar: avatar, node_id: branchBefore.leaf,
                type: 'normal', user_message: { is_user: true, name: 'User', mes: 'Tell me a story, then vanish.' }, stream: true,
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

        controller.abort();
        await assert.rejects(() => reader.read(), 'the original connection is genuinely dead after abort()');

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
        if (fakeBackend.handlerStarted()) await fakeBackend.done;
        fakeBackend.server.close();
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }

    assert.equal(text, expectedText, 'the resumed stream, spliced into the same decoder, reconstructs the exact complete text with nothing lost or duplicated across the disconnect/resume boundary');
    assert.ok(assistantNodeId, 'the assistant_node_id frame was received via the resume response - the generation completed and persisted for real, and the client learned about it through the resumed connection');

    const branchAfter = await waitFor(async () => {
        const shown = await sessionPath(user.store, { avatar }, branchBefore.session);
        return shown.length === branchBefore.messages.length + 2 ? shown : null;
    });
    const assistantMsg = branchAfter[branchAfter.length - 1];
    assert.equal(assistantMsg.mes, expectedText, 'the real persisted tree message matches the resumed text exactly - the dropped connection did not truncate what got saved, because the upstream generation kept running/buffering in the background after the client disconnected');
    assert.equal(assistantMsg.node_id, assistantNodeId, 'the node id learned via resume is the exact node the reply actually landed on');

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
    .finally(() => user.close());
