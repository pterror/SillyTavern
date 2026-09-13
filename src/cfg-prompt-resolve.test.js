import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cfgType, getGuidanceScale, getCfgPrompt, adjustMaxContextForCfg } from './cfg-prompt-resolve.js';

const fakeCountTokens = async (text) => text.length;

// --- getGuidanceScale ---------------------------------------------------

test('getGuidanceScale: chat-level active', () => {
    const result = getGuidanceScale({ chatGuidanceScale: 3 });
    assert.deepStrictEqual(result, { type: cfgType.chat, value: 3 });
});

test('getGuidanceScale: groupchatIndividualChars suppresses chat-level', () => {
    const result = getGuidanceScale({ chatGuidanceScale: 3, groupchatIndividualChars: true, charaCfg: { guidance_scale: 4 } });
    assert.deepStrictEqual(result, { type: cfgType.chara, value: 4 });
});

test('getGuidanceScale: character-level active (!isGroup case)', () => {
    const result = getGuidanceScale({ isGroup: false, charaCfg: { guidance_scale: 2.5 } });
    assert.deepStrictEqual(result, { type: cfgType.chara, value: 2.5 });
});

test('getGuidanceScale: character-level active (groupchatCharOverride case)', () => {
    const result = getGuidanceScale({ isGroup: true, groupchatIndividualChars: true, charaCfg: { guidance_scale: 2.5 } });
    assert.deepStrictEqual(result, { type: cfgType.chara, value: 2.5 });
});

test('getGuidanceScale: isGroup without override does not use charaCfg', () => {
    // isGroup true, no groupchatIndividualChars override -> chara branch condition is false,
    // falls through to global.
    const result = getGuidanceScale({ isGroup: true, charaCfg: { guidance_scale: 2.5 }, globalCfg: { guidance_scale: 7 } });
    assert.deepStrictEqual(result, { type: cfgType.global, value: 7 });
});

test('getGuidanceScale: global-level active', () => {
    const result = getGuidanceScale({ globalCfg: { guidance_scale: 5 } });
    assert.deepStrictEqual(result, { type: cfgType.global, value: 5 });
});

test('getGuidanceScale: guidance_scale === 1 disables chat level', () => {
    const result = getGuidanceScale({ chatGuidanceScale: 1, globalCfg: { guidance_scale: 5 } });
    assert.deepStrictEqual(result, { type: cfgType.global, value: 5 });
});

test('getGuidanceScale: guidance_scale === 1 disables chara level', () => {
    const result = getGuidanceScale({ charaCfg: { guidance_scale: 1 }, globalCfg: { guidance_scale: 5 } });
    assert.deepStrictEqual(result, { type: cfgType.global, value: 5 });
});

test('getGuidanceScale: guidance_scale === 1 disables global level', () => {
    const result = getGuidanceScale({ globalCfg: { guidance_scale: 1 } });
    assert.strictEqual(result, undefined);
});

test('getGuidanceScale: nothing active falls through to undefined', () => {
    const result = getGuidanceScale({});
    assert.strictEqual(result, undefined);
});

// --- getCfgPrompt ---------------------------------------------------------

test('getCfgPrompt: single-source resolution - chat active', () => {
    const guidanceScale = { type: cfgType.chat, value: 3 };
    const result = getCfgPrompt(guidanceScale, true, {
        chatMetadataPrompts: { negativePrompt: 'chat-negative' },
    });
    assert.deepStrictEqual(result, { value: 'chat-negative', depth: 1 });
});

test('getCfgPrompt: single-source resolution - chara active', () => {
    const guidanceScale = { type: cfgType.chara, value: 3 };
    const result = getCfgPrompt(guidanceScale, false, {
        charaCfg: { positive_prompt: 'chara-positive' },
    });
    assert.deepStrictEqual(result, { value: 'chara-positive', depth: 1 });
});

test('getCfgPrompt: single-source resolution - global active', () => {
    const guidanceScale = { type: cfgType.global, value: 3 };
    const result = getCfgPrompt(guidanceScale, true, {
        globalCfg: { negative_prompt: 'global-negative' },
    });
    assert.deepStrictEqual(result, { value: 'global-negative', depth: 1 });
});

test('getCfgPrompt: promptCombine pulls in additional sources beyond the active type', () => {
    const guidanceScale = { type: cfgType.chat, value: 3 };
    const result = getCfgPrompt(guidanceScale, false, {
        chatMetadataPrompts: { positivePrompt: 'CHAT' },
        charaCfg: { positive_prompt: 'CHARA' },
        globalCfg: { positive_prompt: 'GLOBAL' },
        promptCombine: [cfgType.chara, cfgType.global],
    });
    assert.strictEqual(result.value.includes('CHAT'), true);
    assert.strictEqual(result.value.includes('CHARA'), true);
    assert.strictEqual(result.value.includes('GLOBAL'), true);
});

test('getCfgPrompt: exact ordering of combined sources (global, chara, chat)', () => {
    const guidanceScale = { type: cfgType.chat, value: 3 };
    const result = getCfgPrompt(guidanceScale, false, {
        chatMetadataPrompts: { positivePrompt: 'AAA' },
        charaCfg: { positive_prompt: 'BBB' },
        globalCfg: { positive_prompt: 'CCC' },
        promptCombine: [cfgType.chara, cfgType.global],
        promptSeparator: JSON.stringify('|'),
    });
    // unshift order: chat first -> [AAA]; chara -> [BBB, AAA]; global -> [CCC, BBB, AAA]
    assert.strictEqual(result.value, 'CCC|BBB|AAA');
});

