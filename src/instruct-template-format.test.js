import assert from 'node:assert/strict';
import { formatInstructModeChat, formatInstructModePrompt, formatInstructModeStoryString, force_output_sequence, getInstructStoppingSequences, constructPrompt } from './instruct-template-format.js';

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

// getInstructStoppingSequences: basic sequences + sequences_as_stop_strings + {{name}} substitution
{
    const stopPreset = {
        ...preset, enabled: true, stop_sequence: '', sequences_as_stop_strings: true,
        input_sequence: '<|im_start|>user\n', output_sequence: '<|im_start|>assistant\n',
        first_output_sequence: '', last_output_sequence: '<|im_start|>assistant\n',
        system_sequence: '<|im_start|>system\n', last_system_sequence: '',
    };
    const sequences = getInstructStoppingSequences(stopPreset, {}, { name1: 'Alice', name2: 'Bob' });
    // combined_sequence is joined and re-split on '\n', so each sequence's own trailing newline is
    // stripped off as a separate (empty, filtered-out) line - matches the client exactly.
    assert.equal(sequences.includes('<|im_start|>user'), true);
    assert.equal(sequences.includes('<|im_start|>assistant'), true);
    assert.equal(sequences.includes('<|im_start|>system'), true);
    // Deduped: output_sequence and last_output_sequence are identical strings here
    assert.equal(sequences.filter(s => s === '<|im_start|>assistant').length, 1);
}

// getInstructStoppingSequences: context-template stop strings (chat_start/example_separator)
{
    const disabledPreset = { ...preset, enabled: false };
    const sequences = getInstructStoppingSequences(disabledPreset, {
        use_stop_strings: true, chat_start: '<START>', example_separator: '<EXAMPLE>',
    }, { name1: 'Alice', name2: 'Bob' });
    assert.deepEqual(sequences, ['\n<START>', '\n<EXAMPLE>']);
}

// constructPrompt: solo chat, names_behavior FORCE - no name prefix (not a group, no forced avatar)
// Third message makes the assistant message non-last, so it's formatted via formatInstructModeChat
// rather than treated as an assistant-prefill continuation (which uses a different code path/param).
{
    const forcePreset = { ...preset, names_behavior: 'force', enabled: true };
    const result = constructPrompt(
        [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'thanks' }],
        forcePreset, { name1: 'Alice', name2: 'Bob', isGroup: false },
    );
    assert.equal(result.includes('Bob:'), false, 'solo chat with FORCE names_behavior should not prefix the character name');
}

// constructPrompt: group chat, names_behavior FORCE - name prefix IS included (the isGroup bug this session fixed)
// Third message makes the group assistant message non-last, so it's formatted via formatInstructModeChat
// rather than treated as an assistant-prefill continuation (which uses a different code path/param).
{
    const forcePreset = { ...preset, names_behavior: 'force', enabled: true };
    const result = constructPrompt(
        [{ role: 'user', content: 'hi' }, { role: 'assistant', name: 'Carol', content: 'hello' }, { role: 'user', content: 'thanks' }],
        forcePreset, { name1: 'Alice', name2: 'Bob', isGroup: true },
    );
    assert.equal(result.includes('Carol: hello'), true, 'group chat with FORCE names_behavior must prefix the character name');
}

// constructPrompt: last message appends the assistant prompt line (no prefill). This continuation
// line is always generated with isQuiet=true/isQuietToLoud=false, which per formatInstructModePrompt's
// includeNames formula suppresses the name prefix regardless of names_behavior - by design, verified
// against the actual client code path, not a gap in this port.
{
    const alwaysPreset = { ...preset, names_behavior: 'always', enabled: true };
    const result = constructPrompt([{ role: 'user', content: 'hi' }], alwaysPreset, { name1: 'Alice', name2: 'Bob' });
    assert.equal(result.endsWith('<|im_start|>assistant\n'), true);
}

// constructPrompt: assistant-prefill (last message is already role:assistant) formats as the prefill itself
{
    const simplePreset = { ...preset, names_behavior: 'none', enabled: true };
    const result = constructPrompt(
        [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Well,' }],
        simplePreset, { name1: 'Alice', name2: 'Bob' },
    );
    assert.equal(result.endsWith('Well,'), true);
}

console.log('instruct-template-format.test.js: all assertions passed');
