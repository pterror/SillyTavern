import assert from 'node:assert';
import { test } from 'node:test';

// JUDGMENT CALL: same as chat-completion-budget.test.js - Jimp's WASM codecs need this patch
// installed before any encode/decode happens, and this standalone test file has no other entry
// point that installs it.
import './fetch-patch.js';
import { Jimp, JimpMime } from './jimp.js';

import { TokenHandler, ChatCompletion } from './chat-completion-budget.js';
import { PromptCollection, Prompt } from './chat-completion-prompt-collection.js';
import {
    populateChatHistory,
    isValidChatCompletionName,
    sanitizeChatCompletionName,
    TOOL_REASONING_MODES,
} from './chat-completion-history.js';
import { character_names_behavior } from './chat-completion-messages.js';

/** Simple deterministic fake tokenizer: token count = length of the JSON-stringified message(s). */
const fakeCountTokenAsyncFn = async (messages) => JSON.stringify(messages).length;

/** Builds a real JPEG data URL (mirrors chat-completion-budget.test.js's own helper) - used as a
 *  small valid image fixture for media-inlining tests, avoiding any real network fetch or missing
 *  test fixture file. */
async function makeJpegDataUrl(width, height) {
    const image = new Jimp({ width, height, color: 0xffffffff });
    const buffer = await image.getBuffer(JimpMime.jpeg, { quality: 90, jpegColorSpace: 'ycbcr' });
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

/**
 * @param {number} [budget]
 * @returns {{chatCompletion: ChatCompletion, tokenHandler: TokenHandler}}
 */
function makeChatCompletion(budget = 1_000_000) {
    const tokenHandler = new TokenHandler(fakeCountTokenAsyncFn);
    const chatCompletion = new ChatCompletion(tokenHandler);
    chatCompletion.setTokenBudget(budget, 0);
    return { chatCompletion, tokenHandler };
}

/** @param {string[]} identifiers Extra identifiers, added in order, before 'chatHistory'. */
function makePrompts(identifiers = []) {
    const prompts = new PromptCollection();
    for (const identifier of identifiers) {
        prompts.add(new Prompt({ identifier, role: 'system', content: '' }));
    }
    prompts.add(new Prompt({ identifier: 'chatHistory', role: 'system', content: '' }));
    return prompts;
}

function historyMessages(chatCompletion) {
    return chatCompletion.getMessages().getItemByIdentifier('chatHistory').getCollection();
}

// ---------------------------------------------------------------------------
// isValidChatCompletionName / sanitizeChatCompletionName
// ---------------------------------------------------------------------------

test('isValidChatCompletionName: exact regex behavior', () => {
    assert.strictEqual(isValidChatCompletionName('Alice'), true);
    assert.strictEqual(isValidChatCompletionName('Alice_123'), true);
    assert.strictEqual(isValidChatCompletionName('a'.repeat(64)), true);
    assert.strictEqual(isValidChatCompletionName('a'.repeat(65)), false); // too long
    assert.strictEqual(isValidChatCompletionName(''), false); // too short (needs 1-64)
    assert.strictEqual(isValidChatCompletionName('Alice Bob'), false); // space
    assert.strictEqual(isValidChatCompletionName('Alice-Bob'), false); // hyphen
    assert.strictEqual(isValidChatCompletionName('Alice.Bob'), false); // dot
});

test('sanitizeChatCompletionName: replaces invalid chars, then truncates to 64', () => {
    assert.strictEqual(sanitizeChatCompletionName('Alice Bob'), 'Alice_Bob');
    assert.strictEqual(sanitizeChatCompletionName('a.b-c d'), 'a_b_c_d');
    assert.strictEqual(sanitizeChatCompletionName('Alice_123'), 'Alice_123'); // already valid, unchanged
    const long = 'x'.repeat(70) + '!!!!!';
    const sanitized = sanitizeChatCompletionName(long);
    assert.strictEqual(sanitized.length, 64);
    assert.strictEqual(sanitized, 'x'.repeat(64)); // truncation happens after replacement
});

// ---------------------------------------------------------------------------
// !prompts.has('chatHistory') no-op
// ---------------------------------------------------------------------------

test('no-op when prompts does not have chatHistory slot', async () => {
    const prompts = new PromptCollection(); // no 'chatHistory'
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [{ role: 'user', content: 'Hi' }];

    await populateChatHistory(messages, prompts, chatCompletion, { tokenHandler });

    assert.strictEqual(chatCompletion.has('chatHistory'), false);
    assert.deepStrictEqual(chatCompletion.getChat(), []);
});

// ---------------------------------------------------------------------------
// Basic chronological insertion + chatHistory-N identifiers
// ---------------------------------------------------------------------------

test('basic history insertion: chronological order, chatHistory-N identifiers', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'How are you' },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        tokenHandler,
    });

    const history = historyMessages(chatCompletion);
    // newChatMessage first, then the 3 turns in chronological order.
    assert.deepStrictEqual(history.map(m => m.identifier), ['newMainChat', 'chatHistory-1', 'chatHistory-2', 'chatHistory-3']);
    assert.deepStrictEqual(history.map(m => m.content), ['[New Chat]', 'Hi', 'Hello', 'How are you']);

    const chat = chatCompletion.getChat();
    assert.deepStrictEqual(chat.map(m => m.content), ['[New Chat]', 'Hi', 'Hello', 'How are you']);
});

