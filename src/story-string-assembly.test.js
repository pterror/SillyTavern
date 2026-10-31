import assert from 'node:assert/strict';
import {
    renderStoryString,
    assembleStoryString,
    extension_prompt_types,
    extension_prompt_roles,
    persona_description_positions,
} from './story-string-assembly.js';

const SIMPLE_TEMPLATE = '{{system}}\n{{description}}\n{{personality}}\n{{persona}}\n{{scenario}}\n{{wiBefore}}\n{{loreBefore}}\n{{wiAfter}}\n{{loreAfter}}\n{{mesExamples}}';

{
    const params = {
        description: 'A description',
        personality: 'A personality',
        persona: 'A persona',
        scenario: 'A scenario',
        system: 'A system',
        char: 'Char',
        user: 'User',
        wiBefore: 'WI before',
        wiAfter: 'WI after',
        loreBefore: 'WI before',
        loreAfter: 'WI after',
        anchorBefore: '',
        anchorAfter: '',
        mesExamples: 'examples',
        mesExamplesRaw: 'raw examples',
    };
    const output = renderStoryString(params, { storyStringTemplate: SIMPLE_TEMPLATE });
    assert.equal(
        output,
        'A system\nA description\nA personality\nA persona\nA scenario\nWI before\nWI before\nWI after\nWI after\nexamples\n',
        'renders template fields and appends trailing newline by default',
    );
}

{
    const output = renderStoryString({ description: 'x' }, { storyStringTemplate: '{{description}}\n' });
    assert.equal(output, 'x\n', 'no double newline appended when template already ends with one');
}

{
    const output = renderStoryString({ description: 'x' }, {
        storyStringTemplate: '{{description}}',
        storyStringPosition: extension_prompt_types.IN_CHAT,
    });
    assert.equal(output, 'x', 'no trailing newline appended when storyStringPosition is IN_CHAT');
}

{
    const output = renderStoryString({ description: 'x' }, {
        storyStringTemplate: '{{description}}',
        instructSettings: { enabled: true, wrap: false },
    });
    assert.equal(output, 'x', 'instruct enabled + wrap false + no story_string_suffix -> newline suppressed');
}

{
    const output = renderStoryString({ description: 'x' }, {
        storyStringTemplate: '{{description}}',
        instructSettings: { enabled: true, wrap: true, story_string_suffix: '###' },
    });
    assert.equal(output, 'x', 'instruct enabled + wrap true + story_string_suffix set -> newline suppressed');
}

{
    const output = renderStoryString({ description: 'x' }, {
        storyStringTemplate: '{{description}}',
        instructSettings: { enabled: true, wrap: true, story_string_suffix: '' },
    });
    assert.equal(output, 'x\n', 'instruct enabled + wrap true + no story_string_suffix -> newline added');
}

{
    const output = renderStoryString({ description: 'x' }, {
        storyStringTemplate: '{{description}}',
        instructSettings: { enabled: false },
    });
    assert.equal(output, 'x\n', 'instruct disabled -> newline added');
}

{
    const output = renderStoryString({ description: 'x' }, { storyStringTemplate: '\n\n\n{{description}}' });
    assert.equal(output, 'x\n', 'leading newlines stripped');
}

{
    const output = renderStoryString({ description: '' }, { storyStringTemplate: '{{description}}' });
    assert.equal(output, '', 'empty output stays empty');
}

{
    const output = renderStoryString({ user: 'Alice', char: 'Bob' }, { storyStringTemplate: 'Hi {{user}}, I am {{char}}' });
    assert.equal(output, 'Hi Alice, I am Bob\n', 'substituteParams runs on rendered output using params.user/params.char');
}

const baseAssembleParams = {
    description: 'Desc',
    personality: 'Pers',
    persona: 'Persona text',
    scenario: 'Scenario text',
    name1: 'User',
    name2: 'Char',
    worldInfoBefore: 'WIB',
    worldInfoAfter: 'WIA',
    mesExamplesArray: ['ex1'],
    mesExamplesRawArray: ['rawex1'],
    storyStringTemplate: '{{system}}',
    mainApi: 'textgenerationwebui',
};

{
    const result = assembleStoryString({
        ...baseAssembleParams,
        system: 'card system prompt',
        sysPromptEnabled: false,
    });
    assert.equal(result.system, '', 'system nullified when sysprompt disabled');
}

{
    const result = assembleStoryString({
        ...baseAssembleParams,
        system: 'card system with {{original}} inside',
        sysPromptEnabled: true,
        sysPromptContent: 'DEFAULT_SYS',
        preferCharacterPrompt: true,
        isInstruct: false,
    });
    assert.equal(result.system, 'card system with DEFAULT_SYS inside', 'prefer_character_prompt uses card system, substituting {{original}}');
}

{
    const result = assembleStoryString({
        ...baseAssembleParams,
        system: '',
        sysPromptEnabled: true,
        sysPromptContent: 'DEFAULT_SYS {{char}}',
        preferCharacterPrompt: true,
        isInstruct: false,
    });
    assert.equal(result.system, 'DEFAULT_SYS Char', 'falls back to baseChatReplace(sysPromptContent) when card system is empty');
}

