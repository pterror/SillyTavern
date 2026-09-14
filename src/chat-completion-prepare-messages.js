import { ChatCompletion } from './chat-completion-budget.js';
import { preparePromptsForChatCompletion } from './chat-completion-prepare-prompts.js';
import { populateChatCompletion } from './chat-completion-populate.js';

/**
 * Server-side port of public/scripts/chat-completion-settings.js's `prepareOpenAIMessages()` - the
 * TOP-LEVEL Chat Completion (`main_api === 'openai'`) prompt-assembly entry point, and the direct
 * chat-completion analog of `src/text-completion-prompt-orchestrator.js`'s
 * `assembleTextCompletionPrompt()`. It does not reimplement any prompt-assembly logic itself - it is
 * pure wiring between the two already-ported orchestrators one level down:
 *   - `preparePromptsForChatCompletion()` (src/chat-completion-prepare-prompts.js) - builds the
 *     `PromptCollection` (system prompts merged with the user's prompt-manager order/overrides).
 *   - `populateChatCompletion()` (src/chat-completion-populate.js) - walks that collection, applying
 *     token-budget-aware history/dialogue-example population, into a `ChatCompletion` instance.
 * Together with the `ChatCompletion`/`TokenHandler` class family (src/chat-completion-budget.js),
 * this closes out all 8 previously-independently-ported chat-completion-* modules into one callable
 * pipeline.
 *
 * ============================================================================================
 * SCOPE BOUNDARIES / JUDGMENT CALLS - read before trusting this as production-accurate
 * ============================================================================================
 *
 * 1. `!promptManager.activeCharacter && dryRun` EARLY-RETURN GUARD -> taken as an explicit
 *    `hasActiveCharacter` boolean param (default `true`, i.e. "assume a character is active unless a
 *    caller says otherwise" - matching the common case and never silently short-circuiting a normal
 *    caller who doesn't pass it). When `!hasActiveCharacter && dryRun`, this function returns
 *    immediately with `{ chat: null, counts: false }` - the same 2-value shape as the client's
 *    `[null, false]` tuple, translated to an object (see judgment call 9 below for why the *real*
 *    return value also uses an object, for consistency with this one).
 *
 * 2. `new ChatCompletion()` -> `new ChatCompletion(tokenHandler)`. The already-ported `ChatCompletion`
 *    constructor (src/chat-completion-budget.js) requires an explicit `TokenHandler` instance (that
 *    module's own judgment call, not repeated here) - `tokenHandler` is REQUIRED param on this
 *    function, forwarded to the `ChatCompletion` constructor and then again to `populateChatCompletion`
 *    (which needs it directly for `Message.fromPromptAsync`/etc.) and used again at the very end to
 *    read back `tokenHandler.counts` for the return value.
 *
 * 3. `power_user.console_log_prompts` -> `enableLogging` boolean param (default `false`). Calls the
 *    already-ported, harmless `chatCompletion.enableLogging()` when true.
 *
 * 4. `userSettings.openai_max_context` / `.openai_max_tokens` -> explicit `maxContext`/`maxTokens`
 *    params, forwarded verbatim to `chatCompletion.setTokenBudget(maxContext, maxTokens)`.
 *
 * 5. THE try/catch's toastr/`promptManager.error` UI-ONLY ERROR REPORTING -> DELIBERATELY NOT PORTED.
 *    There is no server-side UI toast equivalent, so `TokenBudgetExceededError` /
 *    `InvalidCharacterNameError` / any other error thrown by `preparePromptsForChatCompletion()` or
 *    `populateChatCompletion()` is left to PROPAGATE out of this function to its own caller - a
 *    server function should surface an assembly failure to its caller, not silently swallow it into a
 *    UI toast that has no server-side meaning. This is a real, deliberate behavioral choice, not an
 *    oversight. The client's `finally` block's *non-UI* side effects still need to run even when the
 *    try block throws (matching the client's own guarantee that its `finally` always executes) - this
 *    is implemented below as a real `try { ... } finally { ... }` (no `catch`), so an error thrown
 *    inside the `try` still runs the `finally` block before propagating out of this function
 *    unchanged.
 *
 * 6. `promptManager.setChatCompletion(chatCompletion)` -> SKIPPED ENTIRELY. This client call reads
 *    `chatCompletion.getMessages()` purely to update `PromptManager`-internal, UI-facing token-count
 *    display bookkeeping (`populateTokenCounts()` etc.) - it has no output this function's caller
 *    needs and no server-side equivalent state to update. Documented as a no-op, not forgotten.
 *
 * 7. `oai_settings.squash_system_messages` -> explicit `squashSystemMessages` boolean param (default
 *    `false`). Calls the already-ported `chatCompletion.squashSystemMessages()` (no extra args - it
 *    already has `tokenHandler` stored on the instance from construction) when `squashSystemMessages`
 *    is true AND `dryRun == false` - this LOOSE `==` comparison against the literal `false` is kept
 *    verbatim from the client (not tightened to `===`) even though `dryRun` here is typed/defaulted
 *    as a plain boolean; kept for exactness in case a caller ever passes `dryRun` as `0`/`''`/
 *    `undefined`/`null`, all of which are `== false` but not `=== false`, and the client's own check
 *    would treat identically.
 *
 * 8. `promptManager.render(false)` -> SKIPPED ENTIRELY. Pure UI rendering; no server-side equivalent.
 *
 * 9. `chat = chatCompletion.getChat()` -> calls the already-ported `ChatCompletion.getChat()`
 *    directly; this is the real, final output of the whole pipeline.
 *
 * 10. `eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, eventData)` -> NOT IMPLEMENTED, NOT
 *     STUBBED. This is the exact same category of undecided extension-hook design question already
 *     flagged (and left unresolved) by `src/final-prompt-combination.js`'s module doc comment for the
 *     text-completion path's `GENERATE_BEFORE_COMBINE_PROMPTS`/`GENERATE_AFTER_COMBINE_PROMPTS` hooks,
 *     and by `src/text-completion-prompt-orchestrator.js`'s own gap list (gap 5) for the same reason:
 *     there is no server-side extension-execution model (no event bus, no arbitrary-extension-JS
 *     execution) for this event to usefully reach. Whether the server needs an equivalent hook
 *     mechanism (a plugin API? a declarative override config?) is a real, undecided design question
 *     this task does not decide as a side effect of wiring these two orchestrators together - it is
 *     simply not implemented here, matching the established precedent's tone exactly.
 *
 * 11. `openai_messages_count` (a UI-facing global counter, `chat.filter(...).length`) -> NOT
 *     COMPUTED. It has no consumer this function's caller needs (nothing downstream of
 *     `prepareOpenAIMessages()` on the client ever reads it back through this function - it's a
 *     display-only global) - not returned, not computed as a side value.
 *
 * 12. RETURN SHAPE -> JUDGMENT CALL: the client returns the 2-tuple `[chat, promptManager.tokenHandler
 *     .counts]`. Since THIS function's own caller already supplies `tokenHandler` as a required param
 *     (see judgment call 2), they already have direct, no-extra-cost access to `tokenHandler.counts`
 *     without it being returned at all - but for closest interface parity with the client (and for
 *     symmetry with the early-return shape in judgment call 1, which is also an object rather than a
 *     tuple), this function still returns both values, as `{ chat, counts }` rather than a bare tuple.
 *     An object was chosen over a tuple for both return shapes because the two fields are given
 *     descriptive names once, at both return points, rather than relying on positional-tuple-order
 *     that a caller has to remember or a `// eslint-disable` destructuring comment has to explain.
 *
 * 13. `name2` -> ACCEPTED FOR INTERFACE PARITY, NEVER FORWARDED DIRECTLY. The client's top-level
 *     destructuring includes `name2`, but re-reading the REAL current signatures of both
 *     `preparePromptsForChatCompletion()` and `populateChatCompletion()` confirms neither one takes a
 *     bare `name2` param - on the client, every macro (`{{char}}` etc.) that would need it is resolved
 *     through the ambient `substituteParams()` singleton, which this porting effort's convention
 *     (src/macro-substitution.js's `SubstituteParamsContext`) instead threads through explicitly as
 *     the `macroContext` param already accepted by both downstream functions. So `name2` is accepted
 *     here (matching the task's exact documented deliverable signature) but is a deliberate no-op
 *     unless the caller has already folded it into `macroContext.name2` themselves - it is not
 *     silently dropped-and-forgotten, it is dropped-and-documented because there is nowhere real for
 *     it to go that isn't already covered by `macroContext`.
 *
 * Everything else - the full "caller resolves entities" parameter surface of
 * `preparePromptsForChatCompletion()` and `populateChatCompletion()` - is forwarded through
 * unmodified; see those two modules' own doc comments for what each option does.
 *
 * @typedef {import('./chat-completion-budget.js').TokenHandler} TokenHandler
 * @typedef {import('./chat-completion-budget.js').ChatCompletion} ChatCompletion
 * @typedef {import('./chat-completion-prepare-prompts.js').PreparePromptsForChatCompletionParams} PreparePromptsForChatCompletionParams
 * @typedef {import('./chat-completion-populate.js').PopulateChatCompletionOptions} PopulateChatCompletionOptions
 *
 * @typedef {object} PrepareOpenAIMessagesInput
 * @property {string} [name2] See judgment call 13 - accepted, not directly forwarded.
 * @property {string} [charDescription] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [charPersonality] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [scenario] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [worldInfoBefore] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [worldInfoAfter] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [bias] Forwarded to preparePromptsForChatCompletion() and populateChatCompletion().
 * @property {string} [type] Forwarded to preparePromptsForChatCompletion() and populateChatCompletion().
 * @property {string} [quietPrompt] Forwarded to preparePromptsForChatCompletion() and populateChatCompletion().
 * @property {*} [quietImage] Forwarded to populateChatCompletion() (never read there either - see that module's own scope boundary 2).
 * @property {Record<string, import('./chat-completion-system-prompts.js').ExtensionPromptInput>} [extensionPrompts] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [cyclePrompt] Forwarded to populateChatCompletion().
 * @property {string} [systemPromptOverride] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [jailbreakPromptOverride] Forwarded to preparePromptsForChatCompletion().
 * @property {object[]} messages Forwarded to populateChatCompletion() - MUTATED in place, see that module's own docs.
 * @property {object[][]} [messageExamples] Forwarded to populateChatCompletion().
 *
 * @property {boolean} [hasActiveCharacter] See judgment call 1. Default `true`.
 * @property {TokenHandler} tokenHandler REQUIRED. See judgment call 2.
 * @property {number} maxContext See judgment call 4.
 * @property {number} maxTokens See judgment call 4.
 * @property {boolean} [enableLogging] See judgment call 3. Default `false`.
 * @property {boolean} [squashSystemMessages] See judgment call 7. Default `false`.
 *
 * @property {string} [scenarioFormat] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [personalityFormat] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [groupNudgePrompt] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [impersonationPrompt] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [personaDescription] Forwarded to preparePromptsForChatCompletion().
 * @property {number} [personaDescriptionPosition] Forwarded to preparePromptsForChatCompletion().
 * @property {string} [wiFormat] Forwarded to preparePromptsForChatCompletion().
 * @property {import('./chat-completion-prompt-collection.js').RawPrompt[]} [prompts] Forwarded to preparePromptsForChatCompletion() as its own `prompts` param (the user's raw prompt-manager definitions).
 * @property {import('./chat-completion-prompt-collection.js').PromptOrderList[]} [promptOrder] Forwarded to preparePromptsForChatCompletion() and populateChatCompletion().
 * @property {string|number} [characterId] Forwarded to preparePromptsForChatCompletion() and populateChatCompletion().
 * @property {string[]} [groupMemberNames] Forwarded to preparePromptsForChatCompletion() only (populateChatCompletion() has no direct use for it - see that module's own params).
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext] Forwarded to preparePromptsForChatCompletion() and populateChatCompletion().
 *
 * @property {number} [toolBudgetTokens] Forwarded to populateChatCompletion(). Default `0`.
 * @property {boolean} [continuePrefill] Forwarded to populateChatCompletion(). Default `false`.
 * @property {boolean} [supportsAssistantPrefill] Forwarded to populateChatCompletion(). Default `false`.
 * @property {boolean} [namesInCompletion] Forwarded to populateChatCompletion(). Default `false`.
 * @property {string} [assistantPrefill] Forwarded to populateChatCompletion(). Default `''`.
 * @property {boolean} [pinExamples] Forwarded to populateChatCompletion(). Default `false`.
 * @property {import('./extension-prompt-table.js').ExtensionPromptTable} [injectionTable] Forwarded to populateChatCompletion() as its `injectionTable` option.
 * @property {import('./chat-completion-history.js').PopulateChatHistoryOptions} [historyOptions] Forwarded to populateChatCompletion().
 * @property {import('./chat-completion-dialogue-examples.js').PopulateDialogueExamplesOptions} [dialogueExamplesOptions] Forwarded to populateChatCompletion().
 */

