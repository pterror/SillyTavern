import assert from 'node:assert/strict';
import { formatInstructModeChat, formatInstructModePrompt, formatInstructModeStoryString, force_output_sequence } from './instruct-template-format.js';

// A representative preset, shaped like a real instruct preset (ChatML-style) on disk.
const preset = {
    input_sequence: '<|im_start|>user\n',
    output_sequence: '<|im_start|>assistant\n',
    first_output_sequence: '',
    last_output_sequence: '<|im_start|>assistant\n',
    system_sequence: '<|im_start|>system\n',
    system_same_as_user: false,
    input_suffix: '<|im_end|>\n',
    output_suffix: '<|im_end|>\n',
    system_suffix: '<|im_end|>\n',
    last_system_sequence: '',
    names_behavior: 'always',
    wrap: false,
    macro: true,
    story_string_prefix: 'Story about {{char}}:',
    story_string_suffix: '\nEND',
};

// User message, names always included
assert.equal(
    formatInstructModeChat('Alice', 'hi there', true, false, false, undefined, 'Alice', 'Bob', undefined, preset),
    '<|im_start|>user\nAlice: hi there<|im_end|>\n',
);

// Character message
assert.equal(
    formatInstructModeChat('Bob', 'hello!', false, false, false, undefined, 'Alice', 'Bob', undefined, preset),
    '<|im_start|>assistant\nBob: hello!<|im_end|>\n',
);

// Narrator message uses system sequence, and never gets a name prefix regardless of names_behavior
assert.equal(
    formatInstructModeChat('System', 'A narrator note', false, true, false, undefined, 'Alice', 'Bob', undefined, preset),
    '<|im_start|>system\nA narrator note<|im_end|>\n',
);

// names_behavior FORCE: only forced (group/forceAvatar) messages get a name prefix
{
    const forcePreset = { ...preset, names_behavior: 'force' };
    assert.equal(
        formatInstructModeChat('Alice', 'solo, no name expected', true, false, false, undefined, 'Alice', 'Bob', undefined, forcePreset),
        '<|im_start|>user\nsolo, no name expected<|im_end|>\n',
    );
    assert.equal(
        formatInstructModeChat('Carol', 'group message, name expected', false, false, true, undefined, 'Alice', 'Bob', undefined, forcePreset),
        '<|im_start|>assistant\nCarol: group message, name expected<|im_end|>\n',
    );
    // Not in a group, but this specific message carries a forced avatar - name still included.
    assert.equal(
        formatInstructModeChat('Dave', 'forced avatar message', false, false, false, 'some-avatar.png', 'Alice', 'Bob', undefined, forcePreset),
        '<|im_start|>assistant\nDave: forced avatar message<|im_end|>\n',
    );
}

// {{name}} macro substitution in prefix/suffix (macro: true)
{
    const macroPreset = { ...preset, input_sequence: '### {{name}}:\n', names_behavior: 'none' };
    assert.equal(
        formatInstructModeChat('Alice', 'hi', true, false, false, undefined, 'Alice', 'Bob', undefined, macroPreset),
        '### Alice:\nhi<|im_end|>\n',
    );
}

// forceOutputSequence FIRST/LAST selects the right sequence when set
{
    const seqPreset = { ...preset, first_input_sequence: '<FIRST_USER>', input_sequence: '<USER>' };
    assert.equal(
        formatInstructModeChat('Alice', 'hi', true, false, false, undefined, 'Alice', 'Bob', force_output_sequence.FIRST, seqPreset),
        '<FIRST_USER>Alice: hi<|im_end|>\n',
    );
}

// formatInstructModePrompt: default AI response line
assert.equal(
    formatInstructModePrompt('Bob', false, '', 'Alice', 'Bob', false, false, false, preset),
    '<|im_start|>assistant\nBob:',
);

// formatInstructModePrompt: impersonation uses last_input_sequence fallback to input_sequence
assert.equal(
    formatInstructModePrompt('Alice', true, '', 'Alice', 'Bob', false, false, false, preset),
    '<|im_start|>user\nAlice:',
);

// formatInstructModePrompt: quiet (non-loud) uses last_system_sequence || output_sequence, and strips the leading separator when wrap is on
{
    const wrapPreset = { ...preset, wrap: true, names_behavior: 'none' };
    const quiet = formatInstructModePrompt('', false, '', 'Alice', 'Bob', true, false, false, wrapPreset);
    assert.equal(quiet, '<|im_start|>assistant\n'); // leading '\n' separator stripped for quiet
}

// promptBias appended for non-impersonate
assert.equal(
    formatInstructModePrompt('Bob', false, ' (smiling)', 'Alice', 'Bob', false, false, false, preset),
    '<|im_start|>assistant\nBob: (smiling)',
);

// formatInstructModeStoryString
assert.equal(
    formatInstructModeStoryString('Once upon a time.', preset, { story_string_position: 0, name2: 'Bob' }),
    'Story about Bob:Once upon a time.\nEND',
);
assert.equal(formatInstructModeStoryString('', preset), '');
// IN_CHAT position (1) skips prefix/suffix wrapping
assert.equal(
    formatInstructModeStoryString('Once upon a time.', preset, { story_string_position: 1, name2: 'Bob' }),
    'Once upon a time.',
);

console.log('instruct-template-format.test.js: all assertions passed');