// ---------------------------------------------------------------------------
// Group nudge reservation/insertion
// ---------------------------------------------------------------------------

test('group nudge is inserted at end of chatHistory when isGroup and groupNudge prompt exists', async () => {
    const prompts = makePrompts(['groupNudge']);
    prompts.set(new Prompt({ identifier: 'groupNudge', role: 'system', content: 'Nudge!' }), prompts.index('groupNudge'));
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [{ role: 'user', content: 'Hi' }];

    await populateChatHistory(messages, prompts, chatCompletion, {
        isGroup: true,
        newGroupChatPrompt: '[New Group Chat]',
        tokenHandler,
    });

    const history = historyMessages(chatCompletion);
    assert.strictEqual(history[history.length - 1].content, 'Nudge!');
});

test('group nudge is absent for type=impersonate even when isGroup', async () => {
    const prompts = makePrompts(['groupNudge']);
    prompts.set(new Prompt({ identifier: 'groupNudge', role: 'system', content: 'Nudge!' }), prompts.index('groupNudge'));
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [{ role: 'user', content: 'Hi' }];

    await populateChatHistory(messages, prompts, chatCompletion, {
        isGroup: true,
        type: 'impersonate',
        newGroupChatPrompt: '[New Group Chat]',
        tokenHandler,
    });

    const history = historyMessages(chatCompletion);
    assert.ok(!history.some(m => m.content === 'Nudge!'));
});

test('group nudge is absent when not isGroup', async () => {
    const prompts = makePrompts(['groupNudge']);
    prompts.set(new Prompt({ identifier: 'groupNudge', role: 'system', content: 'Nudge!' }), prompts.index('groupNudge'));
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [{ role: 'user', content: 'Hi' }];

    await populateChatHistory(messages, prompts, chatCompletion, {
        isGroup: false,
        newChatPrompt: '[New Chat]',
        tokenHandler,
    });

    const history = historyMessages(chatCompletion);
    assert.ok(!history.some(m => m.content === 'Nudge!'));
});

// ---------------------------------------------------------------------------
// Continue-nudge branch
// ---------------------------------------------------------------------------

test('continue branch: last non-injected message pulled out of chatHistory and re-inserted via continueNudge collection', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Partial answer' },
        { role: 'system', content: 'Injected note', injected: true }, // must be skipped by findLastIndex
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        type: 'continue',
        cyclePrompt: 'Partial answer',
        continuePrefill: false,
        continueNudgePrompt: 'Continue from: {{lastChatMessage}}',
        newChatPrompt: '[New Chat]',
        tokenHandler,
    });

    // The 'assistant' message was spliced OUT of `messages` (mutated in place).
    assert.strictEqual(messages.length, 2);
    assert.ok(!messages.some(m => m.content === 'Partial answer'));
    assert.deepStrictEqual(messages.map(m => m.content), ['Hi', 'Injected note']);

    // It's not present in the plain chatHistory collection either.
    const history = historyMessages(chatCompletion);
    assert.ok(!history.some(m => m.content === 'Partial answer'));

    // It (plus the continue-nudge message) is present in the continueNudge collection instead,
    // added at the end of chatCompletion's top-level collection (position -1 -> pushed).
    const topLevel = chatCompletion.getMessages().getCollection();
    const continueCollection = topLevel.find(c => c.identifier === 'continueNudge');
    assert.ok(continueCollection, 'continueNudge collection should exist');
    const continueItems = continueCollection.getCollection();
    assert.strictEqual(continueItems.length, 2);
    assert.strictEqual(continueItems[0].content, 'Partial answer');
    assert.strictEqual(continueItems[1].content, 'Continue from: Partial answer');
});