/**
 * Server-side port of `prepareOpenAIMessages(input, dryRun)` - the top-level Chat Completion
 * prompt-assembly entry point. See the module doc comment above for the full scope-boundary/
 * judgment-call list, especially (5): errors thrown while preparing/populating the prompt PROPAGATE
 * to this function's own caller rather than being swallowed into a UI toast.
 *
 * @param {PrepareOpenAIMessagesInput} input
 * @param {boolean} [dryRun] Equivalent of the client's own `dryRun` param.
 * @returns {Promise<{chat: object[]|null, counts: Record<string, number>|false}>}
 */
export async function prepareOpenAIMessages({
    name2,
    charDescription, charPersonality, scenario, worldInfoBefore, worldInfoAfter, bias, type,
    quietPrompt, quietImage, extensionPrompts, cyclePrompt, systemPromptOverride, jailbreakPromptOverride,
    messages, messageExamples,
    hasActiveCharacter = true,
    tokenHandler,
    maxContext, maxTokens,
    enableLogging = false,
    squashSystemMessages = false,
    scenarioFormat, personalityFormat, groupNudgePrompt, impersonationPrompt,
    personaDescription, personaDescriptionPosition, wiFormat,
    prompts, promptOrder, characterId, groupMemberNames = [],
    macroContext = {},
    toolBudgetTokens = 0,
    continuePrefill = false,
    supportsAssistantPrefill = false,
    namesInCompletion = false,
    assistantPrefill = '',
    pinExamples = false,
    injectionTable = {},
    historyOptions = {},
    dialogueExamplesOptions = {},
} = {}, dryRun = false) {
    void name2; // See judgment call 13 - accepted for interface parity, never forwarded directly.

    // ---- Early-return guard (judgment call 1) --------------------------------------------------
    if (!hasActiveCharacter && dryRun) {
        return { chat: null, counts: false };
    }

    if (typeof tokenHandler === 'undefined' || tokenHandler === null) {
        throw new Error('prepareOpenAIMessages: tokenHandler is required');
    }

    const chatCompletion = new ChatCompletion(tokenHandler);
    if (enableLogging) chatCompletion.enableLogging();
    chatCompletion.setTokenBudget(maxContext, maxTokens);

    try {
        const preparedPrompts = preparePromptsForChatCompletion({
            scenario, charPersonality, worldInfoBefore, worldInfoAfter, charDescription,
            quietPrompt, bias, extensionPrompts, systemPromptOverride, jailbreakPromptOverride, type,
            scenarioFormat, personalityFormat, groupNudgePrompt, impersonationPrompt,
            personaDescription, personaDescriptionPosition, wiFormat, macroContext,
            prompts, promptOrder, characterId, groupMemberNames,
        });

        await populateChatCompletion(preparedPrompts, chatCompletion, {
            bias, quietPrompt, quietImage, type, cyclePrompt, messages, messageExamples,
            promptOrder, characterId,
            toolBudgetTokens, continuePrefill, supportsAssistantPrefill, namesInCompletion,
            assistantPrefill, pinExamples, injectionTable, macroContext, tokenHandler,
            historyOptions, dialogueExamplesOptions,
        });
    } finally {
        // promptManager.setChatCompletion(chatCompletion) - UI-only bookkeeping, skipped (judgment
        // call 6). Runs even when the try block threw, matching the client's own `finally` guarantee
        // (judgment call 5) - EXCEPT for the two steps below, which the client itself only performs
        // when it reaches the (equivalent of the) `finally` block at all - which it always does, same
        // as here.
        if (squashSystemMessages && dryRun == false) { // eslint-disable-line eqeqeq -- see judgment call 7: loose comparison kept verbatim from the client.
            await chatCompletion.squashSystemMessages();
        }
        // promptManager.render(false) - pure UI rendering, skipped (judgment call 8).
    }

    // eventSource.emit(CHAT_COMPLETION_PROMPT_READY, ...) - not implemented, see judgment call 10.
    // openai_messages_count - not computed, see judgment call 11.

    const chat = chatCompletion.getChat();
    return { chat, counts: tokenHandler.counts };
}
