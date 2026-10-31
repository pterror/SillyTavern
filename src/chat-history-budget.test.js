import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    injectJailbreak,
    buildChat2,
    shiftCyclePromptOffFront,
    fillContextBudget,
    estimateExampleBudget,
    buildMesSend,
} from './chat-history-budget.js';

const countTokens = async (text) => text.length;

const basicInstructPreset = {
    enabled: true,
    wrap: true,
    macro: false,
    names_behavior: 'none',
    input_sequence: '<|user|>',
    output_sequence: '<|assistant|>',
    first_input_sequence: '',
    last_input_sequence: '<|user_last|>',
    first_output_sequence: '<|assistant_first|>',
    last_output_sequence: '<|assistant_last|>',
    input_suffix: '',
    output_suffix: '',
    system_sequence: '<|system|>',
    system_suffix: '',
    system_same_as_user: false,
};

test('injectJailbreak: non-continue splices at end and shifts injectedIndices', () => {
    const coreChat = [{ mes: 'a', is_user: true }, { mes: 'b', is_user: false }];
    const result = injectJailbreak(coreChat, [0], {
        mainApi: 'textgenerationwebui',
        sysPromptEnabled: true,
        jailbreak: 'JB',
        preferCharacterJailbreak: false,
        sysPromptPostHistory: 'post history text',
        isContinue: false,
    });

    assert.equal(result.coreChat.length, 3);
    assert.deepEqual(result.coreChat[2], { mes: 'post history text', is_user: true });
    assert.deepEqual(result.injectedIndices, [1]);
    assert.equal(result.jailbreak, 'post history text');
});

test('injectJailbreak: continue splices before last element, indices NOT shifted', () => {
    const coreChat = [{ mes: 'a', is_user: true }, { mes: 'b', is_user: false }];
    const result = injectJailbreak(coreChat, [0], {
        mainApi: 'textgenerationwebui',
        sysPromptEnabled: true,
        jailbreak: 'JB',
        preferCharacterJailbreak: false,
        sysPromptPostHistory: 'post history text',
        isContinue: true,
    });

    assert.equal(result.coreChat.length, 3);
    assert.deepEqual(result.coreChat[1], { mes: 'post history text', is_user: true });
    assert.deepEqual(result.coreChat[2], { mes: 'b', is_user: false });
    assert.deepEqual(result.injectedIndices, [0]);
});

test('injectJailbreak: no-op when resolved jailbreak is empty', () => {
    const coreChat = [{ mes: 'a', is_user: true }];
    const result = injectJailbreak(coreChat, [0], {
        mainApi: 'textgenerationwebui',
        sysPromptEnabled: true,
        jailbreak: '',
        preferCharacterJailbreak: false,
        sysPromptPostHistory: '',
        isContinue: false,
    });

    assert.equal(result.coreChat.length, 1);
    assert.deepEqual(result.injectedIndices, [0]);
    assert.equal(result.jailbreak, '');
});

test('injectJailbreak: no-op when sysPromptEnabled is false', () => {
    const coreChat = [{ mes: 'a', is_user: true }];
    const result = injectJailbreak(coreChat, [0], {
        mainApi: 'textgenerationwebui',
        sysPromptEnabled: false,
        jailbreak: 'JB',
        preferCharacterJailbreak: true,
        sysPromptPostHistory: 'post',
        isContinue: false,
    });
    assert.equal(result.coreChat.length, 1);
    assert.equal(result.jailbreak, 'JB');
});

test('injectJailbreak: preferCharacterJailbreak=true uses substituteParams(jailbreak, {original}) path', () => {
    const coreChat = [{ mes: 'a', is_user: true }];
    const result = injectJailbreak(coreChat, [], {
        mainApi: 'textgenerationwebui',
        sysPromptEnabled: true,
        jailbreak: 'JB says {{original}}!',
        preferCharacterJailbreak: true,
        sysPromptPostHistory: 'POSTHIST',
        isContinue: false,
    });
    assert.equal(result.jailbreak, 'JB says POSTHIST!');
});

test('injectJailbreak: preferCharacterJailbreak=false uses baseChatReplace(sysPromptPostHistory) path', () => {
    const coreChat = [{ mes: 'a', is_user: true }];
    const result = injectJailbreak(coreChat, [], {
        mainApi: 'textgenerationwebui',
        sysPromptEnabled: true,
        jailbreak: 'JB says {{original}}!',
        preferCharacterJailbreak: false,
        sysPromptPostHistory: 'raw post history {{char}}',
        isContinue: false,
        macroContext: { name2: 'Bob' },
    });
    assert.equal(result.jailbreak, 'raw post history ');
});

