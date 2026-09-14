import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { write as writeCard } from './character-card-parser.js';
// chat-completion-generation-input.js pulls in src/endpoints/characters.js (via readCardContent) and
// src/endpoints/tokenizers.js (via getTokenizerModel/getTiktokenTokenizer), both of which read
// process-wide config at import time - set the config path before importing it, the same way
// text-completion-generation-input.test.js (and character-card-fields.test.js before it) does, since
// this test runs standalone.
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const { resolveChatCompletionGenerationInput } = await import('./chat-completion-generation-input.js');
const { writeAllSettings } = await import('./settings-store.js');
const { saveChatToTree, disposeMessageTreeStores } = await import('./message-tree-db.js');
const { prepareOpenAIMessages } = await import('./chat-completion-prepare-messages.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-completion-generation-input-test-'));
const charactersDir = path.join(root, 'characters');
const groupsDir = path.join(root, 'groups');
const worldsDir = path.join(root, 'worlds');
fs.mkdirSync(charactersDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(worldsDir, { recursive: true });

const directories = { root, characters: charactersDir, groups: groupsDir, worlds: worldsDir };
globalThis.DATA_ROOT = root;

/** Minimal real on-disk lorebook, matching src/world-info/candidate-resolution.test.js's own fixture shape. */
function writeLorebook(name, entries) {
    const entriesObj = {};
    for (const entry of entries) {
        entriesObj[String(entry.uid)] = entry;
    }
    fs.writeFileSync(path.join(worldsDir, `${name}.json`), JSON.stringify({ entries: entriesObj }));
}

const baseImage = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'ai4.png'));

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

/** A real settings.json-shaped fixture, trimmed to what resolveChatCompletionGenerationInput() actually
 * reads - see that module's own field-mapping notes for exactly why each field lives where it does. */
function buildSettingsFixture() {
    return {
        username: 'Tester',
        main_api: 'koboldhorde', // deliberately NOT 'openai' - proves the resolver hardcodes mainApi regardless.
        power_user: {
            persona_description: 'A curious {{user}}.',
            persona_description_position: 1,
            console_log_prompts: false,
            pin_examples: false,
            prefer_character_prompt: true,
            prefer_character_jailbreak: false,
        },
        world_info: {
            globalSelect: ['TestLore'],
            charLore: [],
        },
        world_info_character_strategy: 1, // world_info_insertion_strategy.character_first
        oai_settings: {
            chat_completion_source: 'openai',
            openai_model: 'gpt-4o',
            openai_max_context: 8192,
            openai_max_tokens: 512,
            squash_system_messages: true,
            wi_format: '{0}',
            new_chat_prompt: '[Start a new Chat]',
            new_group_chat_prompt: '[Start a new group chat. Group members: {{group}}]',
            new_example_chat_prompt: '[Example Chat]',
            send_if_empty: '',
            continue_nudge_prompt: '[Continue your last message.]',
            impersonation_prompt: '[Write the next reply as {{user}}.]',
            assistant_prefill: '',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'You are {{char}}.', system_prompt: true },
                { identifier: 'worldInfoBefore', name: 'World Info (before)', role: 'system', content: '', system_prompt: true },
                { identifier: 'charDescription', name: 'Char Description', role: 'system', content: '', system_prompt: true },
                { identifier: 'charPersonality', name: 'Char Personality', role: 'system', content: '', system_prompt: true },
                { identifier: 'scenario', name: 'Scenario', role: 'system', content: '', system_prompt: true },
                { identifier: 'worldInfoAfter', name: 'World Info (after)', role: 'system', content: '', system_prompt: true },
                { identifier: 'dialogueExamples', name: 'Chat Examples', role: 'system', content: '', system_prompt: true },
                { identifier: 'chatHistory', name: 'Chat History', role: 'system', content: '', system_prompt: true },
                { identifier: 'jailbreak', name: 'Post-History Instructions', role: 'system', content: '', system_prompt: true },
            ],
            prompt_order: [
                {
                    character_id: 100000,
                    order: [
                        { identifier: 'main', enabled: true },
                        { identifier: 'worldInfoBefore', enabled: true },
                        { identifier: 'charDescription', enabled: true },
                        { identifier: 'charPersonality', enabled: true },
                        { identifier: 'scenario', enabled: true },
                        { identifier: 'worldInfoAfter', enabled: true },
                        { identifier: 'dialogueExamples', enabled: true },
                        { identifier: 'chatHistory', enabled: true },
                        { identifier: 'jailbreak', enabled: true },
                    ],
                },
            ],
        },
    };
}

