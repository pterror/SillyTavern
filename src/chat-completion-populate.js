import { Message, MessageCollection } from './chat-completion-budget.js';
import { Prompt, INJECTION_POSITION, isPromptDisabledForCharacter } from './chat-completion-prompt-collection.js';
import { populateInjectionPrompts } from './chat-completion-injection-prompts.js';
import { populateChatHistory, sanitizeChatCompletionName } from './chat-completion-history.js';
import { populateDialogueExamples } from './chat-completion-dialogue-examples.js';
import { substituteParams } from './macro-substitution.js';

/**
 * Server-side port of public/scripts/chat-completion-settings.js's
 * `populateChatCompletion(prompts, chatCompletion, {bias, quietPrompt, quietImage, type,
 * cyclePrompt, messages, messageExamples})` - the TOP-LEVEL orchestrator that ties together every
 * other already-ported piece of the Chat Completion (`main_api === 'openai'`) prompt-assembly
 * pipeline: `src/chat-completion-budget.js` (`Message`/`MessageCollection`/`ChatCompletion`),
 * `src/chat-completion-prompt-collection.js` (`Prompt`/`PromptCollection`/`INJECTION_POSITION`/
 * `isPromptDisabledForCharacter`), `src/chat-completion-injection-prompts.js`
 * (`populateInjectionPrompts` - client calls it `populationInjectionPrompts`, kept renamed per an
 * earlier port's naming fix), `src/chat-completion-history.js` (`populateChatHistory`,
 * `sanitizeChatCompletionName`), and `src/chat-completion-dialogue-examples.js`
 * (`populateDialogueExamples`). None of those are reimplemented here - only called.
 *
 * SCOPE BOUNDARIES / JUDGMENT CALLS (every one from the task instructions, plus this port's own
 * decisions):
 *
 * 1. `promptManager.isPromptDisabledForActiveCharacter(source)` -> the already-ported
 *    `isPromptDisabledForCharacter(promptOrder, characterId, identifier)`. This function therefore
 *    takes explicit `promptOrder`/`characterId` params (see `PopulateChatCompletionOptions`).
 *
 * 2. `quietPromptMessage.addImage(quietImage)` is NOW WIRED FOR REAL, using the real
 *    `Message.addImage` ported in chat-completion-budget.js and the same
 *    `imageInlining`-as-caller-supplied-boolean convention wired into
 *    chat-completion-history.js's media inlining. `isImageInliningSupported()` itself (the
 *    CAPABILITY PREDICATE) remains OUT OF SCOPE - a real, separate settings/capability-resolution
 *    concern - so this function takes the already-resolved `imageInlining` boolean (default
 *    `false`) instead of calling it. When `imageInlining` is true and `quietImage` is provided,
 *    `quietPromptMessage.addImage(quietImage, {quality: imageQuality, chatCompletionSource,
 *    directories})` is called before `quietPromptMessage` is added to `controlPrompts` (mirroring
 *    the client's exact call site, inside the same `if (quietPromptMessage &&
 *    quietPromptMessage.content)` guard). This is the new, narrower remaining gap - only the
 *    capability predicate is not ported, the inlining itself is real.
 *
 * 3. `ToolManager.canPerformToolCalls(type)` / `ToolManager.registerFunctionToolsOpenAI(toolData)` /
 *    the whole tool-budget-preallocation block - OUT OF SCOPE (ToolManager subsystem). Replaced with
 *    a single optional pre-resolved `toolBudgetTokens` (number, default `0`) param: this function
 *    calls `chatCompletion.reserveBudget(toolBudgetTokens)` ONLY when `toolBudgetTokens > 0`,
 *    mirroring the client's `ToolManager.canPerformToolCalls(type) === false` no-op branch exactly
 *    when a caller has no tool-calling support and passes `0`/omits the param.
 *
 * 4. `oai_settings.continue_prefill` -> `continuePrefill` (boolean), matching
 *    `src/chat-completion-history.js`'s existing param name for the identical setting.
 *
 * 5. `oai_settings.chat_completion_source === chat_completion_sources.CLAUDE` -> taken as the
 *    ALREADY-COMPUTED boolean `supportsAssistantPrefill` param (client's own local variable name) -
 *    this function does not resolve `chat_completion_sources`/`oai_settings.chat_completion_source`
 *    itself.
 *
 * 6. `oai_settings.names_behavior === character_names_behavior.COMPLETION` -> JUDGMENT CALL: this
 *    port takes the pre-computed boolean `namesInCompletion` directly (rather than a raw
 *    `namesBehavior` enum value it would compare itself), for consistency with how this exact
 *    boolean is threaded as a single flag in the surrounding continue-prefill block (the client's
 *    own `namesInCompletion` local variable name is reused verbatim as the param name). This is a
 *    narrower need than `chat-completion-history.js`'s `namesBehavior` param, which is compared
 *    against `character_names_behavior.COMPLETION` in TWO places in that module (turn names AND
 *    tool-call-reconstruction paths) - here the ONLY use is this single `===` check the client
 *    itself hoists into a boolean before using it, so taking the already-computed boolean avoids
 *    pulling in the `character_names_behavior` enum for a single comparison this function's own
 *    caller has almost certainly already made (e.g. right before calling `populateChatHistory`,
 *    which needs the raw enum value anyway).
 *
 * 7. `oai_settings.assistant_prefill` -> `assistantPrefill` (raw, pre-`substituteParams`) - this
 *    function performs the `substituteParams` step itself, matching the client's exact conditional:
 *    `isAssistantRole && supportsAssistantPrefill ? substituteParams(...) : ''`.
 *
 * 8. `promptManager.sanitizeName(...)` -> reuses the already-ported `sanitizeChatCompletionName`
 *    from `src/chat-completion-history.js` (not reimplemented).
 *
 * 9. `power_user.pin_examples` -> `pinExamples` boolean param.
 *
 * 10. `promptManager.log(...)` debug calls inside `addToChatCompletion` - dropped entirely (no
 *     server equivalent), matching how console.log-only debug lines were handled elsewhere.
 *
 * 11. `populationInjectionPrompts` (client name) -> calls the already-committed
 *     `populateInjectionPrompts(absolutePrompts, messages, {table, macroContext})` - note its real
 *     signature takes an OPTIONS OBJECT for `table`/`macroContext`, not the client's simple
 *     2-positional-arg call `populationInjectionPrompts(absolutePrompts, messages)`. This function
 *     forwards `injectionTable`/`macroContext` options through to it.
 *
 * 12. `populateChatHistory`/`populateDialogueExamples` OPTION-FORWARDING SHAPE - JUDGMENT CALL:
 *     both take large options objects with many explicit params. To avoid a single flat 30+-key
 *     options object on THIS function (which would make it unclear which option belongs to which
 *     downstream call, and would collide on the couple of option names that are genuinely shared -
 *     `tokenHandler`, `macroContext`, `type`, `cyclePrompt`, `continuePrefill`), this port groups
 *     each downstream call's OWN options into a nested sub-object - `historyOptions` (forwarded
 *     as-is, spread, into `populateChatHistory`'s options) and `dialogueExamplesOptions` (forwarded
 *     as-is into `populateDialogueExamples`'s options) - while options this orchestrator itself
 *     needs directly (`type`, `cyclePrompt`, `tokenHandler`, `macroContext`, `continuePrefill`) stay
 *     top-level params, and are ALSO auto-merged into `historyOptions`/`dialogueExamplesOptions`
 *     before forwarding (nested options win on conflict, since a caller who explicitly nests a
 *     value is assumed to want to override the shared top-level one for that specific downstream
 *     call). This keeps the common case (single `tokenHandler`/`macroContext`/`type`/`cyclePrompt`
 *     shared by everything) a single top-level param each, while still allowing full control over
 *     every one of `populateChatHistory`'s/`populateDialogueExamples`'s many other options via the
 *     nested bags.
 *
 * 13. `structuredClone`/`new Prompt(prompt)` in `injectToMain`'s absolute-prompt-splice fallback -
 *     ported verbatim, including the exact `position === 'end' ? indexOfMain + 1 : indexOfMain`
 *     splice-index math (see the function body below) - confirmed unchanged from the client.
 *
 * 14. Return value - JUDGMENT CALL: the client reassigns its own local `messages` variable from
 *     `populationInjectionPrompts()`'s return value and passes the UPDATED value into
 *     `populateChatHistory`/`populateDialogueExamples`, but never reads `messages` again itself
 *     (its caller, `prepareOpenAIMessages`, never reads it back either). This port still RETURNS
 *     `{ messages }` (the post-injection value) purely for testability - nothing in this module's
 *     own control flow depends on the return value being read.
 *
 * DELIBERATELY NOT PORTED: `isImageInliningSupported()` (the capability predicate underlying #2 -
 * the inlining itself is now real, see #2 above) and the ToolManager tool-budget pre-allocation
 * internals (#3) - see above; both are permanent, already-documented gaps elsewhere in this
 * porting effort, not TODOs.
 *
 * @typedef {import('./chat-completion-budget.js').ChatCompletion} ChatCompletion
 * @typedef {import('./chat-completion-budget.js').TokenHandler} TokenHandler
 * @typedef {import('./chat-completion-prompt-collection.js').PromptCollection} PromptCollection
 * @typedef {import('./chat-completion-prompt-collection.js').PromptOrderList} PromptOrderList
 * @typedef {import('./macro-substitution.js').SubstituteParamsContext} SubstituteParamsContext
 *
 * @typedef {object} PopulateChatCompletionOptions
 * @property {string} [bias] Equivalent of the client's `bias` param - only added if non-empty after trim.
 * @property {string} [quietPrompt] Unused directly here (forwarded implicitly via `prompts.get('quietPrompt')`); kept for interface parity with the client's destructured param list.
 * @property {string} [quietImage] Image to inline into the quiet-prompt message when `imageInlining` is true - see scope boundary #2.
 * @property {boolean} [imageInlining] Replaces the client's `isImageInliningSupported()` result - see scope boundary #2. Default `false`.
 * @property {string} [imageQuality] Mirrors `oai_settings.inline_image_quality`, forwarded to `quietPromptMessage.addImage`. Default `'auto'`.
 * @property {string} [chatCompletionSource] Mirrors `oai_settings.chat_completion_source`, forwarded to `quietPromptMessage.addImage`.
 * @property {{userImages?: string}} [directories] Forwarded to `quietPromptMessage.addImage` for resolving local relative attachment paths.
 * @property {string} [type] Generation type (e.g. `'impersonate'`, `'continue'`, or other/`null` for normal generation).
 * @property {string} [cyclePrompt] Forwarded to `populateChatHistory` (only relevant for `type === 'continue'`).
 * @property {object[]} messages Chat-history messages, newest-first per `populateInjectionPrompts`'s documented input convention. MUTATED in place by the continue-prefill branch (`.shift()` removes the displaced message), matching the client exactly and matching the established precedent in `populateChatHistory` (which also mutates its own `messages` param in place). The RETURN VALUE of this function (`{messages}`) is the post-`populateInjectionPrompts` value, which is a NEW array (that helper never mutates its input) - see judgment call #14.
 * @property {object[][]} [messageExamples] Forwarded to `populateDialogueExamples`.
 * @property {PromptOrderList[]} [promptOrder] See scope boundary #1.
 * @property {string|number} [characterId] See scope boundary #1.
 * @property {number} [toolBudgetTokens] See scope boundary #3. Default `0` (no-op, matching `ToolManager.canPerformToolCalls(type) === false`).
 * @property {boolean} [continuePrefill] See scope boundary #4.
 * @property {boolean} [supportsAssistantPrefill] See scope boundary #5.
 * @property {boolean} [namesInCompletion] See scope boundary #6.
 * @property {string} [assistantPrefill] See scope boundary #7.
 * @property {boolean} [pinExamples] See scope boundary #9.
 * @property {import('./extension-prompt-table.js').ExtensionPromptTable} [injectionTable] Forwarded to `populateInjectionPrompts` as its `table` option.
 * @property {SubstituteParamsContext} [macroContext] Forwarded to `populateInjectionPrompts`/`populateChatHistory`/`populateDialogueExamples`, and merged into `historyOptions`/`dialogueExamplesOptions` (see scope boundary #12).
 * @property {TokenHandler} tokenHandler Injected token handler, forwarded to every `Message.fromPromptAsync`/`Message.createAsync` call, and merged into `historyOptions`/`dialogueExamplesOptions`.
 * @property {import('./chat-completion-history.js').PopulateChatHistoryOptions} [historyOptions] Extra options forwarded to `populateChatHistory` (see scope boundary #12); `type`/`cyclePrompt`/`continuePrefill`/`tokenHandler`/`macroContext` are auto-merged in (nested values win on conflict).
 * @property {import('./chat-completion-dialogue-examples.js').PopulateDialogueExamplesOptions} [dialogueExamplesOptions] Extra options forwarded to `populateDialogueExamples` (see scope boundary #12); `tokenHandler`/`macroContext` are auto-merged in (nested values win on conflict).
 */

