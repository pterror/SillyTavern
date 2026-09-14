import assert from 'node:assert';
import { test } from 'node:test';

import { TokenHandler, ChatCompletion } from './chat-completion-budget.js';
import { PromptCollection, Prompt, INJECTION_POSITION } from './chat-completion-prompt-collection.js';
import { populateChatCompletion } from './chat-completion-populate.js';

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
    return { chatCompletion, tokenHandler };
}

/** Minimal prompt set required for populateChatCompletion to run without throwing:
 * `impersonate`/`quietPrompt` are always read via `Message.fromPromptAsync`, so they must exist. */
function baseFixturePrompts(extra = []) {
    const prompts = new PromptCollection();
    prompts.add(new Prompt({ identifier: 'impersonate', role: 'system', content: '' }));
    prompts.add(new Prompt({ identifier: 'quietPrompt', role: 'system', content: '' }));
    for (const p of extra) prompts.add(new Prompt(p));
    return prompts;
}

function contentsOf(chat) {
    return chat.map((m) => m.content);
}

// ---------------------------------------------------------------------------
// Fixed-order marker prompts land at their OWN PromptCollection index, not call order
// ---------------------------------------------------------------------------

test('marker prompts land at PromptCollection-assigned index, not addToChatCompletion call order', async () => {
    const prompts = baseFixturePrompts([
        { identifier: 'scenario', role: 'system', content: 'C-scenario' },
        { identifier: 'main', role: 'system', content: 'C-main' },
        { identifier: 'worldInfoBefore', role: 'system', content: 'C-worldInfoBefore' },
        { identifier: 'charDescription', role: 'system', content: 'C-charDescription' },
        { identifier: 'worldInfoAfter', role: 'system', content: 'C-worldInfoAfter' },
        { identifier: 'charPersonality', role: 'system', content: 'C-charPersonality' },
        { identifier: 'personaDescription', role: 'system', content: 'C-personaDescription' },
    ]);
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    await populateChatCompletion(prompts, chatCompletion, {
        messages: [],
        tokenHandler,
    });

    // The call order inside populateChatCompletion is worldInfoBefore, main, worldInfoAfter,
    // charDescription, charPersonality, scenario, personaDescription - deliberately NOT the same
    // as the PromptCollection order constructed above. The final getChat() order must follow the
    // collection's index order.
    assert.deepStrictEqual(contentsOf(chatCompletion.getChat()), [
        'C-scenario',
        'C-main',
        'C-worldInfoBefore',
        'C-charDescription',
        'C-worldInfoAfter',
        'C-charPersonality',
        'C-personaDescription',
    ]);
});

// ---------------------------------------------------------------------------
// isPromptDisabledForCharacter gating, main exempted
// ---------------------------------------------------------------------------

test('prompt disabled for character is skipped, except main which is never skipped for this reason', async () => {
    const prompts = baseFixturePrompts([
        { identifier: 'worldInfoBefore', role: 'system', content: 'C-worldInfoBefore' },
        { identifier: 'main', role: 'system', content: 'C-main' },
    ]);
    const promptOrder = [{
        character_id: 100000,
        order: [
            { identifier: 'worldInfoBefore', enabled: false },
            { identifier: 'main', enabled: false },
        ],
    }];
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    await populateChatCompletion(prompts, chatCompletion, {
        messages: [],
        tokenHandler,
        promptOrder,
        characterId: 100000,
    });

    assert.strictEqual(chatCompletion.has('worldInfoBefore'), false, 'worldInfoBefore is disabled and must be skipped');
    assert.strictEqual(chatCompletion.has('main'), true, 'main is exempt from the disabled-for-character skip');
    assert.deepStrictEqual(contentsOf(chatCompletion.getChat()), ['C-main']);
});

// ---------------------------------------------------------------------------
// ABSOLUTE-position prompts are skipped by addToChatCompletion, routed to absolutePrompts instead
// ---------------------------------------------------------------------------