test('injectJailbreak: preferCharacterJailbreak=true but jailbreak falsy falls back to baseChatReplace', () => {
    const coreChat = [{ mes: 'a', is_user: true }];
    const result = injectJailbreak(coreChat, [], {
        mainApi: 'textgenerationwebui',
        sysPromptEnabled: true,
        jailbreak: '',
        preferCharacterJailbreak: true,
        sysPromptPostHistory: 'fallback text',
        isContinue: false,
    });
    assert.equal(result.jailbreak, 'fallback text');
});

function ctxParams(overrides = {}) {
    return {
        isInstruct: false,
        isImpersonate: false,
        isContinue: false,
        instructPreset: basicInstructPreset,
        name1: 'User',
        name2: 'Char',
        isGroup: false,
        instructUserAlignmentMessage: '',
        ...overrides,
    };
}

test('buildChat2: basic reverse-indexed construction for a 3-message chat (non-instruct)', () => {
    const coreChat = [
        { name: 'User', mes: 'first', is_user: true },
        { name: 'Char', mes: 'second', is_user: false },
        { name: 'User', mes: 'third', is_user: true },
    ];
    const result = buildChat2(coreChat, ctxParams());

    assert.equal(result.chat2.length, 3);
    assert.match(result.chat2[2], /first/);
    assert.match(result.chat2[1], /second/);
    assert.match(result.chat2[0], /third/);
    assert.deepEqual(result.userMessageIndices.sort(), [0, 2]);
});

test('buildChat2: FIRST message gets force_output_sequence.FIRST reformatting in instruct mode', () => {
    const coreChat = [
        { name: 'User', mes: 'first', is_user: true },
        { name: 'Char', mes: 'middle', is_user: false },
        { name: 'User', mes: 'last', is_user: true },
    ];
    const result = buildChat2(coreChat, ctxParams({ isInstruct: true }));
    assert.match(result.chat2[2], /<\|user\|>/);
    assert.doesNotMatch(result.chat2[2], /<\|user_last\|>/);
});

test('buildChat2: LAST user message gets force_output_sequence.LAST reformatting in instruct mode (non-impersonate)', () => {
    const coreChat = [
        { name: 'Char', mes: 'greeting', is_user: false },
        { name: 'User', mes: 'question', is_user: true },
    ];
    const result = buildChat2(coreChat, ctxParams({ isInstruct: true }));
    assert.match(result.chat2[0], /<\|user_last\|>/);
});

test('buildChat2: LAST-user reformatting is skipped when isImpersonate is true', () => {
    const coreChat = [
        { name: 'Char', mes: 'greeting', is_user: false },
        { name: 'User', mes: 'question', is_user: true },
    ];
    const result = buildChat2(coreChat, ctxParams({ isInstruct: true, isImpersonate: true }));
    assert.doesNotMatch(result.chat2[0], /<\|user_last\|>/);
    assert.match(result.chat2[0], /<\|user\|>/);
});

test('buildChat2: continuation truncation - non-instruct mode does lastIndexOf on raw text', () => {
    const coreChat = [
        { name: 'Char', mes: 'partial output text', is_user: false },
    ];
    const result = buildChat2(coreChat, ctxParams({ isContinue: true, isInstruct: false }));
    assert.equal(result.chat2[0], 'Char: partial output text');
    assert.equal(result.continueMag, 'partial output text');
});

test('buildChat2: continuation truncation - instruct mode uses FORMAT_TOKEN sentinel', () => {
    const coreChat = [
        { name: 'User', mes: 'to be continued', is_user: true },
    ];
    const result = buildChat2(coreChat, ctxParams({ isContinue: true, isInstruct: true }));

    const expectedFull = '<|user_last|>\nto be continued\n';
    assert.equal(result.chat2[0] + '\n', expectedFull);
    assert.equal(result.continueMag, 'to be continued');
});

test('buildChat2: userMessageIndices correctness across mixed users', () => {
    const coreChat = [
        { name: 'User', mes: 'u1', is_user: true },
        { name: 'Char', mes: 'c1', is_user: false },
        { name: 'User', mes: 'u2', is_user: true },
        { name: 'Char', mes: 'c2', is_user: false },
    ];
    const result = buildChat2(coreChat, ctxParams());
    assert.deepEqual(result.userMessageIndices.sort((a, b) => a - b), [1, 3]);
});

test('buildChat2: userAlignmentMessage construction when enabled', () => {
    const coreChat = [{ name: 'Char', mes: 'hi', is_user: false }];
    const result = buildChat2(coreChat, ctxParams({
        isInstruct: true,
        instructUserAlignmentMessage: 'Alignment for {{user}}',
    }));
    assert.equal(result.addUserAlignment, true);
    assert.match(result.userAlignmentMessage, /Alignment for \n/);
    assert.doesNotMatch(result.userAlignmentMessage, /Alignment for User/);
});