/**
 * Server-side port of `populateChatCompletion(prompts, chatCompletion, options)`. See the module doc
 * comment for the full scope-boundary/judgment-call list.
 *
 * Mutates `chatCompletion` in place. Returns `{ messages }` - the post-`populateInjectionPrompts`
 * value - purely for testability; see judgment call #14 (nothing in this module reads it back).
 *
 * @param {PromptCollection} prompts
 * @param {ChatCompletion} chatCompletion
 * @param {PopulateChatCompletionOptions} options
 * @returns {Promise<{messages: object[]}>}
 */
export async function populateChatCompletion(prompts, chatCompletion, {
    bias = '',
    quietPrompt,
    quietImage,
    imageInlining = false,
    imageQuality = 'auto',
    chatCompletionSource,
    directories,
    type = null,
    cyclePrompt = null,
    messages,
    messageExamples,
    promptOrder = [],
    characterId,
    toolBudgetTokens = 0,
    continuePrefill = false,
    supportsAssistantPrefill = false,
    namesInCompletion = false,
    assistantPrefill = '',
    pinExamples = false,
    injectionTable = {},
    macroContext = {},
    tokenHandler,
    historyOptions = {},
    dialogueExamplesOptions = {},
} = {}) {
    void quietPrompt; // documented-only, see PopulateChatCompletionOptions JSDoc

    const addToChatCompletion = async (source, target = null) => {
        if (false === prompts.has(source)) return;
        if (isPromptDisabledForCharacter(promptOrder, characterId, source) && source !== 'main') return;
        const prompt = prompts.get(source);
        if (prompt.injection_position === INJECTION_POSITION.ABSOLUTE) return;
        const index = target ? prompts.index(target) : prompts.index(source);
        const collection = new MessageCollection(source);
        const message = await Message.fromPromptAsync(prompt, tokenHandler);
        collection.add(message);
        chatCompletion.add(collection, index);
    };

    chatCompletion.reserveBudget(3); // every reply is primed with <|start|>assistant<|message|>
    await addToChatCompletion('worldInfoBefore');
    await addToChatCompletion('main');
    await addToChatCompletion('worldInfoAfter');
    await addToChatCompletion('charDescription');
    await addToChatCompletion('charPersonality');
    await addToChatCompletion('scenario');
    await addToChatCompletion('personaDescription');

    chatCompletion.setOverriddenPrompts(prompts.overriddenPrompts);
    const controlPrompts = new MessageCollection('controlPrompts');

    // Matches the client exactly: `prompts.get('impersonate')`/`prompts.get('quietPrompt')` are
    // assumed present (the client's own `Message.fromPromptAsync` would throw on `undefined.role`
    // otherwise, since `Message.createAsync` always resolves to a real object - the client's
    // `?? null` after `fromPromptAsync(...)` is dead defensive code, never actually reachable).
    // Callers of this port must likewise ensure `prompts` always carries both identifiers.
    const impersonateMessage = await Message.fromPromptAsync(prompts.get('impersonate'), tokenHandler) ?? null;
    if (type === 'impersonate') controlPrompts.add(impersonateMessage);

    const quietPromptMessage = await Message.fromPromptAsync(prompts.get('quietPrompt'), tokenHandler) ?? null;
    if (quietPromptMessage && quietPromptMessage.content) {
        // Image inlining - see scope boundary #2. `isImageInliningSupported()` itself remains out
        // of scope; `imageInlining` is the caller-resolved boolean standing in for it.
        if (imageInlining && quietImage) {
            await quietPromptMessage.addImage(quietImage, { quality: imageQuality, chatCompletionSource, directories });
        }
        controlPrompts.add(quietPromptMessage);
    }

    chatCompletion.reserveBudget(controlPrompts);

    const systemPrompts = ['nsfw', 'jailbreak'];
    const userRelativePrompts = prompts.collection
        .filter((prompt) => false === prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE)
        .reduce((acc, prompt) => { acc.push(prompt.identifier); return acc; }, []);
    const absolutePrompts = prompts.collection
        .filter((prompt) => prompt.injection_position === INJECTION_POSITION.ABSOLUTE)
        .reduce((acc, prompt) => { acc.push(prompt); return acc; }, []);

    for (const identifier of [...systemPrompts, ...userRelativePrompts]) await addToChatCompletion(identifier);

    if (prompts.has('enhanceDefinitions')) await addToChatCompletion('enhanceDefinitions');
    if (bias && bias.trim().length) await addToChatCompletion('bias');

    const injectToMain = async (prompt, position) => {
        if (chatCompletion.has('main')) {
            const message = await Message.fromPromptAsync(prompt, tokenHandler);
            chatCompletion.insert(message, 'main', position);
        } else {
            const indexOfMain = absolutePrompts.findIndex(p => p.identifier === 'main');
            if (indexOfMain >= 0) {
                const main = absolutePrompts[indexOfMain];
                const promptCopy = new Prompt(prompt);
                promptCopy.role = main.role;
                promptCopy.injection_position = main.injection_position;
                promptCopy.injection_depth = main.injection_depth;
                promptCopy.injection_order = main.injection_order;
                const newIndex = position === 'end' ? indexOfMain + 1 : indexOfMain;
                absolutePrompts.splice(newIndex, 0, promptCopy);
            }
        }
    };

    const knownPrompts = ['summary', 'authorsNote', 'vectorsMemory', 'vectorsDataBank', 'smartContext'];
    for (const key of knownPrompts) {
        if (prompts.has(key)) {
            const prompt = prompts.get(key);
            if (prompt.position) await injectToMain(prompt, prompt.position);
        }
    }
    for (const prompt of prompts.collection.filter(p => p.extension && p.position)) await injectToMain(prompt, prompt.position);

    // TOOL BUDGET PRE-ALLOCATION - see scope boundary #3. The ToolManager subsystem itself (deciding
    // whether tool calls can be performed, and building/counting the tool-definitions message) is out
    // of scope; a caller who has already resolved that elsewhere passes the resulting token count in
    // as `toolBudgetTokens`, mirroring `ToolManager.canPerformToolCalls(type) === false`'s no-op.
    if (toolBudgetTokens > 0) {
        chatCompletion.reserveBudget(toolBudgetTokens);
    }

    // CONTINUE-PREFILL DISPLACEMENT - mutates the caller's `messages` array via `.shift()`, matching
    // the client exactly (and matching the established precedent in `populateChatHistory`, which
    // likewise mutates its own `messages` param in place via `.splice()`).
    if (type === 'continue' && continuePrefill && messages.length) {
        const chatMessage = messages.shift();
        const isAssistantRole = chatMessage.role === 'assistant';
        const prefill = isAssistantRole && supportsAssistantPrefill ? substituteParams(assistantPrefill, macroContext) : '';
        const messageContent = [prefill, chatMessage.content].filter(x => x).join('\n\n');
        const continueMessage = await Message.createAsync(chatMessage.role, messageContent, 'continuePrefill', tokenHandler);
        if (chatMessage.name && namesInCompletion) await continueMessage.setName(sanitizeChatCompletionName(chatMessage.name), tokenHandler);
        controlPrompts.add(continueMessage);
        chatCompletion.reserveBudget(continueMessage);
    }

    let workingMessages = populateInjectionPrompts(absolutePrompts, messages, { table: injectionTable, macroContext });

    const sharedHistoryOptions = { type, cyclePrompt, continuePrefill, tokenHandler, macroContext, ...historyOptions };
    const sharedDialogueExamplesOptions = { tokenHandler, macroContext, ...dialogueExamplesOptions };

    if (pinExamples) {
        await populateDialogueExamples(prompts, chatCompletion, messageExamples, sharedDialogueExamplesOptions);
        await populateChatHistory(workingMessages, prompts, chatCompletion, sharedHistoryOptions);
    } else {
        await populateChatHistory(workingMessages, prompts, chatCompletion, sharedHistoryOptions);
        await populateDialogueExamples(prompts, chatCompletion, messageExamples, sharedDialogueExamplesOptions);
    }

    chatCompletion.freeBudget(controlPrompts);
    if (controlPrompts.collection.length) chatCompletion.add(controlPrompts);

    return { messages: workingMessages };
}