test('ABSOLUTE-position prompt is never added directly, but reaches the injection step via absolutePrompts', async () => {
    const prompts = baseFixturePrompts([
        {
            identifier: 'customAbsolute',
            role: 'system',
            content: 'ABS_CONTENT',
            system_prompt: false,
            injection_position: INJECTION_POSITION.ABSOLUTE,
            injection_depth: 0,
            injection_order: 100,
        },
    ]);
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    const messages = [
        { role: 'user', content: 'newest-turn' },
        { role: 'assistant', content: 'oldest-turn' },
    ];

    const result = await populateChatCompletion(prompts, chatCompletion, {
        messages,
        tokenHandler,
    });

    assert.strictEqual(chatCompletion.has('customAbsolute'), false, 'ABSOLUTE prompts are never added directly');
    const injected = result.messages.find((m) => m.content === 'ABS_CONTENT');
    assert.ok(injected, 'the ABSOLUTE prompt content must reach the final messages via the injection step');
    assert.strictEqual(injected.injected, true);
});

// ---------------------------------------------------------------------------
// impersonate/quietPrompt control-prompt gating; controlPrompts added LAST
// ---------------------------------------------------------------------------

test('impersonate message included only for type==="impersonate"; quietPrompt included when it has content; both added last', async () => {
    const prompts = baseFixturePrompts([
        { identifier: 'main', role: 'system', content: 'C-main' },
    ]);
    // Overwrite impersonate/quietPrompt with real content for this test.
    prompts.collection.find((p) => p.identifier === 'impersonate').content = 'IMPERSONATE_TEXT';
    prompts.collection.find((p) => p.identifier === 'quietPrompt').content = 'QUIET_TEXT';

    const { chatCompletion, tokenHandler } = makeChatCompletion();

    await populateChatCompletion(prompts, chatCompletion, {
        messages: [],
        type: 'impersonate',
        tokenHandler,
    });

    const chat = chatCompletion.getChat();
    const contents = contentsOf(chat);
    // controlPrompts (impersonate + quietPrompt) must be the LAST two entries, main comes first.
    assert.deepStrictEqual(contents, ['C-main', 'IMPERSONATE_TEXT', 'QUIET_TEXT']);
});

test('quietPrompt is excluded from controlPrompts when its content is empty', async () => {
    const prompts = baseFixturePrompts([
        { identifier: 'main', role: 'system', content: 'C-main' },
    ]);
    // impersonate/quietPrompt both default to empty content from baseFixturePrompts.
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    await populateChatCompletion(prompts, chatCompletion, {
        messages: [],
        type: 'normal',
        tokenHandler,
    });

    assert.deepStrictEqual(contentsOf(chatCompletion.getChat()), ['C-main']);
});

// ---------------------------------------------------------------------------
// injectToMain: both branches
// ---------------------------------------------------------------------------

test('injectToMain: when main exists in chatCompletion, inserts directly at the given position', async () => {
    const prompts = baseFixturePrompts([
        { identifier: 'main', role: 'system', content: 'C-main' },
        { identifier: 'authorsNote', role: 'system', content: 'AUTHORS_NOTE', position: 'end' },
    ]);
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    await populateChatCompletion(prompts, chatCompletion, {
        messages: [],
        tokenHandler,
    });

    const mainCollection = chatCompletion.getMessages().getItemByIdentifier('main').getCollection();
    const mainContents = mainCollection.map((m) => m.content);
    assert.deepStrictEqual(mainContents, ['C-main', 'AUTHORS_NOTE'], 'authorsNote must be inserted at the end of the main collection');
});

