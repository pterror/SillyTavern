import assert from 'node:assert';
import { TokenHandler } from './chat-completion-budget.js';
import { prepareOpenAIMessages } from './chat-completion-prepare-messages.js';

/** Deterministic fake tokenizer: token count = length of the JSON-stringified message(s). */
const fakeCountTokenAsyncFn = async (messages) => JSON.stringify(messages).length;

/**
 * Real-shaped fixture: a `prompts`/`promptOrder` pair matching the actual `oai_settings.prompts` /
 * `oai_settings.prompt_order` shape (verified against src/chat-completion-prompt-collection.js's own
 * module doc comment), a character description/personality/scenario, and a short chat history.
 */
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

    // Newest-first, matching populateInjectionPrompts's documented input convention (see
    // src/chat-completion-injection-prompts.js's module doc comment: "Messages already in
    // newest-first order").
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

// ---------------------------------------------------------------------------
// 1. Full end-to-end happy path: proves all 8 already-ported modules compose correctly.
// ---------------------------------------------------------------------------
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

    // character description present
    assert.ok(contents.includes('CHAR_DESCRIPTION_TEXT'), `expected charDescription content in chat, got: ${JSON.stringify(chat)}`);
    // main prompt present
    assert.ok(contents.includes('DEFAULT MAIN CONTENT'), 'expected main prompt content in chat');
    // jailbreak prompt present (registered as a fixed systemPrompts identifier)
    assert.ok(contents.includes('DEFAULT JAILBREAK CONTENT'), 'expected jailbreak prompt content in chat');
    // world info before present
    assert.ok(contents.includes('WI_BEFORE_TEXT'), 'expected worldInfoBefore content in chat');

    // chat history present, in the right roles/chronological order (oldest -> newest)
    const historyIdx1 = contents.indexOf('USER_TURN_1 (oldest)');
    const historyIdx2 = contents.indexOf('ASSISTANT_TURN_1');
    const historyIdx3 = contents.indexOf('USER_TURN_2 (newest)');
    assert.ok(historyIdx1 >= 0 && historyIdx2 >= 0 && historyIdx3 >= 0, `expected all 3 history turns present, got: ${JSON.stringify(chat)}`);
    assert.ok(historyIdx1 < historyIdx2 && historyIdx2 < historyIdx3, 'chat history must appear in chronological (oldest-first) order in the final chat array');
    assert.strictEqual(chat[historyIdx1].role, 'user');
    assert.strictEqual(chat[historyIdx2].role, 'assistant');
    assert.strictEqual(chat[historyIdx3].role, 'user');

    // dialogue examples present, with names sanitized/threaded through
    assert.ok(contents.includes('EXAMPLE_USER_TURN'), 'expected a dialogue example turn in chat');
    assert.ok(contents.includes('EXAMPLE_ASSISTANT_TURN'), 'expected a dialogue example turn in chat');

    // counts is the real, live TokenHandler.counts object (judgment call 12).
    //
    // GENUINE CROSS-MODULE INTEGRATION FINDING (reported, not silently patched around - per this
    // task's own instructions): every real `tokenHandler.countAsync(...)` call site across all 8
    // already-ported modules (`Message.createAsync`/`.setName`/`.setToolCalls` and
    // `ChatCompletion.squashSystemMessages` in src/chat-completion-budget.js; nowhere else calls
    // `countAsync` at all - re-verified by grepping every module for `countAsync(`) omits the third
    // `type` argument entirely. `TokenHandler.countAsync(messages, full, type)` then does
    // `this.counts[type] += token_count`, so with `type === undefined` this becomes
    // `this.counts[undefined] += token_count`, i.e. `undefined + token_count`, which is `NaN` -
    // silently. `TokenHandler.getTotal()` explicitly guards against this (`isNaN(b) ? 0 : b`), so
    // the running total quietly reports `0` even though real, correct tokens WERE counted and the
    // real token BUDGET (`chatCompletion.tokenBudget`, via `message.getTokens()`) is enforced
    // correctly throughout (proven separately by the TokenBudgetExceededError propagation test
    // below, and by chat-completion-populate.test.js's own tight-budget race test). Only the
    // informational `counts`/`getTotal()` diagnostic surface is dead in this real call graph - this
    // is a genuine, observable gap in how the 8 modules compose (none of them was ever exercised
    // together with a real TokenHandler before this task), not a bug in any single module taken in
    // isolation (each module's own unit tests pass an explicit `type` string directly to
    // `countAsync`, e.g. chat-completion-budget.test.js's own `th.countAsync(..., 'prompt')`, which
    // is why this never surfaced earlier). NOT fixed here since it would require editing an
    // already-committed, read-only module (chat-completion-budget.js) - flagged for a human/product
    // decision on whether every `Message`-creating call site anywhere in the pipeline should also
    // supply a `type` tag.
    assert.strictEqual(counts, tokenHandler.counts);
    assert.strictEqual(tokenHandler.getTotal(), 0, 'documents the getTotal()-always-0 finding above - NOT a claim that no tokenization happened');
    assert.ok(Number.isNaN(counts[undefined]), 'documents the counts[undefined] === NaN finding above');

    console.log('PASS: full end-to-end happy path (8 modules compose correctly)');
}

