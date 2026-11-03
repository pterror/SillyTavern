import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));
const { buildChatCompletionPrompt } = await import('./chat-prompt.js');
const { TokenHandler } = await import('./chat-message.js');
const { positionedEntries } = await import('./injections.js');
const { PromptOverBudgetError } = await import('./model.js');
const { buildChatCompletionMessages, buildChatCompletionMessageExamples } = await import('../chat-completion-messages.js');
const { exampleBlocks } = await import('../example-blocks.js');
const { resolveAuthorsNote } = await import('../authors-note.js');
const { substituteParams } = await import('../macro-substitution.js');
const { promptsWithDefaults, promptOrdersWithDefault } = await import('../../public/scripts/prompt-manager-defaults.js');

const characterId = 100001;
const chat = [
    { name: 'Aria', mes: 'Hello there!', is_user: false },
    { name: 'User', mes: 'Tell me about {{char}}.', is_user: true },
    { name: 'Aria', mes: 'They are old and quiet.', is_user: false },
    { name: 'User', mes: 'Any danger?', is_user: true },
];
const chatEndsAssistant = [...chat, { name: 'Aria', mes: 'Wolves, sometimes. And', is_user: false }];
const page = {
    'ext-chat0': { value: 'Page at zero.', position: 1, depth: 0, scan: false, role: 0 },
    'ext-chat1u': { value: 'Page at one as user.', position: 1, depth: 1, scan: false, role: 1 },
    'ext-chat2': { value: 'Page at two as assistant.', position: 1, depth: 2, scan: false, role: 2 },
    'ext-before': { value: 'Page before.', position: 2, depth: 0, scan: false, role: 0 },
    'ext-before2': { value: 'Page before two.', position: 2, depth: 0, scan: false, role: 1 },
    'ext-after': { value: 'Page after.', position: 0, depth: 0, scan: false, role: 0 },
    '1_memory': { value: 'Summary text.', position: 2, depth: 0, scan: false, role: 0 },
    '3_vectors': { value: 'Vector memory.', position: 0, depth: 0, scan: false, role: 1 },
};
const lore = { before: ['Before lore one.', 'Before lore two.'], after: ['After lore.'], anBefore: ['Top of note.'], anAfter: ['Bottom of note.'], depth: [{ depth: 1, role: 0, entries: ['Depth lore.'] }] };
const defaultPrompts = () => structuredClone(promptsWithDefaults(undefined));
const defaultOrder = () => structuredClone(promptOrdersWithDefault(undefined, characterId));

/**
 * @param {Record<string, any>} c
 * @returns {any}
 */
