import { Message, MessageCollection } from './chat-completion-budget.js';
import { Prompt, preparePrompt } from './chat-completion-prompt-collection.js';
import { substituteParams } from './macro-substitution.js';
import { character_names_behavior } from './chat-completion-messages.js';

/** @enum {string} Mirrors public/scripts/constants.js's MEDIA_DISPLAY (verified by direct read). */
const MEDIA_DISPLAY = {
    LIST: 'list',
    GALLERY: 'gallery',
};

/** @enum {string} Mirrors public/scripts/constants.js's MEDIA_TYPE (verified by direct read - only
 *  the plain string values are needed here, not the `getFromMime` helper). */
const MEDIA_TYPE = {
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
};

/**
 * Server-side port of public/scripts/chat-completion-settings.js's
 * `populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt)` (~lines 880-1057) -
 * the largest orchestrator in the Chat Completion (`main_api === 'openai'`) prompt-assembly
 * pipeline. It builds the `'chatHistory'` `MessageCollection` in the budget-aware, insert-from-the-
 * end-until-it-doesn't-fit way the client does: newest message first, walking backwards, each
 * accepted message `insertAtStart`-ed so the final order comes out chronological again.
 *
 * Reuses ALREADY-PORTED pieces verbatim: `Message`/`MessageCollection` (src/chat-completion-budget.js,
 * including `Message.setToolCalls` for tool-call reconstruction), `Prompt`/`preparePrompt`
 * (src/chat-completion-prompt-collection.js), `substituteParams` (src/macro-substitution.js), and the
 * `character_names_behavior` enum (src/chat-completion-messages.js) - none of these are redeclared
 * here.
 *
 * DIFFERENCE FROM THE CLIENT, BY DESIGN ("caller resolves entities" - the same convention used by
 * every module ported this session): the client closes over a long list of module-level globals.
 * This port takes each of them as an explicit option instead:
 * - `selected_group` (truthiness) -> `isGroup` (boolean).
 * - `oai_settings.new_chat_prompt` / `.new_group_chat_prompt` -> `newChatPrompt` / `newGroupChatPrompt`
 *   (raw, pre-`substituteParams` values - this function still does the `substituteParams` step
 *   itself, matching the client).
 * - `oai_settings.continue_prefill` -> `continuePrefill`.
 * - `oai_settings.continue_nudge_prompt` -> `continueNudgePrompt` (raw). See the JUDGMENT CALL below
 *   for the `substituteParamsExtended(..., {lastChatMessage})` translation.
 * - `oai_settings.send_if_empty` -> `sendIfEmpty`.
 * - `promptManager.serviceSettings.names_behavior` -> `namesBehavior` (compared against the
 *   already-mirrored `character_names_behavior` enum).
 * - `promptManager.isValidName`/`.sanitizeName` (PromptManager.js ~1380-1388) -> ported directly
 *   into this module as `isValidChatCompletionName`/`sanitizeChatCompletionName` (see exports below)
 *   since no other ported module owns OpenAI name validation yet. Ported verbatim: the validity
 *   regex is `^[a-zA-Z0-9_]{1,64}$`; sanitization replaces every non-matching character with `_`
 *   then truncates to 64 chars (the truncation happens on the ALREADY-replaced string, matching
 *   `name.replace(...).substring(0, 64)`'s left-to-right evaluation).
 * - `ToolManager.isToolCallingSupported()` -> `canUseTools` (boolean).
 * - `isReasoningSignatureSupported()` -> `includeSignature` (boolean).
 * - `interleaved_reasoning_providers.includes(oai_settings.chat_completion_source)` combined with
 *   `getEffectiveToolReasoningMode()` -> `toolReasoningMode` (one of the `tool_reasoning_modes`
 *   values mirrored below - the caller is responsible for resolving both the provider allowlist
 *   check and the effective-mode logic and collapsing them into a single already-resolved value,
 *   exactly as the client's own `isToolReasoningProvider ? getEffectiveToolReasoningMode() :
 *   tool_reasoning_modes.DISABLED` ternary does before this function ever runs).
 * - `includeToolReasoning` (`toolReasoningMode !== tool_reasoning_modes.DISABLED` on the client) is
 *   ALSO taken as an explicit param rather than re-derived here, since the task's documented
 *   deliverable signature lists it separately - callers should pass
 *   `toolReasoningMode !== TOOL_REASONING_MODES.DISABLED` (re-derivation would be redundant with the
 *   client's own math, not a divergence).
 * - `promptManager.preparePrompt(prompt)` -> the ALREADY-PORTED `preparePrompt(prompt, options)` from
 *   src/chat-completion-prompt-collection.js. The client calls it with zero extra options at every
 *   call site in this function (no `original`, no explicit group override) - this port forwards
 *   `{ macroContext }` only (see that module's own JSDoc for why `macroContext` exists as an
 *   extension point beyond the client's literal call shape). `groupMemberNames` is NOT threaded
 *   through here (the task's documented option list has no such param), matching the client's
 *   actual call sites, which likewise pass no group override in this function specifically (unlike
 *   `getPromptCollection`, which does resolve group members elsewhere).
 *
 * JUDGMENT CALL - `substituteParamsExtended(oai_settings.continue_nudge_prompt, {lastChatMessage:
 * String(cyclePrompt).trim()})`: the client's `substituteParamsExtended` (public/script.js) is a
 * distinct function from `substituteParams` - it forwards its second argument as
 * `evaluateMacros`'s `additionalMacro` (an extension-registered-macro bag), which the
 * ALREADY-PORTED `substituteParams(content, context)` exposes as `context.dynamicMacros` (see
 * src/macro-substitution.js's `SubstituteParamsContext` typedef: "`dynamicMacros` - Extra macros,
 * checked after the built-in environment (same precedence as the client's additionalMacro)"). So
 * this port calls `substituteParams(continueNudgePrompt, { ...macroContext, dynamicMacros: {
 * ...macroContext.dynamicMacros, lastChatMessage: String(cyclePrompt).trim() } })` - translating the
 * client's one-off `substituteParamsExtended` call into the ported module's `dynamicMacros` escape
 * hatch, which is documented as having exactly this precedence/purpose. Not a guess: verified
 * against src/macro-substitution.js's real JSDoc and implementation before writing this.
 *
 * JUDGMENT CALL - `tool_reasoning_modes` enum values (verified by reading
 * public/scripts/chat-completion-settings.js ~line 255-259 directly, not guessed):
 * ```js
 * export const tool_reasoning_modes = {
 *     DISABLED: 'disabled',
 *     SINCE_LAST_USER: 'since_last_user',
 *     ACTIVE_CHAIN: 'active_chain',
 * };
 * ```
 * Mirrored verbatim below as `TOOL_REASONING_MODES`.
 *
 * The tool-call reconstruction branch (`canUseTools && Array.isArray(chatPrompt.invocations)`) is
 * ported in FULL, including both the `ACTIVE_CHAIN` and `SINCE_LAST_USER` reasoning-forwarding
 * walk-back loops, which are genuinely different algorithms and are NOT merged/simplified here:
 * - `ACTIVE_CHAIN` walks backward from `promptIdx - 1` and stops at the FIRST message that is
 *   neither a `tool`-role message nor an assistant message that itself carries `.invocations`
 *   (i.e. it skips over the immediately-preceding tool-call/tool-result chain but stops the moment
 *   it hits anything else) - only if THAT stopping message happens to be assistant text does it take
 *   the message's `.reasoning`; otherwise `previousAssistantReasoning` stays `''`. This is a
 *   "nearest boundary, one shot" algorithm.
 * - `SINCE_LAST_USER` walks backward across the ENTIRE range down to (exclusive) `lastUserIdx`,
 *   skipping every non-assistant-text message, and takes the FIRST assistant-text message it finds
 *   that has a non-empty `.reasoning` (skipping assistant-text messages with empty reasoning and
 *   continuing the walk) - a "first non-empty reasoning anywhere since the last user turn"
 *   algorithm.
 * These produce different results whenever an assistant-text message sits between two tool-call
 * rounds with `.reasoning` present on an earlier boundary but not the nearest one (or vice versa) -
 * see chat-completion-history.test.js's dedicated fixture proving the two modes diverge on the same
 * message history.
 *
 * MEDIA INLINING (`inlineMediaAttachment`/`chatPrompt.media`/`.mediaDisplay`/`.mediaIndex`): NOW
 * REAL, wired to the real `Message.addImage`/`addVideo`/`addAudio` ported in
 * src/chat-completion-budget.js (that module's own doc comment's earlier "no server-side
 * image/video/audio processing pipeline exists" claim is now FALSE and has been corrected there -
 * the pipeline exists and this function calls it). Per prompt, for `chatPrompt.media` entries:
 * `MEDIA_DISPLAY.LIST` inlines every entry, `MEDIA_DISPLAY.GALLERY` inlines only
 * `chatPrompt.media[chatPrompt.mediaIndex]`; each entry's `.type` (defaulting to
 * `MEDIA_TYPE.IMAGE` when falsy, matching the client) picks `addImage`/`addVideo`/`addAudio`,
 * gated respectively by the caller-supplied `imageInlining`/`videoInlining`/`audioInlining`
 * booleans (see "caller resolves entities" below).
 *
 * DELIBERATELY NOT PORTED (explicit, permanent gaps - see task instructions):
 * 1. `isImageInliningSupported()`/`isVideoInliningSupported()`/`isAudioInliningSupported()` (the
 *    CAPABILITY PREDICATES that decide whether media inlining is even possible for the current
 *    chat-completion source/model) are NOT ported - a real, separate settings/capability-resolution
 *    concern, analogous to how `canUseTools`/`includeSignature`/`toolReasoningMode` below are
 *    likewise caller-resolved rather than re-derived here. Callers must resolve
 *    `imageInlining`/`videoInlining`/`audioInlining` themselves (mirroring the client's own
 *    `const imageInlining = isImageInliningSupported();` etc.) and pass them in as plain
 *    already-resolved booleans (default `false`). This is the new, narrower remaining gap -
 *    the actual inlining logic itself is fully wired, only the capability predicates are not.
 * 2. `ToolManager.isToolCallingSupported()`, `isReasoningSignatureSupported()`,
 *    `interleaved_reasoning_providers.includes(...)`, and `getEffectiveToolReasoningMode()` are NOT
 *    ported - real, separate settings/capability-resolution concerns (model-name allowlists, a
 *    whole `ToolManager` subsystem) explicitly out of scope for this task. Callers must resolve
 *    `canUseTools`/`includeSignature`/`toolReasoningMode`/`includeToolReasoning` themselves and pass
 *    them in as plain, already-resolved values.
 *
 * @typedef {import('./chat-completion-budget.js').TokenHandler} TokenHandler
 * @typedef {import('./chat-completion-budget.js').ChatCompletion} ChatCompletion
 * @typedef {import('./chat-completion-prompt-collection.js').PromptCollection} PromptCollection
 * @typedef {import('./macro-substitution.js').SubstituteParamsContext} SubstituteParamsContext
 *
 * @typedef {object} ToolInvocation
 * @property {string} id
 * @property {string} name
 * @property {any} [parameters]
 * @property {string} [result]
 * @property {string} [signature]
 * @property {string} [reasoning]
 *
 * @typedef {object} ChatHistoryMessage A single already-resolved chat-history turn, matching the
 *  shape the client's `messages` array elements have by the time `populateChatHistory` runs (i.e.
 *  after `Generate()`'s own earlier `chat2`-to-`{role, content, ...}` mapping, which is out of
 *  scope for this module).
 * @property {string} role
 * @property {string} [content]
 * @property {string} [name]
 * @property {boolean} [injected] Whether this turn was injected (e.g. author's note/world info at
 *  depth) rather than a real chat turn - `findLastIndex(x => !x.injected)` skips these when looking
 *  for the continue-nudge splice target.
 * @property {string} [identifier]
 * @property {string} [signature]
 * @property {string} [reasoning]
 * @property {ToolInvocation[]} [invocations] When present (and `canUseTools`), this turn is
 *  reconstructed as a tool-call message plus one tool-result message per invocation instead of a
 *  plain text message.
 *
 * @typedef {object} PopulateChatHistoryOptions
 * @property {string} [type] Generation type (e.g. `'continue'`, `'impersonate'`, or `null`/other for normal generation).
 * @property {string} [cyclePrompt] The in-flight user input for a `'continue'` generation; only used when `type === 'continue'`.
 * @property {boolean} [isGroup] Replaces the client's `selected_group` truthiness check.
 * @property {string} [newChatPrompt] Raw (pre-`substituteParams`) `oai_settings.new_chat_prompt` equivalent, used when `!isGroup`.
 * @property {string} [newGroupChatPrompt] Raw (pre-`substituteParams`) `oai_settings.new_group_chat_prompt` equivalent, used when `isGroup`.
 * @property {boolean} [continuePrefill] Replaces `oai_settings.continue_prefill`.
 * @property {string} [continueNudgePrompt] Raw `oai_settings.continue_nudge_prompt` equivalent; substituted with a one-off `{{lastChatMessage}}` dynamic macro - see the module doc comment's JUDGMENT CALL.
 * @property {string} [sendIfEmpty] Replaces `oai_settings.send_if_empty`.
 * @property {number} [namesBehavior] One of `character_names_behavior`'s values (src/chat-completion-messages.js), replaces `promptManager.serviceSettings.names_behavior`.
 * @property {boolean} [imageInlining] Replaces the client's `isImageInliningSupported()` result - see "DELIBERATELY NOT PORTED" #1. Default `false`.
 * @property {boolean} [videoInlining] Replaces the client's `isVideoInliningSupported()` result - see "DELIBERATELY NOT PORTED" #1. Default `false`.
 * @property {boolean} [audioInlining] Replaces the client's `isAudioInliningSupported()` result - see "DELIBERATELY NOT PORTED" #1. Default `false`.
 * @property {string} [imageQuality] Mirrors `oai_settings.inline_image_quality`, forwarded to every `Message.addImage`/`addVideo` call as their `quality` option. Default `'auto'`.
 * @property {string} [chatCompletionSource] Mirrors `oai_settings.chat_completion_source`, forwarded to `Message.addImage` (only used to gate its size-threshold compression path).
 * @property {{userImages?: string}} [directories] Forwarded to `Message.addImage`/`addVideo`/`addAudio` for resolving local relative attachment paths - see src/chat-completion-budget.js's `AttachmentDirectories`.
 * @property {boolean} [canUseTools] Replaces `ToolManager.isToolCallingSupported()` - see "DELIBERATELY NOT PORTED".
 * @property {boolean} [includeSignature] Replaces `isReasoningSignatureSupported()` - see "DELIBERATELY NOT PORTED".
 * @property {string} [toolReasoningMode] One of `TOOL_REASONING_MODES`'s values, already resolved by the caller - see "DELIBERATELY NOT PORTED".
 * @property {boolean} [includeToolReasoning] `toolReasoningMode !== TOOL_REASONING_MODES.DISABLED`, computed by the caller (mirrors the client's own eager computation - see module doc comment).
 * @property {TokenHandler} [tokenHandler] Injected token handler, forwarded to every `Message.createAsync`/`.setToolCalls`/`.setName` call (see src/chat-completion-budget.js's module doc comment and the sibling src/chat-completion-dialogue-examples.js's identical pattern).
 * @property {SubstituteParamsContext} [macroContext] Context forwarded to every `substituteParams()`/`preparePrompt()` call in this function.
 */

