import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { write as writeCardIntoPng } from '../character-card-parser.js';
import { worldInfoGlobalsOf } from '../../public/scripts/world-info-globals.js';
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));
const { buildTextCompletionPrompt } = await import('./text-prompt.js');
const { PromptOverBudgetError } = await import('./model.js');
const stores = await import('../user-stores.js');
const { loadEngine } = await import('../../engine/load.js');
const engineBinding = loadEngine().binding;
stores.setStoreEngine(() => engineBinding);
after(() => stores.closeUserStores());

const avatarPng = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'img', 'ai4.png'));
const description = 'Aria is a ranger. {{char}} guards the woods for {{user}}.';
const examples = '<START>\n{{user}}: Hi.\n{{char}}: Welcome.\n<START>\n{{user}}: Who?\n{{char}}: Aria.';

/**
 * @param {Record<string, any>} [fields]
 */
function card(fields = {}) {
    const shared = { name: 'Aria', description, personality: 'brave', scenario: 'A misty dawn.', first_mes: 'Hello there!', mes_example: examples, ...fields };
    return {
        spec: 'chara_card_v2', spec_version: '2.0', ...shared,
        data: {
            ...shared, system_prompt: 'Card system: {{original}} plus card.', post_history_instructions: 'Card PHI: {{original}}.',
            character_version: '', creator_notes: '', alternate_greetings: [],
            extensions: { depth_prompt: { prompt: 'Depth note: {{char}} is tired.', depth: 2, role: 'system' } },
        },
    };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-text-prompt-test-'));
const directories = { characters: path.join(root, 'characters'), chats: path.join(root, 'chats'), root, files: path.join(root, 'user', 'files') };
for (const dir of [directories.characters, directories.chats, directories.files]) fs.mkdirSync(dir, { recursive: true });
for (const [avatar, cardV2] of [['aria.png', card()], ['outlet.png', card({ description: 'Aria. Outlet: {{outlet::spot}}' })]]) {
    const json = JSON.stringify(cardV2);
    fs.writeFileSync(path.join(directories.characters, /** @type {string} */ (avatar)), writeCardIntoPng(avatarPng, json));
    await (await stores.userStore(directories)).lib.writeCard(directories, avatar, json);
}

const storyString = '{{#if anchorBefore}}{{anchorBefore}}\n{{/if}}{{#if system}}{{system}}\n{{/if}}{{#if wiBefore}}{{wiBefore}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{char}}\'s personality: {{personality}}\n{{/if}}{{#if scenario}}Scenario: {{scenario}}\n{{/if}}{{#if wiAfter}}{{wiAfter}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}{{#if anchorAfter}}{{anchorAfter}}\n{{/if}}{{trim}}';
const chat = [
    { name: 'Aria', mes: 'Hello there!', is_user: false },
    { name: 'User', mes: 'Tell me about the woods.', is_user: true },
    { name: 'Aria', mes: 'They are old and quiet.', is_user: false },
    { name: 'User', mes: 'Any danger?', is_user: true },
];
const chatEndsAssistant = [...chat, { name: 'Aria', mes: 'Wolves, sometimes. And', is_user: false }];
const chatml = {
    enabled: true, input_sequence: '<|im_start|>user', output_sequence: '<|im_start|>assistant', last_output_sequence: '', system_sequence: '<|im_start|>system',
    stop_sequence: '<|im_end|>', wrap: true, macro: true, names_behavior: 'force', first_output_sequence: '', skip_examples: false,
    output_suffix: '<|im_end|>\n', input_suffix: '<|im_end|>\n', system_suffix: '<|im_end|>\n', system_same_as_user: false,
    last_system_sequence: '', first_input_sequence: '', last_input_sequence: '', story_string_prefix: '<|im_start|>system', story_string_suffix: '<|im_end|>\n',
};
const alpaca = {
    enabled: true, input_sequence: '### Instruction:', output_sequence: '### Response:', last_output_sequence: '### Final:', first_output_sequence: '### First:',
    first_input_sequence: '### FirstIn:', last_input_sequence: '### LastIn:', system_sequence: '### System:', system_suffix: '', input_suffix: '', output_suffix: '',
    wrap: false, macro: true, names_behavior: 'always', skip_examples: false, system_same_as_user: false, story_string_prefix: '', story_string_suffix: '',
};
const lore = (/** @type {number} */ position, /** @type {string} */ content, extra = {}) => ({ uid: content, world: 'w', key: ['x'], constant: true, content, order: 100, position, ...extra });
const note = (/** @type {number} */ position, depth = 1) => ({ note_prompt: 'Note: {{char}} hears a sound.', note_interval: 1, note_position: position, note_depth: depth, note_role: 0 });
const page = {
    'ext-chat0': { value: 'Page at zero.', position: 1, depth: 0, scan: false, role: 0 },
    'ext-chat2': { value: 'Page at two as assistant.', position: 1, depth: 2, scan: false, role: 2 },
    'ext-before': { value: 'Page before.', position: 2, depth: 0, scan: false, role: 0 },
    'ext-after': { value: 'Page after.', position: 0, depth: 0, scan: false, role: 0 },
    'ext-none': { value: 'Page none.', position: -1, depth: 0, scan: false, role: 0 },
};

/**
 * @param {Record<string, any>} [overrides]
 * @returns {any}
 */
function input(overrides = {}) {
    return {
        type: 'normal', name1: 'User', name2: 'Aria', directories, avatar: 'aria.png', chatMetadata: {}, chat,
        thisMaxContext: 100000, countTokens: async (/** @type {string} */ text) => text.length,
        encodeTokens: (/** @type {string} */ text) => Array.from(text).map(c => /** @type {number} */ (c.codePointAt(0))),
        amountGen: 80, mainApi: 'textgenerationwebui', worldInfoCandidates: [], worldInfoRandom: () => 0.5,
        worldInfoGlobals: worldInfoGlobalsOf({}), storyStringTemplate: storyString, hasCharacterOrGroup: true,
        contextSettings: { example_separator: '***', chat_start: '' }, alwaysForceName2: true,
        settings: { type: 'ooba' }, model: 'm', isDryRun: true,
        ...overrides,
    };
}

const CASES = {
    'plain': {},
    'chatml sysprompt': { isInstruct: true, instructPreset: chatml, instructWrap: true, sysPromptEnabled: true, sysPromptContent: 'Sys.', sysPromptPostHistory: 'PHI.' },
    'continue phi': { type: 'continue', isContinue: true, chat: chatEndsAssistant, sysPromptEnabled: true, sysPromptPostHistory: 'PHI.', pageInjections: page },
    'impersonate': { type: 'impersonate', isImpersonate: true },
    'lore all positions + note in chat': {
        chatMetadata: note(1),
        worldInfoCandidates: [
            lore(0, 'Before char lore.'), lore(1, 'After char lore.'), lore(2, 'Top of note lore.'), lore(3, 'Bottom of note lore.'),
            lore(4, 'Depth one lore.', { depth: 1, role: 0 }), lore(4, 'Depth zero user lore.', { depth: 0, role: 1 }),
            lore(5, '{{user}}: EM top?\n{{char}}: EM top.'), lore(6, 'EM bottom lore.'),
        ],
    },
    'persona top of note': { chatMetadata: note(1), personaDescription: '{{user}} is tall.', personaDescriptionPosition: 2 },
    'cfg depth 1': { chatGuidanceScale: 1.5, chatMetadataPrompts: { positivePrompt: 'Be vivid.', negativePrompt: 'Be dull.' }, promptInsertionDepth: 1, sysPromptEnabled: true, sysPromptPostHistory: 'PHI.' },
    'story string at depth': { storyStringPosition: 1, storyStringDepth: 2, storyStringRole: 0 },
    'outlet in a card field': { avatar: 'outlet.png', storyStringTemplate: '{{description}}\n{{trim}}', worldInfoCandidates: [lore(7, 'Outlet lore.', { outletName: 'spot' })] },
};

/** @type {Record<string, string>} */
const EXPECTED = {
    'plain': 'Aria is a ranger. Aria guards the woods for User.\nAria\'s personality: brave\nScenario: A misty dawn.\n***\nUser: Hi.\nAria: Welcome.\n***\nUser: Who?\nAria: Aria.\nAria: Hello there!\nUser: Tell me about the woods.\nDepth note: Aria is tired.\nAria: They are old and quiet.\nUser: Any danger?\nAria:',
    'chatml sysprompt': '<|im_start|>system\nSys.\nAria is a ranger. Aria guards the woods for User.\nAria\'s personality: brave\nScenario: A misty dawn.\n<|im_end|>\n***\n<|im_start|>user\nUser: Hi.<|im_end|>\n<|im_start|>assistant\nWelcome.<|im_end|>\n***\n<|im_start|>user\nUser: Who?<|im_end|>\n<|im_start|>assistant\nAria.<|im_end|>\n<|im_start|>assistant\nHello there!<|im_end|>\n<|im_start|>user\nTell me about the woods.<|im_end|>\n<|im_start|>system\nDepth note: Aria is tired.<|im_end|>\n<|im_start|>assistant\nThey are old and quiet.<|im_end|>\n<|im_start|>user\nAny danger?<|im_end|>\n<|im_start|>user\nPHI.<|im_end|>\n<|im_start|>assistant\n',
    'continue phi': 'Page before.\nAria is a ranger. Aria guards the woods for User.\nAria\'s personality: brave\nScenario: A misty dawn.\nPage after.\n***\nUser: Hi.\nAria: Welcome.\n***\nUser: Who?\nAria: Aria.\nAria: Hello there!\nUser: Tell me about the woods.\nAria: They are old and quiet.\nAria: Page at two as assistant.\nDepth note: Aria is tired.\nUser: Any danger?\nPage at zero.\nPHI.\nAria:Aria: Wolves, sometimes. And',
    'impersonate': 'Aria is a ranger. Aria guards the woods for User.\nAria\'s personality: brave\nScenario: A misty dawn.\n***\nUser: Hi.\nAria: Welcome.\n***\nUser: Who?\nAria: Aria.\nAria: Hello there!\nUser: Tell me about the woods.\nDepth note: Aria is tired.\nAria: They are old and quiet.\nUser: Any danger?\nUser:',
    'lore all positions + note in chat': 'Before char lore.\nAria is a ranger. Aria guards the woods for User.\nAria\'s personality: brave\nScenario: A misty dawn.\nAfter char lore.\n***\nUser: EM top?\nAria: EM top.\n***\nUser: Hi.\nAria: Welcome.\n***\nUser: Who?\nAria: Aria.\n***\nEM bottom lore.\nAria: Hello there!\nUser: Tell me about the woods.\nDepth note: Aria is tired.\nAria: They are old and quiet.\nTop of note lore.\nNote: Aria hears a sound.\nBottom of note lore.\nDepth one lore.\nUser: Any danger?\nUser: Depth zero user lore.\nAria:',
    'persona top of note': 'Aria is a ranger. Aria guards the woods for User.\nAria\'s personality: brave\nScenario: A misty dawn.\n***\nUser: Hi.\nAria: Welcome.\n***\nUser: Who?\nAria: Aria.\nAria: Hello there!\nUser: Tell me about the woods.\nDepth note: Aria is tired.\nAria: They are old and quiet.\nUser is tall.\nNote: Aria hears a sound.\nUser: Any danger?\nAria:',
    'cfg depth 1': 'Aria is a ranger. Aria guards the woods for User.\nAria\'s personality: brave\nScenario: A misty dawn.\n***\nUser: Hi.\nAria: Welcome.\n***\nUser: Who?\nAria: Aria.\nAria: Hello there!\nUser: Tell me about the woods.\nDepth note: Aria is tired.\nAria: They are old and quiet.\nUser: Any danger?\nBe vivid.\nPHI.\nAria:',
    'story string at depth': '***\nUser: Hi.\nAria: Welcome.\n***\nUser: Who?\nAria: Aria.\nAria: Hello there!\nUser: Tell me about the woods.\nDepth note: Aria is tired.\nAria is a ranger. Aria guards the woods for User.\nAria\'s personality: brave\nScenario: A misty dawn.\nAria: They are old and quiet.\nUser: Any danger?\nAria:',
    'outlet in a card field': 'Aria. Outlet: Outlet lore.\n***\nUser: Hi.\nAria: Welcome.\n***\nUser: Who?\nAria: Aria.\nAria: Hello there!\nUser: Tell me about the woods.\nDepth note: Aria is tired.\nAria: They are old and quiet.\nUser: Any danger?\nAria:',
};

for (const [name, overrides] of Object.entries(CASES)) {
    test(`text completion prompt: ${name}`, async () => {
        assert.equal((await buildTextCompletionPrompt(input(overrides))).combinedPrompt, EXPECTED[name]);
    });
}

test('the alignment message opens an instruct chat that doesn\'t start with the user, and only then', async () => {
    const opened = await buildTextCompletionPrompt(input({ isInstruct: true, instructPreset: alpaca, instructUserAlignmentMessage: 'Let us begin.' }));
    assert.ok(opened.combinedPrompt.includes('Aria.### FirstIn:User: Let us begin.### First:Aria: Hello there!'), opened.combinedPrompt);
    const startsWithUser = await buildTextCompletionPrompt(input({ isInstruct: true, instructPreset: alpaca, instructUserAlignmentMessage: 'Let us begin.', chat: chat.slice(1) }));
    assert.ok(!startsWithUser.combinedPrompt.includes('Let us begin.'));
});

test('over the budget examples go after history has filled, then history\'s oldest; alone over the budget, what\'s always sent is refused', async () => {
    const full = (await buildTextCompletionPrompt(input())).combinedPrompt;
    const lastExample = '***\nUser: Who?\nAria: Aria.\n';
    const allExamples = '***\nUser: Hi.\nAria: Welcome.\n' + lastExample;
    assert.equal((await buildTextCompletionPrompt(input({ thisMaxContext: full.length - 1 }))).combinedPrompt, full.replace(lastExample, ''));
    assert.equal(
        (await buildTextCompletionPrompt(input({ thisMaxContext: full.length - allExamples.length - 1 }))).combinedPrompt,
        full.replace(allExamples, '').replace('Aria: Hello there!\n', ''),
    );
    await assert.rejects(buildTextCompletionPrompt(input({ thisMaxContext: 40 })), PromptOverBudgetError);
});

test('a prompt exactly at the budget fits', async () => {
    const full = (await buildTextCompletionPrompt(input())).combinedPrompt;
    assert.equal((await buildTextCompletionPrompt(input({ thisMaxContext: full.length }))).combinedPrompt, full);
});

test('the itemization counts each part as built, post-history instructions among them', async () => {
    const postHistory = 'Stay in character.';
    const result = await buildTextCompletionPrompt(input({
        sysPromptEnabled: true, sysPromptContent: 'You are Aria.', sysPromptPostHistory: postHistory, tokenPadding: 64,
        settings: { type: 'ooba', temp: 0.7, preset: 'Simple' },
    }));
    const itemized = await result.itemize();
    assert.equal(itemized.api, 'textgenerationwebui');
    assert.equal(itemized.preset, 'Simple');
    assert.equal(itemized.rawPrompt, result.combinedPrompt);
    assert.equal(itemized.padding, 64);
    assert.equal(itemized.total, result.combinedPrompt.length);
    assert.equal(itemized.messages_count, 4);
    assert.equal(itemized.examples_count, 2);
    assert.deepEqual(itemized.parts.map(p => p.part), ['story_string', 'system_prompt', 'description', 'personality', 'scenario', 'examples', 'chat_history', 'injections', 'post_history']);
    assert.equal(itemized.parts.find(p => p.part === 'post_history')?.tokens, postHistory.length);
});