function input(c) {
    const type = c.type ?? 'normal';
    const isGroup = Boolean(c.isGroup);
    const macroContext = { name1: 'User', name2: 'Aria', isGroup, groupMembers: c.groupMemberNames, characterCard: { description: 'Aria is a ranger.', personality: 'brave', scenario: 'Dawn.' } };
    const promptChat = c.chat ?? chat;
    const chatForMessages = [{ ...promptChat[0], mes: substituteParams(promptChat[0].mes, macroContext) }, ...promptChat.slice(1)];
    const namesBehavior = c.namesBehavior ?? 0;
    const chatMetadata = c.note !== undefined ? { note_prompt: 'Note: {{char}} hears a sound.', note_interval: 1, note_position: c.note, note_depth: 1, note_role: 0 } : {};
    const entries = positionedEntries({
        pageInjections: c.page ?? {},
        authorsNote: resolveAuthorsNote({ chatMetadata, noteSettings: {}, chat: promptChat, avatar: 'a.png', hasCharacterOrGroup: true }),
        anBefore: c.lore ? lore.anBefore : [], anAfter: c.lore ? lore.anAfter : [], worldInfoDepth: c.lore ? lore.depth : [],
        characterDepthPrompt: { text: '', depth: 4, role: 0 }, substitute: text => substituteParams(text, macroContext),
    });
    return {
        charDescription: 'Aria is a ranger.', charPersonality: 'brave', scenario: 'Dawn.',
        systemPromptOverride: '', jailbreakPromptOverride: '', personaDescription: '', personaDescriptionPosition: 0,
        worldInfoBeforeEntries: c.lore ? lore.before : [], worldInfoAfterEntries: c.lore ? lore.after : [], entries,
        wiFormat: '{0}', bias: '', type, cyclePrompt: c.cyclePrompt ?? '',
        messages: buildChatCompletionMessages(chatForMessages, { isGroup, name1: 'User', name2: 'Aria', namesBehavior, currentApi: 'openai', currentModel: 'gpt' }),
        messageExamples: buildChatCompletionMessageExamples(
            exampleBlocks('<START>\nUser: Hi.\nAria: Welcome.\n<START>\nUser: Who?\nAria: Aria.', [], { mainApi: 'openai', macroContext }),
            { isGroup, name1: 'User', name2: 'Aria', appendNamesForGroup: true },
        ),
        groupMemberNames: c.groupMemberNames ?? [],
        tokenHandler: new TokenHandler(async (m) => JSON.stringify(m).length), maxContext: c.maxContext ?? 100000, maxTokens: 300,
        squashSystemMessages: Boolean(c.squash), scenarioFormat: '{{scenario}}', personalityFormat: '{{personality}}',
        groupNudgePrompt: '[Write the next reply only as {{char}}.]', impersonationPrompt: '',
        prompts: c.prompts ?? defaultPrompts(), promptOrder: defaultOrder(), characterId, macroContext,
        mainApi: 'openai', settings: c.settings ?? { chat_completion_source: 'openai' }, model: 'gpt',
        canUseToolsOverride: c.tools, includeSignatureOverride: c.tools ? false : undefined,
        continuePrefill: Boolean(c.continuePrefill), supportsAssistantPrefill: Boolean(c.supportsAssistantPrefill), namesInCompletion: namesBehavior === 1,
        assistantPrefill: c.assistantPrefill ?? '', pinExamples: Boolean(c.pinExamples),
        historyOptions: { isGroup, newChatPrompt: '[Start a new Chat]', newGroupChatPrompt: '[Start a new group chat.]', continueNudgePrompt: c.continueNudgePrompt ?? '', sendIfEmpty: c.sendIfEmpty ?? '', namesBehavior },
        newExampleChatPrompt: '[Example Chat]',
    };
}

