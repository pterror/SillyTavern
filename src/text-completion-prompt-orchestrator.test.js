import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { write as writeCardIntoPng } from './character-card-parser.js';
import { regex_placement } from './regex-scripts-engine.js';
// character-card-fields.js pulls in src/endpoints/characters.js, which (via character-shallow.js)
// reads process-wide config at import time - set the config path before importing it, the same way
// src/character-card-fields.test.js does (mirroring the real server's src/config-init.js startup
// step), since this test runs standalone.
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));
const { assembleTextCompletionPrompt } = await import('./text-completion-prompt-orchestrator.js');

/**
 * Real, END-TO-END integration test: a small but realistic fixture exercising every stage of the
 * orchestrator (see src/text-completion-prompt-orchestrator.js's module doc comment for exactly
 * what is and isn't wired). No mocking framework - getCharacterCardFields() (one of the 18 already-
 * ported modules) reads real character cards off disk via readCardContent(), which expects a real
 * PNG with the character JSON embedded in a 'chara' tEXt chunk (readCharacterData() only accepts
 * 'png' format). So this test builds a REAL such PNG per fixture, using this repo's own
 * character-card-parser.js write() against the repo's default placeholder avatar image
 * (public/img/ai4.png) as the base image - same technique src/character-card-fields.test.js and
 * tests/character-metadata-db.test.js use - exercising the actual character-card-fields module for
 * real, matching the task's "real integration" intent instead of piping around it.
 */

const baseAvatarBuffer = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'ai4.png'));

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-orchestrator-test-'));
    const charactersDir = path.join(root, 'characters');
    const filesDir = path.join(root, 'user', 'files');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(filesDir, { recursive: true });
    // endpoints/characters.js's on-disk read cache keys its cache dir off this global (set by the
    // real server at startup) - point it at our fixture root so the cache doesn't error out standalone.
    globalThis.DATA_ROOT = root;
    return { charactersDir, filesDir, root };
}

function writeCharacterCard(charactersDir, avatar, cardV2) {
    const pngBuffer = writeCardIntoPng(baseAvatarBuffer, JSON.stringify(cardV2));
    fs.writeFileSync(path.join(charactersDir, avatar), pngBuffer);
}

const fakeCountTokens = async (text) => text.length;
const fakeEncodeTokens = (text) => Array.from(text).map(ch => ch.codePointAt(0));

function baseFixture(directories, avatar) {
    return {
        type: 'normal',
        name1: 'User',
        name2: 'Aria',
        directories,
        avatar,
        chatMetadata: {},
        chat: [
            { name: 'Aria', mes: 'Hello there, traveler! Welcome to the Whispering Woods.', is_user: false },
            { name: 'User', mes: 'Tell me about the ancient sword you have.', is_user: true },
            { name: 'Aria', mes: 'Ah yes, the moonblade sword. It has been in my family for generations.', is_user: false },
            { name: 'User', mes: 'Where did you find it?', is_user: true },
        ],
        thisMaxContext: 100000,
        countTokens: fakeCountTokens,
        encodeTokens: fakeEncodeTokens,
        amountGen: 80,
        mainApi: 'textgenerationwebui',
        worldInfoCandidates: [
            {
                uid: '1', world: 'test', key: ['sword'], content: 'The moonblade sword was forged by ancient elves under a lunar eclipse.',
                order: 100, position: 0, // world_info_position.before
            },
            {
                uid: '2', world: 'test', key: ['dragon'], content: 'Dragons have not been seen in these lands for a thousand years.',
                order: 100, position: 0,
            },
        ],
        worldInfoIncludeNames: false,
        // Same template as default/content/presets/context/Default.json's story_string - the
        // client's own shipped default context preset - so the story string actually renders
        // character-card fields AND world-info before/after strings.
        storyStringTemplate: '{{#if anchorBefore}}{{anchorBefore}}\n{{/if}}{{#if system}}{{system}}\n{{/if}}{{#if wiBefore}}{{wiBefore}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{personality}}\n{{/if}}{{#if scenario}}{{scenario}}\n{{/if}}{{#if wiAfter}}{{wiAfter}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}{{#if anchorAfter}}{{anchorAfter}}\n{{/if}}{{trim}}',
        settings: { type: 'ooba', temp: 0.7, top_p: 0.9, rep_pen: 1.1 },
        model: 'test-model',
    };
}

