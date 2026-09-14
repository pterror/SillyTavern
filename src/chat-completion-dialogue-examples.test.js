import assert from 'node:assert';
import { test } from 'node:test';

import { TokenHandler, ChatCompletion } from './chat-completion-budget.js';
import { PromptCollection, Prompt } from './chat-completion-prompt-collection.js';
import { populateDialogueExamples } from './chat-completion-dialogue-examples.js';

/** Simple deterministic fake tokenizer: token count = length of the JSON-stringified message(s). */
const fakeCountTokenAsyncFn = async (messages) => JSON.stringify(messages).length;

/**
 * @param {number} [budget]
 * @returns {{chatCompletion: ChatCompletion, tokenHandler: TokenHandler}}
 */
function makeChatCompletion(budget = 1_000_000) {
    const tokenHandler = new TokenHandler(fakeCountTokenAsyncFn);
    const chatCompletion = new ChatCompletion(tokenHandler);
    chatCompletion.setTokenBudget(budget, 0);
    // `tokenHandler` is also reachable as `chatCompletion.tokenHandler` (stored by the
    // ChatCompletion constructor - see src/chat-completion-budget.js), but returning it here
    // explicitly keeps call sites self-documenting about what gets threaded into
    // `populateDialogueExamples`'s `tokenHandler` option.
    return { chatCompletion, tokenHandler };
}

function makePromptCollectionWithDialogueExamples(position = 0) {
    const prompts = new PromptCollection();
    // Pad with unrelated prompts so `index('dialogueExamples')` is non-trivial when position > 0.
    for (let i = 0; i < position; i++) {
        prompts.add(new Prompt({ identifier: `filler${i}`, role: 'system', content: 'filler' }));
    }
    prompts.add(new Prompt({ identifier: 'dialogueExamples', role: 'system', content: '' }));
    return prompts;
}

test('no-op when prompts does not have dialogueExamples slot', async () => {
    const prompts = new PromptCollection(); // empty, no 'dialogueExamples'
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const before = JSON.stringify(chatCompletion.getChat());

    await populateDialogueExamples(prompts, chatCompletion, [[{ content: 'hi', name: 'Alice' }]], {
        newExampleChatPrompt: '[Example Chat]',
        tokenHandler,
    });

    assert.strictEqual(chatCompletion.has('dialogueExamples'), false);
    assert.strictEqual(JSON.stringify(chatCompletion.getChat()), before);
    assert.deepStrictEqual(chatCompletion.getChat(), []);
});

test('slot is reserved even when messageExamples is empty/absent', async () => {
    const prompts = makePromptCollectionWithDialogueExamples();
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    await populateDialogueExamples(prompts, chatCompletion, [], {
        newExampleChatPrompt: '[Example Chat]',
        tokenHandler,
    });

    assert.strictEqual(chatCompletion.has('dialogueExamples'), true);
    assert.deepStrictEqual(chatCompletion.getChat(), []);

    // Also verify the "absent" (undefined) case behaves the same.
    const { chatCompletion: chatCompletion2, tokenHandler: tokenHandler2 } = makeChatCompletion();
    await populateDialogueExamples(prompts, chatCompletion2, undefined, {
        newExampleChatPrompt: '[Example Chat]',
        tokenHandler: tokenHandler2,
    });
    assert.strictEqual(chatCompletion2.has('dialogueExamples'), true);
    assert.deepStrictEqual(chatCompletion2.getChat(), []);
});

