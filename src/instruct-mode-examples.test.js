import assert from 'node:assert/strict';
import { formatInstructModeExamples } from './instruct-mode-examples.js';

// A representative instruct preset (ChatML-style), matching the style of instruct-template-format.test.js.
const basePreset = {
    input_sequence: '<|im_start|>user\n',
    output_sequence: '<|im_start|>assistant\n',
    input_suffix: '<|im_end|>\n',
    output_suffix: '<|im_end|>\n',
    names_behavior: 'none',
    wrap: false,
    macro: false,
    skip_examples: false,
};

const exampleBlock = '<START>\n{{user}}: hi there\n{{char}}: hello!\n';

function resolveMacros(block, name1, name2) {
    // parseExampleIntoIndividual() matches on literal "name1:"/"name2:" prefixes, not {{user}}/{{char}}
    // macros - substitute them the way the real pipeline would before this function ever sees the block.
    return block.replace(/{{user}}/gi, name1).replace(/{{char}}/gi, name2);
}

// ---- skip_examples short-circuit ------------------------------------------------------------
{
    const preset = { ...basePreset, skip_examples: true };
    const block = resolveMacros(exampleBlock, 'Alice', 'Bob');
    const result = formatInstructModeExamples([block], 'Alice', 'Bob', {
        instructPreset: preset,
        contextSettings: { example_separator: 'Example:' },
    });
    assert.deepEqual(result, [block.replace(/<START>\n/i, 'Example:\n')]);
}

// ---- names_behavior: NONE never includes names -----------------------------------------------
{
    const block = resolveMacros(exampleBlock, 'Alice', 'Bob');
    const result = formatInstructModeExamples([block], 'Alice', 'Bob', {
        instructPreset: { ...basePreset, names_behavior: 'none' },
    });
    assert.deepEqual(result, [
        '<|im_start|>user\nhi there<|im_end|>\n',
        '<|im_start|>assistant\nhello!<|im_end|>\n',
    ]);
}

// ---- names_behavior: ALWAYS includes names on every example line ------------------------------
{
    const block = resolveMacros(exampleBlock, 'Alice', 'Bob');
    const result = formatInstructModeExamples([block], 'Alice', 'Bob', {
        instructPreset: { ...basePreset, names_behavior: 'always' },
    });
    assert.deepEqual(result, [
        '<|im_start|>user\nAlice: hi there<|im_end|>\n',
        '<|im_start|>assistant\nBob: hello!<|im_end|>\n',
    ]);
}

// ---- names_behavior: FORCE includes names for example_user specifically, even without group names ----
{
    const block = resolveMacros(exampleBlock, 'Alice', 'Bob');
    const result = formatInstructModeExamples([block], 'Alice', 'Bob', {
        instructPreset: { ...basePreset, names_behavior: 'force' },
        isGroup: false,
    });
    assert.deepEqual(result, [
        '<|im_start|>user\nAlice: hi there<|im_end|>\n',
        // example_assistant is NOT forced - only example_user gets the FORCE special case.
        '<|im_start|>assistant\nhello!<|im_end|>\n',
    ]);
}

// ---- macro-gated prefix/suffix substitution ---------------------------------------------------
{
    const block = resolveMacros(exampleBlock, 'Alice', 'Bob');
    const preset = {
        ...basePreset,
        macro: true,
        input_sequence: '### {{name}}:\n',
        output_sequence: '### {{name}}:\n',
        input_suffix: '', // left empty on purpose to exercise the wrap-driven default below
        output_suffix: '',
        wrap: true,
        names_behavior: 'none',
    };
    const result = formatInstructModeExamples([block], 'Alice', 'Bob', { instructPreset: preset });
    assert.deepEqual(result, [
        // {{name}} in a prefix resolves to name1 for the user side, name2 for the assistant side.
        // wrap:true + empty suffix -> suffix defaults to '\n' (only inside the macro:true gate).
        // Note the prefix's own trailing '\n' PLUS the wrap:true join separator both apply (matches
        // the client's exact [prefix, content].filter(x=>x).join(separator) formula - not a typo).
        '### Alice:\n\nhi there\n',
        '### Bob:\n\nhello!\n',
    ]);
}

// ---- macro: false disables ALL substitution/suffix-defaulting, even with wrap: true ------------
{
    const block = resolveMacros(exampleBlock, 'Alice', 'Bob');
    const preset = {
        ...basePreset,
        macro: false,
        input_sequence: '### {{name}}:\n',
        output_sequence: '### {{name}}:\n',
        input_suffix: '',
        output_suffix: '',
        wrap: true,
        names_behavior: 'none',
    };
    const result = formatInstructModeExamples([block], 'Alice', 'Bob', { instructPreset: preset });
    assert.deepEqual(result, [
        // {{name}} is left LITERAL (no substitution happened at all), and the suffix stays empty
        // (no wrap-driven default) since none of that logic runs outside the macro:true gate - only
        // the plain wrap:true join separator (unrelated to the macro gate) still applies.
        '### {{name}}:\n\nhi there',
        '### {{name}}:\n\nhello!',
    ]);
}

// ---- wrap-driven separator: joins prefix / (message+suffix) with '\n' when true, '' when false ----
{
    const block = resolveMacros(exampleBlock, 'Alice', 'Bob');
    // Prefixes/suffixes deliberately carry no newlines of their own, so the separator's effect on
    // the join is unambiguous either way.
    const preset = { ...basePreset, input_sequence: 'USER', output_sequence: 'BOT', input_suffix: 'SUFU', output_suffix: 'SUFB', names_behavior: 'none' };
    const wrapPreset = { ...preset, wrap: true };
    const noWrapPreset = { ...preset, wrap: false };

    assert.deepEqual(
        formatInstructModeExamples([block], 'Alice', 'Bob', { instructPreset: wrapPreset }),
        ['USER\nhi thereSUFU', 'BOT\nhello!SUFB'],
    );
    assert.deepEqual(
        formatInstructModeExamples([block], 'Alice', 'Bob', { instructPreset: noWrapPreset }),
        ['USERhi thereSUFU', 'BOThello!SUFB'],
    );
}

// ---- multi-block input: blockHeading prepended per non-empty block ----------------------------
{
    const blockA = resolveMacros('<START>\n{{user}}: first\n{{char}}: reply one\n', 'Alice', 'Bob');
    const blockB = resolveMacros('<START>\n{{user}}: second\n{{char}}: reply two\n', 'Alice', 'Bob');
    const result = formatInstructModeExamples([blockA, blockB], 'Alice', 'Bob', {
        instructPreset: { ...basePreset, names_behavior: 'none' },
        contextSettings: { example_separator: '***' },
    });
    assert.deepEqual(result, [
        '***\n',
        '<|im_start|>user\nfirst<|im_end|>\n',
        '<|im_start|>assistant\nreply one<|im_end|>\n',
        '***\n',
        '<|im_start|>user\nsecond<|im_end|>\n',
        '<|im_start|>assistant\nreply two<|im_end|>\n',
    ]);
}

// ---- final fallback: every block parses to zero examples ---------------------------------------
{
    // No name1:/name2: prefixed lines anywhere -> parseExampleIntoIndividual() finds nothing.
    const emptyBlock = '<START>\nnothing recognizable here\n';
    const result = formatInstructModeExamples([emptyBlock], 'Alice', 'Bob', {
        instructPreset: { ...basePreset, names_behavior: 'always' },
        contextSettings: { example_separator: 'Example:' },
    });
    assert.deepEqual(result, [emptyBlock.replace(/<START>\n/i, 'Example:\n')]);
}

console.log('instruct-mode-examples.test.js: all assertions passed');