test('assembleTextCompletionPrompt: instruct mode OFF - end to end', async () => {
    const { charactersDir, root } = makeDirectories();
    const avatar = 'aria.png';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            extensions: {}, alternate_greetings: [],
        },
    });

    const directories = { characters: charactersDir, root };
    const input = baseFixture(directories, avatar);

    const result = await assembleTextCompletionPrompt(input);

    assert.equal(typeof result.combinedPrompt, 'string');
    assert.ok(result.combinedPrompt.length > 0, 'combinedPrompt should be non-empty');
    assert.ok(result.combinedPrompt.includes('Aria is a wandering ranger'), 'should contain character description');
    assert.ok(result.combinedPrompt.includes('ancient sword'), 'should contain a chat message');
    assert.ok(result.combinedPrompt.includes('moonblade sword was forged'), 'should contain the activated world-info entry');
    assert.ok(!result.combinedPrompt.includes('Dragons have not been seen'), 'should NOT contain the non-activated world-info entry');

    // generate_data shape sanity check (createTextGenGenerationData's return shape).
    assert.equal(result.generate_data.prompt, result.combinedPrompt);
    assert.equal(result.generate_data.model, 'test-model');
    assert.equal(result.generate_data.max_new_tokens, 80);
    assert.ok(Array.isArray(result.generate_data.stopping_strings));
    assert.ok(Array.isArray(result.generate_data.stop));
    assert.equal(result.generate_data.truncation_length, result.thisMaxContext);

    // Intermediate state sanity checks.
    assert.ok(result.worldInfoBefore.includes('moonblade sword was forged'));
    assert.equal(typeof result.system, 'string');
    assert.ok(Array.isArray(result.mesSend));
    assert.ok(result.mesSend.length > 0);
});

test('assembleTextCompletionPrompt: instruct mode ON differs from instruct mode OFF', async () => {
    const { charactersDir, root } = makeDirectories();
    const avatar = 'aria2.png';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            extensions: {}, alternate_greetings: [],
        },
    });
    const directories = { characters: charactersDir, root };

    const offInput = baseFixture(directories, avatar);
    const offResult = await assembleTextCompletionPrompt(offInput);

    const instructPreset = {
        enabled: true,
        wrap: true,
        macro: true,
        names_behavior: 'none',
        input_sequence: '### Instruction:',
        output_sequence: '### Response:',
        input_suffix: '',
        output_suffix: '',
        system_sequence: '### System:',
        system_suffix: '',
        system_same_as_user: false,
        last_output_sequence: '### FinalResponse:',
        story_string_prefix: '',
        story_string_suffix: '',
    };

    const onInput = {
        ...baseFixture(directories, avatar),
        isInstruct: true,
        instructPreset,
        contextSettings: {},
    };
    const onResult = await assembleTextCompletionPrompt(onInput);

    assert.notEqual(onResult.combinedPrompt, offResult.combinedPrompt, 'instruct mode should change the combined prompt');
    assert.ok(
        onResult.combinedPrompt.includes('### Instruction:') || onResult.combinedPrompt.includes('### Response:') || onResult.combinedPrompt.includes('### FinalResponse:'),
        'instruct mode output should contain an instruct sequence marker',
    );
    assert.ok(!offResult.combinedPrompt.includes('### Instruction:'), 'non-instruct output should not contain instruct markers');
});

