import assert from 'node:assert/strict';
import { getBiasStrings, formatMessageHistoryItem, modifyLastPromptLine, IGNORE_SYMBOL } from './prompt-line-formatting.js';

// A minimal but "real" instruct preset, exercising the actual formatInstructModeChat /
// formatInstructModePrompt logic (not mocked) so tests verify real delegation.
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

// ---------- getBiasStrings ----------

// impersonate/continue short-circuit to all-empty/false
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

// empty textarea falls back to scanning chat for most recent biased eligible message
{
    const chat = [
        { is_user: true, extra: { bias: '' } },
        { is_user: true, extra: { bias: ' [angry]' } },
        { is_user: false }, // not user/system/narrator -> ineligible, loop does NOT break here, keeps scanning backward
    ];
    const result = getBiasStrings({ textareaText: '', type: 'send', chat });
    assert.equal(result.messageBias, '', 'no textarea -> no messageBias');
    assert.equal(result.promptBias, ' [angry]', 'falls back to most recent eligible message with a bias');
    assert.equal(result.isUserPromptBias, false);
}

// swipe type skips the last chat message when scanning
{
    const chat = [
        { is_user: true, extra: { bias: ' [old]' } },
        { is_user: true, extra: { bias: ' [newest, should be skipped for swipe]' } },
    ];
    const result = getBiasStrings({ textareaText: '', type: 'swipe', chat });
    assert.equal(result.promptBias, ' [old]', 'swipe skips the last chat entry');
}

// falls back to userPromptBias when no message bias found
{
    const chat = [{ is_user: true, extra: {} }];
    const result = getBiasStrings({ textareaText: '', type: 'send', chat, userPromptBias: ' [default bias]' });
    assert.equal(result.promptBias, ' [default bias]');
    assert.equal(result.isUserPromptBias, true, 'isUserPromptBias true when promptBias came from userPromptBias');
}

// isUserPromptBias is false when an explicit textarea bias wins
{
    const result = getBiasStrings({ textareaText: '{{bias "explicit"}}', type: 'send', chat: [], userPromptBias: ' [default bias]' });
    assert.equal(result.isUserPromptBias, false);
    assert.equal(result.messageBias, ' explicit');
}

// substituteParams is applied to both messageBias and promptBias
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

// ---------- formatMessageHistoryItem ----------

// plain formatting with name prefix
assert.equal(
    formatMessageHistoryItem({ name: 'Alice', mes: 'hello there', is_user: true }, false, undefined, { name1: 'Alice', name2: 'Bob', instructPreset }),
    'Alice: hello there\n',
);

// no name means no prefix
assert.equal(
    formatMessageHistoryItem({ name: '', mes: 'hello there', is_user: true }, false, undefined, { name1: 'Alice', name2: 'Bob', instructPreset }),
    'hello there\n',
);

// narrator messages never prepend a name even if named
assert.equal(
    formatMessageHistoryItem({ name: 'Narrator', mes: 'The sun sets.', is_user: false, extra: { type: 'narrator' } }, false, undefined, { name1: 'Alice', name2: 'Bob', instructPreset }),
    'The sun sets.\n',
);

// IGNORE_SYMBOL flag skips the message entirely
assert.equal(
    formatMessageHistoryItem({ name: 'Alice', mes: 'hello', is_user: true, extra: { [IGNORE_SYMBOL]: true } }, false, undefined, { name1: 'Alice', name2: 'Bob', instructPreset }),
    '',
);

// instruct mode delegates to real formatInstructModeChat
{
    const result = formatMessageHistoryItem({ name: 'Bob', mes: 'hi', is_user: false }, true, undefined, { isGroup: false, name1: 'Alice', name2: 'Bob', instructPreset });
    assert.ok(result.includes('### Response:'), `expected instruct wrapper in: ${result}`);
    assert.ok(result.includes('hi'));
}

// ---------- modifyLastPromptLine ----------

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

// quiet-prompt early bailout, non-instruct
assert.equal(
    modifyLastPromptLine('base', baseParams({ quiet_prompt: 'Summarize this', isInstruct: false, quietToLoud: false })),
    'base\nSummarize this',
);

// quiet-prompt early bailout also applies when isInstruct is false regardless of quietToLoud=false (already covered above);
// verify quietToLoud=true does NOT bail out early for non-instruct (falls through to further logic, e.g. impersonation line)
{
    const result = modifyLastPromptLine('base', baseParams({ quiet_prompt: 'Summarize this', isInstruct: false, quietToLoud: true, isImpersonate: true, isContinue: false }));
    assert.equal(result, 'base\nSummarize this\nAlice:', 'no early bailout when quietToLoud, falls through to impersonation line append');
}

// instruct quiet path: appends system-wrapped quiet prompt, does not bail (isInstruct always continues), then appends instruct prompt line
{
    const result = modifyLastPromptLine('base', baseParams({ quiet_prompt: 'Summarize this', isInstruct: true, quietToLoud: false, isContinue: false }));
    assert.ok(result.includes('### System:'), result);
    assert.ok(result.includes('Summarize this'));
}

// instruct prompt-line append path, quiet vs non-quiet differ
{
    const quietResult = modifyLastPromptLine('base', baseParams({ isInstruct: true, type: 'quiet', quiet_prompt: 'Do X', quietToLoud: true }));
    const nonQuietResult = modifyLastPromptLine('base', baseParams({ isInstruct: true, type: 'send' }));
    assert.notEqual(quietResult, nonQuietResult);
    assert.ok(nonQuietResult.includes('### Response (last):'), nonQuietResult);
}

// instruct prompt-line append, impersonate vs not
{
    const impersonateResult = modifyLastPromptLine('base', baseParams({ isInstruct: true, isImpersonate: true }));
    const normalResult = modifyLastPromptLine('base', baseParams({ isInstruct: true, isImpersonate: false }));
    assert.ok(impersonateResult.includes('### Instruction (last):'), impersonateResult);
    assert.ok(normalResult.includes('### Response (last):'), normalResult);
}

// non-instruct impersonation line append
assert.equal(
    modifyLastPromptLine('base', baseParams({ isInstruct: false, isImpersonate: true, isContinue: false })),
    'base\nAlice:',
);

// force_name2 append
assert.equal(
    modifyLastPromptLine('base', baseParams({ isInstruct: false, force_name2: true, isContinue: false, chat: [{ is_user: true }, { is_user: false }] })),
    'base\nBob:',
);

// force_name2 does not append the name when continuing after a user message (it still normalizes
// the trailing newline, but skips appending "name2:")
assert.equal(
    modifyLastPromptLine('base', baseParams({
        isInstruct: false,
        force_name2: true,
        isContinue: true,
        chat: [{ is_user: false }, { is_user: true }],
    })),
    'base\n',
);

// force_name2 does not append when continuing the very first message
assert.equal(
    modifyLastPromptLine('base', baseParams({
        isInstruct: false,
        force_name2: true,
        isContinue: true,
        chat: [{ is_user: false }],
    })),
    'base',
);

// nothing applies, string returned unchanged
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