// ---------------------------------------------------------------------------
// 2. Early-return guard: !hasActiveCharacter && dryRun
// ---------------------------------------------------------------------------
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
    // Nothing should have been counted - the early return must happen before any ChatCompletion
    // work, let alone tokenization.
    assert.strictEqual(tokenHandler.getTotal(), 0, 'no tokenization should have happened before the early return');

    console.log('PASS: early-return guard (!hasActiveCharacter && dryRun)');
}

// Sanity: hasActiveCharacter default (true) means dryRun alone does NOT early-return.
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

// ---------------------------------------------------------------------------
// 3. TokenBudgetExceededError genuinely propagates out of prepareOpenAIMessages
// ---------------------------------------------------------------------------
{
    const tokenHandler = makeTokenHandler();
    const fixture = baseFixture();

    let caught = null;
    try {
        await prepareOpenAIMessages({
            ...fixture,
            tokenHandler,
            maxContext: 1, // impossibly tight budget
            maxTokens: 0,
        }, false);
    } catch (error) {
        caught = error;
    }

    assert.ok(caught, 'expected an error to propagate out of prepareOpenAIMessages');
    assert.strictEqual(caught.name, 'TokenBudgetExceeded', `expected a TokenBudgetExceededError, got: ${caught?.name}: ${caught?.message}`);

    console.log('PASS: TokenBudgetExceededError propagates to the caller, not swallowed');
}

// ---------------------------------------------------------------------------
// 4. squashSystemMessages actually runs (or doesn't) based on squashSystemMessages/dryRun
// ---------------------------------------------------------------------------
/**
 * Builds a fixture with 2+ adjacent, squashable system messages: worldInfoBefore, charDescription,
 * charPersonality, and scenario are all `role: 'system'`, no `name`, and (per
 * src/chat-completion-populate.js's fixed addToChatCompletion call order / PromptCollection index
 * order established by preparePromptsForChatCompletion) land immediately adjacent to each other in
 * the flattened chat array with nothing else in between, once main/jailbreak/history/examples are
 * kept empty/absent.
 */
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

    // Without squashing: 4 separate adjacent system messages (worldInfoBefore, charDescription,
    // charPersonality, scenario) plus quietPrompt/groupNudge (empty, filtered by getChat's
    // content-truthiness check) - so exactly the 4 non-empty ones survive as separate entries.
    assert.strictEqual(unsquashed.length, 4, `expected 4 separate system messages without squashing, got: ${JSON.stringify(unsquashed)}`);
    assert.deepStrictEqual(unsquashed.map((m) => m.content), ['SQUASH_WI_BEFORE', 'SQUASH_DESCRIPTION', 'SQUASH_PERSONALITY', 'SQUASH_SCENARIO']);

    // squashSystemMessages=true AND dryRun===false -> the client's exact
    // `oai_settings.squash_system_messages && dryRun == false` gate is satisfied -> merged into ONE.
    assert.strictEqual(squashedDryRunFalse.length, 1, `expected the 4 adjacent system messages to be squashed into 1, got: ${JSON.stringify(squashedDryRunFalse)}`);
    assert.strictEqual(
        squashedDryRunFalse[0].content,
        'SQUASH_WI_BEFORE\nSQUASH_DESCRIPTION\nSQUASH_PERSONALITY\nSQUASH_SCENARIO',
        'squashed content should be newline-joined in original order',
    );

    // squashSystemMessages=true but dryRun===true -> `dryRun == false` is false -> squash must NOT run.
    assert.strictEqual(squashedDryRunTrue.length, 4, `expected squashing to be skipped when dryRun is true, got: ${JSON.stringify(squashedDryRunTrue)}`);

    console.log('PASS: squashSystemMessages runs only when squashSystemMessages=true AND dryRun==false');
}