const CASES = {
    'plain': {},
    'squash': { squash: true },
    'continue with injections': { type: 'continue', chat: chatEndsAssistant, cyclePrompt: 'x', page, continueNudgePrompt: '[Continue]' },
    'continue prefill claude': { type: 'continue', chat: chatEndsAssistant, cyclePrompt: 'x', continuePrefill: true, supportsAssistantPrefill: true, assistantPrefill: 'Prefill.' },
    'note in chat with lore': { note: 1, lore: true },
    'absolute prompts': {
        prompts: [...defaultPrompts(),
            { identifier: 'abs1', name: 'A1', role: 'system', content: 'Absolute one.', injection_position: 1, injection_depth: 1, injection_order: 100, system_prompt: false },
            { identifier: 'abs2', name: 'A2', role: 'user', content: 'Absolute two.', injection_position: 1, injection_depth: 1, injection_order: 50, system_prompt: false },
            { identifier: 'abs3', name: 'A3', role: 'system', content: 'Absolute three.', injection_position: 1, injection_depth: 0, injection_order: 200, system_prompt: false },
            { identifier: 'rel1', name: 'R1', role: 'user', content: 'Relative for {{char}}.', system_prompt: false, injection_trigger: ['normal'] }],
        order: (o) => { o.push({ identifier: 'abs1', enabled: true }, { identifier: 'abs2', enabled: true }, { identifier: 'abs3', enabled: true }); o.splice(2, 0, { identifier: 'rel1', enabled: true }); },
        page,
    },
    'absolute main': { prompts: defaultPrompts().map(p => p.identifier === 'main' ? { ...p, injection_position: 1, injection_depth: 2, injection_order: 100 } : p), page },
    'tool calls': {
        chat: [...chat.slice(0, 3), { name: 'Aria', mes: 'calling', is_user: false, is_system: true, extra: { tool_invocations: [{ id: 't1', name: 'look', parameters: '{}', result: 'Seen.' }, { id: 't2', name: 'listen', parameters: '{}', result: '' }] } }, chat[3]],
        settings: { chat_completion_source: 'openai', function_calling: true }, tools: true,
    },
    'tool calls reasoning': {
        chat: [...chat.slice(0, 3), { name: 'Aria', mes: 'calling', is_user: false, extra: { tool_invocations: [{ id: 't1', name: 'look', parameters: '{}', result: 'Seen.', reasoning: 'r1' }] } }, { name: 'Aria', mes: 'thinking', is_user: false, extra: { tool_invocations: [{ id: 't2', name: 'look', parameters: '{}', result: 'More.' }] } }],
        settings: { chat_completion_source: 'openrouter', function_calling: true, show_thoughts: true, tool_reasoning_mode: 'active_chain' }, tools: true, page,
    },
    'group nudge': { isGroup: true, groupMemberNames: ['Aria', 'Bo'] },
    'send if empty': { chat: chatEndsAssistant, sendIfEmpty: '[nothing]' },
};