test('buildChat2: userAlignmentMessage not built when disabled or non-instruct', () => {
    const coreChat = [{ name: 'Char', mes: 'hi', is_user: false }];
    const result1 = buildChat2(coreChat, ctxParams({ isInstruct: false, instructUserAlignmentMessage: 'x' }));
    assert.equal(result1.addUserAlignment, false);
    assert.equal(result1.userAlignmentMessage, '');

    const result2 = buildChat2(coreChat, ctxParams({ isInstruct: true, instructUserAlignmentMessage: '' }));
    assert.equal(result2.addUserAlignment, false);
});

test('buildChat2: chat2.length===0 pushes an empty string (regenerate-first-message hack)', () => {
    const result = buildChat2([], ctxParams());
    assert.deepEqual(result.chat2, ['']);
});

test('shiftCyclePromptOffFront: shifts only when isContinue && chat2.length > 1', () => {
    const noShift = shiftCyclePromptOffFront(['a', 'b'], [0], [1], false);
    assert.deepEqual(noShift.chat2, ['a', 'b']);
    assert.equal(noShift.cyclePrompt, '');

    const noShiftSingle = shiftCyclePromptOffFront(['a'], [0], [0], true);
    assert.deepEqual(noShiftSingle.chat2, ['a']);
    assert.equal(noShiftSingle.cyclePrompt, '');

    const shifted = shiftCyclePromptOffFront(['a', 'b', 'c'], [1, 2], [2], true);
    assert.deepEqual(shifted.chat2, ['b', 'c']);
    assert.equal(shifted.cyclePrompt, 'a');
    assert.deepEqual(shifted.injectedIndices, [0, 1]);
    assert.deepEqual(shifted.userMessageIndices, [1]);
});

test('fillContextBudget: injected messages get priority and fill first', async () => {
    const chat2 = ['aaaa', 'bbbb', 'cccc'];
    const result = await fillContextBudget({
        chat2,
        injectedIndices: [2],
        userMessageIndices: [],
        thisMaxContext: 1000,
        baselineTokenCount: 0,
        countTokens,
        userAlignmentMessage: '',
        addUserAlignment: false,
        isContinue: false,
    });
    assert.deepEqual(result.arrMes, ['aaaa', 'bbbb', 'cccc']);
    assert.deepEqual(result.injectedIndices, [2]);
});

test('fillContextBudget: a message that does not fit stops the whole pass (stop, not skip)', async () => {
    const chat2 = ['aaaa', 'b', 'c'];
    const result = await fillContextBudget({
        chat2,
        injectedIndices: [],
        userMessageIndices: [],
        thisMaxContext: 5,
        baselineTokenCount: 0,
        countTokens,
        userAlignmentMessage: '',
        addUserAlignment: false,
        isContinue: false,
    });
    assert.deepEqual(result.arrMes, ['aaaa']);
});

test('fillContextBudget: unsparsify/reindex compacts arrMes and remaps injectedIndices', async () => {
    const chat2 = ['aa', 'BIGBIGBIG', 'cc'];
    const result = await fillContextBudget({
        chat2,
        injectedIndices: [2],
        userMessageIndices: [],
        thisMaxContext: 10,
        baselineTokenCount: 0,
        countTokens,
        userAlignmentMessage: '',
        addUserAlignment: false,
        isContinue: false,
    });
    assert.deepEqual(result.arrMes, ['aa', 'cc']);
    assert.deepEqual(result.injectedIndices, [1]);
});

test('fillContextBudget: user-alignment appended when fill did not stop at a user message', async () => {
    const chat2 = ['aa', 'bb'];
    const result = await fillContextBudget({
        chat2,
        injectedIndices: [],
        userMessageIndices: [],
        thisMaxContext: 100,
        baselineTokenCount: 0,
        countTokens,
        userAlignmentMessage: 'ALIGN',
        addUserAlignment: true,
        isContinue: false,
    });
    assert.deepEqual(result.arrMes, ['aa', 'bb', 'ALIGN']);
    assert.deepEqual(result.injectedIndices, [2]);
});

test('fillContextBudget: user-alignment NOT appended when stopped at a user message', async () => {
    const chat2 = ['aa', 'bb'];
    const result = await fillContextBudget({
        chat2,
        injectedIndices: [],
        userMessageIndices: [1],
        thisMaxContext: 100,
        baselineTokenCount: 0,
        countTokens,
        userAlignmentMessage: 'ALIGN',
        addUserAlignment: true,
        isContinue: false,
    });
    assert.deepEqual(result.arrMes, ['aa', 'bb']);
    assert.deepEqual(result.injectedIndices, []);
});

