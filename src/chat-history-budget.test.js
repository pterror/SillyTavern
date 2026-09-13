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

// Deterministic fake token counter: token count == character length.
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

// ---------------------------------------------------------------------------
// injectJailbreak
// ---------------------------------------------------------------------------

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
    assert.deepEqual(result.injectedIndices, [1]); // shifted up by one
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
    // spliced at coreChat.length - 1 (before last element) of the ORIGINAL length (2), i.e. index 1
    assert.deepEqual(result.coreChat[1], { mes: 'post history text', is_user: true });
    assert.deepEqual(result.coreChat[2], { mes: 'b', is_user: false });
    assert.deepEqual(result.injectedIndices, [0]); // unchanged
});

test('injectJailbreak: no-op when resolved jailbreak is empty', () => {
    const coreChat = [{ mes: 'a', is_user: true }];
    const result = injectJailbreak(coreChat, [0], {
        mainApi: 'textgenerationwebui',
        sysPromptEnabled: true,
        jailbreak: '',
        preferCharacterJailbreak: false,
        sysPromptPostHistory: '', // baseChatReplace('') -> ''
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
    assert.equal(result.jailbreak, 'JB'); // passed through unresolved
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
    // Matches the client exactly: `baseChatReplace(power_user.sysprompt.post_history)` is called
    // with NO name1/name2 args on this branch (unlike the substituteParams branch above), so
    // {{char}}/{{user}} macros in sysPromptPostHistory do NOT get substituted here - even though a
    // macroContext is supplied, this path ignores it, same as the client ignores its ambient
    // name1/name2 for this specific call site.
    const coreChat = [{ mes: 'a', is_user: true }];
    const result = injectJailbreak(coreChat, [], {
        mainApi: 'textgenerationwebui',
        sysPromptEnabled: true,
        jailbreak: 'JB says {{original}}!', // ignored - not used on this path
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
        jailbreak: '', // falsy -> ternary condition false even though preferCharacterJailbreak is true
        preferCharacterJailbreak: true,
        sysPromptPostHistory: 'fallback text',
        isContinue: false,
    });
    assert.equal(result.jailbreak, 'fallback text');
});

// ---------------------------------------------------------------------------
// buildChat2
// ---------------------------------------------------------------------------

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

    // j=0 -> coreChat[0] ('first') goes to chat2[2]
    // j=1 -> coreChat[1] ('second') goes to chat2[1]
    // j=2 -> coreChat[2] ('third') goes to chat2[0]
    assert.equal(result.chat2.length, 3);
    assert.match(result.chat2[2], /first/);
    assert.match(result.chat2[1], /second/);
    assert.match(result.chat2[0], /third/);
    assert.deepEqual(result.userMessageIndices.sort(), [0, 2]); // 'first' at i=2, 'third' at i=0
});

test('buildChat2: FIRST message gets force_output_sequence.FIRST reformatting in instruct mode', () => {
    // Two USER messages so the first message (j=0) and the last-user-message index don't coincide
    // - otherwise the LAST reformat would run afterward and overwrite the FIRST reformat, which
    // would still be "correct" per the algorithm's ordering but wouldn't isolate what this test is
    // meant to verify.
    const coreChat = [
        { name: 'User', mes: 'first', is_user: true },
        { name: 'Char', mes: 'middle', is_user: false },
        { name: 'User', mes: 'last', is_user: true },
    ];
    const result = buildChat2(coreChat, ctxParams({ isInstruct: true }));
    // j=0 is coreChat[0] ('first'), placed at i = coreChat.length-1 = 2
    // first_input_sequence is '' so it falls back to input_sequence '<|user|>'
    assert.match(result.chat2[2], /<\|user\|>/);
    assert.doesNotMatch(result.chat2[2], /<\|user_last\|>/);
});

test('buildChat2: LAST user message gets force_output_sequence.LAST reformatting in instruct mode (non-impersonate)', () => {
    const coreChat = [
        { name: 'Char', mes: 'greeting', is_user: false },
        { name: 'User', mes: 'question', is_user: true },
    ];
    const result = buildChat2(coreChat, ctxParams({ isInstruct: true }));
    // lastUserMessageIndex (in coreChat) = 1, so j===1 triggers LAST reformat.
    // j=1 -> coreChat[1] placed at i = coreChat.length-1-1 = 0
    assert.match(result.chat2[0], /<\|user_last\|>/);
});

test('buildChat2: LAST-user reformatting is skipped when isImpersonate is true', () => {
    const coreChat = [
        { name: 'Char', mes: 'greeting', is_user: false },
        { name: 'User', mes: 'question', is_user: true },
    ];
    const result = buildChat2(coreChat, ctxParams({ isInstruct: true, isImpersonate: true }));
    assert.doesNotMatch(result.chat2[0], /<\|user_last\|>/);
    // Should fall back to plain input_sequence instead
    assert.match(result.chat2[0], /<\|user\|>/);
});

test('buildChat2: continuation truncation - non-instruct mode does lastIndexOf on raw text', () => {
    const coreChat = [
        { name: 'Char', mes: 'partial output text', is_user: false },
    ];
    const result = buildChat2(coreChat, ctxParams({ isContinue: true, isInstruct: false }));
    // formatMessageHistoryItem (non-instruct) produces "Char: partial output text\n"
    // truncation does lastIndexOf(coreChat[j].mes) + mes.length -> cuts off the trailing "\n"
    assert.equal(result.chat2[0], 'Char: partial output text');
    assert.equal(result.continueMag, 'partial output text');
});