/** @type {Record<string, any[]>} */
const EXPECTED = {
    'plain': [
        ['system', 'Write Aria\'s next reply in a fictional chat between Aria and User.'],
        ['system', 'Aria is a ranger.'],
        ['system', 'brave'],
        ['system', 'Dawn.'],
        ['system', '[Example Chat]'],
        ['system', 'Hi.', { 'name': 'example_user' }],
        ['system', 'Welcome.', { 'name': 'example_assistant' }],
        ['system', '[Example Chat]'],
        ['system', 'Who?', { 'name': 'example_user' }],
        ['system', 'Aria.', { 'name': 'example_assistant' }],
        ['system', '[Start a new Chat]'],
        ['assistant', 'Hello there!'],
        ['user', 'Tell me about Aria.'],
        ['assistant', 'They are old and quiet.'],
        ['user', 'Any danger?'],
    ],
    'squash': [
        ['system', 'Write Aria\'s next reply in a fictional chat between Aria and User.\nAria is a ranger.\nbrave\nDawn.'],
        ['system', '[Example Chat]'],
        ['system', 'Hi.', { 'name': 'example_user' }],
        ['system', 'Welcome.', { 'name': 'example_assistant' }],
        ['system', '[Example Chat]'],
        ['system', 'Who?', { 'name': 'example_user' }],
        ['system', 'Aria.', { 'name': 'example_assistant' }],
        ['system', '[Start a new Chat]'],
        ['assistant', 'Hello there!'],
        ['user', 'Tell me about Aria.'],
        ['assistant', 'They are old and quiet.'],
        ['user', 'Any danger?'],
    ],
    'continue with injections': [
        ['user', 'Page before two.'],
        ['system', 'Page before.'],
        ['system', 'Summary text.'],
        ['system', 'Write Aria\'s next reply in a fictional chat between Aria and User.'],
        ['system', 'Vector memory.'],
        ['system', 'Page after.'],
        ['system', 'Aria is a ranger.'],
        ['system', 'brave'],
        ['system', 'Dawn.'],
        ['system', '[Example Chat]'],
        ['system', 'Hi.', { 'name': 'example_user' }],
        ['system', 'Welcome.', { 'name': 'example_assistant' }],
        ['system', '[Example Chat]'],
        ['system', 'Who?', { 'name': 'example_user' }],
        ['system', 'Aria.', { 'name': 'example_assistant' }],
        ['system', '[Start a new Chat]'],
        ['assistant', 'Hello there!'],
        ['user', 'Tell me about Aria.'],
        ['assistant', 'They are old and quiet.'],
        ['assistant', 'Page at two as assistant.'],
        ['user', 'Any danger?'],
        ['user', 'Page at one as user.'],
        ['system', 'Page at zero.'],
        ['assistant', 'Wolves, sometimes. And'],
        ['system', '[Continue]'],
    ],
    'continue prefill claude': [
        ['system', 'Write Aria\'s next reply in a fictional chat between Aria and User.'],
        ['system', 'Aria is a ranger.'],
        ['system', 'brave'],
        ['system', 'Dawn.'],
        ['system', '[Example Chat]'],
        ['system', 'Hi.', { 'name': 'example_user' }],
        ['system', 'Welcome.', { 'name': 'example_assistant' }],
        ['system', '[Example Chat]'],
        ['system', 'Who?', { 'name': 'example_user' }],
        ['system', 'Aria.', { 'name': 'example_assistant' }],
        ['system', '[Start a new Chat]'],
        ['assistant', 'Hello there!'],
        ['user', 'Tell me about Aria.'],
        ['assistant', 'They are old and quiet.'],
        ['user', 'Any danger?'],
        ['assistant', 'Prefill.\n\nWolves, sometimes. And'],
    ],
    'note in chat with lore': [
        ['system', 'Write Aria\'s next reply in a fictional chat between Aria and User.'],
        ['system', 'Before lore one.\nBefore lore two.'],
        ['system', 'Aria is a ranger.'],
        ['system', 'brave'],
        ['system', 'Dawn.'],
        ['system', 'After lore.'],
        ['system', '[Example Chat]'],
        ['system', 'Hi.', { 'name': 'example_user' }],
        ['system', 'Welcome.', { 'name': 'example_assistant' }],
        ['system', '[Example Chat]'],
        ['system', 'Who?', { 'name': 'example_user' }],
        ['system', 'Aria.', { 'name': 'example_assistant' }],
        ['system', '[Start a new Chat]'],
        ['assistant', 'Hello there!'],
        ['user', 'Tell me about Aria.'],
        ['assistant', 'They are old and quiet.'],
        ['system', 'Top of note.\nNote: Aria hears a sound.\nBottom of note.\nDepth lore.'],
        ['user', 'Any danger?'],
    ],
    'absolute prompts': [
        ['user', 'Page before two.'],
        ['system', 'Page before.'],
        ['system', 'Summary text.'],
        ['system', 'Write Aria\'s next reply in a fictional chat between Aria and User.'],
        ['system', 'Vector memory.'],
        ['system', 'Page after.'],
        ['user', 'Relative for Aria.'],
        ['system', 'Aria is a ranger.'],
        ['system', 'brave'],
        ['system', 'Dawn.'],
        ['system', '[Example Chat]'],
        ['system', 'Hi.', { 'name': 'example_user' }],
        ['system', 'Welcome.', { 'name': 'example_assistant' }],
        ['system', '[Example Chat]'],
        ['system', 'Who?', { 'name': 'example_user' }],
        ['system', 'Aria.', { 'name': 'example_assistant' }],
        ['system', '[Start a new Chat]'],
        ['assistant', 'Hello there!'],
        ['user', 'Tell me about Aria.'],
        ['assistant', 'Page at two as assistant.'],
        ['assistant', 'They are old and quiet.'],
        ['user', 'Absolute two.'],
        ['user', 'Page at one as user.'],
        ['system', 'Absolute one.'],
        ['user', 'Any danger?'],
        ['system', 'Page at zero.'],
        ['system', 'Absolute three.'],
    ],
    'absolute main': [
        ['system', 'Aria is a ranger.'],
        ['system', 'brave'],
        ['system', 'Dawn.'],
        ['system', '[Example Chat]'],
        ['system', 'Hi.', { 'name': 'example_user' }],
        ['system', 'Welcome.', { 'name': 'example_assistant' }],
        ['system', '[Example Chat]'],
        ['system', 'Who?', { 'name': 'example_user' }],
        ['system', 'Aria.', { 'name': 'example_assistant' }],
        ['system', '[Start a new Chat]'],
        ['assistant', 'Hello there!'],
        ['user', 'Tell me about Aria.'],
        ['assistant', 'Page at two as assistant.'],
        ['system', 'Summary text.\nPage before.\nPage before two.\nWrite Aria\'s next reply in a fictional chat between Aria and User.\nPage after.\nVector memory.'],
        ['assistant', 'They are old and quiet.'],
        ['user', 'Page at one as user.'],
        ['user', 'Any danger?'],
        ['system', 'Page at zero.'],
    ],
    'tool calls': [
        ['system', 'Write Aria\'s next reply in a fictional chat between Aria and User.'],
        ['system', 'Aria is a ranger.'],
        ['system', 'brave'],
        ['system', 'Dawn.'],
        ['system', '[Example Chat]'],
        ['system', 'Hi.', { 'name': 'example_user' }],
        ['system', 'Welcome.', { 'name': 'example_assistant' }],
        ['system', '[Example Chat]'],
        ['system', 'Who?', { 'name': 'example_user' }],
        ['system', 'Aria.', { 'name': 'example_assistant' }],
        ['system', '[Start a new Chat]'],
        ['assistant', 'Hello there!'],
        ['user', 'Tell me about Aria.'],
        ['assistant', 'They are old and quiet.'],
        ['assistant', null, { 'tool_calls': [{ 'id': 't1', 'type': 'function', 'function': { 'arguments': '{}', 'name': 'look' } }, { 'id': 't2', 'type': 'function', 'function': { 'arguments': '{}', 'name': 'listen' } }] }],
        ['tool', 'Seen.', { 'tool_call_id': 't1' }],
        ['tool', '[No content]', { 'tool_call_id': 't2' }],
        ['user', 'Any danger?'],
    ],
    'tool calls reasoning': [
        ['user', 'Page before two.'],
        ['system', 'Page before.'],
        ['system', 'Summary text.'],
        ['system', 'Write Aria\'s next reply in a fictional chat between Aria and User.'],
        ['system', 'Vector memory.'],
        ['system', 'Page after.'],
        ['system', 'Aria is a ranger.'],
        ['system', 'brave'],
        ['system', 'Dawn.'],
        ['system', '[Example Chat]'],
        ['system', 'Hi.', { 'name': 'example_user' }],
        ['system', 'Welcome.', { 'name': 'example_assistant' }],
        ['system', '[Example Chat]'],
        ['system', 'Who?', { 'name': 'example_user' }],
        ['system', 'Aria.', { 'name': 'example_assistant' }],
        ['system', '[Start a new Chat]'],
        ['assistant', 'Hello there!'],
        ['user', 'Tell me about Aria.'],
        ['assistant', 'They are old and quiet.'],
        ['assistant', 'Page at two as assistant.'],
        ['assistant', null, { 'tool_calls': [{ 'id': 't1', 'type': 'function', 'function': { 'arguments': '{}', 'name': 'look' } }] }],
        ['tool', 'Seen.', { 'tool_call_id': 't1' }],
        ['user', 'Page at one as user.'],
        ['assistant', null, { 'tool_calls': [{ 'id': 't2', 'type': 'function', 'function': { 'arguments': '{}', 'name': 'look' } }] }],
        ['tool', 'More.', { 'tool_call_id': 't2' }],
        ['system', 'Page at zero.'],
    ],
    'group nudge': [
        ['system', 'Write Aria\'s next reply in a fictional chat between Aria, Bo and User.'],
        ['system', 'Aria is a ranger.'],
        ['system', 'brave'],
        ['system', 'Dawn.'],
        ['system', '[Example Chat]'],
        ['system', 'User: Hi.', { 'name': 'example_user' }],
        ['system', 'Aria: Welcome.', { 'name': 'example_assistant' }],
        ['system', '[Example Chat]'],
        ['system', 'User: Who?', { 'name': 'example_user' }],
        ['system', 'Aria: Aria.', { 'name': 'example_assistant' }],
        ['system', '[Start a new group chat.]'],
        ['assistant', 'Aria: Hello there!'],
        ['user', 'Tell me about Aria.'],
        ['assistant', 'Aria: They are old and quiet.'],
        ['user', 'Any danger?'],
        ['system', '[Write the next reply only as Aria.]'],
    ],
    'send if empty': [
        ['system', 'Write Aria\'s next reply in a fictional chat between Aria and User.'],
        ['system', 'Aria is a ranger.'],
        ['system', 'brave'],
        ['system', 'Dawn.'],
        ['system', '[Example Chat]'],
        ['system', 'Hi.', { 'name': 'example_user' }],
        ['system', 'Welcome.', { 'name': 'example_assistant' }],
        ['system', '[Example Chat]'],
        ['system', 'Who?', { 'name': 'example_user' }],
        ['system', 'Aria.', { 'name': 'example_assistant' }],
        ['system', '[Start a new Chat]'],
        ['assistant', 'Hello there!'],
        ['user', 'Tell me about Aria.'],
        ['assistant', 'They are old and quiet.'],
        ['user', 'Any danger?'],
        ['assistant', 'Wolves, sometimes. And'],
        ['user', '[nothing]'],
    ],
};