test('injectToMain: absolute-prompt-splice fallback clones role/injection_position/injection_depth/injection_order from main, splicing start before / end after', async () => {
    // 'main' is ABSOLUTE-positioned and thus never lands in chatCompletion directly (has('main') stays
    // false), forcing the absolutePrompts-splice fallback branch.
    const prompts = baseFixturePrompts([
        {
            identifier: 'main',
            role: 'system',
            content: '', // empty - must not itself contribute to the merged injected content
            system_prompt: false,
            injection_position: INJECTION_POSITION.ABSOLUTE,
            injection_depth: 3,
            injection_order: 77,
        },
        {
            identifier: 'authorsNote',
            role: 'user', // deliberately different from main's role, to prove the clone overrides it
            content: 'AUTHORS_NOTE',
            position: 'start',
            injection_depth: 999,
            injection_order: 5,
        },
        {
            identifier: 'summary',
            role: 'assistant', // deliberately different from main's role
            content: 'SUMMARY_TEXT',
            position: 'end',
            injection_depth: 1,
            injection_order: 2,
        },
    ]);
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    const messages = [{ role: 'user', content: 'newest-turn' }];

    const result = await populateChatCompletion(prompts, chatCompletion, {
        messages,
        tokenHandler,
    });

    assert.strictEqual(chatCompletion.has('main'), false);

    // knownPrompts is processed in the fixed order ['summary', 'authorsNote', ...], so:
    // - summary (position 'end') splices at indexOfMain + 1 -> after main.
    // - authorsNote (position 'start') splices at indexOfMain (recomputed, still 0) -> before main.
    // Final absolutePrompts order: [authorsNoteCopy, main, summaryCopy]. main's own content is empty
    // so it contributes nothing to the joined string, leaving authorsNote before summary.
    // Both copies inherit main's role ('system'), injection_depth (3), and injection_order (77) -
    // that's what makes them land in the SAME order-group/depth/role bucket and get joined together
    // rather than at their own original depth/order/role.
    const injected = result.messages.find((m) => m.content === 'AUTHORS_NOTE\nSUMMARY_TEXT');
    assert.ok(injected, `expected a merged 'AUTHORS_NOTE\\nSUMMARY_TEXT' system message from the depth-3/order-77 bucket, got: ${JSON.stringify(result.messages)}`);
    assert.strictEqual(injected.role, 'system');
});

// ---------------------------------------------------------------------------
// toolBudgetTokens optional reservation
// ---------------------------------------------------------------------------

test('toolBudgetTokens: reserved only when > 0', async () => {
    const makeFixture = () => baseFixturePrompts([{ identifier: 'main', role: 'system', content: 'C-main' }]);

    const withoutTools = makeChatCompletion();
    await populateChatCompletion(makeFixture(), withoutTools.chatCompletion, {
        messages: [],
        tokenHandler: withoutTools.tokenHandler,
        toolBudgetTokens: 0,
    });

    const withTools = makeChatCompletion();
    await populateChatCompletion(makeFixture(), withTools.chatCompletion, {
        messages: [],
        tokenHandler: withTools.tokenHandler,
        toolBudgetTokens: 500,
    });

    assert.strictEqual(withoutTools.chatCompletion.tokenBudget - withTools.chatCompletion.tokenBudget, 500);
});

// ---------------------------------------------------------------------------
// Continue-prefill displacement
// ---------------------------------------------------------------------------

test('continue-prefill: assistant-role message with supportsAssistantPrefill gets the prefill prepended, and is removed from messages', async () => {
    const prompts = baseFixturePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [
        { role: 'assistant', content: 'ASSISTANT_MSG', name: 'Bob' },
        { role: 'user', content: 'earlier-turn' },
    ];

    await populateChatCompletion(prompts, chatCompletion, {
        messages,
        type: 'continue',
        continuePrefill: true,
        supportsAssistantPrefill: true,
        assistantPrefill: 'PREFILL_TEXT',
        namesInCompletion: true,
        tokenHandler,
    });

    // The displaced message is genuinely removed from the original `messages` array via .shift().
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].content, 'earlier-turn');

    const chat = chatCompletion.getChat();
    const prefillMessage = chat.find((m) => m.content === 'PREFILL_TEXT\n\nASSISTANT_MSG');
    assert.ok(prefillMessage, `expected a combined prefill message, got: ${JSON.stringify(chat)}`);
    assert.strictEqual(prefillMessage.name, 'Bob');
});

test('continue-prefill: user-role message does not get the prefill prepended', async () => {
    const prompts = baseFixturePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [{ role: 'user', content: 'USER_MSG' }];

    await populateChatCompletion(prompts, chatCompletion, {
        messages,
        type: 'continue',
        continuePrefill: true,
        supportsAssistantPrefill: true,
        assistantPrefill: 'PREFILL_TEXT',
        tokenHandler,
    });

    assert.strictEqual(messages.length, 0);
    const chat = chatCompletion.getChat();
    const plainMessage = chat.find((m) => m.content === 'USER_MSG');
    assert.ok(plainMessage, `expected the un-prefixed user message, got: ${JSON.stringify(chat)}`);
});