test('assembleTextCompletionPrompt: instruct mode wraps character-card example dialogue with input/output sequences (new in this task)', async () => {
    const { charactersDir, root } = makeDirectories();
    const avatar = 'aria2b.png';
    const mesExample = '<START>\nUser: What is your favorite weapon?\nAria: The moonblade sword, of course.\n';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: mesExample,
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: mesExample,
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            extensions: {}, alternate_greetings: [],
        },
    });
    const directories = { characters: charactersDir, root };

    const instructPreset = {
        enabled: true,
        wrap: true,
        macro: true,
        names_behavior: 'none',
        skip_examples: false,
        input_sequence: '### Instruction:',
        output_sequence: '### Response:',
        input_suffix: '',
        output_suffix: '',
        system_sequence: '### System:',
        system_suffix: '',
        system_same_as_user: false,
        last_output_sequence: '### FinalResponse:',
        story_string_prefix: '',
        story_string_suffix: '',
    };

    const input = {
        ...baseFixture(directories, avatar),
        isInstruct: true,
        instructPreset,
        contextSettings: {},
    };
    const result = await assembleTextCompletionPrompt(input);

    // Before this task, mesExamplesArray/mesExamplesRawArray were always identical (the local
    // parseMesExamplesBlocks adapter never applied formatInstructModeExamples()'s instruct-mode
    // reformatting) - so example dialogues were never wrapped with input_sequence/output_sequence
    // even in instruct mode. Prove that gap is now closed:
    assert.notDeepEqual(result.mesExamplesArray, result.mesExamplesRawArray, 'formatted example array should now diverge from the raw one in instruct mode');
    assert.ok(result.mesExamplesArray.some(x => x.includes('### Instruction:')), 'formatted example array should contain the input_sequence marker');
    assert.ok(result.mesExamplesArray.some(x => x.includes('### Response:')), 'formatted example array should contain the output_sequence marker');
    assert.ok(!result.mesExamplesRawArray.some(x => x.includes('### Instruction:')), 'the raw example array should stay unwrapped');

    // And the wrapped example dialogue actually reaches the final combined prompt.
    assert.ok(result.combinedPrompt.includes('### Instruction:'), 'combinedPrompt should contain the wrapped example input_sequence marker');
    assert.ok(result.combinedPrompt.includes('### Response:'), 'combinedPrompt should contain the wrapped example output_sequence marker');
    assert.ok(result.combinedPrompt.includes('The moonblade sword, of course.'), 'combinedPrompt should still contain the example content itself');
});

test('assembleTextCompletionPrompt: tiny max context trims the prompt without crashing', async () => {
    const { charactersDir, root } = makeDirectories();
    const avatar = 'aria3.png';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            extensions: {}, alternate_greetings: [],
        },
    });
    const directories = { characters: charactersDir, root };

    const normalInput = baseFixture(directories, avatar);
    const normalResult = await assembleTextCompletionPrompt(normalInput);

    const tinyInput = { ...baseFixture(directories, avatar), thisMaxContext: 40 };
    const tinyResult = await assembleTextCompletionPrompt(tinyInput);

    assert.equal(typeof tinyResult.combinedPrompt, 'string');
    assert.ok(tinyResult.combinedPrompt.length < normalResult.combinedPrompt.length, 'budget-constrained prompt should be smaller');
});

test('assembleTextCompletionPrompt: a world-info @Depth entry is spliced into the final output (new in this task)', async () => {
    const { charactersDir, root } = makeDirectories();
    const avatar = 'aria4.png';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            extensions: {}, alternate_greetings: [],
        },
    });
    const directories = { characters: charactersDir, root };

    const input = {
        ...baseFixture(directories, avatar),
        worldInfoCandidates: [
            ...baseFixture(directories, avatar).worldInfoCandidates,
            {
                uid: '3', world: 'test', key: ['sword'], content: 'The sword hums with a faint blue light whenever danger is near.',
                order: 100, position: 4, // world_info_position.atDepth
                depth: 1, role: 0, // extension_prompt_roles.SYSTEM
            },
        ],
    };

    const result = await assembleTextCompletionPrompt(input);

    // Before this task, worldInfoDepth entries were computed but never spliced into anything (see
    // the old gap (1) doc comment) - this proves the @Depth entry now actually reaches combinedPrompt/
    // mesSend/finalMesSend via the new doChatInject()-equivalent wiring.
    assert.ok(result.worldInfoDepth.length > 0, 'sanity check: bucketActivatedEntries should have produced an @Depth entry');
    assert.ok(
        result.combinedPrompt.includes('The sword hums with a faint blue light'),
        'the @Depth world-info entry should now be spliced into combinedPrompt',
    );
    assert.ok(
        result.finalMesSend.some((m) => m.message.includes('The sword hums with a faint blue light')),
        'the @Depth world-info entry should now be spliced into finalMesSend as its own message',
    );
    assert.ok(result.doChatInjectIndices.length > 0, 'doChatInjectIndices should report the injected message');
});