/** @enum {string} Mirrors public/scripts/chat-completion-settings.js's tool_reasoning_modes (verified by direct read - see module doc comment). */
export const TOOL_REASONING_MODES = {
    DISABLED: 'disabled',
    SINCE_LAST_USER: 'since_last_user',
    ACTIVE_CHAIN: 'active_chain',
};

/**
 * Server-side port of `PromptManager.prototype.isValidName(name)` (PromptManager.js ~1380). Ported
 * verbatim: OpenAI's `name` field must match `^[a-zA-Z0-9_]{1,64}$`.
 * @param {string} name
 * @returns {boolean}
 */
export function isValidChatCompletionName(name) {
    const regex = /^[a-zA-Z0-9_]{1,64}$/;
    return regex.test(name);
}

/**
 * Server-side port of `PromptManager.prototype.sanitizeName(name)` (PromptManager.js ~1384-1386).
 * Ported verbatim: every character outside `[a-zA-Z0-9_]` is replaced with `_`, then the result is
 * truncated to 64 characters (truncation happens AFTER replacement, matching the client's
 * left-to-right `name.replace(...).substring(0, 64)` evaluation).
 * @param {string} name
 * @returns {string}
 */
export function sanitizeChatCompletionName(name) {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64);
}

/**
 * Server-side port of `populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt)`.
 * See the module doc comment for the full option-by-option client-global translation and the
 * "DELIBERATELY NOT PORTED" gaps.
 *
 * Mutates `chatCompletion` in place (adding/filling the `'chatHistory'` `MessageCollection`, and
 * possibly re-adding a `'continueNudge'` `MessageCollection` at the end). ALSO mutates `messages` in
 * place via `.splice()` when the continue-nudge branch runs (pulling the last non-injected message
 * out of `messages` and into the continue-nudge collection instead) - exactly matching the client,
 * which passes the very same live `messages` array by reference into this function and relies on
 * that splice being visible to the rest of `Generate()`.
 *
 * @param {ChatHistoryMessage[]} messages
 * @param {PromptCollection} prompts
 * @param {ChatCompletion} chatCompletion
 * @param {PopulateChatHistoryOptions} [options]
 * @returns {Promise<void>}
 */
