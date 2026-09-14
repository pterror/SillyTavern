import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { write as writeCard } from '../../character-card-parser.js';
// chat-completions.js -> chat-completion-generation-input.js pulls in src/endpoints/characters.js
// (via readCardContent) and src/endpoints/tokenizers.js, both of which read process-wide config at
// import time - the config path must be set before that import chain runs, same as
// chat-completion-generation-input.test.js/text-completions.test.js.
import { setConfigFilePath } from '../../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', '..', 'config.yaml'));

// This route handler (src/endpoints/backends/chat-completions.js) mirrors
// src/endpoints/backends/text-completions.js's own precedent (commits ac42ce8c9/6eaa7897d) - no
// existing route-level Express-integration-test convention elsewhere either, so the REQUEST-BUILDING
// portion of the new raw-action /generate branch was extracted into a small, Express-independent,
// directly-testable function - buildRawActionChatCompletionRequest() - exercised here directly with
// real on-disk fixtures, the same way chat-completion-generation-input.test.js and
// text-completions.test.js test their own real logic.
//
// The assistant-reply-persistence addition (wired into the single shared non-streaming response
// point of the default/legacy inline OpenAI/custom dispatch block) DOES need a real route-level
// exercise - there is no way to observe `pendingAssistantPersist` being read from outside the route
// handler otherwise. A minimal harness is built here, identical in spirit to
// text-completions.test.js's own: mount the real `router` on a real `express` app (with a tiny
// middleware standing in for auth middleware's `request.user.directories`), listen on an ephemeral
// port, and point a SECOND real `http` server (standing in for the chat-completion backend) at it via
// `oai_settings.chat_completion_source: 'custom'` + `custom_url` in the settings fixture below - both
// real network I/O, no mocking framework.
const { router, buildRawActionChatCompletionRequest } = await import('./chat-completions.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { saveChatToTree, loadBranch, appendMessages, getAncestorPath, getAlternatives, disposeMessageTreeStores } = await import('../../message-tree-db.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-completions-raw-action-test-'));
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

/** Real settings.json fixture - only the keys resolveChatCompletionGenerationInput()/createGenerationParameters() actually read. */
function buildSettingsFixture() {
    return {
        username: 'Tester',
        power_user: {
            persona_description: '',
            persona_description_position: 0,
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
    const built = await buildRawActionChatCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, branchName,
        type: 'normal', userMessageText: 'What happens next, Rex?',
    });

    assert.equal(built.settings.chat_completion_source, 'custom', 'settings resolves for real from oai_settings');
    assert.equal(built.name1, 'Tester', 'name1 resolves from settings.json username, same as the orchestrator input');
    assert.equal(built.name2, 'Rex');
    assert.ok(built.anchorNodeId, 'anchorNodeId resolves to the real leaf of the loaded branch');

    const branchBeforeAppend = await loadBranch(directories, ownerId, branchName);
    assert.equal(built.anchorNodeId, branchBeforeAppend.branch.leaf_id, 'anchorNodeId is exactly the loaded branch\'s real leaf_id');

    assert.ok(built.params && typeof built.params === 'object', 'params (generate_data) is a real object');
    assert.equal(built.params.model, 'test-model', 'params.model is the resolved chat-completion model, matching getChatCompletionModel()');
    assert.equal(built.params.chat_completion_source, 'custom');
    assert.ok(Array.isArray(built.params.messages), 'params.messages is the real, prepared chat-completion message array');
    const joined = built.params.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.ok(joined.includes('Hello there, traveler.'), 'the real loaded chat history made it into the prepared messages');
    assert.ok(joined.includes('What happens next, Rex?'), 'the raw user_message made it into the prepared messages');

    // --- persistence: the anchorNodeId this function resolves is really appendable-after ---
    const appendResult = await appendMessages(directories, ownerId, built.anchorNodeId, [
        { name: built.name1, is_user: true, mes: 'What happens next, Rex?', extra: {}, send_date: Date.now() },
    ]);
    assert.equal(appendResult.ok, true, 'appendMessages() accepts the resolved anchorNodeId as a real anchor');
    const branchAfterAppend = await loadBranch(directories, ownerId, branchName);
    assert.equal(branchAfterAppend.messages.length, 4, 'the persisted user message is now part of the real loaded branch');
    assert.equal(branchAfterAppend.messages[3].mes, 'What happens next, Rex?');

    // --- continue: no userMessageText, still resolves and assembles from the real history ---
    const continued = await buildRawActionChatCompletionRequest(directories, {
        characterAvatar: avatar, ownerId, branchName, type: 'continue', isContinue: true,
    });
    const continuedJoined = continued.params.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.ok(continuedJoined.includes('Likewise!'), 'continue resolves from the real existing history with no new message appended');
    assert.equal(continued.anchorNodeId, branchAfterAppend.branch.leaf_id, 'the continue anchor is the real current leaf');
    assert.equal(continued.anchorContent?.mes, 'What happens next, Rex?', 'anchorContent is the anchor\'s real, current, unmodified content (the real leaf at this point in the test, appended above) - exactly what the route\'s is_continue edit needs as "oldText"');

    // --- error handling: missing owner_id ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, branchName,
        }),
        /owner_id is required/,
    );

    // --- error handling: unknown character ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: 'NoSuchCharacter.png', ownerId, branchName,
        }),
        /Character not found/,
    );

    // --- error handling: unknown branch ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, ownerId, branchName: 'no-such-branch',
        }),
        /Chat branch not found/,
    );

    // --- error handling: missing branch/node identity ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            characterAvatar: avatar, ownerId,
        }),
        /branch_name or node_id is required/,
    );

    // --- error handling: missing character/group ---
    await assert.rejects(
        () => buildRawActionChatCompletionRequest(directories, {
            ownerId, branchName,
        }),
        /character_avatar or group_id is required/,
    );

    // --- route-level: non-streaming raw-action /generate persists the assistant reply for real ---
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
        settings.oai_settings.custom_url = url;
        writeAllSettings(directories, settings);
    }

    // (a) a real non-streaming generation appends the assistant's reply onto the tree, chained after
    // the just-persisted user message, with the correct name/is_user.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Rex says hello back.' } }] }));
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
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'Rex says hello back.' } }] }, 'response body reaches the client unmodified');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore + 2, 'both the user message and the assistant reply were appended');
        const [userMsg, assistantMsg] = branchAfter.messages.slice(-2);
        assert.equal(userMsg.mes, 'One more time, Rex?');
        assert.equal(userMsg.is_user, true);
        assert.equal(assistantMsg.mes, 'Rex says hello back.', 'the assistant reply text was extracted from data.choices[0].message.content and appended');
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

    // (c) is_impersonate: true - NEITHER the (spuriously passed) user_message NOR the generated reply
    // may ever land on the tree, even though the backend call succeeds and returns real text. The
    // generated text must still reach the client unchanged.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'I think you should go north.' } }] }));
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
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'I think you should go north.' } }] }, 'the generated text still reaches the client unmodified');

        const branchAfter = await loadBranch(directories, ownerId, branchName);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no message (user or assistant) was appended for is_impersonate: true');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the branch leaf/ancestor path is completely unchanged');
    }

    // (d) type: 'quiet' - same assertion as (c): no tree mutation on either side, response still
    // forwarded to the client unchanged.
    {
        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Meta/background result.' } }] }));
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
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'Meta/background result.' } }] }, 'the generated text still reaches the client unmodified');

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
        const swipedNodeId = branchBefore.branch.leaf_id;
        const swipedAncestry = await getAncestorPath(directories, swipedNodeId);
        const parentNodeId = swipedAncestry[swipedAncestry.length - 2].node_id;

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Greetings, traveler!' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, branch_name: swipeBranch,
            type: 'swipe', is_swipe: true, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: 'Greetings, traveler!' } }] }, 'the generated text still reaches the client unmodified');

        const branchAfter = await loadBranch(directories, ownerId, swipeBranch);
        assert.notEqual(branchAfter.branch.leaf_id, swipedNodeId, 'the branch is now positioned on a DIFFERENT node - the new alternative');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Greetings, traveler!', 'the new alternative is now the active/default path');

        // (a) a new SIBLING was added under the correct parent - not a child of the swiped message.
        const newNodeId = branchAfter.branch.leaf_id;
        const newAncestry = await getAncestorPath(directories, newNodeId);
        assert.equal(newAncestry.length, swipedAncestry.length, 'the new alternative sits at the SAME depth as the swiped message (a sibling), not one deeper (a child)');
        assert.equal(newAncestry[newAncestry.length - 2].node_id, parentNodeId, 'the new alternative shares the swiped message\'s real parent');

        const alternatives = await getAlternatives(directories, swipedNodeId);
        assert.equal(alternatives.total, 2, 'the swiped message and the new alternative are now real siblings under the same parent');
        assert.ok(alternatives.alternatives.some(a => a.node_id === swipedNodeId && a.mes === 'Hello there!'), '(b) the swiped message\'s own original content is completely unchanged');
        assert.ok(alternatives.alternatives.some(a => a.node_id === newNodeId && a.mes === 'Greetings, traveler!'));

        // (c) selectDefaultChild() really was called - the new alternative is the one reported as
        // currently selected.
        const parentAlternatives = await getAlternatives(directories, newNodeId);
        assert.equal(parentAlternatives.selected, parentAlternatives.alternatives.findIndex(a => a.node_id === newNodeId), 'the new alternative is the one getAlternatives() reports as currently selected');
    }

    // (f) type: 'regenerate' maps onto the SAME is_swipe-driven persistence as 'swipe' - a real client
    // sends `is_swipe: true` for both (see public/script.js's own `isSwipe` local), so the route never
    // distinguishes between the two literal `type` strings for persistence purposes.
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
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A completely new reply.' } }] }));
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
    // newText), on the SAME node id, at the SAME position in the tree - never a new node.
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

        const fakeBackend = await startFakeBackend((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ' there was a brave adventurer.' } }] }));
        });
        pointBackendAt(fakeBackend.url);

        const app = buildTestApp();
        const { status, data } = await postGenerate(app, {
            owner_id: ownerId, character_avatar: avatar, branch_name: continueBranch,
            type: 'continue', is_continue: true, stream: false,
        });
        fakeBackend.server.close();

        assert.equal(status, 200, 'the (unchanged) response is forwarded to the client');
        assert.deepEqual(data, { choices: [{ message: { role: 'assistant', content: ' there was a brave adventurer.' } }] }, 'the generated text still reaches the client unmodified');

        const branchAfter = await loadBranch(directories, ownerId, continueBranch);
        assert.equal(branchAfter.messages.length, messageCountBefore, 'no new node (user or assistant) was created - continue only edits the existing leaf');
        assert.equal(branchAfter.branch.leaf_id, leafBefore, 'the SAME node is still the leaf - editMessage() edits in place, it does not reparent/replace the node');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].mes, 'Once upon a time, there was a brave adventurer.', 'the stored text is now oldText + newText, on the same node, at the same position');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].name, 'Rex');
        assert.equal(branchAfter.messages[branchAfter.messages.length - 1].is_user, false);
    }

    // (h) is_continue: true combined with a REAL (non-empty) user_message - see text-completions.test.js's
    // own identical case for the full rationale (public/script.js's own Generate() does not exempt
    // 'continue' from its send-textarea-as-user_message condition). The real user message must still be
    // committed, but the assistant reply must NOT be persisted anywhere (neither spliced onto the
    // original leaf, nor appended as a plain new child) - `continueUserTextConflict` skips it entirely.
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
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ' this should NOT be persisted anywhere.' } }] }));
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
        assert.equal(branchAfter.messages.length, messageCountBefore + 1, 'only the user message was added - the generated reply was NOT persisted anywhere in this guarded combination');
        const newLeaf = branchAfter.messages[branchAfter.messages.length - 1];
        assert.equal(newLeaf.mes, 'Wait, actually - tell me about dragons instead.');
        assert.equal(newLeaf.is_user, true);

        const originalNode = (await getAlternatives(directories, originalLeafId)).alternatives.find(a => a.node_id === originalLeafId);
        assert.equal(originalNode.mes, 'Once upon a time,', 'the original assistant leaf\'s text is byte-for-byte unchanged - continueUserTextConflict correctly skipped persisting the reply');
    }

    // (i) STREAMING and the provider-`switch` cases (Claude/AI21/MakerSuite/etc) are intentionally NOT
    // exercised here - see this session's report / the code comments at `pendingAssistantPersist`'s
    // declaration in chat-completions.js for the full, explicit list of what remains deferred. Proving
    // the assistant reply is untouched for them is trivial (pendingAssistantPersist is simply never
    // read on those paths), but actually driving real streaming/provider-specific traffic through this
    // harness would be exercising existing, unmodified plumbing - out of scope here.

    // --- error handling (route-level): missing owner_id falls through as an ordinary (non-raw-action)
    // request - it is NOT gated into the raw-action branch at all (the gate itself requires owner_id),
    // so it reaches the default dispatch code below with whatever fields the client actually sent.
    // Not asserted further here - this is the same "not a raw action" byte-for-byte-unchanged path the
    // connection_profile_id branch and legacy default path already exercise elsewhere.

    console.log('chat-completions.test.js: all assertions passed');
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
