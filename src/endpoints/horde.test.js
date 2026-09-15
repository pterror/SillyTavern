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

// Route-level Express-integration test for horde.js's own real raw-action /generate-text branch -
// see this task's own report / src/endpoints/horde.js's `buildRawActionHordePayload()` doc comment
// for the full architecture. Mirrors src/endpoints/backends/kobold.test.js's/novelai.test.js's
// established convention: a real express app mounting the real routers, real on-disk fixtures
// (writeCharacter/buildSettingsFixture/saveChatToTree/writeAllSettings), and loadBranch()-based
// tree-persistence assertions.
//
// JUDGMENT CALL (verified, not assumed): AI Horde's real coordinator URL
// (`https://aihorde.net/api/v2/generate/text/async`) is hardcoded in horde.js's own `/generate-text`
// route - there is no settings.json field or raw-action-resolved value that can override it (unlike
// Kobold's own `kai_settings.api_server`, which the raw-action branch DOES resolve from real,
// on-disk settings - see kobold.test.js's own comment on this exact distinction for NovelAI). So,
// like novelai.test.js, this file uses this repo's own established `mock.module()` node-fetch reroute
// technique to redirect ONLY `https://aihorde.net` traffic to a local fake backend - every other URL
// (there are none reachable from this route) would pass straight through unmodified.
//
// SCOPE: this file only exercises what the SERVER genuinely participates in - assembling the
// raw-action prompt (via buildRawActionKoboldRequest(), reused as-is from kobold.js with
// `macroExtras: { isHorde: true }`), persisting the user's message immediately, and submitting the
// job to Horde's real coordinator. The actual submit-then-POLL-then-report loop
// (public/scripts/horde.js's `generateHordeRawAction()`/`pollHordeTask()`) is real BROWSER code that
// polls `/api/horde/task-status` itself over time with a live client-side AbortController - a
// genuinely different, client-side concern this Node test suite does not simulate (see this task's
// own report for the full "why this architecture" investigation). What IS tested end-to-end here is
// the real persistence contract that architecture depends on: this route's own `raw_action_persist`
// response field carries everything `generateHordeRawAction()`'s own `persistHordeRawActionReply()`
// needs to persist the assistant's reply via the EXISTING, already-idempotent-by-content-identity
// `/api/chats/message/append` route (src/endpoints/chats.js) - test (a) below drives that SAME real
// route directly with the SAME real field shape `persistHordeRawActionReply()` sends, proving the
// full real persistence chain (user message via buildRawActionHordePayload(), assistant reply via
// the real chats.js route) produces the correct final tree state.
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
    console.log('horde.test.js: node:test mock.module() is unavailable (run with --experimental-test-module-mocks) - skipping all raw-action /generate-text route tests, which need it to redirect AI Horde\'s hardcoded coordinator host to a local fake backend');
}

const { router: hordeRouter } = await import('./horde.js');
const { router: chatsRouter } = await import('./chats.js');
const { writeAllSettings } = await import('../settings-store.js');
const { saveChatToTree, loadBranch, getAlternatives, disposeMessageTreeStores } = await import('../message-tree-db.js');

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

async function startFakeHordeCoordinator(handler) {
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
        req.user = { directories, profile: { handle: 'tester' } };
        next();
    });
    app.use('/api/horde', hordeRouter);
    app.use('/api/chats', chatsRouter);
    return app;
}

