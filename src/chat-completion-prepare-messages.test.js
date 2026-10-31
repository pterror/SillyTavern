import assert from 'node:assert';
import { TokenHandler } from './chat-completion-budget.js';
import { prepareOpenAIMessages } from './chat-completion-prepare-messages.js';

const fakeCountTokenAsyncFn = async (messages) => JSON.stringify(messages).length;

function baseFixture() {
    /** @type {import('./chat-completion-prompt-collection.js').RawPrompt[]} */
    const prompts = [
        { identifier: 'main', role: 'system', content: 'DEFAULT MAIN CONTENT', system_prompt: true, forbid_overrides: false },
        { identifier: 'jailbreak', role: 'system', content: 'DEFAULT JAILBREAK CONTENT', system_prompt: true, forbid_overrides: false },
        { identifier: 'chatHistory', role: 'system', content: '', system_prompt: true },
        { identifier: 'dialogueExamples', role: 'system', content: '', system_prompt: true },
    ];

    /** @type {import('./chat-completion-prompt-collection.js').PromptOrderList[]} */
    const promptOrder = [
        {
            character_id: 1,
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'jailbreak', enabled: true },
                { identifier: 'chatHistory', enabled: true },
                { identifier: 'dialogueExamples', enabled: true },
            ],
        },
    ];

    const messages = [
        { role: 'user', content: 'USER_TURN_2 (newest)' },
        { role: 'assistant', content: 'ASSISTANT_TURN_1' },
        { role: 'user', content: 'USER_TURN_1 (oldest)' },
    ];

    const messageExamples = [
        [
            { role: 'user', content: 'EXAMPLE_USER_TURN', name: 'Alice' },
            { role: 'assistant', content: 'EXAMPLE_ASSISTANT_TURN', name: 'Bob' },
        ],
    ];

    return {
        name2: 'Bob',
        charDescription: 'CHAR_DESCRIPTION_TEXT',
        charPersonality: 'CHAR_PERSONALITY_TEXT',
        scenario: 'SCENARIO_TEXT',
        worldInfoBefore: 'WI_BEFORE_TEXT',
        worldInfoAfter: '',
        bias: '',
        type: 'normal',
        quietPrompt: '',
        quietImage: undefined,
        extensionPrompts: {},
        cyclePrompt: null,
        systemPromptOverride: undefined,
        jailbreakPromptOverride: undefined,
        messages,
        messageExamples,
        prompts,
        promptOrder,
        characterId: 1,
        groupMemberNames: [],
    };
}

function makeTokenHandler() {
    return new TokenHandler(fakeCountTokenAsyncFn);
}

{
    const tokenHandler = makeTokenHandler();
    const fixture = baseFixture();

    const { chat, counts } = await prepareOpenAIMessages({
        ...fixture,
        tokenHandler,
        maxContext: 1_000_000,
        maxTokens: 0,
    }, false);

    assert.ok(Array.isArray(chat), 'chat should be a real array');

    const contents = chat.map((m) => m.content);

    assert.ok(contents.includes('CHAR_DESCRIPTION_TEXT'), `expected charDescription content in chat, got: ${JSON.stringify(chat)}`);
    assert.ok(contents.includes('DEFAULT MAIN CONTENT'), 'expected main prompt content in chat');
    assert.ok(contents.includes('DEFAULT JAILBREAK CONTENT'), 'expected jailbreak prompt content in chat');
    assert.ok(contents.includes('WI_BEFORE_TEXT'), 'expected worldInfoBefore content in chat');

    const historyIdx1 = contents.indexOf('USER_TURN_1 (oldest)');
    const historyIdx2 = contents.indexOf('ASSISTANT_TURN_1');
    const historyIdx3 = contents.indexOf('USER_TURN_2 (newest)');
    assert.ok(historyIdx1 >= 0 && historyIdx2 >= 0 && historyIdx3 >= 0, `expected all 3 history turns present, got: ${JSON.stringify(chat)}`);
    assert.ok(historyIdx1 < historyIdx2 && historyIdx2 < historyIdx3, 'chat history must appear in chronological (oldest-first) order in the final chat array');
    assert.strictEqual(chat[historyIdx1].role, 'user');
    assert.strictEqual(chat[historyIdx2].role, 'assistant');
    assert.strictEqual(chat[historyIdx3].role, 'user');

    assert.ok(contents.includes('EXAMPLE_USER_TURN'), 'expected a dialogue example turn in chat');
    assert.ok(contents.includes('EXAMPLE_ASSISTANT_TURN'), 'expected a dialogue example turn in chat');

    assert.strictEqual(counts, tokenHandler.counts);
    assert.strictEqual(tokenHandler.getTotal(), 0, 'documents the getTotal()-always-0 finding above - NOT a claim that no tokenization happened');
    assert.ok(Number.isNaN(counts[undefined]), 'documents the counts[undefined] === NaN finding above');

    console.log('PASS: full end-to-end happy path (8 modules compose correctly)');
}