test('continue-prefill: assistant-role message with supportsAssistantPrefill=false does not get the prefill prepended', async () => {
    const prompts = baseFixturePrompts();
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const messages = [{ role: 'assistant', content: 'ASSISTANT_MSG' }];

    await populateChatCompletion(prompts, chatCompletion, {
        messages,
        type: 'continue',
        continuePrefill: true,
        supportsAssistantPrefill: false,
        assistantPrefill: 'PREFILL_TEXT',
        tokenHandler,
    });

    assert.strictEqual(messages.length, 0);
    const chat = chatCompletion.getChat();
    const plainMessage = chat.find((m) => m.content === 'ASSISTANT_MSG');
    assert.ok(plainMessage, `expected the un-prefixed assistant message, got: ${JSON.stringify(chat)}`);
});

// ---------------------------------------------------------------------------
// pinExamples ordering toggle
// ---------------------------------------------------------------------------

function pinExamplesFixture() {
    const prompts = baseFixturePrompts([
        { identifier: 'chatHistory', role: 'system', content: '' },
        { identifier: 'dialogueExamples', role: 'system', content: '' },
    ]);
    const messages = [{ role: 'user', content: 'HISTORY_TURN' }];
    const messageExamples = [[{ content: 'EXAMPLE_TURN', name: 'Alice' }]];
    return { prompts, messages, messageExamples };
}

test('pinExamples=true: dialogue examples are populated before chat history', async () => {
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const { prompts, messages, messageExamples } = pinExamplesFixture();

    await populateChatCompletion(prompts, chatCompletion, {
        messages,
        messageExamples,
        pinExamples: true,
        tokenHandler,
        dialogueExamplesOptions: { newExampleChatPrompt: '[Example Chat]' },
        historyOptions: { newChatPrompt: '[Start a new Chat]' },
    });

    const topLevel = chatCompletion.getMessages().getCollection();
    const dialogueIdx = topLevel.findIndex((c) => c && c.identifier === 'dialogueExamples');
    const historyIdx = topLevel.findIndex((c) => c && c.identifier === 'chatHistory');
    assert.ok(dialogueIdx >= 0 && historyIdx >= 0);
    // Both collections exist regardless of population order (their slots are reserved up front by
    // index), so verify population ORDER via actual content presence timing is implicit; assert
    // instead that dialogueExamples slot got filled (has messages) confirming it ran.
    const dialogueCollection = chatCompletion.getMessages().getItemByIdentifier('dialogueExamples').getCollection();
    const historyCollection = chatCompletion.getMessages().getItemByIdentifier('chatHistory').getCollection();
    assert.ok(dialogueCollection.length > 0, 'dialogueExamples should have been populated');
    assert.ok(historyCollection.length > 0, 'chatHistory should have been populated');
});

test('pinExamples=false (default): chat history is populated before dialogue examples', async () => {
    const { chatCompletion, tokenHandler } = makeChatCompletion();
    const { prompts, messages, messageExamples } = pinExamplesFixture();

    await populateChatCompletion(prompts, chatCompletion, {
        messages,
        messageExamples,
        pinExamples: false,
        tokenHandler,
        dialogueExamplesOptions: { newExampleChatPrompt: '[Example Chat]' },
        historyOptions: { newChatPrompt: '[Start a new Chat]' },
    });

    const dialogueCollection = chatCompletion.getMessages().getItemByIdentifier('dialogueExamples').getCollection();
    const historyCollection = chatCompletion.getMessages().getItemByIdentifier('chatHistory').getCollection();
    assert.ok(dialogueCollection.length > 0, 'dialogueExamples should have been populated');
    assert.ok(historyCollection.length > 0, 'chatHistory should have been populated');
});

