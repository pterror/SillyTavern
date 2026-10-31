import assert from 'node:assert/strict';
import {
    formatWorldInfo,
    getPromptPosition,
    getPromptRole,
    buildChatCompletionSystemPrompts,
} from './chat-completion-system-prompts.js';
import { extension_prompt_types, extension_prompt_roles } from './extension-prompt-table.js';
import { persona_description_positions } from './story-string-assembly.js';

assert.equal(formatWorldInfo('some lore', { wiFormat: '[Details: {0}]' }), '[Details: some lore]');

assert.equal(formatWorldInfo('some lore', { wiFormat: '' }), 'some lore');
assert.equal(formatWorldInfo('some lore', { wiFormat: '   ' }), 'some lore');
assert.equal(formatWorldInfo('some lore'), 'some lore', 'no wiFormat option at all falls back to null -> unchanged');

assert.equal(formatWorldInfo(''), '');
assert.equal(formatWorldInfo(null), '');
assert.equal(formatWorldInfo(undefined, { wiFormat: '[{0}]' }), '');

assert.equal(getPromptPosition(extension_prompt_types.BEFORE_PROMPT), 'start');
assert.equal(getPromptPosition(extension_prompt_types.IN_PROMPT), 'end');
assert.equal(getPromptPosition(extension_prompt_types.IN_CHAT), false);
assert.equal(getPromptPosition(extension_prompt_types.NONE), false);
assert.equal(getPromptPosition(undefined), false);

assert.equal(getPromptRole(extension_prompt_roles.SYSTEM), 'system');
assert.equal(getPromptRole(extension_prompt_roles.USER), 'user');
assert.equal(getPromptRole(extension_prompt_roles.ASSISTANT), 'assistant');
assert.equal(getPromptRole(undefined), 'system', 'default');
assert.equal(getPromptRole(999), 'system', 'unknown value defaults to system');

{
    const result = buildChatCompletionSystemPrompts({
        scenario: '',
        charPersonality: '',
        worldInfoBefore: 'wi-before',
        worldInfoAfter: 'wi-after',
        charDescription: 'char desc',
        quietPrompt: 'quiet',
        bias: 'bias text',
        wiFormat: '[{0}]',
        groupNudgePrompt: 'nudge {{user}}',
        impersonationPrompt: '',
        macroContext: { name1: 'Alice' },
    });

    assert.deepEqual(result, [
        { role: 'system', content: '[wi-before]', identifier: 'worldInfoBefore' },
        { role: 'system', content: '[wi-after]', identifier: 'worldInfoAfter' },
        { role: 'system', content: 'char desc', identifier: 'charDescription' },
        { role: 'system', content: '', identifier: 'charPersonality' },
        { role: 'system', content: '', identifier: 'scenario' },
        { role: 'system', content: '', identifier: 'impersonate' },
        { role: 'system', content: 'quiet', identifier: 'quietPrompt' },
        { role: 'system', content: 'nudge Alice', identifier: 'groupNudge' },
        { role: 'assistant', content: 'bias text', identifier: 'bias' },
    ], 'fixed 9-entry shape/content with no extension prompts and no formats configured');
}

{
    const result = buildChatCompletionSystemPrompts({
        scenario: 'the actual scenario text',
        charPersonality: 'the actual personality text',
        scenarioFormat: 'literal scenario format, unrelated to the scenario value',
        personalityFormat: 'literal personality format {{user}}',
        macroContext: { name1: 'Bob' },
    });

    const scenarioEntry = result.find(e => e.identifier === 'scenario');
    const personalityEntry = result.find(e => e.identifier === 'charPersonality');

    assert.equal(scenarioEntry.content, 'literal scenario format, unrelated to the scenario value');
    assert.ok(!scenarioEntry.content.includes('the actual scenario text'));
    assert.equal(personalityEntry.content, 'literal personality format Bob');
    assert.ok(!personalityEntry.content.includes('the actual personality text'));
}

{
    const result = buildChatCompletionSystemPrompts({
        scenario: 'raw scenario',
        charPersonality: 'raw personality',
    });
    assert.equal(result.find(e => e.identifier === 'scenario').content, 'raw scenario');
    assert.equal(result.find(e => e.identifier === 'charPersonality').content, 'raw personality');
}

{
    const result = buildChatCompletionSystemPrompts({
        scenario: '',
        charPersonality: '',
        scenarioFormat: 'would have been used',
        personalityFormat: 'would have been used too',
    });
    assert.equal(result.find(e => e.identifier === 'scenario').content, '');
    assert.equal(result.find(e => e.identifier === 'charPersonality').content, '');
}

{
    const withPrompt = buildChatCompletionSystemPrompts({ impersonationPrompt: 'do the {{user}} thing', macroContext: { name1: 'Carl' } });
    assert.equal(withPrompt.find(e => e.identifier === 'impersonate').content, 'do the Carl thing');

    const withoutPrompt = buildChatCompletionSystemPrompts({ impersonationPrompt: '' });
    assert.equal(withoutPrompt.find(e => e.identifier === 'impersonate').content, '');
}

const buildExt = (extensionPrompts) => buildChatCompletionSystemPrompts({ extensionPrompts });

{
    const result = buildExt({ '1_memory': { value: 'summary text', role: extension_prompt_roles.USER, position: extension_prompt_types.BEFORE_PROMPT } });
    const entry = result.find(e => e.identifier === 'summary');
    assert.ok(entry, 'present when value truthy');
    assert.equal(entry.role, 'user');
    assert.equal(entry.position, 'start');
    assert.equal(entry.content, 'summary text');
}
assert.equal(buildExt({ '1_memory': { value: '' } }).find(e => e.identifier === 'summary'), undefined);
assert.equal(buildExt({}).find(e => e.identifier === 'summary'), undefined);