test('getCfgPrompt: custom separator (valid JSON)', () => {
    const guidanceScale = { type: cfgType.chat, value: 3 };
    const result = getCfgPrompt(guidanceScale, false, {
        chatMetadataPrompts: { positivePrompt: 'A' },
        charaCfg: { positive_prompt: 'B' },
        promptCombine: [cfgType.chara],
        promptSeparator: JSON.stringify(' -- '),
    });
    assert.strictEqual(result.value, 'B -- A');
});

test('getCfgPrompt: invalid JSON separator falls back to default \\n', () => {
    const guidanceScale = { type: cfgType.chat, value: 3 };
    const result = getCfgPrompt(guidanceScale, false, {
        chatMetadataPrompts: { positivePrompt: 'A' },
        charaCfg: { positive_prompt: 'B' },
        promptCombine: [cfgType.chara],
        promptSeparator: 'not valid json {{{',
    });
    assert.strictEqual(result.value, 'B\nA');
});

test('getCfgPrompt: default separator is \\n when unset', () => {
    const guidanceScale = { type: cfgType.chat, value: 3 };
    const result = getCfgPrompt(guidanceScale, false, {
        chatMetadataPrompts: { positivePrompt: 'A' },
        charaCfg: { positive_prompt: 'B' },
        promptCombine: [cfgType.chara],
    });
    assert.strictEqual(result.value, 'B\nA');
});

test('getCfgPrompt: empty sources are filtered out before joining', () => {
    const guidanceScale = { type: cfgType.chat, value: 3 };
    const result = getCfgPrompt(guidanceScale, false, {
        chatMetadataPrompts: { positivePrompt: 'A' },
        charaCfg: { positive_prompt: '' },
        globalCfg: { positive_prompt: undefined },
        promptCombine: [cfgType.chara, cfgType.global],
    });
    assert.strictEqual(result.value, 'A');
});

test('getCfgPrompt: insertionDepth defaults to 1', () => {
    const guidanceScale = { type: cfgType.chat, value: 3 };
    const result = getCfgPrompt(guidanceScale, false, {
        chatMetadataPrompts: { positivePrompt: 'A' },
    });
    assert.strictEqual(result.depth, 1);
});

test('getCfgPrompt: insertionDepth passed through when given', () => {
    const guidanceScale = { type: cfgType.chat, value: 3 };
    const result = getCfgPrompt(guidanceScale, false, {
        chatMetadataPrompts: { positivePrompt: 'A' },
        promptInsertionDepth: 4,
    });
    assert.strictEqual(result.depth, 4);
});

// --- adjustMaxContextForCfg -----------------------------------------------

test('adjustMaxContextForCfg: decrement is Math.max(negativeCount, positiveCount), not sum or negative-only', async () => {
    const cfgGuidanceScale = { type: cfgType.chat, value: 3 };
    const result = await adjustMaxContextForCfg({
        cfgGuidanceScale,
        thisMaxContext: 1000,
        countTokens: fakeCountTokens,
        chatMetadataPrompts: { negativePrompt: 'short', positivePrompt: 'a much longer positive prompt string' },
    });
    const negativeLen = 'short'.length;
    const positiveLen = 'a much longer positive prompt string'.length;
    assert.ok(positiveLen > negativeLen);
    assert.strictEqual(result.thisMaxContext, 1000 - positiveLen);
    assert.strictEqual(result.negativePrompt.value, 'short');
    assert.strictEqual(result.positivePrompt.value, 'a much longer positive prompt string');
});

test('adjustMaxContextForCfg: no decrement when both prompts are empty', async () => {
    const cfgGuidanceScale = { type: cfgType.chat, value: 3 };
    const result = await adjustMaxContextForCfg({
        cfgGuidanceScale,
        thisMaxContext: 1000,
        countTokens: fakeCountTokens,
        chatMetadataPrompts: { negativePrompt: '', positivePrompt: '' },
    });
    assert.strictEqual(result.thisMaxContext, 1000);
});

test('adjustMaxContextForCfg: no decrement when cfgGuidanceScale is undefined', async () => {
    const result = await adjustMaxContextForCfg({
        cfgGuidanceScale: undefined,
        thisMaxContext: 1000,
        countTokens: fakeCountTokens,
        chatMetadataPrompts: { negativePrompt: 'nonempty', positivePrompt: 'nonempty' },
    });
    assert.strictEqual(result.thisMaxContext, 1000);
    assert.strictEqual(result.negativePrompt, undefined);
    assert.strictEqual(result.positivePrompt, undefined);
});

test('adjustMaxContextForCfg: no decrement when cfgGuidanceScale.value === 1', async () => {
    const result = await adjustMaxContextForCfg({
        cfgGuidanceScale: { type: cfgType.chat, value: 1 },
        thisMaxContext: 1000,
        countTokens: fakeCountTokens,
        chatMetadataPrompts: { negativePrompt: 'nonempty', positivePrompt: 'nonempty' },
    });
    assert.strictEqual(result.thisMaxContext, 1000);
    assert.strictEqual(result.negativePrompt, undefined);
    assert.strictEqual(result.positivePrompt, undefined);
});