test('assembleTextCompletionPrompt: author\'s note combines with WI ANTop/ANBottom entries when due', async () => {
    const { charactersDir, root } = makeDirectories();
    const avatar = 'aria5.png';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            extensions: {}, alternate_greetings: [],
        },
    });
    const directories = { characters: charactersDir, root };

    const input = {
        ...baseFixture(directories, avatar),
        hasCharacterOrGroup: true,
        chatMetadata: {
            note_prompt: 'Remember: it is raining.',
            note_interval: 1, // always due
            note_position: 1, // extension_prompt_types.IN_CHAT
            note_depth: 0,
            note_role: 0, // SYSTEM
        },
        worldInfoCandidates: [
            ...baseFixture(directories, avatar).worldInfoCandidates,
            {
                uid: '4', world: 'test', key: ['sword'], content: 'Above the note: a chill wind blows.',
                order: 200, position: 2, // world_info_position.ANTop
            },
            {
                uid: '5', world: 'test', key: ['sword'], content: 'Below the note: the woods grow quiet.',
                order: 200, position: 3, // world_info_position.ANBottom
            },
        ],
    };

    const result = await assembleTextCompletionPrompt(input);

    assert.equal(result.authorsNote.disabled, false, 'sanity check: authors note should be active');
    assert.equal(result.authorsNote.shouldAddPrompt, true, 'sanity check: note should be due this turn');
    assert.ok(result.anBefore.includes('Above the note: a chill wind blows.'), 'sanity check: ANTop entry activated');
    assert.ok(result.anAfter.includes('Below the note: the woods grow quiet.'), 'sanity check: ANBottom entry activated');

    assert.ok(
        result.combinedPrompt.includes('Above the note: a chill wind blows.\nRemember: it is raining.\nBelow the note: the woods grow quiet.'),
        'combinedPrompt should contain the ANTop+note+ANBottom combined block, in that exact order',
    );
});

test('assembleTextCompletionPrompt: quiet-prompt and scannable author\'s-note text now feed World-Info scan injection (new in this task)', async () => {
    const { charactersDir, root } = makeDirectories();
    const avatar = 'aria5b.png';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            extensions: {}, alternate_greetings: [],
        },
    });
    const directories = { characters: charactersDir, root };

    // Case 1: a world-info entry whose ONLY matching keyword appears in the quiet-prompt text - not
    // in chat history, character card, or an author's note. Before this task's ordering fix, World
    // Info activation ran before the quiet-prompt was ever resolvable as scannable input, so this
    // entry could never activate purely from quiet_prompt text.
    {
        const input = {
            ...baseFixture(directories, avatar),
            quiet_prompt: 'Describe the glowing amulet in detail.',
            worldInfoCandidates: [
                {
                    uid: 'qp-1', world: 'test', key: ['amulet'], content: 'The amulet was blessed by moonlight priests.',
                    order: 100, position: 0,
                },
            ],
        };
        const result = await assembleTextCompletionPrompt(input);
        assert.ok(
            result.combinedPrompt.includes('The amulet was blessed by moonlight priests.'),
            'a WI entry matching only quiet_prompt text should now activate and appear in combinedPrompt',
        );
    }

    // Case 2: a world-info entry whose ONLY matching keyword appears in an author's-note value, with
    // noteSettings.allowWIScan: true - not in chat history or character card. Before this task's
    // ordering fix, the Author's Note wasn't even resolved yet when World Info ran, so this could
    // never activate.
    {
        const input = {
            ...baseFixture(directories, avatar),
            hasCharacterOrGroup: true,
            noteSettings: { allowWIScan: true },
            chatMetadata: {
                note_prompt: 'The griffin nests atop the northern cliffs.',
                note_interval: 1, // always due
                note_position: 1, // extension_prompt_types.IN_CHAT
                note_depth: 0,
                note_role: 0,
            },
            worldInfoCandidates: [
                {
                    uid: 'an-1', world: 'test', key: ['griffin'], content: 'Griffins are fiercely territorial.',
                    order: 100, position: 0,
                },
            ],
        };
        const result = await assembleTextCompletionPrompt(input);
        assert.equal(result.authorsNote.scan, true, 'sanity check: authors note scan flag reflects noteSettings.allowWIScan');
        assert.ok(
            result.combinedPrompt.includes('Griffins are fiercely territorial.'),
            'a WI entry matching only the scannable author\'s-note text should now activate and appear in combinedPrompt',
        );
    }
});

