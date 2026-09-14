import assert from 'node:assert/strict';
import {
    regex_placement,
    substitute_find_regex,
    sanitizeRegexMacro,
    getRegexedString,
    runRegexScript,
    RegexProvider,
} from './regex-scripts-engine.js';

function makeScript(overrides = {}) {
    return {
        scriptName: 'test-script',
        disabled: false,
        findRegex: '/foo/g',
        replaceString: 'bar',
        trimStrings: [],
        placement: [regex_placement.AI_OUTPUT],
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: false,
        substituteRegex: substitute_find_regex.NONE,
        minDepth: null,
        maxDepth: null,
        ...overrides,
    };
}

// --- RegexProvider caching ---
{
    const provider = new RegexProvider();
    const r1 = provider.get('/abc/g');
    const r2 = provider.get('/abc/g');
    assert.equal(r1, r2, 'same regex string should return the cached (identical) RegExp instance');
    assert.equal(r1.test('xxabcxx'), true);

    // Invalid regex returns null, does not throw
    const invalid = provider.get('[abc');
    assert.equal(invalid, null);

    // global regex has lastIndex reset to 0 on each get()
    const g = provider.get('/a/g');
    g.exec('aaa');
    assert.notEqual(g.lastIndex, 0);
    const g2 = provider.get('/a/g');
    assert.equal(g2.lastIndex, 0, 'lastIndex should be reset to 0 on cache hit');
}

// LRU eviction at capacity - use a tiny throwaway provider by exercising instance behavior logically.
// We can't shrink #maxSize (private + fixed at 1000), so just confirm re-insertion-on-hit ordering
// doesn't break correctness for a handful of entries (functional proxy for the eviction logic).
{
    const provider = new RegexProvider();
    for (let i = 0; i < 5; i++) {
        provider.get(`/pattern${i}/`);
    }
    // touch pattern0 again (should still be retrievable / correct)
    const again = provider.get('/pattern0/');
    assert.ok(again.test('pattern0'));
}

console.log('RegexProvider caching: OK');

// --- getRegexedString: markdownOnly / promptOnly / unrestricted gating ---
{
    const markdownOnlyScript = makeScript({ scriptName: 'md-only', markdownOnly: true, replaceString: 'MD' });
    const promptOnlyScript = makeScript({ scriptName: 'prompt-only', promptOnly: true, replaceString: 'PR' });
    const unrestrictedScript = makeScript({ scriptName: 'unrestricted', replaceString: 'UR' });

    // markdownOnly script runs only when isMarkdown is true
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [markdownOnlyScript], { isMarkdown: true }), 'MD');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [markdownOnlyScript], { isMarkdown: false }), 'foo');

    // promptOnly script runs only when isPrompt is true
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [promptOnlyScript], { isPrompt: true }), 'PR');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [promptOnlyScript], { isPrompt: false }), 'foo');

    // Unrestricted script (neither flag set on the script) runs ONLY when BOTH isMarkdown and isPrompt are falsy
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [unrestrictedScript], {}), 'UR');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [unrestrictedScript], { isMarkdown: true }), 'foo');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [unrestrictedScript], { isPrompt: true }), 'foo');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [unrestrictedScript], { isMarkdown: true, isPrompt: true }), 'foo');
}

console.log('markdownOnly/promptOnly/unrestricted gating: OK');

// --- isEdit / runOnEdit skip ---
{
    const noEditScript = makeScript({ runOnEdit: false, replaceString: 'X' });
    const editScript = makeScript({ runOnEdit: true, replaceString: 'X' });

    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [noEditScript], { isEdit: true }), 'foo', 'script without runOnEdit should be skipped during edit');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [noEditScript], { isEdit: false }), 'X', 'same script should run when not editing');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [editScript], { isEdit: true }), 'X', 'runOnEdit script should run during edit');
}

console.log('isEdit/runOnEdit skip: OK');