// ---------------------------------------------------------------------------
// 5. Tool-capability resolution (judgment call 14) genuinely flows end-to-end into
//    populateChatHistory()'s tool-call-reconstruction branch - not just computed in isolation.
// ---------------------------------------------------------------------------
/**
 * A fixture whose chat history's last turn carries `.invocations` (a tool call the assistant made),
 * matching src/chat-completion-history.js's documented `canUseTools && Array.isArray(chatPrompt
 * .invocations)` reconstruction-branch trigger.
 */
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
            // Newest-first, matching populateInjectionPrompts's documented input convention.
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

    // The reconstructed tool RESULT message should also be present (role 'tool', matching invocation.id).
    const toolResultMessage = chat.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
    assert.ok(toolResultMessage, `expected a reconstructed tool-result message in the final chat, got: ${JSON.stringify(chat)}`);
    assert.strictEqual(toolResultMessage.content, 'sunny');

    console.log('PASS: canUseTools resolved true really flows through to populateChatHistory’s tool-call-reconstruction branch');
}

// ---------------------------------------------------------------------------
// 6. Same fixture, but mainApi !== 'openai' -> canUseTools resolves false -> the tool-call branch
//    must NOT fire; the message is instead treated as plain text (dropped here since its content
//    is empty, proving it did NOT go through reconstruction, which would have produced tool_calls).
// ---------------------------------------------------------------------------
{
    const tokenHandler = makeTokenHandler();
    const fixture = toolCallFixture();

    const { chat, canUseTools, canPerformToolCalls } = await prepareOpenAIMessages({
        ...fixture,
        tokenHandler,
        maxContext: 1_000_000,
        maxTokens: 0,
        mainApi: 'textgenerationwebui', // not 'openai'
        settings: { function_calling: true, chat_completion_source: 'openai', custom_prompt_post_processing: '' },
    }, false);

    assert.strictEqual(canUseTools, false, 'canUseTools must resolve false when mainApi is not openai');
    assert.strictEqual(canPerformToolCalls, false, 'canPerformToolCalls must also be false when the underlying capability is false');

    const toolCallMessage = chat.find((m) => Array.isArray(m.tool_calls));
    assert.ok(!toolCallMessage, `expected NO reconstructed tool-call message when canUseTools is false, got: ${JSON.stringify(chat)}`);
    const toolResultMessage = chat.find((m) => m.role === 'tool');
    assert.ok(!toolResultMessage, `expected NO reconstructed tool-result message when canUseTools is false, got: ${JSON.stringify(chat)}`);

    // The turn's own (empty) content means it's dropped by getChat()'s content-truthiness filter,
    // since it has no `.content` and (with canUseTools false) never gets `.tool_calls` set either -
    // proving the plain-text fallback path ran instead of the tool-call-reconstruction branch.
    const contents = chat.map((m) => m.content);
    assert.ok(contents.includes('USER_TURN_1'), 'the other history turn must still be present as plain text');

    console.log('PASS: canUseTools resolved false really prevents populateChatHistory’s tool-call-reconstruction branch from firing');
}

console.log('All chat-completion-prepare-messages tests passed.');

// ---------------------------------------------------------------------------
// 7. Media inlining (judgment call 15): imageInlining flows all the way through this top-level
//    entry point into both the chat-history media block (chat-completion-history.js) and the
//    quiet-prompt image (chat-completion-populate.js), and imageInlining=false suppresses both.
// ---------------------------------------------------------------------------
{
    // 1x1 transparent PNG, small enough that quality:'low' never needs real dimension parsing.
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