test('continue branch does not run when continuePrefill is true', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Partial answer' },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        type: 'continue',
        cyclePrompt: 'Partial answer',
        continuePrefill: true,
        continueNudgePrompt: 'Continue from: {{lastChatMessage}}',
        newChatPrompt: '[New Chat]',
        tokenHandler,
    });

    assert.strictEqual(messages.length, 2); // unchanged
    const topLevel = chatCompletion.getMessages().getCollection();
    assert.ok(!topLevel.some(c => c.identifier === 'continueNudge'));
});

// ---------------------------------------------------------------------------
// send_if_empty
// ---------------------------------------------------------------------------

test('send_if_empty inserts synthetic user message only when last chat message is assistant and affordable', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        sendIfEmpty: 'Continue.',
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    assert.ok(chat.some(m => m.role === 'user' && m.content === 'Continue.'));
});

test('send_if_empty does not insert when last chat message is a user message', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Hi' },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        sendIfEmpty: 'Continue.',
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    assert.ok(!chat.some(m => m.content === 'Continue.'));
});

// ---------------------------------------------------------------------------
// Budget-exhaustion break behavior (normal messages)
// ---------------------------------------------------------------------------

test('budget exhaustion stops the whole loop for normal messages (break, not skip)', async () => {
    const prompts = makePrompts();

    // Real per-message costs as produced by Message.createAsync({role, content}):
    const costOf = async (role, content) => fakeCountTokenAsyncFn({ role, content });
    const cNewChat = await costOf('system', '[New Chat]');
    const cMsg2 = await costOf('user', 'Second'); // chatHistory-2
    const cMsg3 = await costOf('user', 'Third'); // newest -> chatHistory-3, processed FIRST (chatPool reversed)

    // Budget: enough to reserve newChat + afford msg3, but NOT enough left over for msg2.
    const budget = cMsg3 + cMsg2 - 1; // strictly less than cMsg3 + cMsg2, but >= cMsg3 alone after newChat is freed
    const { chatCompletion, tokenHandler } = makeChatCompletion(budget + cNewChat);

    const messages = [
        { role: 'user', content: 'First' },
        { role: 'user', content: 'Second' },
        { role: 'user', content: 'Third' },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        tokenHandler,
    });

    const history = historyMessages(chatCompletion);
    const contents = history.map(m => m.content);
    // 'Third' (processed first, newest) fits; 'Second' does not -> loop breaks; 'First' (older, would
    // be processed next) must ALSO be absent even though it might individually be cheaper, proving
    // this is a `break`, not a `continue`/skip.
    assert.ok(contents.includes('Third'));
    assert.ok(!contents.includes('Second'));
    assert.ok(!contents.includes('First'));
});

// ---------------------------------------------------------------------------
// Tool-call branch
// ---------------------------------------------------------------------------

test('tool-call branch: toolCall + one tool-result message per invocation, in order', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    const messages = [
        { role: 'user', content: 'Do something' },
        {
            role: 'assistant',
            content: '',
            invocations: [
                { id: 'call_1', name: 'toolA', parameters: '{}', result: 'result A' },
                { id: 'call_2', name: 'toolB', parameters: '{}', result: 'result B' },
            ],
        },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        canUseTools: true,
        includeSignature: false,
        toolReasoningMode: TOOL_REASONING_MODES.DISABLED,
        includeToolReasoning: false,
        tokenHandler,
    });

    const history = historyMessages(chatCompletion);
    // Order: newMainChat, user 'Do something', toolCall message, tool result (call_1), tool result (call_2)
    const identifiers = history.map(m => m.identifier);
    assert.deepStrictEqual(identifiers, [
        'newMainChat',
        'chatHistory-1',
        'toolCall-chatHistory-2',
        'call_1',
        'call_2',
    ]);
    assert.strictEqual(history[3].role, 'tool');
    assert.strictEqual(history[3].content, 'result A');
    assert.strictEqual(history[4].role, 'tool');
    assert.strictEqual(history[4].content, 'result B');
    assert.ok(Array.isArray(history[2].tool_calls));
    assert.strictEqual(history[2].tool_calls.length, 2);
});

