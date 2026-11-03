import assert from 'node:assert/strict';
import { getBiasStrings, formatMessageHistoryItem, lastPromptLineParts, IGNORE_SYMBOL } from './prompt-line-formatting.js';

const modifyLastPromptLine = (last, params) => lastPromptLineParts(params)
    .reduce((text, part) => text + (part.breakBefore && !text.endsWith('\n') ? '\n' : '') + part.text, last);

const instructPreset = {
    enabled: true,
    wrap: true,
    macro: true,
    names_behavior: 'force',
    input_sequence: '### Instruction:',
    output_sequence: '### Response:',
    first_output_sequence: '',
    last_output_sequence: '### Response (last):',
    first_input_sequence: '',
    last_input_sequence: '### Instruction (last):',
    input_suffix: '',
    output_suffix: '',
    system_sequence: '### System:',
    system_suffix: '',
    system_same_as_user: false,
    last_system_sequence: '',
};

assert.deepEqual(
    getBiasStrings({ textareaText: 'whatever {{bias "x"}}', type: 'impersonate', chat: [] }),
    { messageBias: '', promptBias: '', isUserPromptBias: false },
    'impersonate short-circuits',
);
assert.deepEqual(
    getBiasStrings({ textareaText: 'whatever', type: 'continue', chat: [] }),
    { messageBias: '', promptBias: '', isUserPromptBias: false },
    'continue short-circuits',
);

{
    const chat = [
        { is_user: true, extra: { bias: '' } },
        { is_user: true, extra: { bias: ' [angry]' } },
        { is_user: false },
    ];
    const result = getBiasStrings({ textareaText: '', type: 'send', chat });
    assert.equal(result.messageBias, '', 'no textarea -> no messageBias');
    assert.equal(result.promptBias, ' [angry]', 'falls back to most recent eligible message with a bias');
    assert.equal(result.isUserPromptBias, false);
}

{
    const chat = [
        { is_user: true, extra: { bias: ' [old]' } },
        { is_user: true, extra: { bias: ' [newest, should be skipped for swipe]' } },
    ];
    const result = getBiasStrings({ textareaText: '', type: 'swipe', chat });
    assert.equal(result.promptBias, ' [old]', 'swipe skips the last chat entry');
}

{
    const chat = [{ is_user: true, extra: {} }];
    const result = getBiasStrings({ textareaText: '', type: 'send', chat, userPromptBias: ' [default bias]' });
    assert.equal(result.promptBias, ' [default bias]');
    assert.equal(result.isUserPromptBias, true, 'isUserPromptBias true when promptBias came from userPromptBias');
}

{
    const result = getBiasStrings({ textareaText: '{{bias "explicit"}}', type: 'send', chat: [], userPromptBias: ' [default bias]' });
    assert.equal(result.isUserPromptBias, false);
    assert.equal(result.messageBias, ' explicit');
}

{
    const macroContext = { name1: 'Alice', name2: 'Bob' };
    const result = getBiasStrings({
        textareaText: '{{bias "{{user}} loves {{char}}"}}',
        type: 'send',
        chat: [],
        macroContext,
    });
    assert.equal(result.messageBias, ' Alice loves Bob', 'messageBias gets substituteParams applied');
    assert.equal(result.promptBias, ' Alice loves Bob', 'promptBias gets substituteParams applied');
}

assert.equal(
    formatMessageHistoryItem({ name: 'Alice', mes: 'hello there', is_user: true }, false, undefined, { name1: 'Alice', name2: 'Bob', instructPreset }),
    'Alice: hello there\n',
);

assert.equal(
    formatMessageHistoryItem({ name: '', mes: 'hello there', is_user: true }, false, undefined, { name1: 'Alice', name2: 'Bob', instructPreset }),
    'hello there\n',
);

assert.equal(
    formatMessageHistoryItem({ name: 'Narrator', mes: 'The sun sets.', is_user: false, extra: { type: 'narrator' } }, false, undefined, { name1: 'Alice', name2: 'Bob', instructPreset }),
    'The sun sets.\n',
);