test('assembleTextCompletionPrompt: character card depth_prompt is now spliced into the chat as a real IN_CHAT injection, single-character case (new in this task)', async () => {
    const { charactersDir, root } = makeDirectories();
    const avatar = 'aria-depth-prompt.png';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            alternate_greetings: [],
            // depth 0 lands on the newest message (see doChatInject's depth convention) so the
            // injected text is guaranteed to survive any token-budget trimming in this small fixture.
            extensions: { depth_prompt: { prompt: 'Remember: the moonblade hums when danger is near.', depth: 0, role: 'user' } },
        },
    });
    const directories = { characters: charactersDir, root };

    const input = {
        ...baseFixture(directories, avatar),
        hasCharacterOrGroup: true,
        isGroup: false,
    };
    const result = await assembleTextCompletionPrompt(input);

    // Before this task, getCharacterCardFields() never resolved depth/role, and nothing wrote the
    // character's depth_prompt into the extension-prompt table, so this text could never reach
    // combinedPrompt/finalMesSend via doChatInject() - proving the single-character gap is now closed.
    assert.ok(
        result.combinedPrompt.includes('Remember: the moonblade hums when danger is near.'),
        'character-card depth_prompt text should now appear in combinedPrompt via doChatInject()',
    );
    assert.ok(
        result.finalMesSend.some(m => m.message.includes('Remember: the moonblade hums when danger is near.')),
        'character-card depth_prompt text should appear as a spliced entry in finalMesSend',
    );
});

