import assert from 'node:assert';
import { test } from 'node:test';

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

const fakeCountTokenAsyncFn = async (messages) => JSON.stringify(messages).length;

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

/** @param {string[]} identifiers */
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

test('isValidChatCompletionName: exact regex behavior', () => {
    assert.strictEqual(isValidChatCompletionName('Alice'), true);
    assert.strictEqual(isValidChatCompletionName('Alice_123'), true);
    assert.strictEqual(isValidChatCompletionName('a'.repeat(64)), true);
    assert.strictEqual(isValidChatCompletionName('a'.repeat(65)), false);
    assert.strictEqual(isValidChatCompletionName(''), false);
    assert.strictEqual(isValidChatCompletionName('Alice Bob'), false);
    assert.strictEqual(isValidChatCompletionName('Alice-Bob'), false);
    assert.strictEqual(isValidChatCompletionName('Alice.Bob'), false);
});

test('sanitizeChatCompletionName: replaces invalid chars, then truncates to 64', () => {
    assert.strictEqual(sanitizeChatCompletionName('Alice Bob'), 'Alice_Bob');
    assert.strictEqual(sanitizeChatCompletionName('a.b-c d'), 'a_b_c_d');
    assert.strictEqual(sanitizeChatCompletionName('Alice_123'), 'Alice_123');
    const long = 'x'.repeat(70) + '!!!!!';
    const sanitized = sanitizeChatCompletionName(long);
    assert.strictEqual(sanitized.length, 64);
    assert.strictEqual(sanitized, 'x'.repeat(64));
});

test('no-op when prompts does not have chatHistory slot', async () => {
    const prompts = new PromptCollection();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [{ role: 'user', content: 'Hi' }];

    await populateChatHistory(messages, prompts, chatCompletion, { tokenHandler });

    assert.strictEqual(chatCompletion.has('chatHistory'), false);
    assert.deepStrictEqual(chatCompletion.getChat(), []);
});

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
    assert.deepStrictEqual(history.map(m => m.identifier), ['newMainChat', 'chatHistory-1', 'chatHistory-2', 'chatHistory-3']);
    assert.deepStrictEqual(history.map(m => m.content), ['[New Chat]', 'Hi', 'Hello', 'How are you']);

    const chat = chatCompletion.getChat();
    assert.deepStrictEqual(chat.map(m => m.content), ['[New Chat]', 'Hi', 'Hello', 'How are you']);
});

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

test('continue branch: last non-injected message pulled out of chatHistory and re-inserted via continueNudge collection', async () => {
    const prompts = makePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Partial answer' },
        { role: 'system', content: 'Injected note', injected: true },
    ];

    await populateChatHistory(messages, prompts, chatCompletion, {
        type: 'continue',
        cyclePrompt: 'Partial answer',
        continuePrefill: false,
        continueNudgePrompt: 'Continue from: {{lastChatMessage}}',
        newChatPrompt: '[New Chat]',
        tokenHandler,
    });

    assert.strictEqual(messages.length, 2);
    assert.ok(!messages.some(m => m.content === 'Partial answer'));
    assert.deepStrictEqual(messages.map(m => m.content), ['Hi', 'Injected note']);

    const history = historyMessages(chatCompletion);
    assert.ok(!history.some(m => m.content === 'Partial answer'));

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

    assert.strictEqual(messages.length, 2);
    const topLevel = chatCompletion.getMessages().getCollection();
    assert.ok(!topLevel.some(c => c.identifier === 'continueNudge'));
});

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

test('budget exhaustion stops the whole loop for normal messages (break, not skip)', async () => {
    const prompts = makePrompts();

    const costOf = async (role, content) => fakeCountTokenAsyncFn({ role, content });
    const cNewChat = await costOf('system', '[New Chat]');
    const cMsg2 = await costOf('user', 'Second');
    const cMsg3 = await costOf('user', 'Third');

    const budget = cMsg3 + cMsg2 - 1;
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
    assert.ok(contents.includes('Third'));
    assert.ok(!contents.includes('Second'));
    assert.ok(!contents.includes('First'));
});

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

    const cNewChat = await fakeCountTokenAsyncFn({ role: 'system', content: '[New Chat]' });
    const { chatCompletion, tokenHandler } = makeChatCompletion(cNewChat);

    await populateChatHistory(messages, prompts, chatCompletion, {
        newChatPrompt: '[New Chat]',
        canUseTools: true,
        tokenHandler,
    });

    const history = historyMessages(chatCompletion);
    assert.deepStrictEqual(history.map(m => m.identifier), ['newMainChat']);
});

test('ACTIVE_CHAIN vs SINCE_LAST_USER produce different previousAssistantReasoning from the same history', async () => {
    const prompts = makePrompts();

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

    assert.strictEqual(activeChainReasoning, null);

    assert.strictEqual(sinceLastUserReasoning, 'first thought');

    assert.notStrictEqual(activeChainReasoning, sinceLastUserReasoning);
});

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
