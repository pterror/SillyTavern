import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const { buildRawActionTextCompletionRequest } = await import('./text-completions.js');
const { writeAllSettings } = await import('../../settings-store.js');
const { saveChatToTree, loadBranch, appendMessages, disposeMessageTreeStores } = await import('../../message-tree-db.js');

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