/**
 * @param {Record<string, any>[]} messages
 * @returns {any[]}
 */
function compact(messages) {
    return messages.map(({ role, content, ...rest }) => (Object.keys(rest).length ? [role, content ?? null, rest] : [role, content ?? null]));
}

/**
 * @param {Record<string, any>} c
 */
function withOrder(c) {
    const built = input(c);
    if (c.order) c.order(built.promptOrder[0].order);
    return built;
}

for (const [name, c] of Object.entries(CASES)) {
    test(`chat completion prompt: ${name}`, async () => {
        assert.deepEqual(compact((await buildChatCompletionPrompt(withOrder(c))).chat), EXPECTED[name]);
    });
}

test('over the budget history fills first and the last example dialogue goes; what\'s always sent alone over it is refused', async () => {
    const count = async (/** @type {Record<string, any>} */ c) => (await buildChatCompletionPrompt(input(c))).chat;
    const full = await count({});
    const size = async (/** @type {any[]} */ messages) => {
        const handler = new TokenHandler(async (m) => JSON.stringify(m).length);
        let total = 3;
        for (const message of messages) total += await handler.countAsync({ role: message.role, content: message.content, ...(message.name ? { name: message.name } : {}) });
        return total;
    };
    const fullSize = await size(full);
    const fewer = await count({ maxContext: fullSize + 300 - 1 });
    assert.deepEqual(compact(fewer), compact(full).filter(m => m[1] !== 'Aria.' && m[1] !== 'Who?').filter((m, i, all) => !(m[1] === '[Example Chat]' && all[i + 1]?.[1] === '[Start a new Chat]')));
    await assert.rejects(buildChatCompletionPrompt(input({ maxContext: 300 + 50 })), PromptOverBudgetError);
});

test('the itemization lists each part once, in prompt order, with the messages and example dialogues counted', async () => {
    const { itemize } = await buildChatCompletionPrompt(input({ note: 1, lore: true }));
    const itemized = await /** @type {any} */ (itemize)();
    assert.deepEqual(itemized.parts.map(p => p.part), ['main', 'world_info', 'description', 'personality', 'scenario', 'chat_start', 'examples', 'chat_history', 'injections']);
    assert.equal(itemized.messages_count, 4);
    assert.equal(itemized.examples_count, 2);
    assert.equal(itemized.total, itemized.parts.reduce((sum, p) => sum + p.tokens, 0));
});