test('assembleTextCompletionPrompt: group-chat member depth_prompt is spliced into the chat as a real IN_CHAT injection, one entry per member (new in this task)', async () => {
    const { charactersDir, root } = makeDirectories();
    const groupsDir = path.join(root, 'groups');
    fs.mkdirSync(groupsDir, { recursive: true });

    const avatarAria = 'aria-group.png';
    writeCharacterCard(charactersDir, avatarAria, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar: avatarAria,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            alternate_greetings: [],
            // Depth 0 lands on the newest message (same reasoning as the single-character test above)
            // so the injected text is guaranteed to survive any token-budget trimming in this fixture.
            extensions: { depth_prompt: { prompt: 'Aria whispers: the moonblade hums when danger is near.', depth: 0, role: 'user' } },
        },
    });

    const avatarBran = 'bran-group.png';
    writeCharacterCard(charactersDir, avatarBran, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Bran',
        description: 'Bran is a gruff blacksmith.',
        personality: 'gruff',
        scenario: '',
        first_mes: 'Need something forged?',
        mes_example: '',
        avatar: avatarBran,
        data: {
            name: 'Bran',
            description: 'Bran is a gruff blacksmith.',
            personality: 'gruff',
            scenario: '',
            first_mes: 'Need something forged?',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            alternate_greetings: [],
            // No depth_prompt at all - should not contribute any injected entry.
            extensions: {},
        },
    });

    fs.writeFileSync(path.join(groupsDir, 'the-woods-group.json'), JSON.stringify({
        id: 'the-woods-group',
        generation_mode: 1, // group_generation_mode.APPEND
        members: [avatarAria, avatarBran],
        disabled_members: [],
    }));

    const directories = { characters: charactersDir, groups: groupsDir, root };

    const input = {
        ...baseFixture(directories, avatarAria),
        hasCharacterOrGroup: true,
        isGroup: true,
        groupId: 'the-woods-group',
    };
    const result = await assembleTextCompletionPrompt(input);

    // Before this task, only the single-character branch existed, so a group chat's per-member
    // depth_prompt text could never reach combinedPrompt/finalMesSend - proving the group-chat gap
    // (getGroupCharacterDepthPrompts()) is now closed.
    assert.ok(
        result.combinedPrompt.includes('Aria whispers: the moonblade hums when danger is near.'),
        'the group member\'s own depth_prompt text should now appear in combinedPrompt via doChatInject()',
    );
    assert.ok(
        result.finalMesSend.some(m => m.message.includes('Aria whispers: the moonblade hums when danger is near.')),
        'the group member\'s depth_prompt text should appear as a spliced entry in finalMesSend',
    );
});

test('assembleTextCompletionPrompt: an AI_OUTPUT regex script transforms a chat message (new in this task)', async () => {
    const { charactersDir, root } = makeDirectories();
    const avatar = 'aria6.png';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            extensions: {}, alternate_greetings: [],
        },
    });
    const directories = { characters: charactersDir, root };

    const input = {
        ...baseFixture(directories, avatar),
        regexScripts: [
            {
                scriptName: 'moonblade-to-starblade',
                findRegex: '/moonblade/g',
                replaceString: 'starblade',
                trimStrings: [],
                placement: [regex_placement.AI_OUTPUT],
                markdownOnly: false,
                promptOnly: true,
                substituteRegex: 0,
            },
        ],
    };

    const result = await assembleTextCompletionPrompt(input);

    // The raw chat message ("Ah yes, the moonblade sword...") is an AI (non-user) message, so the
    // AI_OUTPUT-placement script above should have rewritten "moonblade" to "starblade" before it
    // ever reached finalizeCoreChatMessage()/combinedPrompt.
    assert.ok(result.combinedPrompt.includes('the starblade sword'), 'the AI_OUTPUT-regexed chat message should appear in combinedPrompt');
    assert.ok(!result.combinedPrompt.includes('the moonblade sword'), 'the pre-regex chat message text should NOT appear in combinedPrompt');
});

test('assembleTextCompletionPrompt: a WORLD_INFO regex script transforms an activated entry (new in this task)', async () => {
    const { charactersDir, root } = makeDirectories();
    const avatar = 'aria7.png';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            extensions: {}, alternate_greetings: [],
        },
    });
    const directories = { characters: charactersDir, root };

    const input = {
        ...baseFixture(directories, avatar),
        regexScripts: [
            {
                scriptName: 'forged-to-crafted',
                findRegex: '/forged/g',
                replaceString: 'crafted',
                trimStrings: [],
                placement: [regex_placement.WORLD_INFO],
                markdownOnly: false,
                promptOnly: true,
                substituteRegex: 0,
            },
        ],
    };

    const result = await assembleTextCompletionPrompt(input);

    // The activated world-info entry's raw content is "The moonblade sword was forged by ancient
    // elves..." - the WORLD_INFO-placement script above should have rewritten "forged" to "crafted"
    // via bucketActivatedEntries's resolveContent callback before it landed in worldInfoBefore/
    // combinedPrompt.
    assert.ok(result.worldInfoBefore.includes('was crafted by ancient elves'), 'the WORLD_INFO-regexed entry content should appear in worldInfoBefore');
    assert.ok(!result.worldInfoBefore.includes('was forged by ancient elves'), 'the pre-regex entry content should NOT appear in worldInfoBefore');
    assert.ok(result.combinedPrompt.includes('was crafted by ancient elves'), 'the WORLD_INFO-regexed entry content should appear in combinedPrompt');
    assert.ok(!result.combinedPrompt.includes('was forged by ancient elves'), 'the pre-regex entry content should NOT appear in combinedPrompt');
});