// --- minDepth / maxDepth boundary filtering ---
{
    const minDepthScript = makeScript({ minDepth: 2, replaceString: 'X' });
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [minDepthScript], { depth: 1 }), 'foo', 'one below minDepth should be skipped');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [minDepthScript], { depth: 2 }), 'X', 'exactly at minDepth should run');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [minDepthScript], { depth: 3 }), 'X', 'above minDepth should run');

    const maxDepthScript = makeScript({ maxDepth: 2, replaceString: 'X' });
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [maxDepthScript], { depth: 2 }), 'X', 'exactly at maxDepth should run');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [maxDepthScript], { depth: 3 }), 'foo', 'one above maxDepth should be skipped');

    // minDepth === -1 is the lowest allowed bound (>= -1 guard) and should still apply
    const minNegOneScript = makeScript({ minDepth: -1, replaceString: 'X' });
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [minNegOneScript], { depth: -1 }), 'X');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [minNegOneScript], { depth: -2 }), 'foo');

    // null/NaN minDepth/maxDepth means "no bound" - script always runs regardless of depth
    const noBoundScript = makeScript({ minDepth: null, maxDepth: NaN, replaceString: 'X' });
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [noBoundScript], { depth: 0 }), 'X');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [noBoundScript], { depth: 999 }), 'X');

    // depth not provided at all (not a number) - depth filtering skipped entirely
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [minDepthScript]), 'X');
}

console.log('minDepth/maxDepth filtering: OK');

// --- placement.includes() filtering ---
{
    const userInputScript = makeScript({ placement: [regex_placement.USER_INPUT], replaceString: 'X' });
    assert.equal(getRegexedString('foo', regex_placement.USER_INPUT, [userInputScript]), 'X');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [userInputScript]), 'foo', 'script should not run for a placement not in its placement list');

    const multiPlacementScript = makeScript({ placement: [regex_placement.USER_INPUT, regex_placement.AI_OUTPUT], replaceString: 'X' });
    assert.equal(getRegexedString('foo', regex_placement.USER_INPUT, [multiPlacementScript]), 'X');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [multiPlacementScript]), 'X');
    assert.equal(getRegexedString('foo', regex_placement.WORLD_INFO, [multiPlacementScript]), 'foo');
}

console.log('placement filtering: OK');

// --- runRegexScript: substituteRegex modes ---
{
    // NONE: findRegex used verbatim, no macro substitution
    const noneScript = makeScript({ findRegex: '/{{user}}/g', substituteRegex: substitute_find_regex.NONE, replaceString: 'HIT' });
    assert.equal(
        runRegexScript(noneScript, 'text with {{user}} literal', { macroContext: { name1: 'Alice' } }),
        'text with HIT literal',
        'NONE mode should match the literal find-regex text without substituting macros in it',
    );

    // RAW: findRegex macro-substituted, unescaped - special chars in the macro value ARE treated as regex metacharacters
    const rawScript = makeScript({ findRegex: '/{{user}}/g', substituteRegex: substitute_find_regex.RAW, replaceString: 'HIT' });
    // name1 = 'a.c' -> pattern becomes /a.c/g, and '.' matches any char, so "aXc" also matches
    assert.equal(
        runRegexScript(rawScript, 'abc aXc', { macroContext: { name1: 'a.c' } }),
        'HIT HIT',
        'RAW mode should substitute macros into the regex source without escaping regex metacharacters',
    );

    // ESCAPED: findRegex macro-substituted, WITH escaping - special chars are treated literally
    const escapedScript = makeScript({ findRegex: '/{{user}}/g', substituteRegex: substitute_find_regex.ESCAPED, replaceString: 'HIT' });
    assert.equal(
        runRegexScript(escapedScript, 'abc aXc', { macroContext: { name1: 'a.c' } }),
        'abc aXc',
        'ESCAPED mode should escape regex metacharacters, so "a.c" only matches a literal "a.c", not "aXc"',
    );
    assert.equal(
        runRegexScript(escapedScript, 'abc a.c', { macroContext: { name1: 'a.c' } }),
        'abc HIT',
        'ESCAPED mode should still match the literal "a.c" text',
    );

    // Also verify escaping with a "(" (grouping metacharacter)
    const escapedParenScript = makeScript({ findRegex: '/{{user}}/g', substituteRegex: substitute_find_regex.ESCAPED, replaceString: 'HIT' });
    assert.equal(
        runRegexScript(escapedParenScript, 'say (hi) now', { macroContext: { name1: '(hi)' } }),
        'say HIT now',
        'a literal "(hi)" in the macro value should be escaped and match the literal text, not be treated as a capture group',
    );
}