{
    const tokenHandler = makeTokenHandler();
    const fixture = baseFixture();

    const result = await prepareOpenAIMessages({
        ...fixture,
        hasActiveCharacter: false,
        tokenHandler,
        maxContext: 1_000_000,
        maxTokens: 0,
    }, true);

    assert.deepStrictEqual(
        result,
        { chat: null, counts: false, canUseTools: false, canPerformToolCalls: false },
        'early-return shape must match the documented {chat: null, counts: false, canUseTools: false, canPerformToolCalls: false}',
    );
    assert.strictEqual(tokenHandler.getTotal(), 0, 'no tokenization should have happened before the early return');

    console.log('PASS: early-return guard (!hasActiveCharacter && dryRun)');
}

{
    const tokenHandler = makeTokenHandler();
    const fixture = baseFixture();

    const result = await prepareOpenAIMessages({
        ...fixture,
        tokenHandler,
        maxContext: 1_000_000,
        maxTokens: 0,
    }, true);

    assert.notStrictEqual(result.chat, null, 'dryRun alone (hasActiveCharacter defaults to true) must NOT early-return');
    console.log('PASS: dryRun alone does not trigger the early-return guard');
}

{
    const tokenHandler = makeTokenHandler();
    const fixture = baseFixture();

    let caught = null;
    try {
        await prepareOpenAIMessages({
            ...fixture,
            tokenHandler,
            maxContext: 1,
            maxTokens: 0,
        }, false);
    } catch (error) {
        caught = error;
    }

    assert.ok(caught, 'expected an error to propagate out of prepareOpenAIMessages');
    assert.strictEqual(caught.name, 'TokenBudgetExceeded', `expected a TokenBudgetExceededError, got: ${caught?.name}: ${caught?.message}`);

    console.log('PASS: TokenBudgetExceededError propagates to the caller, not swallowed');
}

function squashFixture() {
    return {
        name2: 'Bob',
        charDescription: 'SQUASH_DESCRIPTION',
        charPersonality: 'SQUASH_PERSONALITY',
        scenario: 'SQUASH_SCENARIO',
        worldInfoBefore: 'SQUASH_WI_BEFORE',
        worldInfoAfter: '',
        bias: '',
        type: 'normal',
        quietPrompt: '',
        extensionPrompts: {},
        cyclePrompt: null,
        messages: [],
        messageExamples: [],
        prompts: [],
        promptOrder: [],
        characterId: 1,
        groupMemberNames: [],
    };
}

async function countSystemMessages(squashSystemMessages, dryRun) {
    const tokenHandler = makeTokenHandler();
    const { chat } = await prepareOpenAIMessages({
        ...squashFixture(),
        tokenHandler,
        maxContext: 1_000_000,
        maxTokens: 0,
        squashSystemMessages,
    }, dryRun);
    return chat.filter((m) => m.role === 'system');
}

{
    const unsquashed = await countSystemMessages(false, false);
    const squashedDryRunFalse = await countSystemMessages(true, false);
    const squashedDryRunTrue = await countSystemMessages(true, true);

    assert.strictEqual(unsquashed.length, 4, `expected 4 separate system messages without squashing, got: ${JSON.stringify(unsquashed)}`);
    assert.deepStrictEqual(unsquashed.map((m) => m.content), ['SQUASH_WI_BEFORE', 'SQUASH_DESCRIPTION', 'SQUASH_PERSONALITY', 'SQUASH_SCENARIO']);

    assert.strictEqual(squashedDryRunFalse.length, 1, `expected the 4 adjacent system messages to be squashed into 1, got: ${JSON.stringify(squashedDryRunFalse)}`);
    assert.strictEqual(
        squashedDryRunFalse[0].content,
        'SQUASH_WI_BEFORE\nSQUASH_DESCRIPTION\nSQUASH_PERSONALITY\nSQUASH_SCENARIO',
        'squashed content should be newline-joined in original order',
    );

    assert.strictEqual(squashedDryRunTrue.length, 4, `expected squashing to be skipped when dryRun is true, got: ${JSON.stringify(squashedDryRunTrue)}`);

    console.log('PASS: squashSystemMessages runs only when squashSystemMessages=true AND dryRun==false');
}

function toolCallFixture() {
    return {
        name2: 'Bob',
        charDescription: '',
        charPersonality: '',
        scenario: '',
        worldInfoBefore: '',
        worldInfoAfter: '',
        bias: '',
        type: 'normal',
        quietPrompt: '',
        extensionPrompts: {},
        cyclePrompt: null,
        messages: [
            { role: 'assistant', content: '', invocations: [{ id: 'call_1', name: 'get_weather', parameters: '{"city":"NYC"}', result: 'sunny' }] },
            { role: 'user', content: 'USER_TURN_1' },
        ],
        messageExamples: [],
        prompts: [
            { identifier: 'main', role: 'system', content: 'MAIN', system_prompt: true, forbid_overrides: false },
            { identifier: 'chatHistory', role: 'system', content: '', system_prompt: true },
        ],
        promptOrder: [
            { character_id: 1, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] },
        ],
        characterId: 1,
        groupMemberNames: [],
    };
}