test('tool-call branch: budget exhaustion breaks the loop (not skip-and-continue)', async () => {
    const prompts = makePrompts();

    const messages = [
        { role: 'user', content: 'Older turn that should be excluded by the break' },
        {
            role: 'assistant',
            content: '',
            invocations: [{ id: 'call_1', name: 'toolA', parameters: '{}', result: 'result A' }],
        },
    ];

    // Budget too small to afford the tool-call reconstruction at all (0 remaining after newChat).
    const cNewChat = await fakeCountTokenAsyncFn({ role: 'system', content: '[New Chat]' });
    const { chatCompletion, tokenHandler } = makeChatCompletion(cNewChat); // exactly enough for newChat, nothing else

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        canUseTools: true,
        tokenHandler,
    });

    const history = historyMessages(chatCompletion);
    // Only newMainChat should be present; the tool-call reconstruction didn't fit, loop broke,
    // and the older plain 'user' turn (which comes later in the reversed pool) was never reached.
    assert.deepStrictEqual(history.map(m => m.identifier), ['newMainChat']);
});

// ---------------------------------------------------------------------------
// ACTIVE_CHAIN vs SINCE_LAST_USER reasoning-forwarding divergence
// ---------------------------------------------------------------------------

/**
 * Fixture where the two algorithms genuinely diverge:
 *   [0] user: "Question"
 *   [1] assistant text, reasoning: "" (empty)          <- nearest boundary for msg[3]'s tool call
 *   [2] assistant text, reasoning: "deep thought"        <- earlier text with non-empty reasoning
 *   [3] assistant tool-call turn (the one being reconstructed)
 *
 * ACTIVE_CHAIN walks back from [2], stops at the FIRST non-tool/non-tool-call-assistant message,
 * which is [2] itself (assistant text) -> takes its reasoning "deep thought" and stops immediately
 * (single boundary, not a search). Wait: the walk starts at promptIdx-1 = 2, so it immediately hits
 * [2] (assistant text, reasoning "deep thought") and takes it, having never seen [1] at all.
 * To make ACTIVE_CHAIN and SINCE_LAST_USER produce genuinely DIFFERENT results, the assistant text
 * message with non-empty reasoning must NOT be the immediate predecessor.
 */
test('ACTIVE_CHAIN vs SINCE_LAST_USER produce different previousAssistantReasoning from the same history', async () => {
    const prompts = makePrompts();

    // History (already-resolved chat turns):
    // [0] user "Question"
    // [1] assistant text, reasoning "first thought" (non-empty) - the nearest boundary
    // [2] assistant tool-call turn with its OWN invocations (so it's a "tool-call assistant" -
    //     ACTIVE_CHAIN skips over it because Array.isArray(candidate.invocations))
    // [3] tool result-ish placeholder not needed; ACTIVE_CHAIN skips role==='tool' too, but here we
    //     just need [1] to be reachable by ACTIVE_CHAIN (nearest boundary) while SINCE_LAST_USER
    //     would also reach [1] if it's the first with non-empty reasoning walking back - so instead
    //     put a *closer* assistant-text message with EMPTY reasoning right before the tool-call turn
    //     being reconstructed, and [1] (further back) with non-empty reasoning:
    const baseMessages = () => ([
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Earlier thinking out loud', reasoning: 'first thought' },
        { role: 'assistant', content: 'Closer thinking out loud', reasoning: '' },
        { role: 'assistant', content: '', invocations: [{ id: 'call_1', name: 'toolA', parameters: '{}', result: 'r' }] },
    ]);

    async function runWithMode(mode) {
        const { chatCompletion, tokenHandler } = makeChatCompletion();
        const messages = baseMessages();
        await populateChatHistory(messages, prompts, chatCompletion, {
            newChatPrompt: '[New Chat]',
            canUseTools: true,
            includeSignature: false,
            toolReasoningMode: mode,
            includeToolReasoning: true,
            tokenHandler,
        });
        const history = historyMessages(chatCompletion);
        const toolCallMsg = history.find(m => m.identifier?.startsWith('toolCall-'));
        return toolCallMsg?.reasoning ?? null;
    }

    const activeChainReasoning = await runWithMode(TOOL_REASONING_MODES.ACTIVE_CHAIN);
    const sinceLastUserReasoning = await runWithMode(TOOL_REASONING_MODES.SINCE_LAST_USER);

    // ACTIVE_CHAIN: walks back from idx=2 ("Closer thinking out loud"), which IS assistant text
    // (not tool, not invocations-bearing) -> takes ITS reasoning ('') and stops immediately.
    // Message.setToolCalls only sets a truthy reasoning through when includeReasoning && fallback
    // exists; here previousAssistantReasoning is '' (falsy), so no reasoning gets forwarded onto
    // the invocation, and the final toolCallMessage.reasoning falls back to whatever fallbackReasoning
    // setToolCalls computes from the invocations themselves (none had `.reasoning` to begin with).
    assert.strictEqual(activeChainReasoning, null);

    // SINCE_LAST_USER: walks back from idx=2 ("Closer thinking out loud", reasoning: '' -> skipped
    // since candidateReasoning is falsy, loop continues), then idx=1 ("Earlier thinking out loud",
    // reasoning: 'first thought' -> non-empty, taken). previousAssistantReasoning = 'first thought',
    // forwarded onto the invocation (which had no reasoning of its own), which setToolCalls then
    // surfaces as the message's fallback reasoning.
    assert.strictEqual(sinceLastUserReasoning, 'first thought');

    assert.notStrictEqual(activeChainReasoning, sinceLastUserReasoning);
});

