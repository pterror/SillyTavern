import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineFinalPrompt } from './final-prompt-combination.js';

function mkMesSend(messages) {
    return messages.map((message) => ({ message, extensionPrompts: [] }));
}

const baseParams = {
    injectedIndices: [],
    cfgPrompt: null,
    promptBias: '',
    isInstruct: false,
    isImpersonate: false,
    combinedStoryString: '',
    mesExmString: '',
    generatedPromptCache: '',
    chatStart: '',
    mainApi: 'textgenerationwebui',
    naiPreamble: '',
    collapseNewlines: false,
};

test('CFG splice at depth 0 appends to last message, no trailing whitespace -> space inserted', () => {
    const mesSend = mkMesSend(['first', 'last']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        cfgPrompt: { value: 'CFG_VALUE', depth: 0 },
    });
    assert.equal(finalMesSend[1].message, 'last CFG_VALUE');
    assert.equal(finalMesSend[0].message, 'first');
});

test('CFG splice at depth 0 appends to last message, trailing whitespace -> no space inserted', () => {
    const mesSend = mkMesSend(['first', 'last \n']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        cfgPrompt: { value: 'CFG_VALUE', depth: 0 },
    });
    assert.equal(finalMesSend[1].message, 'last \nCFG_VALUE');
});

test('CFG splice at non-zero depth pushes into extensionPrompts at computed depth', () => {
    // mesSend.length = 3, cfgPrompt.depth = 1 -> lengthDiff = 3 - 1 = 2 -> cfgDepth = 2
    const mesSend = mkMesSend(['a', 'b', 'c']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        cfgPrompt: { value: 'CFG_VALUE', depth: 1 },
    });
    assert.deepEqual(finalMesSend[0].extensionPrompts, []);
    assert.deepEqual(finalMesSend[1].extensionPrompts, []);
    assert.deepEqual(finalMesSend[2].extensionPrompts, ['CFG_VALUE\n']);
    // Messages themselves untouched by this branch
    assert.equal(finalMesSend[2].message, 'c');
});

test('CFG splice at non-zero depth: lengthDiff negative clamps cfgDepth to 0', () => {
    // mesSend.length = 2, cfgPrompt.depth = 10 -> lengthDiff = 2 - 10 = -8 -> cfgDepth = 0
    const mesSend = mkMesSend(['a', 'b']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        cfgPrompt: { value: 'CFG_VALUE', depth: 10 },
    });
    assert.deepEqual(finalMesSend[0].extensionPrompts, ['CFG_VALUE\n']);
    assert.deepEqual(finalMesSend[1].extensionPrompts, []);
});

test('CFG splice at non-zero depth: out-of-range cfgDepth is a no-op, no crash', () => {
    // mesSend.length = 1, cfgPrompt.depth = -5 -> lengthDiff = 1 - (-5) = 6 -> cfgDepth = 6, out of range
    const mesSend = mkMesSend(['only']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        cfgPrompt: { value: 'CFG_VALUE', depth: -5 },
    });
    assert.deepEqual(finalMesSend[0].extensionPrompts, []);
    assert.equal(finalMesSend[0].message, 'only');
});

test('No CFG splice when cfgPrompt is null', () => {
    const mesSend = mkMesSend(['first', 'last']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        cfgPrompt: null,
    });
    assert.equal(finalMesSend[1].message, 'last');
    assert.deepEqual(finalMesSend[1].extensionPrompts, []);
});

test('No CFG splice when cfgPrompt.value is falsy (empty string)', () => {
    const mesSend = mkMesSend(['first', 'last']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        cfgPrompt: { value: '', depth: 0 },
    });
    assert.equal(finalMesSend[1].message, 'last');
});

test('Prompt-bias appended when !isInstruct && !isImpersonate and non-empty, no trailing whitespace', () => {
    const mesSend = mkMesSend(['first', 'last']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        isInstruct: false,
        isImpersonate: false,
        promptBias: '  BIAS_VALUE  ',
    });
    // trimStart() keeps trailing whitespace of the bias itself, only strips leading
    assert.equal(finalMesSend[1].message, 'last BIAS_VALUE  ');
});

test('Prompt-bias appended, message already ends in whitespace -> no extra space', () => {
    const mesSend = mkMesSend(['first', 'last\n']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        isInstruct: false,
        isImpersonate: false,
        promptBias: 'BIAS_VALUE',
    });
    assert.equal(finalMesSend[1].message, 'last\nBIAS_VALUE');
});