test('normal case: 2+ dialogue blocks that all fit, with correct identifiers/roles/names', async () => {
    const prompts = makePromptCollectionWithDialogueExamples();
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    const messageExamples = [
        [
            { content: 'Hello there', name: 'Alice' },
            { content: 'General Kenobi', name: '' }, // falsy name -> omitted from getChat() output
        ],
        [
            { content: 'Second block turn 0', name: 'Bob' },
        ],
    ];

    await populateDialogueExamples(prompts, chatCompletion, messageExamples, {
        newExampleChatPrompt: '[Start a new Chat]',
        tokenHandler,
    });

    assert.strictEqual(chatCompletion.has('dialogueExamples'), true);

    const chat = chatCompletion.getChat();
    // 2 headers + 2 turns (block 0) + 1 turn (block 1) = 5 messages total.
    assert.strictEqual(chat.length, 5);

    assert.deepStrictEqual(chat[0], { role: 'system', content: '[Start a new Chat]' });
    assert.deepStrictEqual(chat[1], { role: 'system', content: 'Hello there', name: 'Alice' });
    assert.deepStrictEqual(chat[2], { role: 'system', content: 'General Kenobi' }); // no `name` key
    assert.deepStrictEqual(chat[3], { role: 'system', content: '[Start a new Chat]' });
    assert.deepStrictEqual(chat[4], { role: 'system', content: 'Second block turn 0', name: 'Bob' });

    // Verify exact identifiers via the underlying MessageCollection.
    const dialogueCollection = chatCompletion.getMessages().getItemByIdentifier('dialogueExamples');
    const identifiers = dialogueCollection.getCollection().map(m => m.identifier);
    assert.deepStrictEqual(identifiers, [
        'newChat',
        'dialogueExamples 0-0',
        'dialogueExamples 0-1',
        'newChat',
        'dialogueExamples 1-0',
    ]);
});

test('all-or-nothing per block: a block that does not fit stops the loop entirely', async () => {
    const prompts = makePromptCollectionWithDialogueExamples();

    // Figure out exact token costs with the fake tokenizer to build a tight budget.
    const probeTokenHandler = new TokenHandler(fakeCountTokenAsyncFn);
    const headerTokens = await probeTokenHandler.countAsync({ role: 'system', content: '[New Chat]' });
    const block0Turn0Tokens = await probeTokenHandler.countAsync({ role: 'system', content: 'Block0 turn0', name: 'A' });

    // Budget affords exactly: header + block0's single turn, but not a second header + block1's turn.
    const budget = headerTokens + block0Turn0Tokens;
    const { chatCompletion, tokenHandler } = makeChatCompletion(budget);

    const messageExamples = [
        [{ content: 'Block0 turn0', name: 'A' }],
        [{ content: 'Block1 turn0', name: 'B' }],
    ];

    await populateDialogueExamples(prompts, chatCompletion, messageExamples, {
        newExampleChatPrompt: '[New Chat]',
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    assert.deepStrictEqual(chat, [
        { role: 'system', content: '[New Chat]' },
        { role: 'system', content: 'Block0 turn0', name: 'A' },
    ]);

    const dialogueCollection = chatCompletion.getMessages().getItemByIdentifier('dialogueExamples');
    const identifiers = dialogueCollection.getCollection().map(m => m.identifier);
    assert.deepStrictEqual(identifiers, ['newChat', 'dialogueExamples 0-0']);
    // Block 1's content must not appear anywhere.
    assert.ok(!JSON.stringify(chat).includes('Block1'));
});

test('newExampleChat header is inserted fresh for every fitting block', async () => {
    const prompts = makePromptCollectionWithDialogueExamples();
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    const messageExamples = [
        [{ content: 'a', name: 'A' }],
        [{ content: 'b', name: 'B' }],
        [{ content: 'c', name: 'C' }],
    ];

    await populateDialogueExamples(prompts, chatCompletion, messageExamples, {
        newExampleChatPrompt: '[New Chat Header]',
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    const headerCount = chat.filter(m => m.content === '[New Chat Header]').length;
    assert.strictEqual(headerCount, 3);

    const dialogueCollection = chatCompletion.getMessages().getItemByIdentifier('dialogueExamples');
    const newChatIdentifierCount = dialogueCollection.getCollection().filter(m => m.identifier === 'newChat').length;
    assert.strictEqual(newChatIdentifierCount, 3);
});

test('macroContext is forwarded to substituteParams for newExampleChatPrompt', async () => {
    const prompts = makePromptCollectionWithDialogueExamples();
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    await populateDialogueExamples(prompts, chatCompletion, [[{ content: 'x', name: 'X' }]], {
        newExampleChatPrompt: 'Hi {{user}}, new example chat with {{char}}',
        macroContext: { name1: 'Ehren', name2: 'Bot' },
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    assert.strictEqual(chat[0].content, 'Hi Ehren, new example chat with Bot');
});
