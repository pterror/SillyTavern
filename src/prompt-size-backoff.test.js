import assert from 'node:assert';
import { addChatsPreamble, addChatsSeparator, resolvePromptStrings } from './prompt-size-backoff.js';

// Simple deterministic fake token counter: token count = string length.
const countTokens = async (text) => text.length;

const baseModifyParams = {
    quiet_prompt: '',
    name1: 'User',
    name2: 'Char',
    isInstruct: false,
    quietToLoud: false,
    type: undefined,
    quietName: undefined,
    isImpersonate: false,
    promptBias: '',
    chat: [{ is_user: false }, { is_user: false }],
    force_name2: false,
    isContinue: false,
    isGroup: false,
    instructPreset: {},
};

function mesEntry(message) {
    return { message, extensionPrompts: [] };
}

// ---- addChatsPreamble ----

{
    const result = addChatsPreamble('hello', { mainApi: 'novel', naiPreamble: 'PREAMBLE', macroContext: {} });
    assert.strictEqual(result, 'PREAMBLE\nhello', 'novel API prepends substituted preamble + newline');
}

{
    const result = addChatsPreamble('hello', { mainApi: 'novel', naiPreamble: '', macroContext: {} });
    assert.strictEqual(result, '\nhello', 'novel API with empty preamble still prepends just the newline');
}

{
    const result = addChatsPreamble('hello', { mainApi: 'kobold', naiPreamble: 'PREAMBLE', macroContext: {} });
    assert.strictEqual(result, 'hello', 'non-novel API passes through unchanged regardless of naiPreamble');
}

{
    const result = addChatsPreamble('hello', { mainApi: 'textgenerationwebui', naiPreamble: '', macroContext: {} });
    assert.strictEqual(result, 'hello', 'non-novel API passes through unchanged with empty naiPreamble');
}

// ---- addChatsSeparator ----

{
    const result = addChatsSeparator('hello', { chatStart: '***', macroContext: {} });
    assert.strictEqual(result, '***\nhello', 'set chatStart prepends substituted chatStart + newline');
}

{
    const result = addChatsSeparator('hello', { chatStart: '', macroContext: {} });
    assert.strictEqual(result, 'hello', 'empty chatStart passes through unchanged');
}

{
    const result = addChatsSeparator('hello', { chatStart: undefined, macroContext: {} });
    assert.strictEqual(result, 'hello', 'unset chatStart passes through unchanged');
}

// ---- resolvePromptStrings: no-backoff-needed case ----

{
    const mesSend = [mesEntry('Alice: hi\n'), mesEntry('Bob: yo\n')];
    const result = await resolvePromptStrings({
        mesSend,
        mesExamplesArray: ['ex1', 'ex2', 'ex3'],
        countExmAdd: 2,
        pinExmString: undefined,
        combinedStoryString: 'STORY',
        generatedPromptCache: '', // empty -> setPromptString-equivalent only, no recursion
        thisMaxContext: 1, // deliberately tiny - must be irrelevant since no size check runs
        countTokens,
        mainApi: 'kobold',
        naiPreamble: '',
        chatStart: '',
        macroContext: {},
        modifyLastPromptLineParams: baseModifyParams,
    });

    assert.strictEqual(result.countExmAdd, 2, 'countExmAdd untouched when generatedPromptCache is empty');
    assert.strictEqual(result.mesExmString, 'ex1ex2', 'mesExmString computed from mesExamplesArray.slice(0, countExmAdd)');
    assert.strictEqual(result.mesSend.length, 2, 'mesSend not trimmed when generatedPromptCache is empty');
    // Last entry gets modifyLastPromptLine('') applied even in the no-backoff path (force_name2 false -> passthrough here)
    assert.strictEqual(result.mesSend[1].message, 'Bob: yo\n', 'last mesSend entry passed through modifyLastPromptLine');
    // Caller's original array must not be mutated.
    assert.strictEqual(mesSend[1].message, 'Bob: yo\n', 'caller mesSend array left untouched');
}

// ---- resolvePromptStrings: backoff case - count_exm_add decremented first, then mesSend shifted ----

{
    // Construct sizes such that: with countExmAdd=3 and full mesSend, prompt too big;
    // decrementing countExmAdd (each example is 1 char: 'a','b','c') should eventually not be enough,
    // and then mesSend must be shifted from the front.
    const mesSend = [mesEntry('1111111111'), mesEntry('2222222222'), mesEntry('3333333333')];
    const mesExamplesArray = ['a', 'b', 'c'];

    const result = await resolvePromptStrings({
        mesSend,
        mesExamplesArray,
        countExmAdd: 3,
        pinExmString: undefined,
        combinedStoryString: '',
        generatedPromptCache: 'CACHE', // non-empty -> triggers checkPromptSize backoff
        thisMaxContext: 15,
        countTokens,
        mainApi: 'kobold',
        naiPreamble: '',
        chatStart: '',
        macroContext: {},
        modifyLastPromptLineParams: baseModifyParams,
    });

    // countExmAdd must have been driven down to 0 before any mesSend shifting could help further,
    // and mesSend must have shrunk (oldest/front entries removed).
    assert.strictEqual(result.countExmAdd, 0, 'countExmAdd is decremented to 0 during backoff');
    assert.ok(result.mesSend.length < 3, 'mesSend was shifted (shrunk) after countExmAdd hit 0');
    // Shifting removes from the FRONT (oldest) - so whatever remains must be a suffix of the original.
    const remainingMessages = result.mesSend.map(e => e.message);
    const originalMessages = ['1111111111', '2222222222', '3333333333'];
    assert.deepStrictEqual(
        remainingMessages,
        originalMessages.slice(originalMessages.length - remainingMessages.length),
        'remaining mesSend entries are a suffix (oldest/front entries were shifted off)',
    );
}