test('Prompt-bias skipped when isInstruct is true', () => {
    const mesSend = mkMesSend(['first', 'last']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        isInstruct: true,
        isImpersonate: false,
        promptBias: 'BIAS_VALUE',
    });
    assert.equal(finalMesSend[1].message, 'last');
});

test('Prompt-bias skipped when isImpersonate is true', () => {
    const mesSend = mkMesSend(['first', 'last']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        isInstruct: false,
        isImpersonate: true,
        promptBias: 'BIAS_VALUE',
    });
    assert.equal(finalMesSend[1].message, 'last');
});

test('Prompt-bias skipped when empty/whitespace-only', () => {
    const mesSend = mkMesSend(['first', 'last']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        isInstruct: false,
        isImpersonate: false,
        promptBias: '   \n  ',
    });
    assert.equal(finalMesSend[1].message, 'last');
});

test('combine(): full flatten including addChatsSeparator/addChatsPreamble, \\r stripping', () => {
    const mesSend = mkMesSend(['hello\r', 'world']);
    const { combinedPrompt, mesSendString } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        combinedStoryString: 'STORY|',
        mesExmString: 'EXM|',
        generatedPromptCache: '|CACHE',
        chatStart: 'CHATSTART',
        mainApi: 'novel',
        naiPreamble: 'NAIPREAMBLE',
    });
    // addChatsSeparator prepends `${chatStart}\n`; addChatsPreamble prepends `${naiPreamble}\n` (novel api)
    assert.equal(mesSendString, 'NAIPREAMBLE\nCHATSTART\nhello\rworld');
    // combinedPrompt strips \r globally
    assert.equal(combinedPrompt, 'STORY|EXM|NAIPREAMBLE\nCHATSTART\nhelloworld|CACHE');
});

test('combine(): collapse_newlines off leaves multiple newlines intact', () => {
    const mesSend = mkMesSend(['a\n\n\nb']);
    const { combinedPrompt } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        collapseNewlines: false,
    });
    assert.equal(combinedPrompt, 'a\n\n\nb');
});

test('combine(): collapse_newlines on collapses runs of newlines', () => {
    const mesSend = mkMesSend(['a\n\n\nb']);
    const { combinedPrompt } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        collapseNewlines: true,
    });
    assert.equal(combinedPrompt, 'a\nb');
});

test('.injected flag: inverted-index computation matches hand-verified expectations', () => {
    // finalMesSend.length = 4 (indices 0..3). item.injected = injectedIndices.includes(length - i - 1)
    // i=0 -> checks 3 ; i=1 -> checks 2 ; i=2 -> checks 1 ; i=3 -> checks 0
    const mesSend = mkMesSend(['m0', 'm1', 'm2', 'm3']);
    const injectedIndices = [0, 2]; // original pre-reverse indices considered "injected"
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        injectedIndices,
    });
    // i=0 -> length-0-1=3 -> not in [0,2] -> false
    // i=1 -> length-1-1=2 -> in [0,2] -> true
    // i=2 -> length-2-1=1 -> not in [0,2] -> false
    // i=3 -> length-3-1=0 -> in [0,2] -> true
    assert.deepEqual(finalMesSend.map((e) => e.injected), [false, true, false, true]);
});

test('original mesSend parameter is never mutated (deep clone, not shallow)', () => {
    const mesSend = mkMesSend(['first', 'last']);
    const snapshotJson = JSON.stringify(mesSend);

    combineFinalPrompt({
        ...baseParams,
        mesSend,
        cfgPrompt: { value: 'CFG_VALUE', depth: 0 },
        promptBias: 'BIAS_VALUE',
        injectedIndices: [0],
    });

    assert.equal(JSON.stringify(mesSend), snapshotJson);
    // Also verify nested extensionPrompts arrays are distinct references (structuredClone, not
    // a shallow copy that would share nested array/object references).
    const mesSend2 = mkMesSend(['a', 'b']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend: mesSend2,
        cfgPrompt: { value: 'X', depth: 1 }, // pushes into finalMesSend[cfgDepth].extensionPrompts
    });
    assert.notEqual(finalMesSend[1].extensionPrompts, mesSend2[1].extensionPrompts);
    assert.deepEqual(mesSend2[1].extensionPrompts, []);
});
