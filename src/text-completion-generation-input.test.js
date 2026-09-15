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
                story_string: '{{#if system}}{{system}}\n{{/if}}{{wiBefore}}{{description}}{{wiAfter}}',
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
        // Real global lorebook selection - top-level `world_info` key, NOT `world_info_settings`
        // (see text-completion-generation-input.js's own field-mapping notes on this exact distinction).
        world_info: {
            globalSelect: ['TestLore'],
            charLore: [],
        },
        world_info_character_strategy: 1, // world_info_insertion_strategy.character_first
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
        kai_settings: {
            temp: 0.65,
            rep_pen: 1.05,
            rep_pen_range: 512,
            top_p: 0.9,
            top_k: 0,
            top_a: 0,
            typical: 1,
            tfs: 1,
            min_p: 0.02,
            rep_pen_slope: 0,
            sampler_order: [6, 0, 1, 2, 3, 4, 5],
            mirostat: 0,
            mirostat_tau: 5,
            mirostat_eta: 0.1,
            use_default_badwordsids: false,
            grammar: '',
            streaming_kobold: false,
            api_server: 'http://localhost:5001',
        },
        nai_settings: {
            model_novel: 'clio-v1',
            temperature: 1.5,
            min_length: 1,
            tail_free_sampling: 0.975,
            repetition_penalty: 2.25,
            repetition_penalty_range: 2048,
            repetition_penalty_slope: 0.09,
            repetition_penalty_frequency: 0,
            repetition_penalty_presence: 0.005,
            top_a: 0.08,
            top_p: 0.75,
            top_k: 10,
            min_p: 0,
            math1_temp: 0,
            math1_quad: 0,
            math1_quad_entropy_scale: 0,
            typical_p: 0.975,
            mirostat_lr: 1,
            mirostat_tau: 0,
            phrase_rep_pen: 'off',
            banned_tokens: '',
            logit_bias: [],
            prefix: 'vanilla',
            order: [1, 5, 0, 2, 3, 4],
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
    assert.equal(input.storyStringTemplate, '{{#if system}}{{system}}\n{{/if}}{{wiBefore}}{{description}}{{wiAfter}}');
    assert.equal(input.chatStart, undefined, 'chatStart is not a resolved field on this orchestrator input - only storyStringTemplate/contextSettings are');
    assert.equal(input.contextSettings.chat_start, '***', 'chatStart-equivalent data is still present, nested under contextSettings');
    assert.equal(input.namesAsStopStrings, true, 'namesAsStopStrings resolves from power_user.context.names_as_stop_strings');
    assert.equal(input.customStoppingStringsRaw, '"CUSTOM_STOP"');
    assert.equal(input.noteSettings.default, 'Author note default text.', 'noteSettings passes extension_settings.note through unchanged (same field names)');
    assert.equal(input.globalCfg.guidance_scale, 1, 'globalCfg resolves from extension_settings.cfg.global');
    // --- world-info candidate resolution (now real, via resolveWorldInfoCandidates()) ---
    assert.equal(input.worldInfoCandidates.length, 1, 'worldInfoCandidates is auto-resolved for real from the on-disk lorebook named in settings.world_info.globalSelect');
    assert.equal(input.worldInfoCandidates[0].content, 'The ancient tower looms over the village.');
    assert.equal(input.worldInfoCandidates[0].world, 'TestLore');
    assert.ok(input.worldInfoCandidates[0].hash, 'resolved candidates carry the real getStringHash() hash');

    // An explicit override (including []) always wins over auto-resolution.
    const overriddenWI = await resolveTextCompletionGenerationInput(directories, {
        avatar, ownerId, branchName, countTokens, encodeTokens, worldInfoCandidates: [],
    });
    assert.deepEqual(overriddenWI.worldInfoCandidates, [], 'an explicit worldInfoCandidates override bypasses auto-resolution');

    // --- userMessageText: appends the pending user action onto the loaded chat history ---
    const withUserMessage = await resolveTextCompletionGenerationInput(directories, {
        avatar, ownerId, branchName, countTokens, encodeTokens,
        userMessageText: 'What happens next, Rex?',
    });
    assert.equal(withUserMessage.chat.length, 4, 'userMessageText appends one new message onto the real loaded history');
    const appended = withUserMessage.chat[3];
    assert.equal(appended.is_user, true);
    assert.equal(appended.name, 'Tester', 'appended message uses the resolved name1');
    assert.equal(appended.mes, 'What happens next, Rex?');
    assert.deepEqual(appended.extra, {});
    assert.equal(input.chat.length, 3, 'omitting userMessageText leaves chat exactly as loaded, unchanged');

    // --- userMessageExtra: a forwarded file-attachment reference becomes the appended message's
    // real `extra`, and is later actually inlined by the real orchestrator (not just carried through
    // as inert data) ---
    fs.writeFileSync(path.join(filesDir, 'notes.txt'), 'The tower key is hidden under the loose stone.');
    const withUserMessageExtra = await resolveTextCompletionGenerationInput(directories, {
        avatar, ownerId, branchName, countTokens, encodeTokens,
        userMessageText: 'Check my notes.',
        userMessageExtra: { files: [{ url: '/user/files/notes.txt', size: 42, name: 'notes.txt', created: 1700000000000 }] },
    });
    const appendedWithExtra = withUserMessageExtra.chat[withUserMessageExtra.chat.length - 1];
    assert.deepEqual(appendedWithExtra.extra, { files: [{ url: '/user/files/notes.txt', size: 42, name: 'notes.txt', created: 1700000000000 }] });
    const resultWithFile = await assembleTextCompletionPrompt(withUserMessageExtra);
    assert.ok(
        resultWithFile.combinedPrompt.includes('The tower key is hidden under the loose stone.'),
        'a real file-attachment reference forwarded via userMessageExtra is actually inlined into the assembled prompt, via the already-generic file-attachment-inline.js machinery',
    );

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

    // --- end-to-end #2: the userMessageText-appended chat + real auto-resolved world-info
    // candidates, both flowing all the way through the real orchestrator - the important proof for
    // this session's two additions, not just that the individual fields look right in isolation.
    const resultWithUserMessage = await assembleTextCompletionPrompt(withUserMessage);
    assert.ok(typeof resultWithUserMessage.combinedPrompt === 'string' && resultWithUserMessage.combinedPrompt.length > 0);
    assert.ok(
        resultWithUserMessage.combinedPrompt.includes('What happens next, Rex?'),
        'the new user message appended by userMessageText made it into the final assembled prompt',
    );
    assert.ok(
        resultWithUserMessage.combinedPrompt.includes('The ancient tower looms over the village.'),
        'the real, auto-resolved world-info candidate (a constant entry) was activated and made it into the final assembled prompt',
    );

    // --- mainApi: 'kobold' dispatch (new in this task) ---
    const koboldInput = await resolveTextCompletionGenerationInput(directories, {
        avatar, ownerId, branchName, mainApi: 'kobold', countTokens, encodeTokens,
    });
    assert.equal(koboldInput.mainApi, 'kobold');
    assert.equal(koboldInput.settings.temp, 0.65, 'settings resolves from the real top-level kai_settings, not textgenerationwebui_settings');
    assert.equal(koboldInput.settings.rep_pen, 1.05);
    assert.equal(koboldInput.model, undefined, 'Kobold has no per-request model field - model stays undefined');
    assert.equal(koboldInput.apiServer, 'http://localhost:5001', 'apiServer resolves from kai_settings.api_server');
    const koboldResult = await assembleTextCompletionPrompt(koboldInput);
    assert.equal(koboldResult.generate_data.prompt, koboldResult.combinedPrompt, 'kobold dispatch produces createKoboldGenerationData()\'s own shape');
    assert.equal(koboldResult.generate_data.temperature, 0.65);
    assert.equal(koboldResult.generate_data.api_server, 'http://localhost:5001');
    assert.equal(koboldResult.generate_data.max_new_tokens, undefined, 'textgen-only field must not leak into the kobold payload');

    // --- mainApi: 'novel' dispatch (new in this task) ---
    const novelInput = await resolveTextCompletionGenerationInput(directories, {
        avatar, ownerId, branchName, mainApi: 'novel', countTokens, encodeTokens,
    });
    assert.equal(novelInput.mainApi, 'novel');
    assert.equal(novelInput.settings.model_novel, 'clio-v1', 'settings resolves from the real top-level nai_settings, not textgenerationwebui_settings');
    assert.equal(novelInput.model, undefined, 'model is a textgenerationwebui-only field - novel carries its own model via settings.model_novel');
    const novelResult = await assembleTextCompletionPrompt(novelInput);
    assert.equal(novelResult.generate_data.input, novelResult.combinedPrompt, 'novel dispatch produces createNovelGenerationData()\'s own shape');
    assert.equal(novelResult.generate_data.model, 'clio-v1');
    assert.equal(novelResult.generate_data.max_new_tokens, undefined, 'textgen-only field must not leak into the novel payload');

    // --- mainApi: 'koboldhorde' is explicitly rejected (see module doc comment) ---
    await assert.rejects(
        () => resolveTextCompletionGenerationInput(directories, { avatar, ownerId, branchName, mainApi: 'koboldhorde', countTokens, encodeTokens }),
        /unsupported mainApi/,
    );

    // --- CORRECTED ADDRESSING MODEL (this task): resolveChatHistory()'s new "neither branchName nor
    // nodeId given" branch - see that function's own doc comment. `branchName` itself stays a real,
    // still-supported LEGACY input here (kobold.js/novelai.js still use it) - only the raw-action
    // builders (buildRawActionTextCompletionRequest()) stopped accepting it; this resolver's own
    // behavior for an explicit branchName/nodeId is completely unchanged (regression, not just
    // "still passes" - reasserted below against the SAME real fixture used throughout this file). ---
    {
        // (a) explicit nodeId resolves identically to the equivalent explicit branchName - the exact
        // node id a real client would already have from having loaded this same chat.
        const mainLeafId = input.chat[input.chat.length - 1].node_id;
        const viaNodeId = await resolveTextCompletionGenerationInput(directories, {
            avatar, ownerId, nodeId: mainLeafId, countTokens, encodeTokens,
        });
        assert.deepEqual(viaNodeId.chat, input.chat, 'an explicit node_id resolves the exact same chat history as the equivalent explicit branch_name');
        assert.equal(viaNodeId.resolvedNodeId, mainLeafId, 'resolvedNodeId echoes back the given node_id');
        assert.equal(viaNodeId.chatResolutionAmbiguous, false);

        // (b) neither branchName nor nodeId given, on an owner that ALREADY has real history -
        // ambiguous: true, chat: [] - never a silent guess at "the current leaf".
        const ambiguous = await resolveTextCompletionGenerationInput(directories, {
            avatar, ownerId, countTokens, encodeTokens,
        });
        assert.equal(ambiguous.chatResolutionAmbiguous, true, 'an owner with real existing history and no given identifier is reported as ambiguous, not silently resolved');
        assert.equal(ambiguous.resolvedNodeId, null);
        assert.deepEqual(ambiguous.chat, [], 'the ambiguous case resolves to an empty chat rather than guessing the current leaf');

        // (c) neither branchName nor nodeId given, on a GENUINELY BRAND-NEW owner with zero prior
        // messages - the only safe identifier-free case: resolves via the owner's own anchor
        // (auto-created, no name required) to a real node id and an empty chat.
        const freshOwnerId = 'fresh-owner-with-no-history';
        const fresh = await resolveTextCompletionGenerationInput(directories, {
            avatar, ownerId: freshOwnerId, countTokens, encodeTokens,
        });
        assert.equal(fresh.chatResolutionAmbiguous, false, 'a genuinely empty owner is not ambiguous');
        assert.ok(fresh.resolvedNodeId, 'a genuinely empty owner still resolves to a real anchor node id');
        assert.deepEqual(fresh.chat, [], 'a genuinely new owner correctly resolves to an empty chat, not an error');
    }

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