{
    const result = assembleStoryString({
        ...baseAssembleParams,
        system: 'card system prompt',
        sysPromptEnabled: true,
        sysPromptContent: 'DEFAULT_SYS',
        preferCharacterPrompt: false,
        isInstruct: false,
    });
    assert.equal(result.system, 'DEFAULT_SYS', 'prefer_character_prompt false ignores card system entirely');
}

{
    const result = assembleStoryString({
        ...baseAssembleParams,
        system: 'card {{original}}',
        sysPromptEnabled: true,
        sysPromptContent: 'DEFAULT {{original}}',
        preferCharacterPrompt: true,
        isInstruct: true,
    });
    assert.equal(result.system, 'card DEFAULT DEFAULT {{original}}', 'isInstruct applies a second substituteParams pass with a fresh {{original}} binding');
}

{
    const result = assembleStoryString({
        ...baseAssembleParams,
        system: 'untouched system value',
        sysPromptEnabled: true,
        sysPromptContent: 'DEFAULT_SYS',
        preferCharacterPrompt: false,
        isInstruct: true,
        mainApi: 'openai',
    });
    assert.equal(result.system, 'untouched system value', 'main_api === openai skips system-prompt resolution entirely');
}

{
    const result = assembleStoryString({
        ...baseAssembleParams,
        system: '',
        sysPromptEnabled: false,
        mainApi: 'openai',
    });
    assert.equal(result.system, '', 'main_api === openai passes through even a falsy system unmodified (not nullified specially)');
}

{
    const templateWithPersona = { ...baseAssembleParams, storyStringTemplate: '{{persona}}' };

    const inPrompt = assembleStoryString({
        ...templateWithPersona,
        persona: 'Persona details',
        personaDescriptionPosition: persona_description_positions.IN_PROMPT,
    });
    assert.equal(inPrompt.combinedStoryString, 'Persona details\n', 'persona included when position is IN_PROMPT');

    const elsewhere = assembleStoryString({
        ...templateWithPersona,
        persona: 'Persona details',
        personaDescriptionPosition: 999,
    });
    assert.equal(elsewhere.combinedStoryString, '', 'persona blanked from the story string when position is not IN_PROMPT');
}

{
    const instructPreset = {
        wrap: true,
        story_string_prefix: '<<SYS>>',
        story_string_suffix: '<<END>>',
    };
    const result = assembleStoryString({
        ...baseAssembleParams,
        storyStringTemplate: '{{description}}',
        isInstruct: true,
        instructPreset,
        contextSettings: { story_string_position: extension_prompt_types.IN_PROMPT },
    });
    assert.equal(result.combinedStoryString, '<<SYS>>\nDesc\n<<END>>', 'instruct mode wraps rendered story string with story_string_prefix/suffix via formatInstructModeStoryString');
}

{
    const result = assembleStoryString({
        ...baseAssembleParams,
        storyStringTemplate: '{{description}}',
        isInstruct: false,
    });
    assert.equal(result.combinedStoryString, 'Desc\n', 'non-instruct mode leaves the rendered story string unwrapped');
}

for (const mainApi of ['openai', 'textgenerationwebui']) {
    for (const storyStringPosition of [extension_prompt_types.IN_PROMPT, extension_prompt_types.IN_CHAT]) {
        const result = assembleStoryString({
            ...baseAssembleParams,
            storyStringTemplate: '{{description}}',
            mainApi,
            storyStringPosition,
            storyStringDepth: 3,
            storyStringRole: extension_prompt_roles.USER,
        });

        const shouldInject = mainApi !== 'openai' && storyStringPosition === extension_prompt_types.IN_CHAT;

        if (shouldInject) {
            assert.deepEqual(
                result.storyStringInjection,
                { content: 'Desc', depth: 3, role: extension_prompt_roles.USER },
                `expected injection for mainApi=${mainApi} storyStringPosition=${storyStringPosition}`,
            );
            assert.equal(result.combinedStoryString, '', 'combinedStoryString blanked to prevent duplication when injected');
        } else {
            assert.equal(result.storyStringInjection, null, `expected no injection for mainApi=${mainApi} storyStringPosition=${storyStringPosition}`);
            assert.notEqual(result.combinedStoryString, '', 'combinedStoryString retained at top of prompt when not injected');
        }
    }
}

{
    const result = assembleStoryString({
        ...baseAssembleParams,
        storyStringTemplate: '{{description}}',
        mainApi: 'textgenerationwebui',
        storyStringPosition: extension_prompt_types.IN_CHAT,
    });
    assert.equal(result.storyStringInjection.content, 'Desc', 'IN_CHAT position suppresses renderStoryString\'s trailing-newline append');
}

{
    const kept = assembleStoryString({ ...baseAssembleParams, storyStringTemplate: '', stripExamples: false });
    assert.deepEqual(kept.mesExamplesArray, ['ex1'], 'mesExamplesArray unchanged when stripExamples is false');

    const stripped = assembleStoryString({ ...baseAssembleParams, storyStringTemplate: '', stripExamples: true });
    assert.deepEqual(stripped.mesExamplesArray, [], 'mesExamplesArray emptied when stripExamples is true');
}

console.log('All story-string-assembly tests passed.');