// ---- resolvePromptStrings: terminal case - both exhausted, stops without erroring ----

{
    const mesSend = [mesEntry('X')];
    const result = await resolvePromptStrings({
        mesSend,
        mesExamplesArray: ['a'],
        countExmAdd: 0, // already 0
        pinExmString: undefined,
        combinedStoryString: 'S'.repeat(1000), // guarantee it stays over budget forever
        generatedPromptCache: 'CACHE',
        thisMaxContext: 1, // impossible to satisfy
        countTokens,
        mainApi: 'kobold',
        naiPreamble: '',
        chatStart: '',
        macroContext: {},
        modifyLastPromptLineParams: baseModifyParams,
    });

    assert.strictEqual(result.countExmAdd, 0, 'countExmAdd stays 0 in terminal case');
    assert.strictEqual(result.mesSend.length, 0, 'mesSend fully shifted out in terminal case');
    // Must resolve without throwing/hanging - reaching here is the assertion.
}

// ---- resolvePromptStrings: modifyLastPromptLine applied to last mesSend entry on EVERY recursive pass ----

{
    // force_name2 makes modifyLastPromptLine visibly append ":${name2}" to the last entry (when it
    // doesn't already end appropriately) - use this to confirm re-application happens each pass,
    // not just once, by checking that after several shifts, the (new) last entry still shows the
    // suffix, which could only happen if modifyLastPromptLine ran again on the new last entry.
    const forceNameParams = {
        ...baseModifyParams,
        force_name2: true,
        chat: [{ is_user: false }, { is_user: false }, { is_user: false }],
    };

    const mesSend = [mesEntry('AAAAAAAAAA'), mesEntry('BBBBBBBBBB'), mesEntry('CCCCCCCCCC')];
    const mesExamplesArray = [];

    const result = await resolvePromptStrings({
        mesSend,
        mesExamplesArray,
        countExmAdd: 0,
        pinExmString: undefined,
        combinedStoryString: '',
        generatedPromptCache: 'CACHE',
        thisMaxContext: 46, // forces exactly one shift, then stops with entries still remaining
        countTokens,
        mainApi: 'kobold',
        naiPreamble: '',
        chatStart: '',
        macroContext: {},
        modifyLastPromptLineParams: forceNameParams,
    });

    assert.ok(result.mesSend.length >= 1, 'at least one entry remains to inspect');
    const lastMessage = result.mesSend[result.mesSend.length - 1].message;
    assert.ok(lastMessage.endsWith('Char:'), 'modifyLastPromptLine (force_name2) re-applied to the new last entry after shifting');
    // Sanity: it should NOT still be the raw, un-suffixed original text.
    assert.ok(!/^[A-Z]{10}$/.test(lastMessage), 'last entry text is not the raw unmodified original');
}

// ---- resolvePromptStrings: pinExmString used verbatim instead of slicing mesExamplesArray ----

{
    const mesSend = [mesEntry('hi')];
    const result = await resolvePromptStrings({
        mesSend,
        mesExamplesArray: ['should', 'not', 'be', 'used'],
        countExmAdd: 2,
        pinExmString: 'PINNED_EXAMPLES',
        combinedStoryString: 'STORY',
        generatedPromptCache: '',
        thisMaxContext: 1,
        countTokens,
        mainApi: 'kobold',
        naiPreamble: '',
        chatStart: '',
        macroContext: {},
        modifyLastPromptLineParams: baseModifyParams,
    });

    assert.strictEqual(result.mesExmString, 'PINNED_EXAMPLES', 'pinExmString used verbatim when set');
}

{
    // Also verify pinExmString survives (verbatim) through the backoff loop's countExmAdd decrements.
    const mesSend = [mesEntry('1111111111'), mesEntry('2222222222')];
    const result = await resolvePromptStrings({
        mesSend,
        mesExamplesArray: ['should', 'not', 'be', 'used'],
        countExmAdd: 2,
        pinExmString: 'PINNED',
        combinedStoryString: '',
        generatedPromptCache: 'CACHE',
        thisMaxContext: 5, // forces backoff
        countTokens,
        mainApi: 'kobold',
        naiPreamble: '',
        chatStart: '',
        macroContext: {},
        modifyLastPromptLineParams: baseModifyParams,
    });

    assert.strictEqual(result.mesExmString, 'PINNED', 'pinExmString stays verbatim through backoff recursion');
}

console.log('All prompt-size-backoff tests passed.');