test('assembleTextCompletionPrompt: no extra.files on any fixture message - file-attachment inlining is a no-op (explicit verification of gap 3 default behavior)', async () => {
    const { charactersDir, filesDir, root } = makeDirectories();
    const avatar = 'aria8.png';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            extensions: {}, alternate_greetings: [],
        },
    });
    const directories = { characters: charactersDir, files: filesDir, root };

    // Same fixture chat as baseFixture() - none of its messages carry an `extra.files` array, so
    // appendFileAttachments() should take its no-op path for every message (see
    // src/file-attachment-inline.js: `!Array.isArray(extra.files) || extra.files.length === 0` ->
    // messageText unchanged) and combinedPrompt should be identical to the pre-gap-3-port baseline.
    const withDirectories = baseFixture(directories, avatar);
    const result = await assembleTextCompletionPrompt(withDirectories);

    assert.ok(result.combinedPrompt.includes('ancient sword'), 'sanity check: raw chat message still present');
    assert.ok(result.combinedPrompt.includes('moonblade sword'), 'sanity check: raw chat message still present');
    // No stray leading '\n\n' artifact (the all-empty-file-texts edge case from
    // file-attachment-inline.test.js) should leak in when there was never a files array at all.
    assert.ok(!result.combinedPrompt.includes('\n\n\n\n'), 'no unexpected blank-line artifact from file-attachment inlining');
});

test('assembleTextCompletionPrompt: a real extra.files attachment is inlined into the final combinedPrompt (new in this task, closes gap 3)', async () => {
    const { charactersDir, filesDir, root } = makeDirectories();
    const avatar = 'aria9.png';
    writeCharacterCard(charactersDir, avatar, {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Aria',
        description: 'Aria is a wandering ranger who guards the Whispering Woods.',
        personality: 'brave and curious',
        scenario: '',
        first_mes: 'Hello there, traveler!',
        mes_example: '',
        avatar,
        data: {
            name: 'Aria',
            description: 'Aria is a wandering ranger who guards the Whispering Woods.',
            personality: 'brave and curious',
            scenario: '',
            first_mes: 'Hello there, traveler!',
            mes_example: '',
            system_prompt: '', post_history_instructions: '', character_version: '', creator_notes: '',
            extensions: {}, alternate_greetings: [],
        },
    });
    // A real temp file inside a real fixture directories.files directory, exactly as
    // src/file-attachment-inline.test.js exercises readFileAttachment() itself.
    fs.writeFileSync(path.join(filesDir, 'notes.txt'), 'ATTACHED NOTES: the bridge is out east of town.');
    const directories = { characters: charactersDir, files: filesDir, root };

    const input = {
        ...baseFixture(directories, avatar),
        chat: [
            ...baseFixture(directories, avatar).chat,
            {
                name: 'User', mes: 'Here is a file I found.', is_user: true,
                extra: { files: [{ url: '/user/files/notes.txt', name: 'notes.txt' }] },
            },
        ],
    };

    const result = await assembleTextCompletionPrompt(input);

    assert.ok(
        result.combinedPrompt.includes('ATTACHED NOTES: the bridge is out east of town.'),
        'the real file attachment content should be read from disk and inlined into combinedPrompt',
    );
    assert.ok(result.combinedPrompt.includes('Here is a file I found.'), 'the message text itself should still be present, after the attachment content');
    assert.ok(
        result.combinedPrompt.indexOf('ATTACHED NOTES') < result.combinedPrompt.indexOf('Here is a file I found.'),
        'attachment text should be prepended before the message text, matching appendFileContent\'s ordering',
    );
});