// ---------------------------------------------------------------------------
// namesBehavior === COMPLETION triggers setName with sanitization
// ---------------------------------------------------------------------------

test('namesBehavior COMPLETION calls setName, sanitizing invalid names', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [
        { role: 'user', content: 'Hi', name: 'Bad Name!' },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        namesBehavior: character_names_behavior.COMPLETION,
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    const turn = chat.find(m => m.content === 'Hi');
    assert.strictEqual(turn.name, 'Bad_Name_');
});

test('namesBehavior COMPLETION leaves a valid name untouched', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [
        { role: 'user', content: 'Hi', name: 'Valid_Name' },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        namesBehavior: character_names_behavior.COMPLETION,
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    const turn = chat.find(m => m.content === 'Hi');
    assert.strictEqual(turn.name, 'Valid_Name');
});

test('namesBehavior other than COMPLETION does not call setName', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [
        { role: 'user', content: 'Hi', name: 'Bad Name!' },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        namesBehavior: character_names_behavior.DEFAULT,
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    const turn = chat.find(m => m.content === 'Hi');
    assert.strictEqual(turn.name, undefined);
});

// ---------------------------------------------------------------------------
// Media inlining (image/video/audio)
// ---------------------------------------------------------------------------

test('media inlining: mediaDisplay=list + imageInlining=true inlines an image_url content part', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const dataUrl = await makeJpegDataUrl(32, 32);
    const messages = [
        { role: 'user', content: 'Look at this', media: [{ url: dataUrl, type: 'image' }], mediaDisplay: 'list' },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        imageInlining: true,
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    const turn = chat.find(m => Array.isArray(m.content));
    assert.ok(turn, `expected a message with array content, got: ${JSON.stringify(chat)}`);
    const imagePart = turn.content.find(p => p.type === 'image_url');
    assert.ok(imagePart, 'expected an image_url content part');
    assert.ok(imagePart.image_url.url.startsWith('data:image/jpeg;base64,'));
    const textPart = turn.content.find(p => p.type === 'text');
    assert.strictEqual(textPart.text, 'Look at this');
});

test('media inlining: mediaDisplay=gallery + mediaIndex selects only one of several media items', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const dataUrl0 = await makeJpegDataUrl(16, 16);
    const dataUrl1 = await makeJpegDataUrl(24, 24);
    const dataUrl2 = await makeJpegDataUrl(48, 48);
    const messages = [
        {
            role: 'user',
            content: 'Pick one',
            media: [
                { url: dataUrl0, type: 'image' },
                { url: dataUrl1, type: 'image' },
                { url: dataUrl2, type: 'image' },
            ],
            mediaDisplay: 'gallery',
            mediaIndex: 1,
        },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        imageInlining: true,
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    const turn = chat.find(m => Array.isArray(m.content));
    const imageParts = turn.content.filter(p => p.type === 'image_url');
    assert.strictEqual(imageParts.length, 1, 'only the media[mediaIndex] entry should be inlined');
});

test('media inlining: imageInlining=false means no media gets inlined even when chatPrompt.media is present', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const dataUrl = await makeJpegDataUrl(32, 32);
    const messages = [
        { role: 'user', content: 'Look at this', media: [{ url: dataUrl, type: 'image' }], mediaDisplay: 'list' },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        imageInlining: false,
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    const turn = chat.find(m => m.content === 'Look at this');
    assert.ok(turn, 'the plain text turn should still exist');
    assert.ok(!Array.isArray(turn.content), 'content should remain a plain string, never converted to an array');
});
