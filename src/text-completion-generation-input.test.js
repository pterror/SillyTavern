import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { write as writeCard } from './character-card-parser.js';
// text-completion-generation-input.js pulls in src/endpoints/characters.js (via readCardContent),
// which (via character-shallow.js) reads process-wide config at import time - set the config path
// before importing it, the same way character-card-fields.test.js does, since this test runs
// standalone (see that file's own comment on the exact same requirement).
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const { resolveTextCompletionGenerationInput } = await import('./text-completion-generation-input.js');
const { writeAllSettings } = await import('./settings-store.js');
const { saveChatToTree, disposeMessageTreeStores } = await import('./message-tree-db.js');
const { assembleTextCompletionPrompt } = await import('./text-completion-prompt-orchestrator.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-text-completion-generation-input-test-'));
const charactersDir = path.join(root, 'characters');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(charactersDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

const directories = { root, characters: charactersDir, groups: groupsDir };
globalThis.DATA_ROOT = root;

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

/** A real settings.json-shaped fixture, trimmed to what resolveTextCompletionGenerationInput() actually reads - see that module's own field-mapping notes for exactly why each field lives where it does. */
function buildSettingsFixture() {
    return {
        username: 'Tester',
        amount_gen: 250,
        max_context: 4096,
        main_api: 'koboldhorde', // deliberately NOT 'textgenerationwebui' - proves the resolver hardcodes mainApi regardless.
        power_user: {
            token_padding: 8,
            always_force_name2: true,
            collapse_newlines: true,
            pin_examples: false,
            strip_examples: false,
            persona_description: 'A curious {{user}}.',
            persona_description_position: 1,
            user_prompt_bias: '',
            custom_stopping_strings: '"CUSTOM_STOP"',
            custom_stopping_strings_macro: false,
            single_line: false,
            request_token_probabilities: true,
            reasoning: {
                add_to_prompts: true,
                max_additions: 2,
                prefix: '<think>',
                separator: '\n',
                suffix: '</think>',
            },
            instruct: {
                enabled: true,
                input_sequence: '### Instruction:',
                output_sequence: '### Response:',
                system_sequence: '### System:',
                stop_sequence: '',
                wrap: true,
                names_behavior: 0,
                user_alignment_message: '',
            },
            context: {
                story_string: '{{#if system}}{{system}}\n{{/if}}{{description}}',
                chat_start: '***',
                example_separator: '***',
                names_as_stop_strings: true,
            },
            sysprompt: {
                enabled: false,
                content: '',
                post_history: '',
            },
        },
        world_info_settings: {
            world_info_depth: 3,
            world_info_budget: 30,
            world_info_budget_cap: 0,
            world_info_include_names: true,
            world_info_recursive: false,
            world_info_min_activations: 0,
            world_info_min_activations_depth_max: 0,
            world_info_use_group_scoring: false,
            world_info_max_recursion_steps: 0,
            // Real settings that exist here but have no orchestrator input to map to - see module doc comment.
            world_info_case_sensitive: false,
            world_info_match_whole_words: true,
            world_info_character_strategy: 1,
        },
        textgenerationwebui_settings: {
            type: 'ooba',
            custom_model: 'test-model-7b',
            temp: 0.9,
            top_p: 0.9,
            rep_pen: 1.05,
            banned_tokens: '',
            global_banned_tokens: '',
            send_banned_tokens: false,
            logit_bias: [],
        },
        extension_settings: {
            note: {
                default: 'Author note default text.',
                defaultDepth: 4,
                defaultInterval: 1,
                defaultPosition: 1,
                defaultRole: 0,
                allowWIScan: false,
                chara: [],
            },
            cfg: {
                global: { guidance_scale: 1, negative_prompt: '' },
                chara: [],
            },
        },
    };
}

/** Deterministic fake tokenizer - real tokenizer resolution is out of this resolver's scope (see module doc comment). */
function makeFakeTokenizers() {
    const countTokens = async (text) => Math.ceil(String(text ?? '').length / 4);
    const encodeTokens = (text) => Array.from(String(text ?? '')).map(ch => ch.codePointAt(0));
    return { countTokens, encodeTokens };
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

    const { countTokens, encodeTokens } = makeFakeTokenizers();

    const input = await resolveTextCompletionGenerationInput(directories, {
        avatar, ownerId, branchName,
        type: 'normal', isImpersonate: false, isContinue: false, isSwipe: false,
        textareaText: 'What happens next?',
        countTokens, encodeTokens,
    });

    // --- settings-derived fields ---
    assert.equal(input.name1, 'Tester', 'name1 resolves from settings.json top-level username');
    assert.equal(input.name2, 'Rex', 'name2 resolves from the real character card, not guessed');
    assert.equal(input.mainApi, 'textgenerationwebui', 'mainApi is hardcoded for this text-completion-only resolver, regardless of the live main_api setting');
    assert.equal(input.thisMaxContext, 4096, 'thisMaxContext resolves from top-level settings.max_context');
    assert.equal(input.amountGen, 250, 'amountGen falls back to settings.amount_gen when not overridden');
    assert.equal(input.tokenPadding, 8, 'tokenPadding resolves from power_user.token_padding');
    assert.equal(input.alwaysForceName2, true, 'alwaysForceName2 resolves from power_user.always_force_name2');
    assert.equal(input.requestTokenProbabilities, true);
    assert.equal(input.reasoningAddToPrompts, true, 'reasoning settings resolve from power_user.reasoning.*');
    assert.equal(input.reasoningMaxAdditions, 2);
    assert.equal(input.isInstruct, true, 'isInstruct resolves from power_user.instruct.enabled');
    assert.equal(input.instructWrap, true);
    assert.equal(input.storyStringTemplate, '{{#if system}}{{system}}\n{{/if}}{{description}}');
    assert.equal(input.chatStart, undefined, 'chatStart is not a resolved field on this orchestrator input - only storyStringTemplate/contextSettings are');
    assert.equal(input.contextSettings.chat_start, '***', 'chatStart-equivalent data is still present, nested under contextSettings');
    assert.equal(input.namesAsStopStrings, true, 'namesAsStopStrings resolves from power_user.context.names_as_stop_strings');
    assert.equal(input.customStoppingStringsRaw, '"CUSTOM_STOP"');
    assert.equal(input.noteSettings.default, 'Author note default text.', 'noteSettings passes extension_settings.note through unchanged (same field names)');
    assert.equal(input.globalCfg.guidance_scale, 1, 'globalCfg resolves from extension_settings.cfg.global');
    assert.deepEqual(input.worldInfoCandidates, [], 'worldInfoCandidates is a plain out-of-scope passthrough, default []');

    // world_info_settings is nested (NOT top-level world_info_depth) - this is the field-mapping
    // correction the task specifically asked to verify against real settings.json.
    assert.equal(input.worldInfoDepth, 3, 'worldInfoDepth resolves from the NESTED world_info_settings.world_info_depth, not a top-level key');
    assert.equal(input.worldInfoBudgetPercent, 30);
    assert.equal(input.worldInfoIncludeNames, true);
    assert.equal(input.worldInfoRecursive, false);

    // --- backend resolution (reused, not re-derived) ---
    assert.equal(input.model, 'test-model-7b', 'model resolves via the real, reused resolveTextGenBackend()');
    assert.equal(input.settings.type, 'ooba', 'settings forwards the real textgenerationwebui_settings object');
    assert.equal(input.settings.temp, 0.9);

    // --- chat resolution (real message-tree DB round trip, not a hand-typed fixture) ---
    assert.equal(input.chat.length, 3, 'chat resolves via a real loadBranch() round trip through message-tree-db.js');
    assert.equal(input.chat[0].mes, 'Hello there, traveler.');
    assert.equal(input.chat[0].name, 'Rex');
    assert.equal(input.chat[0].is_user, false);
    assert.equal(input.chat[1].is_user, true);
    assert.equal(input.chat[2].mes, 'Likewise!');
    assert.ok(input.chat[0].node_id, 'real tree node ids are present, not fabricated');

    // --- macroExtras override ---
    const overridden = await resolveTextCompletionGenerationInput(directories, {
        avatar, ownerId, branchName, countTokens, encodeTokens,
        macroExtras: { quiet_prompt: 'Summarize the scene.', isDryRun: true },
    });
    assert.equal(overridden.quiet_prompt, 'Summarize the scene.', 'macroExtras is shallow-merged over the resolved object');
    assert.equal(overridden.isDryRun, true);

    // --- required-param guards ---
    await assert.rejects(
        () => resolveTextCompletionGenerationInput(directories, { avatar, ownerId, branchName, encodeTokens }),
        /countTokens is required/,
    );
    await assert.rejects(
        () => resolveTextCompletionGenerationInput(directories, { avatar, ownerId, branchName, countTokens }),
        /encodeTokens is required/,
    );

    // --- end-to-end: feed the resolved input straight into the REAL orchestrator ---
    const result = await assembleTextCompletionPrompt(input);
    assert.equal(typeof result.combinedPrompt, 'string');
    assert.ok(result.combinedPrompt.length > 0, 'combinedPrompt is non-empty end to end');
    assert.ok(result.combinedPrompt.includes('Hello there, traveler.'), 'the real chat history made it into the final prompt');
    assert.ok(result.generate_data && typeof result.generate_data === 'object', 'generate_data wire payload is produced');
    assert.equal(result.generate_data.model, 'test-model-7b');

    console.log('text-completion-generation-input.test.js: all assertions passed');
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