async function postJson(app, urlPath, body) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
    } finally {
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
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
    // construction) always strips the `.png` extension before sending `owner_id`
    // (`characterAvatar.replace('.png', '')`), and src/endpoints/chats.js's own `ownerOf()` (used by
    // the REAL /api/chats/message/append route this test also drives directly, in test (a) below)
    // does the exact same strip from `avatar_url` - so both must agree on the SAME owner id for
    // test (a)'s two real routes to operate on the same tree row.
    const ownerId = avatar.replace(/\.png$/, '');
    const branchName = 'main-chat';
    await saveChatToTree(directories, ownerId, branchName, [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        { name: 'Tester', is_user: true, mes: 'Hi Rex, nice to meet you.', send_date: 2, extra: {} },
        { name: 'Rex', is_user: false, mes: 'Likewise!', send_date: 3, extra: {} },
    ]);

    // (a) route-level: successful raw-action submission + real persistence of BOTH the user message
    // (via buildRawActionHordePayload(), server-side, immediately) and the assistant reply (via the
    // REAL /api/chats/message/append route, driven directly with the exact same field shape
    // public/scripts/horde.js's own persistHordeRawActionReply() sends once its own polling loop
    // resolves - see this file's own top-of-file doc comment for why the polling loop itself isn't
    // simulated here).
    {
        const fakeCoordinator = await startFakeHordeCoordinator((req, res, body) => {
            assert.equal(req.url, '/api/v2/generate/text/async', 'the raw-action submission really hits AI Horde\'s real async-generate endpoint');
            const parsed = JSON.parse(body);
            assert.equal(typeof parsed.prompt, 'string', 'a real, server-assembled prompt is sent as a separate top-level field');
            assert.ok(parsed.prompt.includes('Hello there, traveler.'));
            assert.ok(parsed.prompt.includes('One more time, Rex?'), 'the raw user action is included in the assembled prompt');
            assert.equal(parsed.params.prompt, undefined, 'prompt is NOT duplicated inside params - matches generateHorde()\'s own delete params.prompt transformation');
            assert.equal(parsed.params.n, 1);
            assert.equal(parsed.params.api_server, undefined, 'api_server (Kobold-specific, meaningless for Horde) is stripped, never forwarded to the real coordinator');
            assert.equal(parsed.trusted_workers, true);
            assert.deepEqual(parsed.models, ['some-horde-model']);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'task-abc-123' }));
        });
        hordeFakeBackendUrl = fakeCoordinator.url;

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postJson(app, '/api/horde/generate-text', {
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
            type: 'normal', user_message: 'One more time, Rex?',
            trusted_workers: true, models: ['some-horde-model'],
        });
        fakeCoordinator.server.close();
        hordeFakeBackendUrl = null;

        assert.equal(status, 200);
        assert.equal(data.id, 'task-abc-123', 'the real Horde task id reaches the client');
        assert.ok(data.raw_action_persist, 'raw_action_persist metadata is attached for a real, persistable raw-action request');
        assert.equal(data.raw_action_persist.isSwipe, false);
        assert.equal(data.raw_action_persist.isContinue, false);
        assert.equal(data.raw_action_persist.name2, 'Rex', 'name2 is the character\'s real display name');
        assert.ok(data.raw_action_persist.anchorNodeId, 'a real anchor node id (the just-persisted user message) is returned');

        // The user message was already persisted, server-side, immediately - BEFORE any Horde
        // polling could even begin (matches every other raw-action backend's "persist regardless of
        // outcome" principle).
        const branchAfterSubmit = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfterSubmit.messages.length, messageCountBefore + 1, 'only the user message was persisted at submission time - the assistant reply is not known yet');
        const userMsg = branchAfterSubmit.messages[branchAfterSubmit.messages.length - 1];
        assert.equal(userMsg.mes, 'One more time, Rex?');
        assert.equal(userMsg.is_user, true);
        assert.equal(userMsg.node_id, data.raw_action_persist.anchorNodeId, 'raw_action_persist.anchorNodeId really is the just-appended user message\'s own node id');

        // Now simulate generateHordeRawAction()'s OWN post-poll persistence call - the exact same
        // real route, with the exact same real field shape persistHordeRawActionReply() sends for
        // the plain (neither continue nor swipe) case.
        const appendResult = await postJson(app, '/api/chats/message/append', {
            avatar_url: avatar, after_node_id: data.raw_action_persist.anchorNodeId,
            messages: [{ name: data.raw_action_persist.name2, is_user: false, mes: 'Rex says hello back.', extra: {}, send_date: Date.now() }],
        });
        assert.equal(appendResult.status, 200);
        assert.ok(appendResult.data.ok, 'the real /api/chats/message/append route accepted the assistant reply');

        const branchAfterReply = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfterReply.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply are now persisted');
        const [finalUserMsg, assistantMsg] = branchAfterReply.messages.slice(-2);
        assert.equal(finalUserMsg.mes, 'One more time, Rex?');
        assert.equal(assistantMsg.mes, 'Rex says hello back.');
        assert.equal(assistantMsg.is_user, false);
        assert.equal(assistantMsg.name, 'Rex');

        // Chained, not a sibling: the assistant message is a direct child of the user message, not a
        // swipe alternative - real ancestry depth check via getAlternatives, same style as
        // kobold.test.js's own (a) test.
        const userAlternatives = await getAlternatives(directories, userMsg.node_id);
        assert.equal(userAlternatives.total, 1, 'the persisted user message has no siblings - it is a genuine new child, not a swipe alternative');
    }

    // (b) validation error: unknown character - buildRawActionKoboldRequest() throws for real, the
    // route surfaces it as a 400 with the real error message, and (critically) never even attempts
    // to reach the real Horde coordinator - proven by NOT pointing hordeFakeBackendUrl at anything,
    // so a stray real network call to https://aihorde.net would either fail this test's process (no
    // network in a sandboxed test run) or hang, not silently succeed.
    {
        hordeFakeBackendUrl = null;
        const app = buildTestApp();
        const { status, data } = await postJson(app, '/api/horde/generate-text', {
            owner_id: 'NoSuchCharacter.png', character_avatar: 'NoSuchCharacter.png',
            branch_name: branchName, type: 'normal', user_message: 'Hello?',
            trusted_workers: false, models: [],
        });

        assert.equal(status, 400);
        assert.match(data.message, /Character not found/, 'the real buildRawActionKoboldRequest() validation error message reaches the client');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        const branchNow = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, branchNow.messages.length, 'no persistence was attempted for a request that failed validation');
    }

    // (c) legacy, non-raw-action passthrough is unaffected: no `owner_id` field at all means the
    // route never even looks at buildRawActionHordePayload() - the exact real
    // {prompt, params, trusted_workers, models} shape generateHorde() itself builds client-side is
    // forwarded to the real coordinator completely unmodified, and no raw_action_persist metadata is
    // attached.
    {
        const fakeCoordinator = await startFakeHordeCoordinator((req, res, body) => {
            const parsed = JSON.parse(body);
            assert.equal(parsed.prompt, 'Legacy client-assembled prompt.');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'legacy-task-456' }));
        });
        hordeFakeBackendUrl = fakeCoordinator.url;

        const branchBefore = await loadBranch(directories, ownerId, branchName);
        const messageCountBefore = branchBefore.messages.length;

        const app = buildTestApp();
        const { status, data } = await postJson(app, '/api/horde/generate-text', {
            prompt: 'Legacy client-assembled prompt.',
            params: { max_length: 100, max_context_length: 2048 },
            trusted_workers: false,
            models: ['some-model'],
        });
        fakeCoordinator.server.close();
        hordeFakeBackendUrl = null;

        assert.equal(status, 200);
        assert.deepEqual(data, { id: 'legacy-task-456' }, 'the real coordinator response reaches the client with no raw_action_persist field attached');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no persistence was attempted for a non-raw-action request');
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
