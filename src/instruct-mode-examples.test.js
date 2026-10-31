import assert from 'node:assert/strict';
import { formatInstructModeExamples } from './instruct-mode-examples.js';

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
    return block.replace(/{{user}}/gi, name1).replace(/{{char}}/gi, name2);
}

{
    const preset = { ...basePreset, skip_examples: true };
    const block = resolveMacros(exampleBlock, 'Alice', 'Bob');
    const result = formatInstructModeExamples([block], 'Alice', 'Bob', {
        instructPreset: preset,
        contextSettings: { example_separator: 'Example:' },
    });
    assert.deepEqual(result, [block.replace(/<START>\n/i, 'Example:\n')]);
}

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

{
    const block = resolveMacros(exampleBlock, 'Alice', 'Bob');
    const result = formatInstructModeExamples([block], 'Alice', 'Bob', {
        instructPreset: { ...basePreset, names_behavior: 'force' },
        isGroup: false,
    });
    assert.deepEqual(result, [
        '<|im_start|>user\nAlice: hi there<|im_end|>\n',
        '<|im_start|>assistant\nhello!<|im_end|>\n',
    ]);
}

{
    const block = resolveMacros(exampleBlock, 'Alice', 'Bob');
    const preset = {
        ...basePreset,
        macro: true,
        input_sequence: '### {{name}}:\n',
        output_sequence: '### {{name}}:\n',
        input_suffix: '',
        output_suffix: '',
        wrap: true,
        names_behavior: 'none',
    };
    const result = formatInstructModeExamples([block], 'Alice', 'Bob', { instructPreset: preset });
    assert.deepEqual(result, [
        '### Alice:\n\nhi there\n',
        '### Bob:\n\nhello!\n',
    ]);
}

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
        '### {{name}}:\n\nhi there',
        '### {{name}}:\n\nhello!',
    ]);
}

{
    const block = resolveMacros(exampleBlock, 'Alice', 'Bob');
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

{
    const emptyBlock = '<START>\nnothing recognizable here\n';
    const result = formatInstructModeExamples([emptyBlock], 'Alice', 'Bob', {
        instructPreset: { ...basePreset, names_behavior: 'always' },
        contextSettings: { example_separator: 'Example:' },
    });
    assert.deepEqual(result, [emptyBlock.replace(/<START>\n/i, 'Example:\n')]);
}

console.log('instruct-mode-examples.test.js: all assertions passed');