async function run() {
    writeAllSettings(directories, buildSettingsFixture());
    writeLorebook('TestLore', [
        { uid: 'wi1', key: ['irrelevant-key'], keysecondary: [], comment: '', content: 'The ancient tower looms over the village.', constant: true, selective: false, order: 10, position: 0, disable: false },
    ]);
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

    const input = await resolveChatCompletionGenerationInput(directories, {
        avatar, ownerId, branchName,
        type: 'normal',
    });

    // --- settings-derived fields ---
    assert.equal(input.name2, 'Rex', 'name2 resolves from the real character card, not guessed');
    assert.equal(input.mainApi, 'openai', 'mainApi is hardcoded for this chat-completion-only resolver');
    assert.equal(input.model, 'gpt-4o', 'model resolves via the real getChatCompletionModel() port, keyed on oai_settings.chat_completion_source');
    assert.equal(input.maxContext, 8192, 'maxContext resolves from oai_settings.openai_max_context');
    assert.equal(input.maxTokens, 512, 'maxTokens resolves from oai_settings.openai_max_tokens');
    assert.equal(input.squashSystemMessages, true);
    assert.equal(input.personaDescription, 'A curious {{user}}.', 'personaDescription resolves from power_user.persona_description');
    assert.equal(input.personaDescriptionPosition, 1);
    assert.equal(input.wiFormat, '{0}');
    assert.deepEqual(input.prompts.map(p => p.identifier), buildSettingsFixture().oai_settings.prompts.map(p => p.identifier), 'prompts forwards the real oai_settings.prompts array');
    assert.equal(input.promptOrder[0].character_id, 100000);
    assert.equal(input.characterId, 100000, 'characterId defaults to the PromptManager dummy id');

    // --- character-card-field resolution (getCharacterCardFields(), not a lower-level manual parse) ---
    assert.equal(input.charDescription, 'Rex is a Rex.', 'charDescription resolves via the real getCharacterCardFields(), including macro substitution');
    assert.equal(input.systemPromptOverride, '', 'systemPromptOverride resolves from fields.system (empty card system_prompt here, but the real preferCharacterPrompt-gated path)');

    // --- world-info candidate resolution (real, via resolveWorldInfoCandidates()) - activation itself is a documented scope boundary ---
    assert.equal(input.worldInfoCandidates.length, 1, 'worldInfoCandidates is auto-resolved for real from the on-disk lorebook named in settings.world_info.globalSelect');
    assert.equal(input.worldInfoCandidates[0].content, 'The ancient tower looms over the village.');
    assert.equal(input.worldInfoBefore, '', 'worldInfoBefore is an explicit MVP scope boundary (activation not run by this resolver) - see module doc comment');
    assert.equal(input.worldInfoAfter, '');

    // An explicit override (including []) always wins over auto-resolution.
    const overriddenWI = await resolveChatCompletionGenerationInput(directories, {
        avatar, ownerId, branchName, worldInfoCandidates: [],
    });
    assert.deepEqual(overriddenWI.worldInfoCandidates, [], 'an explicit worldInfoCandidates override bypasses auto-resolution');

    // --- messages: converted to {role, content} shape via buildChatCompletionMessages(), NOT the
    // text-completion {is_user, mes} shape. NOTE: buildChatCompletionMessages() (a verbatim port of
    // the client's own setOpenAIMessages()) reverses order relative to its "oldest first" input - its
    // OUTPUT is newest-first (index 0 = most recent turn), matching what
    // populateChatHistory()/chat-completion-history.js's own `[...messages].reverse()` internally
    // expects to receive. Verified directly by reading both functions, not assumed. ---
    assert.equal(input.messages.length, 3, 'messages resolves via a real loadBranch() round trip through message-tree-db.js, converted to chat-completion shape');
    assert.equal(input.messages[0].content, 'Likewise!', 'messages[0] is the NEWEST turn - buildChatCompletionMessages() output is newest-first');
    assert.equal(input.messages[0].role, 'assistant');
    assert.equal(input.messages[1].role, 'user');
    assert.equal(input.messages[1].content, 'Hi Rex, nice to meet you.');
    assert.equal(input.messages[2].content, 'Hello there, traveler.', 'messages[2] is the OLDEST turn');
    assert.ok(!('is_user' in input.messages[0]), 'messages are NOT left in the tree-DB native {is_user, mes} shape');

    // --- userMessageText: appends the pending user action onto the loaded chat history, pre-conversion ---
    const withUserMessage = await resolveChatCompletionGenerationInput(directories, {
        avatar, ownerId, branchName,
        userMessageText: 'What happens next, Rex?',
    });
    assert.equal(withUserMessage.messages.length, 4, 'userMessageText appends one new message onto the real loaded history');
    // The appended message is the NEWEST turn, so it lands at messages[0] (see the newest-first note above).
    const appended = withUserMessage.messages[0];
    assert.equal(appended.role, 'user');
    assert.equal(appended.content, 'What happens next, Rex?');
    assert.equal(input.messages.length, 3, 'omitting userMessageText leaves messages exactly as loaded, unchanged');

    // --- tool-capability inputs are supplied, NOT pre-resolved by this resolver ---
    assert.equal(input.settings.chat_completion_source, 'openai', 'settings forwards the real oai_settings object for prepareOpenAIMessages() to resolve tool-capability values from internally');
    assert.equal(input.canUseToolsOverride, undefined);
    assert.ok(input.tokenHandler && typeof input.tokenHandler.countAsync === 'function', 'a real TokenHandler is constructed');

    // --- MVP scope boundaries, explicitly asserted (not silently defaulted) ---
    assert.equal(input.imageInlining, false);
    assert.equal(input.videoInlining, false);
    assert.equal(input.audioInlining, false);
    assert.equal(input.bias, '');

    // --- macroExtras override ---
    const overridden = await resolveChatCompletionGenerationInput(directories, {
        avatar, ownerId, branchName,
        macroExtras: { quietPrompt: 'Summarize the scene.', bias: '+happy' },
    });
    assert.equal(overridden.quietPrompt, 'Summarize the scene.', 'macroExtras is shallow-merged over the resolved object');
    assert.equal(overridden.bias, '+happy');

    // --- end-to-end: feed the resolved input straight into the REAL prepareOpenAIMessages() ---
    const result = await prepareOpenAIMessages(input);
    assert.ok(Array.isArray(result.chat), 'prepareOpenAIMessages() returns a real chat array, not null/undefined');
    assert.ok(result.chat.length > 0, 'the assembled chat-completion payload is non-empty end to end');
    const flattened = JSON.stringify(result.chat);
    assert.ok(flattened.includes('Hello there, traveler.'), 'the real chat history made it into the final chat-completion payload');
    assert.equal(typeof result.canUseTools, 'boolean', 'canUseTools is resolved internally by prepareOpenAIMessages(), not by this resolver');
    assert.equal(result.canUseTools, false, 'function_calling is not set in the fixture, so tool calling resolves to false internally');

    // --- end-to-end #2: the userMessageText-appended history flows all the way through the real orchestrator ---
    const resultWithUserMessage = await prepareOpenAIMessages(withUserMessage);
    const flattenedWithUserMessage = JSON.stringify(resultWithUserMessage.chat);
    assert.ok(
        flattenedWithUserMessage.includes('What happens next, Rex?'),
        'the new user message appended by userMessageText made it into the final assembled chat-completion payload',
    );

    console.log('chat-completion-generation-input.test.js: all assertions passed');
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
