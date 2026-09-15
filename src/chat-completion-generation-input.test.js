import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { write as writeCard } from './character-card-parser.js';
import './fetch-patch.js';
import { Jimp, JimpMime } from './jimp.js';
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
const { world_info_position } = await import('./world-info/result-bucketing.js');
const { extension_prompt_types, extension_prompt_roles } = await import('./extension-prompt-table.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-completion-generation-input-test-'));
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
        // world_info_depth wide enough to reach every message in this test's short chat history, so
        // the real keyword scan below can genuinely find 'traveler' regardless of which message it's in.
        world_info_settings: { world_info_depth: 10 },
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
    // A REAL, non-constant, non-stubbed lorebook entry - its key ('traveler') genuinely appears in the
    // chat history written below ('Hello there, traveler.'), so it only ends up in worldInfoBefore if
    // activateWorldInfoEntries()'s real keyword scan actually matches it, not via a forced/constant
    // activation.
    // wi2 is a real @Depth-positioned entry (position === world_info_position.atDepth, the raw
    // on-disk lorebook-entry field read directly by readWorldInfoFile()/getGlobalLore() - NOT the
    // extensions.position field that only applies to embedded V2/V3 character_book entries, per
    // src/world-info/candidate-resolution.js's own convertCharacterBook() vs getGlobalLore() field
    // mapping) whose key ('nice to meet') genuinely appears in the chat history written below ('Hi
    // Rex, nice to meet you.') - same real-scan-activation standard as wi1, not a forced/stubbed
    // activation.
    const WI_DEPTH_TEST_DEPTH = 3;
    const WI_DEPTH_TEST_ROLE = extension_prompt_roles.SYSTEM;
    const WI_DEPTH_TEST_CONTENT = 'A secret passed down at this exact depth.';
    writeLorebook('TestLore', [
        { uid: 'wi1', key: ['traveler'], keysecondary: [], comment: '', content: 'The ancient tower looms over the village.', constant: false, selective: false, order: 10, position: 0, disable: false },
        {
            uid: 'wi2', key: ['nice to meet'], keysecondary: [], comment: '', content: WI_DEPTH_TEST_CONTENT,
            constant: false, selective: false, order: 5, disable: false,
            position: world_info_position.atDepth, depth: WI_DEPTH_TEST_DEPTH, role: WI_DEPTH_TEST_ROLE,
        },
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

    // --- world-info candidate resolution (real, via resolveWorldInfoCandidates()) ---
    assert.equal(input.worldInfoCandidates.length, 2, 'worldInfoCandidates is auto-resolved for real from the on-disk lorebook named in settings.world_info.globalSelect (wi1 + the new @Depth wi2)');
    assert.equal(input.worldInfoCandidates[0].content, 'The ancient tower looms over the village.');

    // --- world-info ACTIVATION (real, via activateWorldInfoEntries()/bucketActivatedEntries()) - the
    // 'TestLore' entry's key ('traveler') only appears in the real chat history, so this only ends up
    // non-empty if the real keyword scan genuinely matched it (not a forced/constant activation). Its
    // `position: 0` (world_info_position.before) puts it in worldInfoBefore, not worldInfoAfter. ---
    assert.equal(input.worldInfoAfter, '', 'the test entry is position:before, so worldInfoAfter stays empty');
    assert.ok(
        input.worldInfoBefore.includes('The ancient tower looms over the village.'),
        'worldInfoBefore contains the real entry content, genuinely activated via keyword scan against the real chat history',
    );

    // --- world-info @Depth entries (real, via bucketActivatedEntries()'s worldInfoDepth output) are
    // now written into the real `injectionTable` (setExtensionPrompt()), the same key format
    // (`wi_depth_${depth}_${role}`)/position(IN_CHAT)/depth/scan(false)/role
    // src/text-completion-prompt-orchestrator.js's own reference Step 7.5 loop uses. wi2's key ('nice
    // to meet') only appears in the real chat history, so this only ends up populated if the real
    // keyword scan genuinely matched it. ---
    const wiDepthKey = `wi_depth_${WI_DEPTH_TEST_DEPTH}_${WI_DEPTH_TEST_ROLE}`;
    assert.ok(input.injectionTable[wiDepthKey], `injectionTable has a real entry at the expected ${wiDepthKey} key`);
    assert.equal(input.injectionTable[wiDepthKey].value, WI_DEPTH_TEST_CONTENT, 'the injectionTable entry carries the real, genuinely-activated @Depth entry content');
    assert.equal(input.injectionTable[wiDepthKey].position, extension_prompt_types.IN_CHAT);
    assert.equal(input.injectionTable[wiDepthKey].depth, WI_DEPTH_TEST_DEPTH);
    assert.equal(input.injectionTable[wiDepthKey].scan, false);
    assert.equal(input.injectionTable[wiDepthKey].role, WI_DEPTH_TEST_ROLE);
    // atDepth entries are routed to ONLY the injection table, not also concatenated into
    // worldInfoBefore/worldInfoAfter - verified against bucketActivatedEntries()'s own real behavior
    // (its `switch (entry.position)` has separate, non-overlapping branches for `before`/`after` vs
    // `atDepth`), not assumed.
    assert.ok(!input.worldInfoBefore.includes(WI_DEPTH_TEST_CONTENT), 'the @Depth entry content is NOT duplicated into worldInfoBefore');
    assert.ok(!input.worldInfoAfter.includes(WI_DEPTH_TEST_CONTENT), 'the @Depth entry content is NOT duplicated into worldInfoAfter');

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

    // --- userMessageExtra: a forwarded media-attachment reference becomes the appended message's
    // real `extra`, and (with imageInlining forced on via macroExtras, mirroring how
    // buildRawActionChatCompletionRequest() itself derives it from the real `oai_settings.media_inlining`
    // toggle) is later actually inlined by the real prepareOpenAIMessages()/buildChatCompletionMessages()
    // pipeline as a real image_url content part - not just carried through as inert data ---
    const jpegBuffer = await (async () => {
        const image = new Jimp({ width: 16, height: 16, color: 0xffffffff });
        return image.getBuffer(JimpMime.jpeg, { quality: 90, jpegColorSpace: 'ycbcr' });
    })();
    const dataUrl = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;
    const withUserMessageExtra = await resolveChatCompletionGenerationInput(directories, {
        avatar, ownerId, branchName,
        userMessageText: 'Look at this.',
        userMessageExtra: { media: [{ url: dataUrl, type: 'image', source: 'upload' }], media_index: 0 },
        macroExtras: { imageInlining: true },
    });
    const appendedWithExtra = withUserMessageExtra.messages[0];
    assert.deepEqual(appendedWithExtra.media, [{ url: dataUrl, type: 'image', source: 'upload' }]);
    const resultWithMedia = await prepareOpenAIMessages(withUserMessageExtra);
    const turnWithMedia = resultWithMedia.chat.find(m => Array.isArray(m.content));
    assert.ok(turnWithMedia, `expected a message with array (multi-part) content once media is inlined, got: ${JSON.stringify(resultWithMedia.chat)}`);
    const imagePart = turnWithMedia.content.find(p => p.type === 'image_url');
    assert.ok(imagePart, 'a real media-attachment reference forwarded via userMessageExtra is actually inlined into the assembled chat-completion payload as a real image_url content part');
    assert.ok(imagePart.image_url.url.startsWith('data:image/jpeg;base64,'));

    // --- userMessageExtra: a forwarded FILE (text) attachment reference is inlined into this
    // resolver's own `messages` output - i.e. BEFORE prepareOpenAIMessages() even runs - via the same
    // `appendFileAttachments()` (src/file-attachment-inline.js) text-completion-prompt-orchestrator.js
    // already reuses. Covers both resolution paths: a real on-disk file read via `.url`, and an
    // already-resolved `.text` entry that skips the disk read entirely. ---
    fs.writeFileSync(path.join(filesDir, 'notes.txt'), 'The tower key is hidden under the loose stone.');
    const withFileExtra = await resolveChatCompletionGenerationInput(directories, {
        avatar, ownerId, branchName,
        userMessageText: 'Check my notes.',
        userMessageExtra: {
            files: [
                { url: '/user/files/notes.txt', size: 42, name: 'notes.txt', created: 1700000000000 },
                { text: 'Also remember: the drawbridge is broken.', size: 10, name: 'inline.txt', created: 1700000000001 },
            ],
        },
    });
    const appendedWithFileExtra = withFileExtra.messages[0];
    assert.equal(appendedWithFileExtra.role, 'user');
    assert.ok(
        appendedWithFileExtra.content.includes('The tower key is hidden under the loose stone.'),
        'the .url-resolved file text was read off disk and inlined',
    );
    assert.ok(
        appendedWithFileExtra.content.includes('Also remember: the drawbridge is broken.'),
        'the already-resolved .text file entry was inlined without a disk read',
    );
    assert.ok(
        appendedWithFileExtra.content.includes('Check my notes.'),
        'the inlined file text is prepended onto the turn\'s own message text, not a replacement of it',
    );

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
    assert.ok(
        flattened.includes('The ancient tower looms over the village.'),
        'the genuinely-activated world-info content (worldInfoBefore) made it all the way into the final assembled chat-completion payload, end to end',
    );
    assert.equal(typeof result.canUseTools, 'boolean', 'canUseTools is resolved internally by prepareOpenAIMessages(), not by this resolver');
    assert.equal(result.canUseTools, false, 'function_calling is not set in the fixture, so tool calling resolves to false internally');

    // --- end-to-end #3: the @Depth entry's content, routed through the real injectionTable, actually
    // appears in the final assembled chat output (via populateInjectionPrompts()'s real depth-indexed
    // splicing), inserted somewhere into the message list (not over-asserting the exact index, per the
    // task's own "roughly" standard) - and is present exactly once, i.e. genuinely NOT also duplicated
    // via worldInfoBefore/worldInfoAfter. ---
    const depthOccurrences = result.chat.filter(msg => JSON.stringify(msg).includes(WI_DEPTH_TEST_CONTENT)).length;
    assert.ok(depthOccurrences > 0, 'the @Depth entry content made it into the final assembled chat-completion payload, end to end');
    assert.equal(depthOccurrences, 1, 'the @Depth entry content appears exactly once - not duplicated into worldInfoBefore/worldInfoAfter as well');

    // --- end-to-end #2: the userMessageText-appended history flows all the way through the real orchestrator ---
    const resultWithUserMessage = await prepareOpenAIMessages(withUserMessage);
    const flattenedWithUserMessage = JSON.stringify(resultWithUserMessage.chat);
    assert.ok(
        flattenedWithUserMessage.includes('What happens next, Rex?'),
        'the new user message appended by userMessageText made it into the final assembled chat-completion payload',
    );

    // --- bias: real resolution via getBiasStrings() (src/prompt-line-formatting.js), not stubbed.
    // power_user.user_prompt_bias set to a real, non-empty string; type: 'normal' (NOT
    // impersonate/continue, which short-circuit to empty per getBiasStrings()'s own real behavior);
    // no textareaText override and no message-embedded {{bias "..."}} in the fixture chat history, so
    // the returned bias falls all the way back to userPromptBias - substituteParams() has nothing to
    // substitute in this plain string, so it comes back verbatim. ---
    const biasFixture = buildSettingsFixture();
    biasFixture.power_user.user_prompt_bias = 'always speak in riddles';
    writeAllSettings(directories, biasFixture);
    const withBias = await resolveChatCompletionGenerationInput(directories, {
        avatar, ownerId, branchName,
        type: 'normal',
    });
    assert.equal(
        withBias.bias, 'always speak in riddles',
        'bias resolves via the real getBiasStrings(), falling back to power_user.user_prompt_bias when no textareaText/message-embedded bias is present',
    );

    // type: 'continue' short-circuits getBiasStrings() to an all-empty result, per its own real,
    // unstubbed behavior (verified directly in src/prompt-line-formatting.js) - proves this resolver
    // genuinely reaches the real function rather than always returning the configured bias.
    const withBiasContinue = await resolveChatCompletionGenerationInput(directories, {
        avatar, ownerId, branchName,
        type: 'continue',
    });
    assert.equal(withBiasContinue.bias, '', 'type: \'continue\' short-circuits getBiasStrings() to an empty bias, per its own real behavior');

    // Restore the original fixture (writeAllSettings() is a full sharded-file replace, not a merge).
    writeAllSettings(directories, buildSettingsFixture());

    // --- GROUP CHAT support (this follow-up task): real `groupId` wiring, mirroring
    // text-completions.test.js's own group-chat test fixture conventions (same real group.json shape
    // as src/endpoints/groups.js's own `/create` route writes, two members with deliberately distinct
    // `description`s so a wrong-member/uncombined-card mixup would be detectable). Unlike the
    // text-completion precedent, chat-completion's own `getCharacterCardFields()` COMBINES every
    // member's card into one joined string (via `computeGroupCards()`) rather than resolving only the
    // responding member's own card - so this test asserts against that combined-string shape
    // specifically, not a single member's own uncombined card. ---
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
        /** Exact shape src/endpoints/groups.js's own POST /create route writes to <id>.json - same
         * fixture convention as text-completions.test.js's own group test. `generation_mode: 1`
         * (group_generation_mode.APPEND, public/scripts/group-chats.js) so
         * computeGroupCards()/getCharacterCardFields() actually produces COMBINED cards - SWAP (0) is
         * falsy and would make computeGroupCards() return null (fall back to single-character
         * resolution) instead, per that function's own `!group.generation_mode` guard. */
        const groupMetadata = {
            id: groupId,
            name: 'Adventuring Party',
            members: [nova, zephyr],
            avatar_url: 'img/ai4.png',
            allow_self_responses: false,
            activation_strategy: 0,
            generation_mode: 1,
            disabled_members: [],
            fav: false,
            chat_id: groupChatId,
            chats: [groupChatId],
            auto_mode_delay: 5,
            generation_mode_join_prefix: '',
            generation_mode_join_suffix: '',
        };
        fs.writeFileSync(path.join(groupsDir, `${groupId}.json`), JSON.stringify(groupMetadata, null, 4));

        // A chat branch owned by the GROUP's own id - not either member's avatar - with one message
        // from each member already in history, matching a real multi-member group conversation.
        await saveChatToTree(directories, groupId, groupChatId, [
            { chat_metadata: {} },
            { name: 'Tester', is_user: true, mes: 'Hello, party!', send_date: 1, extra: {} },
            { name: 'Zephyr', is_user: false, mes: 'Winds are shifting!', send_date: 2, extra: {} },
        ]);

        const groupInput = await resolveChatCompletionGenerationInput(directories, {
            avatar: nova, groupId, ownerId: groupId, branchName: groupChatId,
            type: 'normal',
        });

        // --- isGroup is real (Boolean(groupId)) - not exposed as a top-level field on the returned
        // object (see this module's own doc comment decision 2/FIELD-MAPPING NOTES: only
        // `macroContext`/`historyOptions` carry it), so it's checked at both of its real, consumed
        // locations. ---
        assert.equal(groupInput.macroContext.isGroup, true, 'isGroup is real (Boolean(groupId)) in macroContext');
        assert.equal(groupInput.historyOptions.isGroup, true, 'isGroup is real in historyOptions, forwarded to chat-completion-history.js');

        // --- name2 resolves to the SPECIFIC RESPONDING MEMBER (avatar), not the group's own name. ---
        assert.equal(groupInput.name2, 'Nova', 'name2 resolves to the specific responding member, not the group\'s own name, even though groupId is also set');

        // --- groupMemberNames covers the WHOLE roster (a plain string[], per this resolver's own real
        // consumer shape - see doc comment), including the responding member itself (no
        // self-exclusion - resolveCharacterName2() mirrors text-completion's own
        // resolveName2AndGroupMemberNames(), which applies none either). ---
        assert.deepEqual(groupInput.groupMemberNames.slice().sort(), ['Nova', 'Zephyr'], 'groupMemberNames covers the whole roster, as a plain string[]');

        // --- character fields reflect the COMBINED group cards (computeGroupCards()'s real
        // combining behavior), NOT a single member's own uncombined card. ---
        assert.ok(groupInput.charDescription.includes('Nova is a stoic starship engineer.'), 'combined charDescription includes Nova\'s own description');
        assert.ok(groupInput.charDescription.includes('Zephyr is a chaotic weather spirit.'), 'combined charDescription ALSO includes Zephyr\'s description - proving real combining, not just the responding member\'s own uncombined card');

        // --- end-to-end: feed the resolved group input into the REAL prepareOpenAIMessages() and
        // confirm the assembled `chat` output reflects group-appropriate name-prefixing/content -
        // buildChatCompletionMessages()'s own real `isGroup`-driven name-prefixing (character_names_behavior.DEFAULT:
        // `(isGroup && chat[j].name !== name1)`) only activates when it's genuinely fed a real `isGroup: true`. ---
        const groupResult = await prepareOpenAIMessages(groupInput);
        assert.ok(Array.isArray(groupResult.chat), 'prepareOpenAIMessages() returns a real chat array for a group turn');
        const groupFlattened = JSON.stringify(groupResult.chat);
        assert.ok(groupFlattened.includes('Zephyr: Winds are shifting!'), 'the non-responding member\'s message is name-prefixed ("Zephyr: ...") in the assembled chat-completion payload - real group-appropriate name-prefixing, not the single-character (unprefixed) behavior');
        assert.ok(groupFlattened.includes('Nova is a stoic starship engineer.'), 'the combined group-card description made it all the way into the final assembled chat-completion payload');
        assert.ok(groupFlattened.includes('Zephyr is a chaotic weather spirit.'), 'the OTHER member\'s combined-card description also made it into the final assembled chat-completion payload');
    }

    // --- CORRECTED ADDRESSING MODEL (this task): resolveChatHistory()'s new "neither branchName nor
    // nodeId given" branch - see that function's own doc comment. `branchName` itself stays a real,
    // still-supported LEGACY input here (kobold.js/novelai.js still use it) - only the raw-action
    // builder (buildRawActionChatCompletionRequest()) stopped accepting it; this resolver's own
    // behavior for an explicit branchName/nodeId is completely unchanged (regression, not just
    // "still passes" - reasserted below against the same real fixture used throughout this file). ---
    {
        // (a) explicit nodeId resolves identically to the equivalent explicit branchName.
        const mainLeafId = input.macroContext.chat[input.macroContext.chat.length - 1].node_id;
        const viaNodeId = await resolveChatCompletionGenerationInput(directories, {
            avatar, ownerId, nodeId: mainLeafId,
        });
        assert.deepEqual(viaNodeId.macroContext.chat, input.macroContext.chat, 'an explicit node_id resolves the exact same chat history as the equivalent explicit branch_name');
        assert.equal(viaNodeId.resolvedNodeId, mainLeafId, 'resolvedNodeId echoes back the given node_id');
        assert.equal(viaNodeId.chatResolutionAmbiguous, false);

        // (b) neither branchName nor nodeId given, on an owner that ALREADY has real history -
        // ambiguous: true, empty chat - never a silent guess at "the current leaf".
        const ambiguous = await resolveChatCompletionGenerationInput(directories, {
            avatar, ownerId,
        });
        assert.equal(ambiguous.chatResolutionAmbiguous, true, 'an owner with real existing history and no given identifier is reported as ambiguous, not silently resolved');
        assert.equal(ambiguous.resolvedNodeId, null);
        assert.equal(ambiguous.rawChatLength, 0, 'the ambiguous case resolves to an empty chat rather than guessing the current leaf');

        // (c) neither branchName nor nodeId given, on a GENUINELY BRAND-NEW owner with zero prior
        // messages - the only safe identifier-free case: resolves via the owner's own anchor to a
        // real node id and an empty chat.
        const freshOwnerId = 'fresh-owner-with-no-history';
        const fresh = await resolveChatCompletionGenerationInput(directories, {
            avatar, ownerId: freshOwnerId,
        });
        assert.equal(fresh.chatResolutionAmbiguous, false, 'a genuinely empty owner is not ambiguous');
        assert.ok(fresh.resolvedNodeId, 'a genuinely empty owner still resolves to a real anchor node id');
        assert.equal(fresh.rawChatLength, 0, 'a genuinely new owner correctly resolves to an empty chat, not an error');
    }

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