export async function populateChatHistory(messages, prompts, chatCompletion, {
    type = null,
    cyclePrompt = null,
    isGroup = false,
    newChatPrompt = '',
    newGroupChatPrompt = '',
    continuePrefill = false,
    continueNudgePrompt = '',
    sendIfEmpty = '',
    namesBehavior = character_names_behavior.NONE,
    imageInlining = false,
    videoInlining = false,
    audioInlining = false,
    imageQuality = 'auto',
    chatCompletionSource,
    directories,
    canUseTools = false,
    includeSignature = false,
    toolReasoningMode = TOOL_REASONING_MODES.DISABLED,
    includeToolReasoning = false,
    tokenHandler,
    macroContext = {},
} = {}) {
    if (!prompts.has('chatHistory')) {
        return;
    }

    chatCompletion.add(new MessageCollection('chatHistory'), prompts.index('chatHistory'));

    const newChat = isGroup ? newGroupChatPrompt : newChatPrompt;
    const newChatMessage = await Message.createAsync('system', substituteParams(newChat, macroContext), 'newMainChat', tokenHandler);
    chatCompletion.reserveBudget(newChatMessage);

    let groupNudgeMessage = null;
    const noGroupNudgeTypes = ['impersonate'];
    if (isGroup && prompts.has('groupNudge') && !noGroupNudgeTypes.includes(type)) {
        groupNudgeMessage = await Message.fromPromptAsync(prompts.get('groupNudge'), tokenHandler);
        chatCompletion.reserveBudget(groupNudgeMessage);
    }

    let continueMessageCollection = null;
    if (type === 'continue' && cyclePrompt && !continuePrefill) {
        const promptObject = {
            identifier: 'continueNudge',
            role: 'system',
            content: substituteParams(continueNudgePrompt, {
                ...macroContext,
                dynamicMacros: { ...macroContext.dynamicMacros, lastChatMessage: String(cyclePrompt).trim() },
            }),
            system_prompt: true,
        };
        continueMessageCollection = new MessageCollection('continueNudge');
        const continueMessageIndex = messages.findLastIndex(x => !x.injected);
        if (continueMessageIndex >= 0) {
            const continueMessage = messages.splice(continueMessageIndex, 1)[0];
            const prompt = new Prompt(continueMessage);
            const chatMessage = await Message.fromPromptAsync(preparePrompt(prompt, { macroContext }), tokenHandler);
            continueMessageCollection.add(chatMessage);
        }
        const continueNudgePromptInstance = new Prompt(promptObject);
        const preparedNudgePrompt = preparePrompt(continueNudgePromptInstance, { macroContext });
        const continueNudgeMessage = await Message.fromPromptAsync(preparedNudgePrompt, tokenHandler);
        continueMessageCollection.add(continueNudgeMessage);
        chatCompletion.reserveBudget(continueMessageCollection);
    }

    const lastChatPrompt = messages[messages.length - 1];
    const message = await Message.createAsync('user', sendIfEmpty, 'emptyUserMessageReplacement', tokenHandler);
    if (lastChatPrompt && lastChatPrompt.role === 'assistant' && sendIfEmpty && chatCompletion.canAfford(message)) {
        chatCompletion.insert(message, 'chatHistory');
    }

    const lastUserIdx = messages.findLastIndex(x => x.role === 'user');

    const chatPool = [...messages].reverse();
    for (let index = 0; index < chatPool.length; index++) {
        const chatPrompt = chatPool[index];
        const prompt = new Prompt(chatPrompt);
        prompt.identifier = `chatHistory-${messages.length - index}`;
        const chatMessage = await Message.fromPromptAsync(preparePrompt(prompt, { macroContext }), tokenHandler);

        if (namesBehavior === character_names_behavior.COMPLETION && prompt.name) {
            const messageName = isValidChatCompletionName(prompt.name) ? prompt.name : sanitizeChatCompletionName(prompt.name);
            await chatMessage.setName(messageName, tokenHandler);
        }

        const inlineMediaAttachment = async (media) => {
            if (!media || !media.url) return;
            const mediaType = media.type || MEDIA_TYPE.IMAGE;
            if (imageInlining && mediaType === MEDIA_TYPE.IMAGE) {
                await chatMessage.addImage(media.url, { quality: imageQuality, chatCompletionSource, directories });
            }
            if (videoInlining && mediaType === MEDIA_TYPE.VIDEO) {
                await chatMessage.addVideo(media.url, { quality: imageQuality, directories });
            }
            if (audioInlining && mediaType === MEDIA_TYPE.AUDIO) {
                await chatMessage.addAudio(media.url, { directories });
            }
        };

        if (Array.isArray(chatPrompt.media) && chatPrompt.media.length) {
            if (chatPrompt.mediaDisplay === MEDIA_DISPLAY.LIST) {
                for (const media of chatPrompt.media) {
                    await inlineMediaAttachment(media);
                }
            }
            if (chatPrompt.mediaDisplay === MEDIA_DISPLAY.GALLERY) {
                const media = chatPrompt.media[chatPrompt.mediaIndex];
                await inlineMediaAttachment(media);
            }
        }

        if (canUseTools && Array.isArray(chatPrompt.invocations)) {
            const promptIdx = messages.indexOf(chatPrompt);
            const reasoningIsEligible = toolReasoningMode !== TOOL_REASONING_MODES.DISABLED && promptIdx > lastUserIdx;
            let previousAssistantReasoning = '';
            if (reasoningIsEligible) {
                if (toolReasoningMode === TOOL_REASONING_MODES.ACTIVE_CHAIN) {
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        if (candidate?.role === 'tool') continue;
                        if (candidate?.role === 'assistant' && Array.isArray(candidate.invocations)) continue;
                        const hasAssistantText = candidate?.role === 'assistant' && !Array.isArray(candidate.invocations) && typeof candidate.content === 'string' && candidate.content.trim().length > 0;
                        if (hasAssistantText) previousAssistantReasoning = String(candidate.reasoning ?? '');
                        break;
                    }
                } else if (toolReasoningMode === TOOL_REASONING_MODES.SINCE_LAST_USER) {
                    for (let idx = promptIdx - 1; idx > lastUserIdx; idx--) {
                        const candidate = messages[idx];
                        const hasAssistantText = candidate?.role === 'assistant' && !Array.isArray(candidate.invocations) && typeof candidate.content === 'string' && candidate.content.trim().length > 0;
                        if (!hasAssistantText) continue;
                        const candidateReasoning = String(candidate.reasoning ?? '');
                        if (candidateReasoning) { previousAssistantReasoning = candidateReasoning; break; }
                    }
                }
            }
            const invocations = chatPrompt.invocations.map(invocation => {
                const clone = structuredClone(invocation);
                if (!reasoningIsEligible) delete clone.reasoning;
                else if (previousAssistantReasoning && !clone.reasoning) clone.reasoning = previousAssistantReasoning;
                return clone;
            });
            const toolCallMessage = await Message.createAsync(chatMessage.role, undefined, 'toolCall-' + chatMessage.identifier, tokenHandler);
            const toolResultMessages = await Promise.all(invocations.slice().reverse().map((invocation) => Message.createAsync('tool', invocation.result || '[No content]', invocation.id, tokenHandler)));
            await toolCallMessage.setToolCalls(invocations, includeSignature, includeToolReasoning, tokenHandler);
            if (chatCompletion.canAffordAll([toolCallMessage, ...toolResultMessages])) {
                for (const resultMessage of toolResultMessages) chatCompletion.insertAtStart(resultMessage, 'chatHistory');
                chatCompletion.insertAtStart(toolCallMessage, 'chatHistory');
            } else {
                break;
            }
            continue;
        }

        if (includeSignature && chatPrompt.signature) chatMessage.signature = chatPrompt.signature;

        if (chatCompletion.canAfford(chatMessage)) {
            chatCompletion.insertAtStart(chatMessage, 'chatHistory');
        } else {
            break;
        }
    }

    chatCompletion.freeBudget(newChatMessage);
    chatCompletion.insertAtStart(newChatMessage, 'chatHistory');

    if (isGroup && groupNudgeMessage) {
        chatCompletion.freeBudget(groupNudgeMessage);
        chatCompletion.insertAtEnd(groupNudgeMessage, 'chatHistory');
    }

    if (type === 'continue' && continueMessageCollection) {
        chatCompletion.freeBudget(continueMessageCollection);
        chatCompletion.add(continueMessageCollection, -1);
    }
}