{
    const tokenHandler = makeTokenHandler();
    const fixture = toolCallFixture();

    const { chat, canUseTools, canPerformToolCalls } = await prepareOpenAIMessages({
        ...fixture,
        tokenHandler,
        maxContext: 1_000_000,
        maxTokens: 0,
        mainApi: 'openai',
        settings: { function_calling: true, chat_completion_source: 'openai', custom_prompt_post_processing: '' },
    }, false);

    assert.strictEqual(canUseTools, true, 'canUseTools must be resolved true for a genuinely tool-capable openai/function_calling settings combination');
    assert.strictEqual(canPerformToolCalls, true, 'canPerformToolCalls must be true for type: normal');

    const toolCallMessage = chat.find((m) => Array.isArray(m.tool_calls));
    assert.ok(toolCallMessage, `expected a reconstructed tool-call message in the final chat, got: ${JSON.stringify(chat)}`);
    assert.strictEqual(toolCallMessage.role, 'assistant');
    assert.strictEqual(toolCallMessage.tool_calls[0].id, 'call_1');
    assert.strictEqual(toolCallMessage.tool_calls[0].function.name, 'get_weather');

    const toolResultMessage = chat.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
    assert.ok(toolResultMessage, `expected a reconstructed tool-result message in the final chat, got: ${JSON.stringify(chat)}`);
    assert.strictEqual(toolResultMessage.content, 'sunny');

    console.log('PASS: canUseTools resolved true really flows through to populateChatHistory’s tool-call-reconstruction branch');
}

{
    const tokenHandler = makeTokenHandler();
    const fixture = toolCallFixture();

    const { chat, canUseTools, canPerformToolCalls } = await prepareOpenAIMessages({
        ...fixture,
        tokenHandler,
        maxContext: 1_000_000,
        maxTokens: 0,
        mainApi: 'textgenerationwebui',
        settings: { function_calling: true, chat_completion_source: 'openai', custom_prompt_post_processing: '' },
    }, false);

    assert.strictEqual(canUseTools, false, 'canUseTools must resolve false when mainApi is not openai');
    assert.strictEqual(canPerformToolCalls, false, 'canPerformToolCalls must also be false when the underlying capability is false');

    const toolCallMessage = chat.find((m) => Array.isArray(m.tool_calls));
    assert.ok(!toolCallMessage, `expected NO reconstructed tool-call message when canUseTools is false, got: ${JSON.stringify(chat)}`);
    const toolResultMessage = chat.find((m) => m.role === 'tool');
    assert.ok(!toolResultMessage, `expected NO reconstructed tool-result message when canUseTools is false, got: ${JSON.stringify(chat)}`);

    const contents = chat.map((m) => m.content);
    assert.ok(contents.includes('USER_TURN_1'), 'the other history turn must still be present as plain text');

    console.log('PASS: canUseTools resolved false really prevents populateChatHistory’s tool-call-reconstruction branch from firing');
}

console.log('All chat-completion-prepare-messages tests passed.');

{
    const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const tokenHandler = makeTokenHandler();
    const fixture = baseFixture();
    fixture.messages = [
        { role: 'user', content: 'USER_WITH_IMAGE', media: [{ url: TINY_PNG, type: 'image' }], mediaDisplay: 'list' },
        ...fixture.messages,
    ];
    fixture.quietPrompt = 'QUIET_PROMPT_TEXT';
    fixture.quietImage = TINY_PNG;

    const { chat } = await prepareOpenAIMessages({
        ...fixture,
        tokenHandler,
        maxContext: 1_000_000,
        maxTokens: 0,
        imageInlining: true,
        imageQuality: 'low',
    }, false);

    const historyImageMessage = chat.find((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
    assert.ok(historyImageMessage, `expected a chat-history message with an inlined image_url part, got: ${JSON.stringify(chat)}`);

    const quietImageMessage = chat.find((m) => m.identifier === 'quietPrompt' || (Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url') && m !== historyImageMessage));
    assert.ok(quietImageMessage, `expected the quiet-prompt message to also carry an inlined image, got: ${JSON.stringify(chat)}`);

    console.log('PASS: imageInlining=true flows through prepareOpenAIMessages into both chat-history media and quiet-prompt image');
}

{
    const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const tokenHandler = makeTokenHandler();
    const fixture = baseFixture();
    fixture.messages = [
        { role: 'user', content: 'USER_WITH_IMAGE', media: [{ url: TINY_PNG, type: 'image' }], mediaDisplay: 'list' },
        ...fixture.messages,
    ];
    fixture.quietPrompt = 'QUIET_PROMPT_TEXT';
    fixture.quietImage = TINY_PNG;

    const { chat } = await prepareOpenAIMessages({
        ...fixture,
        tokenHandler,
        maxContext: 1_000_000,
        maxTokens: 0,
        imageInlining: false,
    }, false);

    const anyImageMessage = chat.find((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
    assert.ok(!anyImageMessage, `expected NO inlined image anywhere when imageInlining is false, got: ${JSON.stringify(chat)}`);

    console.log('PASS: imageInlining=false suppresses media inlining everywhere in prepareOpenAIMessages');
}
