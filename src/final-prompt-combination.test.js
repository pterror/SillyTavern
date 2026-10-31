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
    const mesSend = mkMesSend(['a', 'b', 'c']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        cfgPrompt: { value: 'CFG_VALUE', depth: 1 },
    });
    assert.deepEqual(finalMesSend[0].extensionPrompts, []);
    assert.deepEqual(finalMesSend[1].extensionPrompts, []);
    assert.deepEqual(finalMesSend[2].extensionPrompts, ['CFG_VALUE\n']);
    assert.equal(finalMesSend[2].message, 'c');
});

test('CFG splice at non-zero depth: lengthDiff negative clamps cfgDepth to 0', () => {
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
    assert.equal(mesSendString, 'NAIPREAMBLE\nCHATSTART\nhello\rworld');
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
    const mesSend = mkMesSend(['m0', 'm1', 'm2', 'm3']);
    const injectedIndices = [0, 2];
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend,
        injectedIndices,
    });
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
    const mesSend2 = mkMesSend(['a', 'b']);
    const { finalMesSend } = combineFinalPrompt({
        ...baseParams,
        mesSend: mesSend2,
        cfgPrompt: { value: 'X', depth: 1 },
    });
    assert.notEqual(finalMesSend[1].extensionPrompts, mesSend2[1].extensionPrompts);
    assert.deepEqual(mesSend2[1].extensionPrompts, []);
});