test('buildChat2: continuation truncation - instruct mode uses FORMAT_TOKEN sentinel', () => {
    const coreChat = [
        { name: 'User', mes: 'to be continued', is_user: true },
    ];
    // Single-message chat: j=0 triggers FIRST reformat, then i===0 && isContinue triggers the
    // continuation branch which re-reformats with LAST via the sentinel technique.
    const result = buildChat2(coreChat, ctxParams({ isContinue: true, isInstruct: true }));

    // Expected LAST-formatted text: instruct.wrap=true, so with input_suffix '' -> suffix defaults to '\n'
    // textArray = [prefix, mes + suffix] joined by '\n' (wrap separator).
    // prefix = last_input_sequence = '<|user_last|>'
    const expectedFull = '<|user_last|>\nto be continued\n';
    assert.equal(result.chat2[0] + '\n', expectedFull); // truncated text is expectedFull minus trailing suffix content added after sentinel
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
    // j=0(u1)->i=3, j=1(c1)->i=2, j=2(u2)->i=1, j=3(c2)->i=0
    assert.deepEqual(result.userMessageIndices.sort((a, b) => a - b), [1, 3]);
});

test('buildChat2: userAlignmentMessage construction when enabled', () => {
    // Matches the client exactly: `substituteParams(power_user.instruct.user_alignment_message)`
    // is called with NO name1/name2/macroContext at this call site, so {{user}}/{{char}} in the
    // template do NOT get substituted here (same no-context-passed pattern as the jailbreak's
    // baseChatReplace call above). What DOES get formatted in is the message's own `name` field
    // (name1), via formatMessageHistoryItem's own name-prefixing logic.
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

// ---------------------------------------------------------------------------
// fillContextBudget (includes shiftCyclePromptOffFront)
// ---------------------------------------------------------------------------

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
    assert.deepEqual(shifted.injectedIndices, [0, 1]); // shifted down by one
    assert.deepEqual(shifted.userMessageIndices, [1]);
});

test('fillContextBudget: injected messages get priority and fill first', async () => {
    // chat2[2] is injected; without priority it would be visited last in pass 2.
    const chat2 = ['aaaa', 'bbbb', 'cccc']; // lengths 4 each
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
    // All fit (max context large); arrMes preserves original chat2 order after unsparsify
    assert.deepEqual(result.arrMes, ['aaaa', 'bbbb', 'cccc']);
    assert.deepEqual(result.injectedIndices, [2]); // index 2 unchanged since nothing dropped
});

test('fillContextBudget: a message that does not fit stops the whole pass (stop, not skip)', async () => {
    // baseline 0, max context 5. chat2[0] len 4 fits (tokenCount=4<5). chat2[1] len 1 -> tokenCount=5, NOT <5 -> break.
    // chat2[2] len 1 would fit on its own but must NOT be added because pass stops entirely.
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
    assert.deepEqual(result.arrMes, ['aaaa']); // 'c' skipped even though it would fit
});

test('fillContextBudget: unsparsify/reindex compacts arrMes and remaps injectedIndices', async () => {
    // chat2 has 3 items; only index 0 and 2 fit (index 1 never added because pass 1's injected
    // index 2 fits, pass 2 fills index 0, but index 1 is too big and stops pass 2 - here we force
    // that shape directly).
    const chat2 = ['aa', 'BIGBIGBIG', 'cc']; // index1 huge, won't fit
    const result = await fillContextBudget({
        chat2,
        injectedIndices: [2], // gets priority, fills first
        userMessageIndices: [],
        thisMaxContext: 10,
        baselineTokenCount: 0,
        countTokens,
        userAlignmentMessage: '',
        addUserAlignment: false,
        isContinue: false,
    });
    // Pass1: index2 'cc' len2 -> tokenCount=2<10 -> arrMes[2]='cc', lastAddedIndex=2
    // Pass2: i=0 'aa' len2 -> tokenCount=4<10 -> arrMes[0]='aa'; i=1 'BIGBIGBIG' len9 -> tokenCount=13 not<10 -> break
    // arrMes = [ 'aa', <empty>, 'cc' ] -> unsparsify -> ['aa','cc'], injectedIndices old=[2] -> new position of old index2 is 1
    assert.deepEqual(result.arrMes, ['aa', 'cc']);
    assert.deepEqual(result.injectedIndices, [1]);
});

test('fillContextBudget: user-alignment appended when fill did not stop at a user message', async () => {
    const chat2 = ['aa', 'bb']; // neither is a user message (userMessageIndices empty)
    const result = await fillContextBudget({
        chat2,
        injectedIndices: [],
        userMessageIndices: [], // stoppedAtUser will be false since lastAddedIndex (1) not in []
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
        userMessageIndices: [1], // lastAddedIndex will be 1, which IS a user message index
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

// ---------------------------------------------------------------------------
// estimateExampleBudget
// ---------------------------------------------------------------------------

test('estimateExampleBudget: normal accumulation stopping at budget', async () => {
    const mesExamplesArray = ['aaaa', 'bbbb', 'cccc']; // len 4 each
    const result = await estimateExampleBudget({
        mesExamplesArray,
        thisMaxContext: 9, // after first: 4<9 count=1; after second: 8<9 count=2; after third: 12 not<9 -> break
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

// ---------------------------------------------------------------------------
// buildMesSend
// ---------------------------------------------------------------------------

test('buildMesSend: non-instruct always strips trailing newline unless continuing', () => {
    const arrMes = ['first\n', 'second\n'];
    const result = buildMesSend({ arrMes, cyclePrompt: '', type: 'normal', isInstruct: false, instructWrap: false });
    // reversed: ['second\n', 'first\n']; last element (index 1, 'first\n') gets stripped
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