{
    const result = buildExt({ '2_floating_prompt': { value: 'note', role: extension_prompt_roles.ASSISTANT, position: extension_prompt_types.IN_PROMPT } });
    const entry = result.find(e => e.identifier === 'authorsNote');
    assert.ok(entry);
    assert.equal(entry.role, 'assistant');
    assert.equal(entry.position, 'end');
}
assert.equal(buildExt({ '2_floating_prompt': { value: null } }).find(e => e.identifier === 'authorsNote'), undefined);

{
    const result = buildExt({ '3_vectors': { value: 'vec mem', role: extension_prompt_roles.USER, position: extension_prompt_types.BEFORE_PROMPT } });
    const entry = result.find(e => e.identifier === 'vectorsMemory');
    assert.ok(entry);
    assert.equal(entry.role, 'system', 'hardcoded system role regardless of .role, matching client quirk');
    assert.equal(entry.position, 'start');
}
assert.equal(buildExt({ '3_vectors': { value: '' } }).find(e => e.identifier === 'vectorsMemory'), undefined);

{
    const result = buildExt({ '4_vectors_data_bank': { value: 'data bank', role: extension_prompt_roles.ASSISTANT, position: extension_prompt_types.IN_PROMPT } });
    const entry = result.find(e => e.identifier === 'vectorsDataBank');
    assert.ok(entry);
    assert.equal(entry.role, 'assistant');
    assert.equal(entry.position, 'end');
}
assert.equal(buildExt({ '4_vectors_data_bank': { value: undefined } }).find(e => e.identifier === 'vectorsDataBank'), undefined);

{
    const result = buildExt({ chromadb: { value: 'smart ctx', role: extension_prompt_roles.USER, position: extension_prompt_types.IN_PROMPT } });
    const entry = result.find(e => e.identifier === 'smartContext');
    assert.ok(entry);
    assert.equal(entry.role, 'system', 'hardcoded system role regardless of .role, matching client quirk');
    assert.equal(entry.position, 'end');
}
assert.equal(buildExt({ chromadb: { value: '' } }).find(e => e.identifier === 'smartContext'), undefined);

{
    const present = buildChatCompletionSystemPrompts({
        personaDescription: 'a persona',
        personaDescriptionPosition: persona_description_positions.IN_PROMPT,
    });
    const entry = present.find(e => e.identifier === 'personaDescription');
    assert.ok(entry);
    assert.equal(entry.role, 'system');
    assert.equal(entry.content, 'a persona');

    const noDescription = buildChatCompletionSystemPrompts({
        personaDescription: '',
        personaDescriptionPosition: persona_description_positions.IN_PROMPT,
    });
    assert.equal(noDescription.find(e => e.identifier === 'personaDescription'), undefined);

    const wrongPosition = buildChatCompletionSystemPrompts({
        personaDescription: 'a persona',
        personaDescriptionPosition: 999,
    });
    assert.equal(wrongPosition.find(e => e.identifier === 'personaDescription'), undefined);
}

{
    const knownSkipped = buildChatCompletionSystemPrompts({
        extensionPrompts: {
            'PERSONA_DESCRIPTION': { value: 'x', position: extension_prompt_types.IN_PROMPT },
            'QUIET_PROMPT': { value: 'x', position: extension_prompt_types.IN_PROMPT },
            'DEPTH_PROMPT': { value: 'x', position: extension_prompt_types.IN_PROMPT },
        },
    });
    assert.equal(knownSkipped.filter(e => e.extension).length, 0, 'known keys never produce generic extension entries');

    const falsyValue = buildChatCompletionSystemPrompts({
        extensionPrompts: { myPlugin: { value: '', position: extension_prompt_types.IN_PROMPT } },
    });
    assert.equal(falsyValue.filter(e => e.extension).length, 0);

    const wrongPosition = buildChatCompletionSystemPrompts({
        extensionPrompts: { myPlugin: { value: 'hi', position: extension_prompt_types.IN_CHAT } },
    });
    assert.equal(wrongPosition.filter(e => e.extension).length, 0);

    const included = buildChatCompletionSystemPrompts({
        extensionPrompts: {
            'my-plugin.hook!': { value: 'plugin content', position: extension_prompt_types.BEFORE_PROMPT, role: extension_prompt_roles.USER },
        },
    });
    const entry = included.find(e => e.extension);
    assert.ok(entry, 'valid unknown key with BEFORE_PROMPT/IN_PROMPT position is included');
    assert.equal(entry.identifier, 'my_plugin_hook_', 'non-word characters sanitized to underscores');
    assert.equal(entry.position, 'start');
    assert.equal(entry.role, 'user');
    assert.equal(entry.content, 'plugin content');
    assert.equal(entry.extension, true);

    const includedInPrompt = buildChatCompletionSystemPrompts({
        extensionPrompts: { anotherPlugin: { value: 'v', position: extension_prompt_types.IN_PROMPT } },
    });
    assert.equal(includedInPrompt.filter(e => e.extension).length, 1);

    let filterWasCalled = false;
    const withFilter = buildChatCompletionSystemPrompts({
        extensionPrompts: {
            filteredPlugin: {
                value: 'should still appear',
                position: extension_prompt_types.BEFORE_PROMPT,
                filter: () => { filterWasCalled = true; return false; },
            },
        },
    });
    assert.equal(filterWasCalled, false, 'no live filter mechanism - .filter is never invoked server-side');
    assert.ok(withFilter.find(e => e.extension && e.content === 'should still appear'), 'entry included regardless of a .filter that would reject it on the client');
}

console.log('All chat-completion-system-prompts tests passed.');
