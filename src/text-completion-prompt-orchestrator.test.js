import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { write as writeCardIntoPng } from './character-card-parser.js';
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
    fs.mkdirSync(charactersDir, { recursive: true });
    // endpoints/characters.js's on-disk read cache keys its cache dir off this global (set by the
    // real server at startup) - point it at our fixture root so the cache doesn't error out standalone.
    globalThis.DATA_ROOT = root;
    return { charactersDir, root };
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