console.log('substituteRegex modes (NONE/RAW/ESCAPED): OK');

// --- numbered and named capture-group substitution, {{match}} -> $0 ---
{
    const numberedScript = makeScript({
        findRegex: '/(\\w+)-(\\w+)/',
        replaceString: '$2 then $1',
    });
    assert.equal(runRegexScript(numberedScript, 'foo-bar', {}), 'bar then foo');

    const namedScript = makeScript({
        findRegex: '/(?<first>\\w+)-(?<second>\\w+)/',
        replaceString: '$<second> then $<first>',
    });
    assert.equal(runRegexScript(namedScript, 'foo-bar', {}), 'bar then foo');

    const matchScript = makeScript({
        findRegex: '/\\w+/',
        replaceString: '[{{match}}]',
    });
    assert.equal(runRegexScript(matchScript, 'hello', {}), '[hello]');
}

console.log('capture-group and {{match}} substitution: OK');

// --- trimStrings filtering ---
{
    const trimScript = makeScript({
        findRegex: '/(\\w+)/',
        replaceString: '$1',
        trimStrings: ['ell'],
    });
    assert.equal(runRegexScript(trimScript, 'hello', {}), 'ho', 'trimStrings entries should be removed from the captured group before substitution');
}

console.log('trimStrings filtering: OK');

// --- final substituteParams() pass on the assembled replaceString ---
{
    const macroReplaceScript = makeScript({
        findRegex: '/foo/',
        replaceString: 'hi {{user}}, i am {{char}}',
    });
    assert.equal(
        runRegexScript(macroReplaceScript, 'foo', { macroContext: { name1: 'Alice', name2: 'Bob' } }),
        'hi Alice, i am Bob',
        'macros in replaceString itself should be substituted via the final substituteParams() pass',
    );
}

console.log('final substituteParams() pass on replaceString: OK');

// --- disabled / malformed scripts skipped without crashing ---
{
    const disabledScript = makeScript({ disabled: true, replaceString: 'X' });
    assert.equal(runRegexScript(disabledScript, 'foo', {}), 'foo');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [disabledScript]), 'foo');

    const missingFindRegexScript = makeScript({ findRegex: undefined, replaceString: 'X' });
    assert.doesNotThrow(() => runRegexScript(missingFindRegexScript, 'foo', {}));
    assert.equal(runRegexScript(missingFindRegexScript, 'foo', {}), 'foo');

    const invalidRegexScript = makeScript({ findRegex: '[unterminated', replaceString: 'X' });
    assert.doesNotThrow(() => runRegexScript(invalidRegexScript, 'foo', {}));
    assert.equal(runRegexScript(invalidRegexScript, 'foo', {}), 'foo', 'an invalid regex should compile to null and leave the string unchanged');

    assert.doesNotThrow(() => getRegexedString('foo', regex_placement.AI_OUTPUT, [disabledScript, missingFindRegexScript, invalidRegexScript]));

    // Also: getRegexedString should not throw or misbehave on a completely empty scripts array,
    // a disabled regex extension, or a non-string rawString.
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, []), 'foo');
    assert.equal(getRegexedString('foo', regex_placement.AI_OUTPUT, [makeScript({ replaceString: 'X' })], { regexExtensionEnabled: false }), 'foo');
    assert.equal(getRegexedString(null, regex_placement.AI_OUTPUT, []), '');
}

console.log('disabled/malformed scripts skipped without crashing: OK');

// --- sanitizeRegexMacro ---
{
    assert.equal(sanitizeRegexMacro('a.b'), 'a\\.b');
    assert.equal(sanitizeRegexMacro('(x)'), '\\(x\\)');
    assert.equal(sanitizeRegexMacro('a\nb'), 'a\\nb');
    assert.equal(sanitizeRegexMacro(42), 42, 'non-string input should pass through unchanged');
}

console.log('sanitizeRegexMacro: OK');

console.log('regex-scripts-engine.test.js: all assertions passed');