test('fillContextBudget: integrates the isContinue shift-off-front step', async () => {
    const chat2 = ['cycle', 'aa', 'bb'];
    const result = await fillContextBudget({
        chat2,
        injectedIndices: [1, 2],
        userMessageIndices: [2],
        thisMaxContext: 100,
        baselineTokenCount: 0,
        countTokens,
        userAlignmentMessage: '',
        addUserAlignment: false,
        isContinue: true,
    });
    assert.equal(result.cyclePrompt, 'cycle');
    assert.deepEqual(result.arrMes, ['aa', 'bb']);
});

test('estimateExampleBudget: normal accumulation stopping at budget', async () => {
    const mesExamplesArray = ['aaaa', 'bbbb', 'cccc'];
    const result = await estimateExampleBudget({
        mesExamplesArray,
        thisMaxContext: 9,
        baselineTokenCount: 0,
        countTokens,
        pinExamples: false,
    });
    assert.equal(result.count_exm_add, 2);
});

test('estimateExampleBudget: pinExamples short-circuits to 0 without iterating', async () => {
    let calls = 0;
    const countingTokens = async (text) => { calls++; return text.length; };
    const result = await estimateExampleBudget({
        mesExamplesArray: ['a', 'b', 'c'],
        thisMaxContext: 1000,
        baselineTokenCount: 0,
        countTokens: countingTokens,
        pinExamples: true,
    });
    assert.equal(result.count_exm_add, 0);
    assert.equal(calls, 0);
});

test('buildMesSend: non-instruct always strips trailing newline unless continuing', () => {
    const arrMes = ['first\n', 'second\n'];
    const result = buildMesSend({ arrMes, cyclePrompt: '', type: 'normal', isInstruct: false, instructWrap: false });
    assert.deepEqual(result.mesSend, [
        { message: 'second\n', extensionPrompts: [] },
        { message: 'first', extensionPrompts: [] },
    ]);
});

test('buildMesSend: instruct + wrap + non-quiet strips trailing newline', () => {
    const arrMes = ['first\n', 'second\n'];
    const result = buildMesSend({ arrMes, cyclePrompt: '', type: 'normal', isInstruct: true, instructWrap: true });
    assert.deepEqual(result.mesSend, [
        { message: 'second\n', extensionPrompts: [] },
        { message: 'first', extensionPrompts: [] },
    ]);
});

test('buildMesSend: instruct + no wrap does NOT strip trailing newline', () => {
    const arrMes = ['first\n', 'second\n'];
    const result = buildMesSend({ arrMes, cyclePrompt: '', type: 'normal', isInstruct: true, instructWrap: false });
    assert.deepEqual(result.mesSend, [
        { message: 'second\n', extensionPrompts: [] },
        { message: 'first\n', extensionPrompts: [] },
    ]);
});

test('buildMesSend: instruct + wrap but type=quiet does NOT strip', () => {
    const arrMes = ['first\n', 'second\n'];
    const result = buildMesSend({ arrMes, cyclePrompt: '', type: 'quiet', isInstruct: true, instructWrap: true });
    assert.deepEqual(result.mesSend, [
        { message: 'second\n', extensionPrompts: [] },
        { message: 'first\n', extensionPrompts: [] },
    ]);
});

test('buildMesSend: type=continue never strips (condition requires type !== continue)', () => {
    const arrMes = ['first\n', 'second\n'];
    const result = buildMesSend({ arrMes, cyclePrompt: '', type: 'continue', isInstruct: false, instructWrap: false });
    assert.deepEqual(result.mesSend, [
        { message: 'second\n', extensionPrompts: [] },
        { message: 'first\n', extensionPrompts: [] },
    ]);
});

test('buildMesSend: cached-prompt short-circuit leaves mesSend empty', () => {
    const arrMes = ['first\n', 'second\n'];
    const result = buildMesSend({ arrMes, cyclePrompt: 'cached prompt text', type: 'normal', isInstruct: false, instructWrap: false });
    assert.equal(result.generatedPromptCache, 'cached prompt text');
    assert.deepEqual(result.mesSend, []);
});

test('buildMesSend: cyclePrompt set but type=continue still builds mesSend (cache branch requires type!==continue too)', () => {
    const arrMes = ['first\n'];
    const result = buildMesSend({ arrMes, cyclePrompt: 'cached prompt text', type: 'continue', isInstruct: false, instructWrap: false });
    assert.equal(result.generatedPromptCache, 'cached prompt text');
    assert.deepEqual(result.mesSend, [{ message: 'first\n', extensionPrompts: [] }]);
});
