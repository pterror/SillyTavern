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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-text-completions-raw-action-test-'));
const charactersDir = path.join(root, 'characters');
const groupsDir = path.join(root, 'groups');
const worldsDir = path.join(root, 'worlds');
fs.mkdirSync(charactersDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(worldsDir, { recursive: true });

const directories = { root, characters: charactersDir, groups: groupsDir, worlds: worldsDir };
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
    const branchName = 'main-chat';
    await saveChatToTree(directories, ownerId, branchName, [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Hello there, traveler.', send_date: 1, extra: {} },
        { name: 'Tester', is_user: true, mes: 'Hi Rex, nice to meet you.', send_date: 2, extra: {} },
        { name: 'Rex', is_user: false, mes: 'Likewise!', send_date: 3, extra: {} },
    ]);

    // --- happy path: a new user message on an existing branch ---
    const built = await buildRawActionTextCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, branchName,
        type: 'normal', userMessageText: 'What happens next, Rex?',
        tokenizerOptions: fakeTokenizerOptions,
    });

    assert.equal(built.backend.type, 'generic', 'backend resolves for real via resolveTextGenBackend()');
    assert.equal(built.backend.model, 'test-model-7b');
    assert.equal(built.name1, 'Tester', 'name1 resolves from settings.json username, same as the orchestrator input');
    assert.ok(built.anchorNodeId, 'anchorNodeId resolves to the real leaf of the loaded branch');

    const branchBeforeAppend = await loadBranch(directories, ownerId, branchName);
    assert.equal(built.anchorNodeId, branchBeforeAppend.branch.leaf_id, 'anchorNodeId is exactly the loaded branch\'s real leaf_id');

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

    // --- continue/swipe: no userMessageText, still resolves and assembles from the real history ---
    const continued = await buildRawActionTextCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, branchName, type: 'continue', isContinue: true,
        tokenizerOptions: fakeTokenizerOptions,
    });
    assert.ok(continued.params.prompt.includes('Likewise!'), 'continue resolves from the real existing history with no new message appended');
    assert.equal(continued.anchorNodeId, branchAfterAppend.branch.leaf_id, 'the continue anchor is the real current leaf');
    assert.equal(continued.anchorContent?.mes, 'What happens next, Rex?', 'anchorContent is the anchor\'s real, current, unmodified content (the real leaf at this point in the test, appended above) - exactly what the route\'s is_continue edit needs as "oldText"');

    // --- error handling: unknown character ---
    await assert.rejects(
        () => buildRawActionTextCompletionRequest(directories, {
            characterAvatar: 'NoSuchCharacter.png', ownerId, branchName,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Character not found/,
    );

    // --- error handling: unknown branch ---
    await assert.rejects(
        () => buildRawActionTextCompletionRequest(directories, {
            characterAvatar: avatar, ownerId, branchName: 'no-such-branch',
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /Chat branch not found/,
    );

    // --- error handling: missing branch/node identity ---
    await assert.rejects(
        () => buildRawActionTextCompletionRequest(directories, {
            characterAvatar: avatar, ownerId,
            tokenizerOptions: fakeTokenizerOptions,
        }),
        /branch_name or node_id is required/,
    );

    // --- error handling: missing character/group ---
    await assert.rejects(
        () => buildRawActionTextCompletionRequest(directories, {
            ownerId, branchName,
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
            await new Promise(resolve => server.close(resolve));
        }
    }

    function pointBackendAt(url) {
        const settings = buildSettingsFixture();
        settings.textgenerationwebui_settings.server_urls = { generic: url };
        writeAllSettings(directories, settings);
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
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
            type: 'normal', user_message: 'One more time, Rex?', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ text: 'Rex says hello back.' }] }, 'response body reaches the client unmodified');

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
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: branchName,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: swipeBranch,
            type: 'swipe', is_swipe: true, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ text: 'Greetings, traveler!' }] }, 'the generated text still reaches the client unmodified');

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
            owner_id: ownerId, character_avatar: avatar, branch_name: regenBranch,
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
            owner_id: ownerId, character_avatar: avatar, branch_name: continueBranch,
            type: 'continue', is_continue: true, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ text: ' there was a brave adventurer.' }] }, 'the generated text still reaches the client unmodified');

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
            owner_id: ownerId, character_avatar: avatar, branch_name: continueWithUserTextBranch,
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

        // --- assembly: buildRawActionTextCompletionRequest() with BOTH characterAvatar (Nova, the
        // member actually responding this turn) AND groupId (the group) set together. ---
        const builtGroup = await buildRawActionTextCompletionRequest(directories, {
            characterAvatar: nova, groupId, ownerId: groupId, branchName: groupChatId,
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
            owner_id: groupId, character_avatar: nova, group_id: groupId, branch_name: groupChatId,
            type: 'normal', user_message: 'Nova, status report?', stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the group raw-action generation succeeds');
        assert.deepEqual(data, { choices: [{ text: 'All systems nominal, Captain.' }] }, 'response body reaches the client unmodified');

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

    // (i) the STREAMING raw-action case (request.body.stream: true) is intentionally NOT exercised
    // here: proving the assistant reply is untouched for it is trivial (pendingAssistantPersist is
    // simply never read by either streaming branch - see the code comment at its declaration in
    // text-completions.js), but actually driving a real SSE/Ollama-stream/llama.cpp-compact-stream
    // response through this harness and asserting the raw bytes reach the client unchanged would be
    // exercising the EXISTING (unmodified) streaming plumbing, not anything this session touched -
    // out of scope here. This session's change to the streaming branches is exactly zero lines; see
    // the manual diff review noted in this session's own report instead.

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
