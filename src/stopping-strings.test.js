import assert from 'node:assert/strict';
import { getStoppingStrings, getCustomStoppingStrings } from './stopping-strings.js';

const disabledInstructPreset = { enabled: false, wrap: false, macro: false, sequences_as_stop_strings: false };

assert.deepEqual(
    getCustomStoppingStrings({ customStoppingStringsRaw: JSON.stringify(['a', 'b']) }),
    ['a', 'b'],
    'valid array',
);

assert.deepEqual(
    getCustomStoppingStrings({ customStoppingStringsRaw: '{not json' }),
    [],
    'invalid JSON returns empty array',
);

assert.deepEqual(
    getCustomStoppingStrings({ customStoppingStringsRaw: JSON.stringify({ a: 1 }) }),
    [],
    'non-array JSON returns empty array',
);

assert.deepEqual(
    getCustomStoppingStrings({ customStoppingStringsRaw: JSON.stringify(['x', '', 5, null, 'y', undefined]) }),
    ['x', 'y'],
    'non-string/empty entries filtered out',
);

assert.deepEqual(getCustomStoppingStrings({}), [], 'no raw string -> empty array');

assert.deepEqual(
    getCustomStoppingStrings({
        customStoppingStringsRaw: JSON.stringify(['Hello {{user}}']),
        customStoppingStringsMacro: false,
        macroContext: { name1: 'Alice', name2: 'Bob' },
    }),
    ['Hello {{user}}'],
    'macro substitution off leaves macros untouched',
);

assert.deepEqual(
    getCustomStoppingStrings({
        customStoppingStringsRaw: JSON.stringify(['Hello {{user}}', 'Hi {{char}}']),
        customStoppingStringsMacro: true,
        macroContext: { name1: 'Alice', name2: 'Bob' },
    }),
    ['Hello Alice', 'Hi Bob'],
    'macro substitution on replaces macros',
);

assert.deepEqual(
    getCustomStoppingStrings({
        customStoppingStringsRaw: JSON.stringify(['perm1']),
        ephemeralStoppingStrings: ['eph1', 'eph2'],
    }),
    ['perm1', 'eph1', 'eph2'],
    'ephemeral strings appended after permanent ones',
);

assert.deepEqual(
    getCustomStoppingStrings({
        customStoppingStringsRaw: JSON.stringify(['a', 'b']),
        ephemeralStoppingStrings: ['c', 'd'],
        limit: 0,
    }),
    ['a', 'b', 'c', 'd'],
    'limit 0 returns all',
);
assert.deepEqual(
    getCustomStoppingStrings({
        customStoppingStringsRaw: JSON.stringify(['a', 'b']),
        ephemeralStoppingStrings: ['c', 'd'],
    }),
    ['a', 'b', 'c', 'd'],
    'limit undefined returns all',
);

assert.deepEqual(
    getCustomStoppingStrings({
        customStoppingStringsRaw: JSON.stringify(['a', 'b']),
        ephemeralStoppingStrings: ['c', 'd'],
        limit: 3,
    }),
    ['a', 'b', 'c'],
    'limit N slices to N items',
);

{
    const result = getStoppingStrings({
        api: 'openai',
        namesAsStopStrings: true,
        name1: 'User',
        name2: 'Char',
        isGroup: true,
        groupMemberNames: [{ name: 'Other' }],
        singleLine: true,
        instructPreset: { ...disabledInstructPreset, enabled: true, stop_sequence: 'STOP' },
        customStoppingStringsRaw: JSON.stringify(['custom1']),
    });
    assert.deepEqual(result, ['custom1'], 'openai api only returns custom stopping strings');
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: false,
        name1: 'User',
        name2: 'Char',
        instructPreset: disabledInstructPreset,
    });
    assert.deepEqual(result, [], 'names_as_stop_strings off yields no name-based stops (nothing else configured)');
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: true,
        isImpersonate: false,
        name1: 'User',
        name2: 'Char',
        instructPreset: disabledInstructPreset,
    });
    assert.deepEqual(result, ['\nUser:'], 'non-impersonate: only userString pushed (charString==userString collapses via dedup... but here they differ)');
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: true,
        isImpersonate: true,
        name1: 'User',
        name2: 'Char',
        instructPreset: disabledInstructPreset,
    });
    assert.deepEqual(result, ['\nChar:', '\nUser:'], 'impersonate: charString then userString');
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: true,
        isImpersonate: false,
        isContinue: true,
        name1: 'User',
        name2: 'Char',
        chat: [{ is_user: false }, { is_user: true }],
        instructPreset: disabledInstructPreset,
    });
    assert.deepEqual(result, ['\nUser:', '\nChar:'], 'continue with trailing user message adds charString');
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: true,
        isImpersonate: false,
        isContinue: true,
        name1: 'User',
        name2: 'Char',
        chat: [{ is_user: false }, { is_user: false }],
        instructPreset: disabledInstructPreset,
    });
    assert.deepEqual(result, ['\nUser:'], 'continue without trailing user message: no extra charString');
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: true,
        isImpersonate: false,
        name1: 'User',
        name2: 'Char',
        isGroup: true,
        groupMemberNames: [{ name: 'Char' }, { name: 'Ally' }, { name: '' }, { name: undefined }, 'Buddy'],
        instructPreset: disabledInstructPreset,
    });
    assert.deepEqual(
        result,
        ['\nUser:', '\nAlly:', '\nBuddy:'],
        'group members: self (matching name2) and nameless members filtered out, survivors added, plain-string members supported',
    );
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: true,
        isImpersonate: false,
        name1: 'User',
        name2: 'Char',
        isGroup: false,
        groupMemberNames: [{ name: 'Ally' }],
        instructPreset: disabledInstructPreset,
    });
    assert.deepEqual(result, ['\nUser:'], 'group members ignored when isGroup is false');
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: true,
        isImpersonate: false,
        name1: 'User',
        name2: '',
        isGroup: true,
        groupMemberNames: [{ name: 'Ally' }],
        instructPreset: disabledInstructPreset,
    });
    assert.deepEqual(result, ['\nUser:'], 'group members skipped entirely when name2 falsy and not impersonating');
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: false,
        singleLine: true,
        instructPreset: disabledInstructPreset,
        customStoppingStringsRaw: JSON.stringify(['custom1']),
    });
    assert.deepEqual(result, ['\n', 'custom1'], 'single_line prepends newline before everything else');
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: false,
        instructPreset: { ...disabledInstructPreset, enabled: true, sequences_as_stop_strings: false, stop_sequence: 'INSTRUCT_STOP' },
        contextSettings: {},
        customStoppingStringsRaw: JSON.stringify(['custom1']),
    });
    assert.deepEqual(result, ['INSTRUCT_STOP', 'custom1'], 'instruct sequences come before custom stopping strings');
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: true,
        isImpersonate: false,
        name1: 'User',
        name2: 'Char',
        instructPreset: disabledInstructPreset,
        customStoppingStringsRaw: JSON.stringify(['\nUser:', 'unique']),
    });
    assert.deepEqual(result, ['\nUser:', 'unique'], 'duplicate stop strings across sources are deduped, first occurrence kept');
}

{
    const result = getStoppingStrings({
        api: 'textgenerationwebui',
        namesAsStopStrings: false,
        instructPreset: disabledInstructPreset,
        customStoppingStringsRaw: JSON.stringify(['', 'kept']),
    });
    assert.deepEqual(result, ['kept'], 'empty-string entries filtered from final result');
}

console.log('stopping-strings.test.js: all assertions passed');