assert.equal(
    formatMessageHistoryItem({ name: 'Alice', mes: 'hello', is_user: true, extra: { [IGNORE_SYMBOL]: true } }, false, undefined, { name1: 'Alice', name2: 'Bob', instructPreset }),
    '',
);

{
    const result = formatMessageHistoryItem({ name: 'Bob', mes: 'hi', is_user: false }, true, undefined, { isGroup: false, name1: 'Alice', name2: 'Bob', instructPreset });
    assert.ok(result.includes('### Response:'), `expected instruct wrapper in: ${result}`);
    assert.ok(result.includes('hi'));
}

function baseParams(overrides = {}) {
    return {
        quiet_prompt: '',
        name1: 'Alice',
        name2: 'Bob',
        isInstruct: false,
        quietToLoud: false,
        type: 'send',
        quietName: undefined,
        isImpersonate: false,
        promptBias: '',
        chat: [{ is_user: true }],
        force_name2: false,
        isContinue: false,
        isGroup: false,
        instructPreset,
        ...overrides,
    };
}

assert.equal(
    modifyLastPromptLine('base', baseParams({ quiet_prompt: 'Summarize this', isInstruct: false, quietToLoud: false })),
    'base\nSummarize this',
);

{
    const result = modifyLastPromptLine('base', baseParams({ quiet_prompt: 'Summarize this', isInstruct: false, quietToLoud: true, isImpersonate: true, isContinue: false }));
    assert.equal(result, 'base\nSummarize this\nAlice:', 'no early bailout when quietToLoud, falls through to impersonation line append');
}

{
    const result = modifyLastPromptLine('base', baseParams({ quiet_prompt: 'Summarize this', isInstruct: true, quietToLoud: false, isContinue: false }));
    assert.ok(result.includes('### System:'), result);
    assert.ok(result.includes('Summarize this'));
}

{
    const quietResult = modifyLastPromptLine('base', baseParams({ isInstruct: true, type: 'quiet', quiet_prompt: 'Do X', quietToLoud: true }));
    const nonQuietResult = modifyLastPromptLine('base', baseParams({ isInstruct: true, type: 'send' }));
    assert.notEqual(quietResult, nonQuietResult);
    assert.ok(nonQuietResult.includes('### Response (last):'), nonQuietResult);
}

{
    const impersonateResult = modifyLastPromptLine('base', baseParams({ isInstruct: true, isImpersonate: true }));
    const normalResult = modifyLastPromptLine('base', baseParams({ isInstruct: true, isImpersonate: false }));
    assert.ok(impersonateResult.includes('### Instruction (last):'), impersonateResult);
    assert.ok(normalResult.includes('### Response (last):'), normalResult);
}

assert.equal(
    modifyLastPromptLine('base', baseParams({ isInstruct: false, isImpersonate: true, isContinue: false })),
    'base\nAlice:',
);

assert.equal(
    modifyLastPromptLine('base', baseParams({ isInstruct: false, force_name2: true, isContinue: false, chat: [{ is_user: true }, { is_user: false }] })),
    'base\nBob:',
);

assert.equal(
    modifyLastPromptLine('base', baseParams({
        isInstruct: false,
        force_name2: true,
        isContinue: true,
        chat: [{ is_user: false }, { is_user: true }],
    })),
    'base\n',
);

assert.equal(
    modifyLastPromptLine('base', baseParams({
        isInstruct: false,
        force_name2: true,
        isContinue: true,
        chat: [{ is_user: false }],
    })),
    'base',
);

assert.equal(
    modifyLastPromptLine('base', baseParams({
        isInstruct: false,
        isImpersonate: false,
        force_name2: false,
        isContinue: false,
        quiet_prompt: '',
    })),
    'base',
);

console.log('All prompt-line-formatting tests passed.');