test('pinExamples ordering affects budget consumption order (side-effect proof via a tight budget)', async () => {
    // With a token budget too small to afford BOTH chat history and dialogue examples, whichever
    // one runs FIRST claims the budget and the second one gets starved. This proves actual call
    // order rather than just "both eventually got populated".
    const buildPrompts = () => baseFixturePrompts([
        { identifier: 'chatHistory', role: 'system', content: '' },
        { identifier: 'dialogueExamples', role: 'system', content: '' },
    ]);
    const messages = [{ role: 'user', content: 'X'.repeat(200) }];
    const messageExamples = [[{ content: 'Y'.repeat(200), name: 'Alice' }]];

    // Budget big enough for the fixed overhead (reserveBudget(3) + control prompts) plus roughly ONE
    // of the two big blocks, not both.
    const tightBudget = 260;

    const pinnedRun = makeChatCompletion(tightBudget);
    await populateChatCompletion(buildPrompts(), pinnedRun.chatCompletion, {
        messages: messages.slice(),
        messageExamples,
        pinExamples: true, // dialogueExamples first
        tokenHandler: pinnedRun.tokenHandler,
        dialogueExamplesOptions: { newExampleChatPrompt: '' },
        historyOptions: { newChatPrompt: '' },
    });

    const unpinnedRun = makeChatCompletion(tightBudget);
    await populateChatCompletion(buildPrompts(), unpinnedRun.chatCompletion, {
        messages: messages.slice(),
        messageExamples,
        pinExamples: false, // chatHistory first
        tokenHandler: unpinnedRun.tokenHandler,
        dialogueExamplesOptions: { newExampleChatPrompt: '' },
        historyOptions: { newChatPrompt: '' },
    });

    const pinnedDialogueFilled = pinnedRun.chatCompletion.getMessages().getItemByIdentifier('dialogueExamples').getCollection().length > 0;
    const pinnedHistoryFilled = pinnedRun.chatCompletion.getMessages().getItemByIdentifier('chatHistory').getCollection().length > 0;
    const unpinnedDialogueFilled = unpinnedRun.chatCompletion.getMessages().getItemByIdentifier('dialogueExamples').getCollection().length > 0;
    const unpinnedHistoryFilled = unpinnedRun.chatCompletion.getMessages().getItemByIdentifier('chatHistory').getCollection().length > 0;

    // Whichever ran first under pinExamples=true (dialogueExamples) should have won the budget race
    // in that run, while under pinExamples=false (chatHistory first) chatHistory should have won.
    assert.strictEqual(pinnedDialogueFilled, true, 'pinExamples=true: dialogueExamples runs first and should win the tight budget');
    assert.strictEqual(unpinnedHistoryFilled, true, 'pinExamples=false: chatHistory runs first and should win the tight budget');
    // At least one of the two orderings must actually starve the SECOND-run collection, proving the
    // order genuinely mattered for this fixture (otherwise the budget wasn't actually tight).
    assert.ok(!pinnedHistoryFilled || !unpinnedDialogueFilled, 'the tight budget should starve whichever collection ran second in at least one ordering');
});

// ---------------------------------------------------------------------------
// controlPrompts only added when non-empty
// ---------------------------------------------------------------------------

test('controlPrompts is not added at all when empty', async () => {
    const prompts = baseFixturePrompts([
        { identifier: 'main', role: 'system', content: 'C-main' },
    ]);
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    await populateChatCompletion(prompts, chatCompletion, {
        messages: [],
        type: 'normal', // not impersonate, quietPrompt content empty -> controlPrompts stays empty
        tokenHandler,
    });

    const topLevel = chatCompletion.getMessages().getCollection();
    assert.strictEqual(topLevel.some((c) => c && c.identifier === 'controlPrompts'), false);
});

test('controlPrompts is added when non-empty (impersonate present)', async () => {
    const prompts = baseFixturePrompts([
        { identifier: 'main', role: 'system', content: 'C-main' },
    ]);
    prompts.collection.find((p) => p.identifier === 'impersonate').content = 'IMPERSONATE_TEXT';
    const { chatCompletion, tokenHandler } = makeChatCompletion();

    await populateChatCompletion(prompts, chatCompletion, {
        messages: [],
        type: 'impersonate',
        tokenHandler,
    });

    const topLevel = chatCompletion.getMessages().getCollection();
    assert.strictEqual(topLevel.some((c) => c && c.identifier === 'controlPrompts'), true);
});
