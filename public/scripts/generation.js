import {
    addChatsPreamble, addChatsSeparator, addPersonaDescriptionExtensionPrompt,
    amount_gen, baseChatReplace, cancelDebouncedChatSave, charactersStore, chat, chat_metadata, cleanUpMessage,
    deactivateSendButtons, DEFAULT_SAVE_EDIT_TIMEOUT, deleteLastMessage, depth_prompt_depth_default, depth_prompt_role_default,
    doChatInject, extension_prompt_roles, extension_prompts, extension_prompt_types,
    extractImagesFromData, extractJsonFromData, extractMessageFromData, extractMultiSwipes, extractTitleFromData,
    flushDraftSave, flushWIInjections, formatMessageHistoryItem,
    getAllExtensionPrompts, getBiasStrings, getCharacterCardFields, getCurrentCharacter, getCurrentChatId, getCurrentDraftContext,
    getExtensionPrompt, getExtensionPromptRoleByName, getMaxPromptTokens, getNextMessageId, getRequestHeaders, getSelectionState,
    hideStopButton, hideSwipeButtons, isStreamingEnabled,
    main_api, max_context, menu_type, name1, name2, neutralCharacterName, online_status,
    parseAndSaveLogprobs, parseMesExamples, parseTokenCounts, pingServer, processCommands,
    removeDepthPrompts, removeLastMessage, removeMacros, resolveClientToolHandoffLoop,
    saveReply, sendGenerationRequest, sendMessageAsUser, sendStreamingRequest,
    setCharacterId, setCharacterName, setExtensionPrompt, setGenerationProgress, setInContextMessages, setSendButtonState,
    showStopButton, StreamingProcessor, substituteParams, swipe,
    triggerAutoContinue, unblockGeneration, unshallowCharacter,
} from '../script.js';
import { _postChatMetadata, saveMetadata } from './metadata-store.js';
import { isStoredNodeId } from './node-identity.js';
import { setFloatingPrompt } from './authors-note.js';
import { getCfgPrompt, getGuidanceScale } from './cfg-scale.js';
import { oai_settings, openai_messages_count, prepareOpenAIMessages, setOpenAIMessageExamples, setOpenAIMessages } from './chat-completion-settings.js';
import { clearDraft } from './chat-draft.js';
import { healDirtyMessages, updateMessage } from './chat-store.js';
import { appendFileContent, hasPendingFileAttachment } from './chats.js';
import { GENERATION_TYPE_TRIGGERS, inject_ids, SWIPE_DIRECTION, SWIPE_SOURCE } from './constants.js';
import { eventSource, event_types } from './events.js';
import { extension_settings, runGenerationInterceptors } from './extensions.js';
import { getRegexedString, regex_placement } from './extensions/regex/engine.js';
import { generateGroupWrapper, getGroupDepthPrompts, groupsStore, is_group_generating, saveGroupField, selected_group } from './group-chats.js';
import { adjustHordeGenerationParams, horde_settings, isHordeGenerationNotAllowed, MIN_LENGTH } from './horde.js';
import { t } from './i18n.js';
import { force_output_sequence, formatInstructModeChat, formatInstructModeExamples, formatInstructModePrompt, formatInstructModeStoryString } from './instruct-mode.js';
import { deleteItemizedPromptForMessage, itemizedPrompts, saveItemizedPrompts } from './itemized-prompts.js';
import { getKoboldGenerationData, kai_flags, kai_settings, koboldai_setting_names, koboldai_settings } from './kai-settings.js';
import { adjustNovelInstructionPrompt, getNovelGenerationData, nai_settings, novelai_setting_names, novelai_settings } from './nai-settings.js';
import { user_avatar } from './personas.js';
import { Popup } from './popup.js';
import { collapseNewlines, generatedTextFiltered, persona_description_positions, playMessageSound, power_user, renderStoryString } from './power-user.js';
import { getPresetManager } from './preset-manager.js';
import { extractReasoningFromData, extractReasoningSignatureFromData, PromptReasoning } from './reasoning.js';
import { compressRequest } from './request-compression.js';
import { sendSystemMessage, system_message_types } from './system-messages.js';
import { getTextGenGenerationData, textgenerationwebui_settings as textgen_settings } from './textgen-settings.js';
import { getFriendlyTokenizerName, getTokenCountAsync, saveTokenCache } from './tokenizers.js';
import { ToolManager } from './tool-calling.js';
import { shiftDownByOne, shiftUpByOne, waitUntilCondition } from './utils.js';
import { getWorldInfoPrompt, wi_anchor_position, world_info_include_names } from './world-info.js';

export let streamingProcessor = null;

// Read directly by saveReply() (script.js) to stamp gen_started/gen_finished on the message it's
// building - only ever assigned here (Generate()'s own start/continue-retiming logic).
export let generation_started = new Date();

export let abortController = new AbortController();

// Read directly by getGeneratingModel() (script.js) for the 'koboldhorde' case - only ever assigned
// here (Generate()'s own post-generation bookkeeping).
export let kobold_horde_model = '';

// Read by several sites in script.js (send-button gating, the debounced-save wait loop) and by
// group-chats.js - only ever reassigned here (saveChatConditional()'s own save-in-progress guard).
export let isChatSaving = false;

export function setAbortController(controller) {
    abortController = controller;
}

// Snapshot after load/save: node_id -> message reference. Messages in `chat` (script.js) are frozen
// after load/creation - all mutation goes through updateMessage()/updateIn() (chat-store.js), which
// swaps in a new frozen object - so reference equality against this snapshot is a complete,
// hash-free change-detection signal for the slim wire save protocol below (_buildSlimPayload()).
/** @type {Map<string, object>} */
export const _messageSnapshots = new Map();

export function _snapshotMessages() {
    _messageSnapshots.clear();
    for (const msg of chat) {
        if (msg.node_id) {
            _messageSnapshots.set(msg.node_id, msg);
        }
    }
}

function _buildSlimPayload(messages) {
    return messages.map(msg => {
        if (msg.node_id && _messageSnapshots.get(msg.node_id) === msg) {
            return { node_id: msg.node_id, _unchanged: true };
        }
        return msg;
    });
}

// Stamps a server-persisted assistant_node_id onto the just-saved reply and marks it clean in
// _messageSnapshots, so the generic save (still reachable through getContext().saveChat() for
// extensions, and through StreamingProcessor's own fallback below) sees nothing to write again.
function _stampAssistantNodeId(nodeId) {
    if (!nodeId) return;
    const mesId = chat.length - 1;
    const msg = chat[mesId];
    if (!msg || msg.is_user) return;
    const selected = msg.swipe_id ?? 0;
    const updates = { node_id: nodeId };
    if (Array.isArray(msg.swipe_info) && msg.swipe_info[selected] && !msg.swipe_info[selected].node_id) {
        const newSwipeInfo = [...msg.swipe_info];
        newSwipeInfo[selected] = { ...newSwipeInfo[selected], node_id: nodeId };
        updates.swipe_info = newSwipeInfo;
    }
    updateMessage(mesId, updates);
    if (chat[mesId]?.node_id) {
        _messageSnapshots.set(chat[mesId].node_id, chat[mesId]);
    }
}

// Overswiping opens an empty slot to type into; nothing exists for it yet, so there is nothing to save, and
// trying anyway means asking the server to blank the row the message still names, which it refuses.
export function _isBlankUnwrittenSwipe(message) {
    if (!Array.isArray(message?.swipes)) return false;
    const at = message.swipe_id ?? 0;
    if (typeof message.swipes[at] !== 'string' || message.swipes[at].length > 0) return false;
    return !message.swipe_info?.[at]?.node_id;
}

// Extracted from StreamingProcessor.onFinishStreaming() (script.js), which still runs the rest of that
// method (finalizeIntermediaryMessage(), the auto-swipe check, playMessageSound()) - this is just its
// save/persist decision, so the DOM-coupled class can stay in script.js while this invariant-critical
// branch is checked under strict null checks with the rest of this file.
export async function finishStreamedReplyPersistence({ assistantNodeId }) {
    if (assistantNodeId) {
        _stampAssistantNodeId(assistantNodeId);
    } else {
        // Backend/path didn't send assistant_node_id: not a raw-action stream, the server-side
        // persist failed, or - the common real case - the user stopped the stream before the
        // trailing assistant_node_id frame arrived (a deliberate abort intentionally never
        // resumes to fetch it - see ResumableCompactStreamReader.read()'s own AbortError
        // handling, llamacpp-compact-stream.js). `chat[messageId]` still has no node_id either
        // way, so `heal: true` is required here, not optional: it's what makes saveChat() run
        // healDirtyMessages() first, which is what actually calls chatOpAppend() to persist this
        // trailing message and learn its real node_id - the plain saveChatConditional() below
        // would otherwise only resave chat_metadata and silently leave chat[messageId].node_id
        // unset, which then surfaces later as a "node_id is required" error the next time this
        // message is addressed (e.g. Continue).
        // eslint-disable-next-line no-restricted-syntax -- see comment above; this IS the direct persistence path for this exact case.
        await saveChatConditional({ heal: true });
    }
}

/**
 * @typedef {object} JsonSchema
 * @property {string} name Name of the schema.
 * @property {object} value JSON schema value.
 * @property {string} [description] Description of the schema.
 * @property {boolean} [strict] If true, the schema will be used in strict mode, meaning that only the fields defined in the schema will be allowed.
 * @property {boolean} [returnInvalid] If true, a string that can't be parsed as a JSON will be returned as is, instead of an empty object.
 *
 * @typedef {object} GenerateOptions
 * @property {boolean} [automatic_trigger] If the generation was triggered automatically (e.g. group auto mode).
 * @property {boolean} [force_name2] If a char name should be forced to add to the prompt's last line (Text Completion, non-Instruct only).
 * @property {string} [quiet_prompt] A system instruction to use for the quiet prompt.
 * @property {boolean} [quietToLoud] Whether the system instruction should be sent in background (quiet) or a foreground (loud) mode.
 * @property {boolean} [skipWIAN] Skip adding World Info and Author's Note to the prompt.
 * @property {string} [force_avatar] Force character (by avatar) to use for the generation. Only works in groups.
 * @property {AbortSignal} [signal] Abort signal to cancel the generation. If not provided, will create a new AbortController.
 * @property {string} [quietImage] Image URL to use for the quiet prompt (defaults to empty string)
 * @property {string} [quietName] Name to use for the quiet prompt (defaults to "System:")
 * @property {number} [depth] Recursion depth for the generation. Used to prevent infinite loops in tool calls.
 * @property {JsonSchema} [jsonSchema] JSON schema to use for the structured generation. Usually requires a special instruction.
 */

/**
 * MARK:Generate()
 * Runs a generation using the current chat context.
 * @param {string} type Generation type
 * @param {GenerateOptions} options Generation options
 * @param {boolean} dryRun Whether to actually generate a message or just assemble the prompt
 * @returns {Promise<any>} Returns a promise that resolves when the text is done generating.
 */
export async function Generate(type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage, quietName, jsonSchema = null, depth = 0 } = {}, dryRun = false) {
    console.log('Generate entered');
    setGenerationProgress(0);
    generation_started = new Date();

    // Prevent generation from shallow characters
    await unshallowCharacter(getCurrentCharacter()?.avatar);

    // Occurs every time, even if the generation is aborted due to slash commands execution
    await eventSource.emit(event_types.GENERATION_STARTED, type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage }, dryRun);

    // Don't recreate abort controller if signal is passed
    if (!(abortController && signal)) {
        abortController = new AbortController();
    }

    // OpenAI doesn't need instruct mode. Use OAI main prompt instead.
    const isInstruct = power_user.instruct.enabled && main_api !== 'openai';
    const isImpersonate = type == 'impersonate';

    if (!(dryRun || depth || type == 'regenerate' || type == 'swipe' || type == 'quiet')) {
        const interruptedByCommand = await processCommands(String($('#send_textarea').val()));

        if (interruptedByCommand) {
            //$("#send_textarea").val('')[0].dispatchEvent(new Event('input', { bubbles:true }));
            unblockGeneration(type);
            return Promise.resolve();
        }
    }

    // Occurs only if the generation is not aborted due to slash commands execution
    await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS, type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage }, dryRun);

    if (main_api == 'kobold' && kai_settings.streaming_kobold && !kai_flags.can_use_streaming) {
        toastr.error(t`Streaming is enabled, but the version of Kobold used does not support token streaming.`, undefined, { timeOut: 10000, preventDuplicates: true });
        unblockGeneration(type);
        return Promise.resolve();
    }

    if (isHordeGenerationNotAllowed()) {
        unblockGeneration(type);
        return Promise.resolve();
    }

    if (!dryRun) {
        // Ping server to make sure it is still alive
        const pingResult = await pingServer();

        if (!pingResult) {
            unblockGeneration(type);
            toastr.error(t`Verify that the server is running and accessible.`, t`ST Server cannot be reached`);
            throw new Error('Server unreachable');
        }

        // Hide swipes if not in a dry run.
        hideSwipeButtons();
        // If generated any message, set the flag to indicate it can't be recreated again.
        chat_metadata.tainted = true;
    }

    if (selected_group && !is_group_generating) {
        if (!dryRun) {
            // Returns the promise that generateGroupWrapper returns; resolves when generation is done
            return generateGroupWrapper(false, type, { quiet_prompt, force_avatar, signal: abortController.signal, quietImage, jsonSchema });
        }

        const group = groupsStore.get(selected_group);

        const enabledMembers = group.members.reduce((acc, member) => {
            if (!group.disabled_members.includes(member) && !acc.includes(member)) {
                acc.push(member);
            }
            return acc;
        }, []);

        if (enabledMembers.length > 0) {
            if (menu_type != 'character_edit') setCharacterId(enabledMembers[0]);
            setCharacterName('');
        } else {
            console.log('No enabled members found');
            unblockGeneration(type);
            return Promise.resolve();
        }
    }

    //#########QUIET PROMPT STUFF##############
    //this function just gives special care to novel quiet instruction prompts
    if (quiet_prompt) {
        quiet_prompt = substituteParams(quiet_prompt);
        quiet_prompt = main_api == 'novel' && !quietToLoud ? adjustNovelInstructionPrompt(quiet_prompt) : quiet_prompt;
    }

    const hasBackendConnection = online_status !== 'no_connection';

    // We can't do anything because we're not in a chat right now. (Unless it's a dry run, in which case we need to
    // assemble the prompt so we can count its tokens regardless of whether a chat is active.)
    if (!dryRun && !hasBackendConnection) {
        setSendButtonState(false);
        return Promise.resolve();
    }

    const lastMessage = chat[chat.length - 1];

    let textareaText;
    if (type !== 'regenerate' && type !== 'swipe' && type !== 'quiet' && !isImpersonate && !dryRun && !depth) {
        setSendButtonState(true);
        textareaText = String($('#send_textarea').val());
        $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
        // Explicit synchronous clear: a message just sent must not be resurrectable as a draft by a reload
        // landing before the debounced save observes the now-empty box.
        const sentDraftContext = getCurrentDraftContext();
        if (sentDraftContext) {
            clearDraft(localStorage, sentDraftContext);
        }
    } else {
        textareaText = '';
        if (chat.length && lastMessage.is_user) {
            //do nothing? why does this check exist?
        } else if (type !== 'quiet' && type !== 'swipe' && !isImpersonate && !dryRun && !depth && chat.length) {
            deleteItemizedPromptForMessage(chat.length - 1);
            chat.length = chat.length - 1;
            await removeLastMessage();
            await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
        }
    }

    const isContinue = type == 'continue';
    // No pre-existing named local for this (every other call site inlines `type === 'swipe'`) - added
    // here so the raw-action cutover below can name it like isImpersonate/isContinue. Deliberately
    // covers `'regenerate'` too, NOT just `'swipe'` - verified (not assumed) that the two need
    // IDENTICAL server-side treatment for this cutover's purposes: both target the same anchor (the
    // branch leaf, i.e. the message being replaced - see getNextMessageId()'s own `type == 'swipe' ?
    // chat.length - 1 : chat.length`, which resolves to the same real index for both once
    // 'regenerate's own earlier "delete the last message" branch a few hundred lines above has run),
    // and both need the server to persist the reply as a sibling ALTERNATIVE rather than a new child
    // message (see the raw-action cutover's own JUDGMENT CALL #1 below). The two are NOT the same
    // client-side in every respect (this variable's own two other real call sites - `coreChat.pop()` a
    // few lines below and `getNextMessageId()` - intentionally still check `type === 'swipe'` alone,
    // since 'regenerate' has already had its own message spliced out of `chat` by that earlier branch,
    // making an ADDITIONAL pop wrong) - only for the raw-action payload's `is_swipe` field (which the
    // server-side orchestrators use to decide whether to exclude the target message from ITS OWN
    // freshly-loaded, never-locally-mutated copy of the chat - see prompt-line-formatting.js's
    // getBiasStrings() and chat-completion-generation-input.js's `promptChat`, both of which now also
    // treat 'swipe' and 'regenerate' identically for the identical reason) is the flag conflated.
    const isSwipe = type == 'swipe' || type == 'regenerate';
    // UPDATE (this task): `isSwipe` is no longer forwarded on the wire as its own `is_swipe` field -
    // the server now derives it from `type` alone (see the raw-action cutovers' own UPDATE comments
    // below) - but the local is kept (mirroring `isImpersonate`/`isContinue` above) since it still
    // documents the real "same anchor for 'swipe' and 'regenerate'" reasoning the comment above
    // explains, and other, non-raw-action call sites reading `type === 'swipe'` directly may still
    // want a byte-for-byte-identical named reference in the future.
    void isSwipe;

    // Rewrite the generation timer to account for the time passed for all the continuations.
    if (isContinue && chat.length) {
        const prevFinished = lastMessage.gen_finished;
        const prevStarted = lastMessage.gen_started;

        if (prevFinished && prevStarted) {
            const timePassed = Number(prevFinished) - Number(prevStarted);
            generation_started = new Date(Date.now() - timePassed);
            updateMessage(chat.length - 1, { gen_started: generation_started });
        }
    }

    if (!dryRun) {
        deactivateSendButtons();
    }

    let { messageBias, promptBias, isUserPromptBias } = getBiasStrings(textareaText, type);

    //*********************************
    //PRE FORMATING STRING
    //*********************************

    // These generation types should not attach pending files to the chat
    const noAttachTypes = [
        'regenerate',
        'swipe',
        'impersonate',
        'quiet',
        'continue',
    ];
    // Set only when this call actually appends a brand-new user message to `chat` via
    // sendMessageAsUser() below (the ONLY place in this function that can - `lastMessage`, captured
    // above, is deliberately the PRE-existing last message, e.g. for the raw-action addressing
    // model's own anchorNodeId, so it does NOT refer to this new message; this local is the only real
    // reference to it). Consumed by the raw-action cutovers below to forward this message's already-
    // uploaded file/media attachment REFERENCE (`extra.files`/`extra.media`/etc, populated by
    // populateFileAttachment() inside sendMessageAsUser() - see that function - BEFORE this Generate()
    // call ever runs any backend request) - see JUDGMENT CALL on hasPendingFileAttachment() below.
    let sentUserMessage;

    // Computed before sendMessageAsUser() runs, mirroring both raw-action gates' real preconditions
    // below verbatim (keep in sync if either changes) - passed in as skipTreePersistence so
    // sendMessageAsUser() doesn't append the user's message itself when a raw-action call is about
    // to append it server-side. Needed because the two appends would hash to different identities
    // (client sends `persona: avatar`, the server-side append falls back to a display name) and
    // dedup would miss it, creating a duplicate node. Doesn't apply to the insertAt/graft path -
    // only the `/send at=` slash command uses that, and it never triggers a raw-action send.
    const rawActionCharacterAvatar = getCurrentCharacter()?.avatar;
    const rawActionGroupId = selected_group || undefined;
    const rawActionOwnerId = rawActionGroupId
        ? String(rawActionGroupId)
        : (rawActionCharacterAvatar ? String(rawActionCharacterAvatar).replace('.png', '') : undefined);
    const willUseRawAction = !dryRun
        && ['textgenerationwebui', 'kobold', 'novel', 'koboldhorde', 'openai'].includes(main_api)
        && [undefined, 'normal', 'impersonate', 'quiet', 'swipe', 'regenerate', 'continue'].includes(type)
        && !!(rawActionOwnerId && rawActionCharacterAvatar);

    //for normal messages sent from user..
    if ((textareaText != '' || (hasPendingFileAttachment() && !noAttachTypes.includes(type))) && !automatic_trigger && type !== 'quiet' && !dryRun && !depth) {
        // If user message contains no text other than bias - send as a system message
        if (messageBias && !removeMacros(textareaText)) {
            sendSystemMessage(system_message_types.GENERIC, ' ', { bias: messageBias });
        } else {
            sentUserMessage = await sendMessageAsUser(textareaText, messageBias, null, false, name1, user_avatar, willUseRawAction);
        }
    } else if (textareaText == '' && !automatic_trigger && !dryRun && [undefined, 'normal'].includes(type) && main_api == 'openai' && oai_settings.send_if_empty.trim().length > 0 && !depth) {
        // Use send_if_empty if set and the user message is empty. Only when sending messages normally
        sentUserMessage = await sendMessageAsUser(oai_settings.send_if_empty.trim(), messageBias, null, false, name1, user_avatar, willUseRawAction);
    }

    const canUseTools = ToolManager.isToolCallingSupported();
    const canPerformToolCalls = !dryRun && ToolManager.canPerformToolCalls(type) && depth < ToolManager.RECURSE_LIMIT;

    // Snapshot of `type` before any downstream mutation (e.g. saveReply()'s destructuring
    // reassignment inside onSuccess()) - onSuccess() reads `originalType` unconditionally, for both
    // the raw-action and legacy-assembly paths, so this cannot be deferred into the
    // (possibly-skipped) assembly below. It has no dependency on that assembly either: `type` is
    // never reassigned anywhere between this function's start and this point (verified by reading
    // every line above this one) - so this is a plain, correctness-critical snapshot, not a
    // best-effort default.
    const originalType = type;

    // === Always-run: character card fields, depth prompts, coreChat construction, extension
    // interceptors ===
    // REGRESSION FIX / JUDGMENT CALL (character-card-fields/depth-prompt block, and
    // coreChat+interceptors, both kept unconditional, i.e. NOT inside the skippable
    // `if (!rawActionGenerateData && !rawActionChatCompletionData) { ... }` block below): this whole
    // section used to be the very first thing the legacy assembly did. It is hoisted out here, ahead
    // of the raw-action gates, so it runs identically to before this whole raw-action-cutover effort,
    // regardless of whether this request ends up using a raw-action payload. Two independent reasons:
    //   1. `runGenerationInterceptors(coreChat, this_max_context, type)`
    //      (public/scripts/extensions.js) is a real, documented third-party extension API - any
    //      installed extension with a `generate_interceptor` manifest field gets to inspect/mutate
    //      `coreChat` and/or ABORT the generation outright
    //      (`if (aborted) { unblockGeneration(type); return Promise.resolve(); }`). A prior version of
    //      this cutover left this call inside the skippable block, which would have silently stopped
    //      it from running for every cut-over raw-action request (the majority of real generations) -
    //      any content-filter/validation/custom-guard extension would have silently stopped working.
    //      This is not part of the "pure prompt-string-construction" work the raw-action cutover is
    //      meant to eliminate; it is an externally-observable side effect (whether the generation
    //      proceeds at all) that code outside this function depends on, so it must always run.
    //   2. `getCharacterCardFields()`'s companion depth-prompt writes (`removeDepthPrompts()` /
    //      `setExtensionPrompt(inject_ids.DEPTH_PROMPT[...], ...)`) write into the client's shared
    //      `extension_prompts` table (public/scripts/extensions.js), which other code/extensions can
    //      read via `getContext().extensionPrompts` independent of whether THIS request's own prompt
    //      text ever gets used. The server now independently resolves character depth-prompt
    //      injection for the raw-action case too (this session's earlier work ported
    //      `getGroupCharacterDepthPrompts()`/`charDepthPromptDepth`/`charDepthPromptRole`
    //      server-side), so keeping this client-side write running is NOT needed to make the
    //      raw-action request itself correct - but it IS needed to keep that shared,
    //      externally-observable table fresh for any other consumer. This write is also cheap (a
    //      handful of object-property assignments), so per this task's own instructions the safer
    //      choice - keeping it unconditional rather than letting it silently go stale whenever a
    //      raw-action request is taken - was picked deliberately, not for lack of a cheaper option.
    // `coreChat` (the filtered/regex-substituted/reasoning-folded message list) is kept unconditional
    // purely so `runGenerationInterceptors()` always receives the SAME real value it always did - not
    // a simplified substitute a third-party interceptor might misclassify or reject. `this_max_context`
    // is computed here (unconditionally) because it is `runGenerationInterceptors()`'s second real
    // argument; it is later further adjusted (Horde/CFG) inside the still-skippable block below for
    // the non-raw-action case only, same as before.
    // Everything from here through the `runGenerationInterceptors()` abort-handling below is therefore
    // a byte-for-byte relocation of this function's original (pre-cutover) code, with no logic changes
    // - only the declarations that used to be the first assignment of `coreChat`/`this_max_context`/
    // `promptReasoning`/`description`/etc. now live here instead of a few hundred lines further down
    // (see the "Hoisted locals for the prompt-assembly block below" comment for the smaller set that
    // remains genuinely deferred).
    let {
        description,
        personality,
        persona,
        scenario,
        mesExamples,
        system,
        jailbreak,
        charDepthPrompt,
        creatorNotes,
    } = getCharacterCardFields();

    // Depth prompt (character-specific A/N)
    removeDepthPrompts();
    const groupDepthPrompts = getGroupDepthPrompts(selected_group, getCurrentCharacter()?.avatar);

    if (selected_group && Array.isArray(groupDepthPrompts) && groupDepthPrompts.length > 0) {
        groupDepthPrompts.forEach((value, index) => {
            const role = getExtensionPromptRoleByName(value.role);
            setExtensionPrompt(inject_ids.DEPTH_PROMPT_INDEX(index), value.text, extension_prompt_types.IN_CHAT, value.depth, extension_settings.note.allowWIScan, role);
        });
    } else {
        const depthPromptText = charDepthPrompt || '';
        const depthPromptDepth = getCurrentCharacter()?.data?.extensions?.depth_prompt?.depth ?? depth_prompt_depth_default;
        const depthPromptRole = getExtensionPromptRoleByName(getCurrentCharacter()?.data?.extensions?.depth_prompt?.role ?? depth_prompt_role_default);
        setExtensionPrompt(inject_ids.DEPTH_PROMPT, depthPromptText, extension_prompt_types.IN_CHAT, depthPromptDepth, extension_settings.note.allowWIScan, depthPromptRole);
    }

    // Kept local, not written back onto chat[0] - that would make the save path see an untouched greeting as user-edited.
    const substitutedFirstMessage = chat.length ? substituteParams(chat[0].mes) : null;

    // Collect messages with usable content
    let coreChat = chat.filter(x => !x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations)));
    if (type === 'swipe') {
        coreChat.pop();
    }

    coreChat = await Promise.all(coreChat.map(async (/** @type {ChatMessage} */ chatItem, index) => {
        let message = chatItem === chat[0] ? substitutedFirstMessage : chatItem.mes;
        let regexType = chatItem.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
        let options = { isPrompt: true, depth: (coreChat.length - index - (isContinue ? 2 : 1)) };

        let regexedMessage = getRegexedString(message, regexType, options);
        const residentId = chat.indexOf(chatItem);
        regexedMessage = await appendFileContent(chatItem, regexedMessage);
        if (residentId >= 0) {
            chatItem = chat[residentId];
        }

        const titles = [];
        if (chatItem?.extra?.append_title && chatItem?.extra?.title) {
            titles.push(chatItem.extra.title);
        }
        if (Array.isArray(chatItem?.extra?.media)) {
            for (const mediaItem of chatItem.extra.media) {
                if (mediaItem?.title && mediaItem?.append_title) {
                    titles.push(mediaItem.title);
                }
            }
        }
        if (titles.length > 0) {
            regexedMessage = `${regexedMessage}\n\n${titles.join('\n\n')}`;
        }

        return {
            ...chatItem,
            mes: regexedMessage,
            index,
        };
    }));

    const promptReasoning = new PromptReasoning();
    for (let i = coreChat.length - 1; i >= 0; i--) {
        const depth = coreChat.length - i - (isContinue ? 2 : 1);
        const isPrefix = isContinue && i === coreChat.length - 1;

        // In group chats, only include reasoning from the currently generating character
        const isOtherGroupMember = selected_group && coreChat[i].name !== name2;

        coreChat[i] = {
            ...coreChat[i],
            mes: isOtherGroupMember
                ? coreChat[i].mes
                : promptReasoning.addToMessage(
                    coreChat[i].mes,
                    getRegexedString(
                        String(coreChat[i].extra?.reasoning ?? ''),
                        regex_placement.REASONING,
                        { isPrompt: true, depth: depth },
                    ),
                    isPrefix,
                    coreChat[i].extra?.reasoning_duration,
                ),
        };
        if (promptReasoning.isLimitReached()) {
            break;
        }
    }

    // Determine token limit
    let this_max_context = getMaxPromptTokens();

    if (!dryRun) {
        console.debug('Running extension interceptors');
        const aborted = await runGenerationInterceptors(coreChat, this_max_context, type);

        if (aborted) {
            console.debug('Generation aborted by extension interceptors');
            unblockGeneration(type);
            return Promise.resolve();
        }
    } else {
        console.debug('Skipping extension interceptors for dry run');
    }

    // === Raw-action text-completion cutover ===
    // For a genuine plain "normal" send-and-reply turn over the textgenerationwebui backend, the
    // server now resolves the ENTIRE prompt (character, chat history, world info, sampler settings)
    // itself from its own stored state - see buildRawActionTextCompletionRequest() in
    // src/endpoints/backends/text-completions.js. Instead of sending the client-assembled
    // finalPrompt/sampler settings, this sends only which character/node and the literal text
    // typed, matching that endpoint's real, tested contract (character_avatar/group_id/owner_id/
    // node_id/type/user_message - there is no `branch_name` field anymore, and
    // is_impersonate/is_continue/is_swipe are derived server-side from `type` alone - see this
    // section's own UPDATE comment below).
    //
    // JUDGMENT CALL #1 (scope): `type === 'normal'`/undefined, `'impersonate'`, `'quiet'`, `'swipe'`,
    // `'regenerate'`, `'continue'`, AND NOW GROUP CHATS are cut over here, for this backend
    // (textgenerationwebui) only - see the chat-completion cutover's own JUDGMENT CALL #1 below for
    // why groups stay OUT of that one. This is narrower than a full cutover, because reading the
    // server's own persistence logic (commits ac42ce8c9, 6eaa7897d) turned up a real correctness bug
    // for each previously-excluded case, not a hypothetical one - see below for each.
    //
    // GROUP CHATS (previously excluded, now included - investigated for real, not assumed): the
    // original exclusion reasoned that `generateGroupWrapper()`'s (public/scripts/group-chats.js)
    // activation-strategy-dependent member selection would need to be replicated/verified against
    // this gate. Reading that function's full body end to end disproves that concern:
    // `generateGroupWrapper()` is a separate orchestration layer ABOVE `Generate()` - it computes
    // `activatedMembers` (an array of member avatars) via one of several strategies (natural/list/
    // pooled/manual order, or `activateSwipe()`/`activateImpersonate()` for 'swipe'/'continue'/
    // 'impersonate'/'quiet'), then, for EACH activated member, calls `setCharacterId(avatar)`
    // (synchronously, before `await`ing) followed by exactly ONE `await Generate(generateType, ...)`
    // call for that member - never more than one member per `Generate()` call, and the loop `await`s
    // each call in turn before moving to the next, so there is no concurrent-iteration race. Crucially,
    // this gate does NOT need `force_avatar` at all to know which member a given inner `Generate()`
    // call is for: `setCharacterId(avatar)` sets `this_avatar` (this file's own source of truth for
    // character selection - see `getCurrentCharacter()`'s doc comment), so `getCurrentCharacter()?.avatar`
    // - the EXACT SAME expression the single-character case already used - already resolves to the
    // correct responding member inside a group turn too, for every generation type this gate covers:
    // verified by reading `generateGroupWrapper()`'s own member-selection for each of
    // normal/impersonate/quiet/swipe/continue (see its `generateType` mapping, which maps every
    // OTHER type - including a bare 'regenerate' - onto 'normal', and group regenerate never reaches
    // here as a literal 'regenerate' type anyway - see `regenerateGroup()` in group-chats.js, which
    // deletes the old message(s) first and then calls `generateGroupWrapper(false, 'normal', ...)`,
    // not `'regenerate'`). `force_avatar` remains a real, separate mechanism (threaded through to let
    // an external caller - e.g. a slash command - FORCE a specific member via
    // `generateGroupWrapper()`'s own `params.force_avatar` check), it is simply not what THIS gate
    // needs to read: by the time control reaches this point inside any inner `Generate()` call,
    // `this_avatar` is already the real, resolved responding member regardless of how it got chosen.
    // The one remaining gap between "just add `group_id`" and a working group gate was server-side,
    // not client-side: `owner_id` for a group must be the group's own id (see below), not a character
    // avatar - `selected_group` IS already that real id (assigned directly from `groupsStore`'s own
    // `g.id`-keyed lookups - see `select_group_chats()`'s `groupsStore.get(openGroupId)` and the
    // `selected_group = groupId` assignment a few hundred lines below in group-chats.js), so no
    // client-side id-translation step was needed either.
    //   - `buildRawActionTextCompletionRequest()`'s own existence check was re-read and confirmed to
    //     already be `if (!characterAvatar && !groupId) throw` - an inclusive OR, not an "either but
    //     not both" exclusivity check - so passing BOTH `character_avatar` (the responding member) AND
    //     `group_id` (the group) together was already accepted with no server-side fix required.
    //     `resolveTextCompletionGenerationInput()`'s own `resolveName2AndGroupMemberNames()` already
    //     resolves `name2` from `avatar` while independently populating `groupMemberNames` from every
    //     group member when `groupId` is ALSO given, and `getGroupCharacterDepthPrompts()`
    //     (text-completion-prompt-orchestrator.js) already takes both `groupId` AND `avatar` together
    //     - this combined shape was already a real, exercised code path for depth prompts before this
    //     change, not a new invention.
    //
    // 'continue' was EXCLUDED for the same kind of reason as 'swipe'/'regenerate' below (a real
    // tree-shape mismatch, not a hypothetical one): the client's saveReply({type:'appendFinal'}) EDITS
    // the existing leaf node's text in place to (old text + new text) - see this file's saveReply(),
    // the `mes: getMessage` assignment in its 'appendFinal' branch, where getMessage was built a few
    // hundred lines above as `continue_mag + newlyGeneratedText`. The server used to always append a
    // brand-new CHILD node containing only the raw continuation fragment (its appendMessages() call
    // keyed off `anchorNodeId`, unconditionally on ANY successful generation) - two different
    // operations on two different nodes that cannot dedupe via nodeIdentityKey() the way a plain
    // new-message/new-reply turn does, and would have corrupted/duplicated the tree.
    // Now fixed server-side: both route handlers (text-completions.js and chat-completions.js) persist
    // the reply via `editMessage()` (src/message-tree-db.js) when `is_continue` is set - splicing
    // `oldText + newText` into a full copy of the anchor's own current content and replacing the whole
    // stored node in place, never creating a new node. `oldText` is the anchor's real, current `.mes`
    // (see those files' own `anchorContent` doc comments) - investigated and confirmed FAITHFUL to what
    // this file's own `continue_mag` resolves to at the point of concatenation, in BOTH the reasoning
    // and non-reasoning case: `continue_mag` (assigned a few hundred lines above, then
    // `promptReasoning.removePrefix(continue_mag)`'d immediately before use) only ever differs from the
    // raw stored `.mes` MOMENTARILY, when the leaf has non-empty `extra.reasoning` - see
    // `PromptReasoning.addToMessage()`/`removePrefix()` in public/scripts/reasoning.js: `addToMessage()`
    // (called with `isPrefix: true` for exactly the continued leaf) prepends a formatted reasoning
    // prefix onto that message's `.mes` for PROMPT-BUILDING purposes and records its exact length as
    // `prefixLength`; `removePrefix()` then slices off EXACTLY that many characters before the
    // concatenation this file's own `getMessage = continue_mag + getMessage` performs. The two are an
    // exact round trip - `continue_mag` at the point of concatenation is always the leaf's original,
    // unmodified `.mes`, reasoning or not - so the server's plain `oldText + newText` needs no separate
    // reasoning-stripping step to match it. `newText` (the raw backend output, not run through this
    // file's own `cleanUpMessage()`) is likewise held to the SAME already-accepted standard every other
    // cut-over type's server-side persistence already uses (see those files' own `anchorContent`/edit
    // doc comments for the full reasoning-round-trip and raw-text writeup) - not a new or continue-
    // specific gap, and not the last word on the stored text either way, since this file's own
    // `saveReply({type: 'appendFinal'})` still runs afterward and its own eventual sync to the server
    // supersedes this route's belt-and-suspenders edit.
    // A REAL edge case was found and guarded server-side while wiring this (not hypothetical): this
    // file's own textareaText-read condition a few hundred lines above (`type !== 'regenerate' && type
    // !== 'swipe' && type !== 'quiet' && !isImpersonate && !dryRun && !depth`) does NOT exclude
    // 'continue' - so leftover text in the send box at the moment Continue is clicked IS sent as a real
    // new user message, same as a normal turn (JUDGMENT CALL #3 below's claim that this "was already
    // like the continue/swipe case" undersold this: swipe/regenerate truly are always `''` here, but
    // continue is not exempted by name at all). The server's route handlers guard against this
    // corrupting the wrong node - see their own `continueUserTextConflict` computation - by skipping the
    // in-place edit (not persisting anything for that one request) whenever a user message was actually
    // appended in the same request, since the anchor for the edit would otherwise be the just-appended
    // USER node instead of the real assistant leaf. This loses nothing new: that combination was already
    // a pre-existing, independent client-side oddity before this task (this file's own
    // `saveReply({type: 'appendFinal'})` reads `chat[chat.length - 1]`, which by then is that SAME
    // just-sent user message, not the real assistant leaf - the legacy path was never coherent for this
    // combination either).
    //
    // 'impersonate'/'quiet' were EXCLUDED in the original version of this cutover (commit 80bdf420c)
    // because the server's persistence was, at the time, unconditional: 'impersonate' generates what
    // the user MIGHT say (written back into the send textarea a few hundred lines below via
    // `$('#send_textarea').val(getMessage)`, never added to the chat client-side) and 'quiet'
    // generations are meta/background - the server used to unconditionally persist the reply (and,
    // defensively, any `user_message`) as a real tree message for both, which would have been wrong.
    // That server-side bug is now fixed (see buildRawActionTextCompletionRequest()'s route handler in
    // src/endpoints/backends/text-completions.js: `isImpersonate`/`type === 'quiet'` now skip BOTH the
    // user-message and assistant-reply appendMessages() calls), so both are now included here.
    // `user_message` is verified to always resolve to `undefined` for both types regardless - see
    // JUDGMENT CALL #3 below - so there is nothing new for the server to spuriously persist even
    // without that fix, but the fix was required for these two types to be safe to widen to.
    //
    // 'swipe'/'regenerate' were EXCLUDED for a DIFFERENT, genuinely-real correctness bug (not a
    // persistence-unconditional-ness bug like impersonate/quiet's): the server's `anchorNodeId` for
    // this raw action is always the branch leaf - i.e. the message BEING swiped/regenerated itself -
    // so a plain `appendMessages()` call would have chained the new reply as a CHILD *after* that
    // message, not as a SIBLING under its parent (an actual swipe/regenerate is a sibling
    // alternative - see `addAlternatives()`/`selectDefaultChild()` in src/message-tree-db.js). That's
    // now fixed server-side too: both route handlers (text-completions.js and chat-completions.js) now
    // persist the reply via `addAlternatives()` (creating the sibling alongside the swiped/regenerated
    // node under ITS real parent, resolved internally) followed by `selectDefaultChild()` (making the
    // new alternative the active one) whenever `is_swipe` is set - see those files' own comments on
    // this branch for the full rationale, including the "swipe with no parent" edge case (verified
    // unreachable here: an empty-chat swipe/regenerate is already rejected with a 400 by
    // buildRawActionTextCompletionRequest()'s own pre-existing `orchestratorInput.chat.length === 0`
    // check, before persistence is ever attempted, and every OTHER reachable target - including a
    // chat's sole opening greeting - has a real parent by construction: either a prior message, or the
    // character's own opening-alternatives anchor row).
    // `'regenerate'` maps onto this SAME `is_swipe` flag as `'swipe'` (see the `isSwipe` local's own
    // declaration a few hundred lines above for why the two need identical server-side treatment, and
    // src/prompt-line-formatting.js's `getBiasStrings()`/src/chat-completion-generation-input.js's
    // `promptChat` for the prompt-assembly-side fix this widening also required for
    // chat-completion - the server always sees the full, un-mutated tree state regardless of which of
    // the two literal `type` strings the client sent, unlike the client's own local `chat` array,
    // which is already shortened for 'regenerate' by the time it matters client-side).
    //
    // JUDGMENT CALL #2 (assembly now REALLY skipped - NARROWED after a real regression was found and
    // fixed): this DOES skip the remaining, genuinely pure-prompt-string-construction part of the
    // client-side assembly (world info scan, author's note resolution, instruct formatting,
    // finalPrompt construction - see the `if (!rawActionGenerateData && !rawActionChatCompletionData)
    // { ... }` block a few hundred lines below) whenever either raw-action gate below resolves to
    // non-null. It does NOT skip the earlier part of the assembly (character-card-fields/depth-prompt
    // writes, `coreChat` construction, `runGenerationInterceptors()`) - that part was moved to run
    // BEFORE this whole comment block, unconditionally, for real, externally-observable-side-effect
    // reasons documented at its own new location above (search "Always-run: character card fields").
    // A prior version of this comment claimed everything through `runGenerationInterceptors()` was
    // also safely skippable; that was wrong - `runGenerationInterceptors()` is a real third-party
    // extension abort hook, not inert prompt-formatting, and leaving it skippable would have silently
    // disabled every installed `generate_interceptor` extension for the majority of real generations.
    // This eligibility check itself (this gate and the chat-completion one below it) was deliberately
    // moved to run BEFORE the (now smaller) remaining assembly, as early as its own dependencies
    // (`dryRun`, `main_api`, `type`, `selected_group`, `hasPendingFileAttachment()`,
    // `canPerformToolCalls`, and - for the chat-completion gate - `jsonSchema`) allow, precisely so the
    // remaining assembly can be conditioned on its result instead of always running and being
    // discarded.
    // Every local the remaining (still-skippable) assembly declares that is read anywhere later in
    // this function (inside the `switch (main_api)` below, finishGenerating(), onSuccess(), or
    // getCombinedPrompt() when called from the textgenerationwebui switch case) - `cfgGuidanceScale`,
    // `useCfgPrompt`, `mesExamplesArray`, `worldInfoString`, `worldInfoBefore`, `worldInfoAfter`,
    // `beforeScenarioAnchor`, `afterScenarioAnchor`, `storyString`, `injectedIndices`, `continue_mag`,
    // `oaiMessages`, `oaiMessageExamples`, `examplesString`, `cyclePrompt`, `pinExmString`, `arrMes`,
    // `count_exm_add`, `mesSend`, `generatedPromptCache`, `mesSendString`, `getCombinedPrompt`,
    // `finalPrompt`, `maxLength`, and `thisPromptBits` - is hoisted with a safe, correctly-typed
    // default a few lines above (see the "Hoisted locals for the prompt-assembly block below" comment),
    // declared with `let` BEFORE this smaller assembly block so skipping it cannot throw a
    // temporal-dead-zone ReferenceError. `description`, `personality`, `persona`, `scenario`,
    // `mesExamples`, `system`, `jailbreak`, `charDepthPrompt`, `creatorNotes`, `promptReasoning`, and
    // `this_max_context` no longer need any such hoisted default at all: they are now computed for
    // real, unconditionally, in the always-run section above (`this_max_context` is only FURTHER
    // adjusted, for Horde/CFG, inside the still-skippable block below - its own first, real assignment
    // already happened above, so no TDZ risk either way). `canPerformToolCalls` itself (also read
    // downstream, e.g. in finishGenerating()'s streaming-tool-call branch and onSuccess()) needed no
    // hoisting either - it was already computed, together with `canUseTools`, before all of this.
    // (`adjustedParams` and `originalType` are handled the same way as before: `adjustedParams` is
    // hoisted with an implicit `undefined` default - it is only ever read inside the kobold/koboldhorde
    // switch case, which never coincides with a raw-action request; `originalType` is a plain,
    // correctness-critical `type` snapshot with no assembly dependency at all, computed unconditionally
    // right after `canUseTools`/`canPerformToolCalls` instead of defaulted.)
    // Every one of the still-hoisted locals is confirmed safe against its own first downstream read for
    // raw-action case - see this task's own verification report for the full enumerated audit (per
    // local: declaration site, first read site, and why the default doesn't crash that read). The one
    // remaining piece of the original "assembly still runs" behavior that is preserved on purpose: the
    // `switch (main_api)` block below still contains its own `if (rawActionGenerateData) { generate_data
    // = rawActionGenerateData; break; }` / `if (rawActionChatCompletionData) { generate_data = {
    // rawAction: rawActionChatCompletionData }; break; }` checks, now effectively always true whenever
    // reached with a non-null raw-action value (since the assembly that would otherwise run before the
    // switch has already been skipped) - kept for defensiveness/clarity rather than removed.
    //
    // Side effects of the legacy assembly that this cutover intentionally leaves alone for the
    // non-raw-action paths (kobold/novel/koboldhorde, dryRun, and any textgenerationwebui/openai request
    // that fails one of the gates' own preconditions - e.g. a pending file attachment or an active tool
    // call): those still run the full assembly exactly as before, including its world-info sticky/
    // cooldown timers and itemized-prompt-bits UI - both pre-existing UI/state surfaces, unchanged by
    // this patch for the cases that still reach them.
    //
    // JUDGMENT CALL #3 (user_message for impersonate/quiet, verified not assumed): `textareaText` (a
    // few hundred lines above, at this function's very start) is only ever read from the send textarea
    // when `type !== 'regenerate' && type !== 'swipe' && type !== 'quiet' && !isImpersonate && !dryRun
    // && !depth` - for every 'impersonate'/'quiet' call, that condition is false, so `textareaText` is
    // unconditionally `''` for both. `userMessageText` below is therefore always `undefined` for these
    // two types - there is no new-user-text case to worry about for them. CORRECTION to an earlier
    // draft of this comment: 'continue' is NOT exempted by this same condition (only 'regenerate'/
    // 'swipe'/'quiet' are named in it) - `textareaText`, and therefore `userMessageText`, CAN be
    // non-empty for a continue call, if the user left text in the send box before clicking Continue.
    // This is real, not hypothetical - see JUDGMENT CALL #1 above for the full investigation and the
    // server-side `continueUserTextConflict` guard this required. Confirmed against the real call sites too: there is no dedicated
    // `generateImpersonate()`-style wrapper - `Generate('impersonate', ...)` is called directly from
    // the `option_impersonate` UI handler and from the `/impersonate` slash command
    // (public/scripts/slash-commands.js), and `Generate('quiet', ...)` is called from
    // generateQuietPrompt() (this file) - none of these three call sites writes new text into
    // `#send_textarea` before calling Generate() (the slash command explicitly CLEARS it instead, to
    // "prevent generate recursion"), so this isn't a coincidence of the current textarea state, it's
    // guaranteed by type regardless.
    //
    // JUDGMENT CALL #4 (quiet does reach this gate, verified not assumed): a `type === 'quiet'` call
    // does NOT short-circuit before this point for the ordinary (non-group, connected, non-dry-run)
    // case - the only early `return`s between this function's start and here that could matter
    // (`processCommands()`'s interrupt, the Kobold-streaming-unsupported/horde-not-allowed checks, the
    // `!hasBackendConnection` bail, and the `selected_group` branch) are either explicitly skipped for
    // `type == 'quiet'` already (the `processCommands()` call) or unrelated to `type` at all - verified
    // by reading each one, not assumed. So a plain quiet generation (no pending group turn, a live
    // backend connection) reaches this gate exactly like a normal turn does.
    //
    // JUDGMENT CALL #5 ('swipe'/'regenerate' do reach this gate too, verified not assumed): the SAME
    // early-return trace as JUDGMENT CALL #4 above applies - `processCommands()`'s own skip condition
    // already explicitly includes `type == 'regenerate' || type == 'swipe'` (not just 'quiet'), and
    // none of the other early returns (`Kobold-streaming-unsupported`/`horde-not-allowed`/
    // `!hasBackendConnection`/`selected_group`) depend on `type` at all. The one type-specific branch
    // between this function's start and here that DOES treat 'regenerate' differently from every other
    // type - the "delete the last message from `chat`" branch (`type !== 'quiet' && type !== 'swipe' &&
    // !isImpersonate && !dryRun && !depth && chat.length`, which fires for 'regenerate' since it's not
    // itself in that exclusion list) - only mutates the CLIENT's local `chat` array (so the legacy
    // prompt assembly, when it still runs at all - i.e. whenever this gate is NOT satisfied - builds
    // the right context for 'regenerate' per its own existing, unchanged logic - see JUDGMENT CALL #2)
    // and has no bearing on whether this gate is reached, nor
    // on the raw-action payload itself (`node_id`/`type` are unaffected by local `chat` array length -
    // the raw-action `node_id` below is deliberately read off `lastMessage`, captured BEFORE this
    // delete branch runs, not off `chat[chat.length - 1]` - and the server resolves its own chat state
    // fresh from the persisted tree, independent of anything the client did to its own copy).
    //
    // ONE quiet-specific gap this scope restriction does NOT close (kept OUT of the raw-action path
    // rather than silently breaking it): `generateQuietPrompt()` can pass a non-null `jsonSchema` (its
    // own `jsonSchema` parameter, threaded through as `Generate()`'s own `jsonSchema` option) for
    // structured/JSON-schema-constrained quiet generations. For 'textgenerationwebui' this is a real
    // non-issue - `getTextGenGenerationData()` never reads a call-time `jsonSchema` argument at all
    // (verified: its call below passes no such argument); the ONLY textgen json-schema knob is
    // `textgenerationwebui_settings.json_schema`, a persisted preset setting `createTextGenGenerationData()`
    // (used identically server-side inside `assembleTextCompletionPrompt()`) already reads from real,
    // on-disk settings either way - nothing here depends on the per-call `jsonSchema` argument, so no
    // extra gate is needed on this path. (The chat-completion cutover below, where `jsonSchema` IS a
    // real per-call value the raw-action request shape cannot currently carry, gates on it explicitly -
    // see that block's own comment.)
    //
    // JUDGMENT CALL #6 ('continue' does reach this gate too, verified not assumed): the SAME
    // early-return trace as JUDGMENT CALL #4/#5 above applies - none of `processCommands()`'s skip
    // condition, the Kobold-streaming-unsupported/horde-not-allowed checks, `!hasBackendConnection`, or
    // `selected_group` excludes 'continue' by name, and none but `processCommands()`'s depend on `type`
    // at all (and that one doesn't exclude 'continue' either - only 'regenerate'/'swipe'/'quiet'/
    // dryRun/depth are named there, so a continue's send-textarea content, if any, still runs through
    // slash-command interception exactly like a normal turn's does - unrelated to this gate, and
    // unchanged by this cutover). So a plain continue reaches this gate exactly like a normal turn does.
    //
    // JUDGMENT CALL #7 (widened to 'kobold'/'novel'/'koboldhorde'): the server side of this cutover
    // (resolveTextCompletionGenerationInput()/assembleTextCompletionPrompt(),
    // src/text-completion-generation-input.js) now dispatches its own Step 16 on `mainApi` for
    // 'kobold'/'novel' too (src/text-completion-prompt-orchestrator.js), and real raw-action `/generate`
    // branches now exist for both (src/endpoints/backends/kobold.js's buildRawActionKoboldRequest(),
    // src/endpoints/novelai.js's buildRawActionNovelRequest()) - built the SAME way as the
    // textgenerationwebui one already wired here, reusing the exact same
    // character_avatar/group_id/owner_id/node_id/type/user_message payload shape (verified: neither
    // builder needs anything backend-specific in the
    // REQUEST shape itself - Kobold's own `kai_settings.api_server`/NovelAI's own `nai_settings.model_novel`
    // are both resolved SERVER-side from real, on-disk settings, not sent by the client). So this gate
    // now covers `main_api === 'kobold'` and `main_api === 'novel'` too, unchanged otherwise (same
    // dryRun/type/file-attachment/tool-calling restrictions).
    // UPDATE (this task): `'koboldhorde'` is NOW REAL, real-verified support too - an earlier version
    // of this comment excluded it "by name" on the assumption that Horde needs a fundamentally
    // different architecture; that assumption was WRONG. `createKoboldGenerationData()`'s own real,
    // already-tested `isHorde` flag (src/kobold-generation-data.js) already produces the correct
    // payload shape for Horde (min_p/stop_sequence/mirostat/use_default_badwordsids/grammar all
    // included regardless of `koboldFlags`) - buildRawActionKoboldRequest() just needed its
    // `macroExtras` threaded through so src/endpoints/horde.js's own new raw-action
    // `/api/horde/generate-text` branch could pass `{ isHorde: true }`. Horde has no single fixed
    // `api_server` (a worker pool routes each request), but that was never actually a REQUEST-shape
    // requirement - Horde's own `/generate-text` endpoint (public/scripts/horde.js's `generateHorde()`)
    // never sent one either; it POSTs `{prompt, params, trusted_workers, models}` to Horde's own
    // coordinator, which does worker selection itself.
    // UPDATE (server-side streaming cutover): Horde generation is no longer client-polled at all -
    // src/endpoints/horde.js's `/generate-text` route now submits the job to Horde AND polls it
    // internally, streaming the result back over the same compact-v1 wire protocol every other
    // backend uses (keepalive frames while waiting, a content frame once done, a real server-side
    // `persistAssistantReply()` call for a raw-action request, then the `assistant_node_id` frame).
    // This gate still only builds the RAW-ACTION IDENTITY payload (character/branch/user-message)
    // here, same as every other backend - see sendGenerationRequest()'s own `main_api ===
    // 'koboldhorde'` branch and public/scripts/horde.js's `generateHordeRawAction()` for how the
    // request reaches the server and the resulting stream is consumed.
    // REAL, NARROW, DELIBERATELY DEFERRED SCOPE BOUNDARY (not attempted by this task):
    // `horde_settings.auto_adjust_response_length`/`auto_adjust_context_length` (live worker-capacity
    // auto-adjustment, `adjustHordeGenerationParams()` below) is NOT applied to a raw-action Horde
    // request - `adjustHordeGenerationParams()` is itself just a client-side wrapper around the
    // EXISTING `/api/horde/text-workers` endpoint, so this is a real, addressable follow-up (the
    // server could call it itself, or the client could still pre-adjust `amount_gen`/`max_context`
    // before this gate runs), not a fundamental blocker - without it, `createKoboldGenerationData()`
    // still produces a valid request from the user's own configured settings, just without shrinking
    // it to fit whatever a currently-available worker can handle, so Horde may reject/retry more
    // often on an unadjusted size. Basic raw-action Horde generation works correctly without it.
    // UPDATE (this task - file/media attachment cutover): `!hasPendingFileAttachment()` REMOVED from
    // this gate's own preconditions. That check was gating on the WRONG signal - whether a file input
    // element still has a File object staged in the DOM - when what actually matters is whether the
    // bytes have already reached the server, which they always have by this point for the one type
    // that can ever have a fresh attachment here ('normal'): `populateFileAttachment()` (public/
    // scripts/chats.js), called from `sendMessageAsUser()` a few hundred lines above (`sentUserMessage`
    // local, captured there), already uploaded the file (`saveBase64AsFile()`/`/api/files/upload`) and
    // attached the result onto that message's own `extra.files`/`extra.media` BEFORE this gate ever
    // runs. Verified (not assumed) that server-side `resolveTextCompletionGenerationInput()`'s already-
    // generic file-attachment inlining (`file-attachment-inline.js`, wired into
    // `text-completion-prompt-orchestrator.js`) reads `.extra` off whatever chat entry it's given,
    // tree-loaded or freshly in-memory alike - so forwarding just the REFERENCE (`user_message_extra`
    // below, sourced from `sentUserMessage.extra`) is sufficient; no re-upload, no client-side
    // re-read of the file, needed. Media/image inlining is chat-completion-specific (no vision-style
    // inlining exists for these four backends), so `.media`/`.media_index`/`.inline_image` are
    // harmlessly forwarded-but-unused here - only `.files` is ever actually read for Kobold/NovelAI/
    // Horde/textgenerationwebui. See buildRawActionKoboldRequest()'s/buildRawActionNovelRequest()'s
    // own doc comments (src/endpoints/backends/kobold.js, src/endpoints/novelai.js) for the
    // server-side confirmation this was extended to all three, not just textgenerationwebui.
    let rawActionGenerateData = null;
    if (!dryRun && (main_api === 'textgenerationwebui' || main_api === 'kobold' || main_api === 'novel' || main_api === 'koboldhorde')
        && [undefined, 'normal', 'impersonate', 'quiet', 'swipe', 'regenerate', 'continue'].includes(type)
        // UPDATE (chunk (c) - client-proxy tool calling): `!canPerformToolCalls` REMOVED. This is a
        // no-op for this particular gate in practice - `ToolManager.isToolCallingSupported()`
        // unconditionally returns `false` whenever `main_api !== 'openai'` (public/scripts/
        // tool-calling.js), and every `main_api` this gate covers is never 'openai' - but it's
        // removed here too for consistency with the chat-completion gate below (see that gate's own,
        // load-bearing removal comment) and so this precondition list doesn't misleadingly suggest
        // tool-calling is a real concern for these four backends.
    ) {
        // `getCurrentCharacter()?.avatar` is unchanged from the single-character case - see JUDGMENT
        // CALL #1 above for why this SAME expression already resolves to the correct RESPONDING
        // MEMBER inside a group turn too (generateGroupWrapper() calls setCharacterId(avatar) - this
        // file's own this_avatar source of truth - synchronously before each per-member Generate()
        // call). `groupId` is `selected_group` itself, already the group's real id (see JUDGMENT CALL
        // #1 above) - not derived from characterAvatar the way `ownerId` is for a plain character chat.
        const characterAvatar = getCurrentCharacter()?.avatar;
        const groupId = selected_group || undefined;
        // For a group turn, owner_id addresses the GROUP's own chat/branch storage (matching
        // src/endpoints/chats.js's own `ownerId = group_id ? touchGroupOwner(...).id : avatar...`
        // pattern) - a character avatar would be the WRONG owner here, even though characterAvatar
        // itself is still resolved and sent (as `character_avatar`) for the responding member's own
        // card/prompt resolution. Falls back to the plain per-character ownerId when not in a group,
        // unchanged from before.
        const ownerId = groupId ? String(groupId) : (characterAvatar ? String(characterAvatar).replace('.png', '') : undefined);
        // UPDATE (this task - node_id-only addressing cutover): `branch_name` is REMOVED from the wire
        // payload entirely (see src/endpoints/backends/text-completions.js's own
        // buildRawActionTextCompletionRequest() ADDRESSING MODEL doc comment) - the server now requires
        // an explicit `node_id` instead: a real node id string addresses that specific node, or the
        // literal `null` asserts "this is a genuinely new, empty conversation" (server-verified, not
        // trusted blindly). The real node the client is generating from/replying to/replacing is
        // `lastMessage` - captured near the top of this function, BEFORE the 'regenerate'-only "delete
        // the last message from `chat`" branch a few hundred lines above (see that branch's own
        // comment) - deliberately NOT re-read as `chat[chat.length - 1]` here, since for 'regenerate'
        // specifically that array has already had its own last entry spliced out by then, which would
        // resolve to the WRONG (parent) node instead of the one actually being regenerated. For every
        // other type this gate covers (normal/continue/impersonate/quiet/swipe), `lastMessage` and
        // `chat[chat.length - 1]` are identical anyway (nothing was deleted), so this is a strict
        // generalization, not a behavior change for those types - matches `isSwipe`'s own established
        // `type == 'swipe' || type == 'regenerate'` "same anchor either way" treatment (see the
        // `isSwipe` local's own doc comment above). `isStoredNodeId()` (this file's own tree-row/
        // provisional-greeting distinction) guards against sending a provisional (`card:`-prefixed) id
        // for an unwritten opening greeting - the server would reject that as an unknown node, whereas
        // `null` correctly asserts "no real history yet" for that same state.
        const anchorNodeId = isStoredNodeId(lastMessage?.node_id) ? lastMessage.node_id : null;
        // `characterAvatar` is required unconditionally, group turn or not: even with `groupId` set,
        // a responding member's own avatar must resolve for real (defensively falls through to the
        // legacy path instead of assuming this, for the unlikely case `getCurrentCharacter()` were
        // ever unresolved mid-group-turn) - see JUDGMENT CALL #1 above for why this is verified to
        // always be true in practice for every type this gate covers.
        if (ownerId && characterAvatar) {
            // Omitted (undefined) for any type that doesn't add a new message - matches the server's
            // own documented contract. In practice, given the scope above, this path is reached for
            // type 'normal'/undefined (where textareaText is the just-sent text, or '' for a depth>0
            // tool-call follow-up generation, which likewise adds no new user message), for
            // 'impersonate'/'quiet' (where textareaText is unconditionally '' - see JUDGMENT CALL #3
            // above), and for 'swipe'/'regenerate' (excluded from the same textareaText-read condition
            // by name, so likewise unconditionally '' - see that condition a few hundred lines above:
            // `type !== 'regenerate' && type !== 'swipe' && type !== 'quiet' && !isImpersonate &&
            // !dryRun && !depth`), so userMessageText is always undefined for all four of these types.
            // 'continue' is the ONE exception: it is NOT named in that same condition, so
            // `userMessageText` CAN be a real, non-empty string for it (leftover send-box text at the
            // moment Continue was clicked) - see JUDGMENT CALL #1/#3 above for the full investigation
            // and the server-side `continueUserTextConflict` guard this required. Sent through unchanged
            // either way (`user_message` below); the server decides what to do with it.
            const userMessageText = textareaText !== '' ? textareaText : undefined;
            // Only meaningful alongside a real `userMessageText` (the server ignores it otherwise -
            // see buildRawActionTextCompletionRequest()'s own doc comment) - `sentUserMessage` (set a
            // few hundred lines above, inside the SAME "for normal messages sent from user.." block
            // whose `sendMessageAsUser()` call is the only thing that can populate a fresh
            // `extra.files`/`extra.media` before this gate runs) is undefined whenever no message was
            // actually appended this call (e.g. a plain continue/swipe/impersonate/quiet), in which
            // case this is simply `undefined` too - a real, verified "nothing to forward" case, not a
            // dropped value. The server re-validates this regardless of what's sent here (see
            // `sanitizeUserMessageExtra()`, message-tree-db.js) - this is a REFERENCE to an attachment
            // already uploaded by `populateFileAttachment()`, never the file itself.
            const userMessageExtra = userMessageText !== undefined ? sentUserMessage?.extra : undefined;
            rawActionGenerateData = {
                character_avatar: characterAvatar,
                group_id: groupId,
                owner_id: ownerId,
                node_id: anchorNodeId,
                type: type ?? 'normal',
                // is_impersonate/is_continue/is_swipe are NOT sent - the server derives all three from
                // `type` alone (isImpersonate = type === 'impersonate', isContinue = type ===
                // 'continue', isSwipe = type === 'swipe' || type === 'regenerate' - see
                // src/endpoints/backends/text-completions.js's/kobold.js's own identical server-side
                // derivation) - sending them too was sending the same fact twice in two encodings.
                user_message: userMessageText,
                // See JUDGMENT CALL above this gate (`!hasPendingFileAttachment()` removal) for the
                // full rationale - a forwarded REFERENCE, not a re-upload.
                user_message_extra: userMessageExtra,
                // Kobold-only: mirrors the EXACT real condition getKoboldGenerationData() (public/
                // scripts/kai-settings.js) and its server-side port createKoboldGenerationData()
                // (src/kobold-generation-data.js) both use for their own `streaming` field -
                // `kai_settings.streaming_kobold && kai_flags.can_use_streaming && type !== 'quiet'`
                // (NOT a simplified two-term version - `type !== 'quiet'` is a real third term found
                // by reading that computation in full). Without this, the raw-action payload built
                // above never set `.streaming` at all, so generateKoboldWithStreaming() (kai-
                // settings.js) - which, unlike generateNovelWithStreaming()'s unconditional
                // `generate_data.streaming = nai_settings.streaming_novel;` overwrite, just fetches
                // whatever `.streaming` already is - would send `streaming: undefined` even though
                // isStreamingEnabled() (~line 4572 above) already decided to call the streaming send
                // path. `kai_flags.can_use_streaming` is a live client-side connection probe result
                // that has no server-side equivalent, so this must be computed here, client-side.
                // Left `undefined` for 'novel'/'textgenerationwebui'/'koboldhorde' (this same object is
                // shared by all four raw-action-eligible main_apis): NovelAI's own wrapper overwrites
                // it unconditionally regardless of what's sent here, so it's a no-op there; Horde is
                // never streamed at all (isStreamingEnabled() has no 'koboldhorde' branch - see that
                // function, ~line 4572 - so this field is simply never read for it); textgen's
                // equivalent asymmetry (if any) is out of scope for this fix.
                streaming: main_api === 'kobold'
                    ? (kai_settings.streaming_kobold && kai_flags.can_use_streaming && type !== 'quiet')
                    : undefined,
                // Kobold-only, same root cause as `streaming` above but a SIMPLER real condition -
                // verified by reading getKoboldGenerationData() (kai-settings.js line ~187) and its
                // server-side port createKoboldGenerationData() (src/kobold-generation-data.js line
                // ~112): both compute `can_abort` as JUST `kai_flags.can_use_streaming` alone - no
                // `kai_settings.streaming_kobold` term, no `type !== 'quiet'` term (unlike `streaming`
                // above, which genuinely needs all three). Without this, the raw-action payload never
                // set `.can_abort`, and built.params.can_abort (from createKoboldGenerationData(), see
                // the route's own `koboldFlags` comment) is unconditionally `false` server-side for the
                // same reason `streaming` was: buildRawActionKoboldRequest() never passes a real
                // `koboldFlags` value through, so it defaults to `{}`. That falsy `can_abort` silently
                // disables the socket-close abort-on-disconnect call in kobold.js's `/generate` route
                // (`if (request.body.can_abort && !response_generate.writableEnded) { ... }`), so a
                // raw-action stream whose client disconnects mid-generation would never tell the real
                // Kobold backend to stop. Left `undefined` for 'novel'/'textgenerationwebui'/
                // 'koboldhorde' for the same reason as `streaming` above - out of scope here (and,
                // for 'koboldhorde' specifically, meaningless: Horde is never streamed at all).
                can_abort: main_api === 'kobold' ? kai_flags.can_use_streaming : undefined,
            };
        }
        // else: no resolvable ownerId/characterAvatar (other precondition) - fall through to the
        // legacy client-assembled path below, unchanged.
    }

    // === Raw-action chat-completion cutover ===
    // Direct analog of the raw-action text-completion cutover immediately above, for main_api === 'openai'. The
    // already-built, already-tested server-side pipeline (resolveChatCompletionGenerationInput() +
    // prepareOpenAIMessages() [src/chat-completion-prepare-messages.js, NOT the client-side legacy function of the
    // same name called a few lines below] + createGenerationParameters() [src/chat-completion-generation-data.js])
    // is wired into a real raw-action branch of /api/backends/chat-completions/generate - see
    // buildRawActionChatCompletionRequest() in src/endpoints/backends/chat-completions.js (commits de3696095,
    // 6bd95de8e). Instead of the client-assembled oaiMessages/prompt, this sends only which character/node and the
    // literal text typed, matching that endpoint's real, tested contract (character_avatar/group_id/owner_id/
    // node_id/type/user_message - field names deliberately verbatim from the text-completion precedent,
    // per this session's own task instructions; there is no `branch_name` field anymore, and
    // is_impersonate/is_continue/is_swipe are derived server-side from `type` alone - see the
    // text-completion cutover's own identical UPDATE comment above).
    //
    // JUDGMENT CALL #1 (scope): IDENTICAL restriction to the text-completion cutover above, for the IDENTICAL
    // underlying reason - re-confirmed by reading the chat-completion side's OWN persistence code
    // (buildRawActionChatCompletionRequest()'s appendMessages()/addAlternatives()/selectDefaultChild()/
    // editMessage() calls in chat-completions.js), not copy-pasted blindly:
    //   - group chats: NOW INCLUDED (this follow-up task) - same client-side mechanism as the text-completion
    //     cutover above (the exact same getCurrentCharacter()/setCharacterId() mechanism applies here too, since
    //     both cutovers live in this same Generate() function and share the identical selected_group/
    //     getCurrentCharacter() primitives - see that block's own JUDGMENT CALL #1 for the full investigation).
    //     Previously excluded because resolveChatCompletionGenerationInput() (src/chat-completion-generation-
    //     input.js) had its own, separate, pre-existing, documented MVP scope boundary (`isGroup` hardcoded
    //     `false`, `groupMemberNames` hardcoded `[]`, `void groupId`) - that resolver now has real group support
    //     (real `isGroup`/`groupMemberNames`/combined group-card resolution via `getCharacterCardFields()`'s own
    //     already-real `groupId` support - see that file's own doc comment GROUPS section), so this cutover is
    //     widened the same way the text-completion one already was.
    // 'continue' is now ALSO INCLUDED, same real tree-shape bug/fix as the text-completion cutover's own
    // (identically-worded) JUDGMENT CALL #1 above: the client's saveReply({type:'appendFinal'}) edits the existing
    // leaf node's text in place, but the server's appendMessages() call (keyed off `anchorNodeId`, which for
    // chat-completion's raw action is ALSO just the branch leaf - see buildRawActionChatCompletionRequest()'s Step
    // 2) used to always append a brand-new CHILD node instead. Now fixed identically: `editMessage()`
    // (src/message-tree-db.js) splices `oldText + newText` into the anchor's own current content and replaces the
    // whole stored node in place when `is_continue` is set - see that route handler's own comment on this branch,
    // and the text-completion cutover's own JUDGMENT CALL #1 above for the full `continue_mag`/reasoning-round-trip/
    // `continueUserTextConflict` investigation this is based on (identical for both backends - chat-completion's own
    // `resolveChatCompletionGenerationInput()` never drops or alters the leaf's content for `isContinue` either,
    // only for `isSwipe` - see that function's own `promptChat` doc comment - so `orchestratorInput.macroContext.chat`
    // 's last entry is the real, current anchor content here too).
    // 'impersonate'/'quiet' are now INCLUDED (previously excluded in commit 9d3091f41 for the identical reason as
    // the text-completion cutover's own original exclusion - the server's persistence used to be unconditional).
    // That's now fixed server-side (see buildRawActionChatCompletionRequest()'s route handler in
    // src/endpoints/backends/chat-completions.js: `isImpersonate`/`type === 'quiet'` skip BOTH the user-message and
    // assistant-reply appendMessages() calls), and `user_message` is verified to always resolve to `undefined` for
    // both (identical reasoning to the text-completion cutover's own JUDGMENT CALL #3 above - `textareaText` is
    // unconditionally `''` for both types), so there's nothing new for the server to spuriously persist regardless.
    // See JUDGMENT CALL #3 below, however, for a real chat-completion-SPECIFIC gap this widening does not close.
    //
    // 'swipe'/'regenerate' are ALSO now INCLUDED, same real tree-shape bug/fix as the text-completion cutover's own
    // (identically-worded) JUDGMENT CALL #1 above - `anchorNodeId` here is likewise just the branch leaf (the
    // message being swiped/regenerated), so a plain appendMessages() call would have chained the reply as a CHILD
    // after it instead of a SIBLING alongside it. Now fixed identically: `addAlternatives()` +
    // `selectDefaultChild()` when `is_swipe` is set (see that route handler's own comment on this branch). A REAL,
    // chat-completion-SPECIFIC gap was found and fixed alongside this, though, that the text-completion pipeline did
    // NOT have: `resolveChatCompletionGenerationInput()` (src/chat-completion-generation-input.js) previously never
    // excluded the message being swiped/regenerated from the `chat` array it builds `messages`/world-info-scanning
    // input/`macroContext` from at all (it accepted an `isSwipe` parameter but never read it - `void isSwipe`) -
    // unlike src/text-completion-prompt-orchestrator.js's own `buildCoreChat({isSwipe})`, which already correctly
    // popped that message. Left as-is, a chat-completion swipe/regenerate would have fed the model its OWN
    // about-to-be-replaced reply as the newest turn of its own context. Fixed there (now a real `promptChat` that
    // drops the last entry when `isSwipe`), plus a matching fix to the shared `getBiasStrings()` (src/prompt-line-
    // formatting.js, used by BOTH pipelines) to skip that same last entry for `type === 'regenerate'` too, not just
    // `'swipe'` (its one-line-literal port of the client's own check only handled `'swipe'`, because client-side the
    // array is already shortened for 'regenerate' by the time that function runs there - not true server-side, where
    // `chat` is always freshly resolved from the persisted tree regardless of which literal `type` string was sent).
    // No genuinely NEW chat-completion-specific correctness concern beyond THAT was found - specifically checked
    // and ruled out:
    //   - Claude's assistant-prefill continuation semantics (`oai_settings.continue_prefill`/`supportsAssistantPrefill`,
    //     threaded through src/chat-completion-history.js/src/chat-completion-prepare-messages.js) are used ONLY for
    //     `type === 'continue'` (verified: src/chat-completion-generation-data.js line ~325, `if (type !== 'quiet' &&
    //     !(type === 'continue' && settings.continue_prefill))`) - already excluded from this narrow scope, so this
    //     never interacts with a plain 'normal' turn.
    //   - Tool-call reconstruction in chat history (src/chat-completion-history.js's `canUseTools &&
    //     Array.isArray(chatPrompt.invocations)` branch) operates on tool invocations already recorded on PAST
    //     messages in the loaded chat history - it is not affected by whether the CURRENT turn is allowed to call
    //     tools. The `!canPerformToolCalls` gate below (same `canPerformToolCalls` local declared above, computed via
    //     `ToolManager.canPerformToolCalls(type)` which itself defaults to `oai_settings`/`getChatCompletionModel(oai_settings)`
    //     when not given explicit settings/model - i.e. it is not main_api-specific in a way that changes anything
    //     here; it already reflects the chat-completion settings regardless of main_api) only prevents the CURRENT
    //     turn from registering/using tools, exactly mirroring the client's own `!canMultiSwipe &&
    //     ToolManager.canPerformToolCalls(type, settings, model)` gate before `registerFunctionToolsOpenAI()` in
    //     createGenerationParameters() (public/scripts/chat-completion-settings.js) - so excluding
    //     `canPerformToolCalls` here is, if anything, an even more directly-applicable precondition for chat
    //     completion than it was for text completion.
    //
    // JUDGMENT CALL #2 (assembly now REALLY skipped - NARROWED after a real regression was found and fixed):
    // IDENTICAL strategy to the text-completion cutover's own (identically-renumbered) JUDGMENT CALL #2 above - this
    // DOES skip the remaining, genuinely pure-prompt-string-construction part of the client-side prompt-assembly
    // (world info scan, the legacy client-side `prepareOpenAIMessages()`-feeding locals) whenever THIS gate (or the
    // text-completion one above it) resolves to non-null, via the SAME
    // `if (!rawActionGenerateData && !rawActionChatCompletionData) { ... }` wrapper. It does NOT skip
    // character-card-fields/depth-prompt resolution, `coreChat` construction, or `runGenerationInterceptors()` -
    // those were moved to run unconditionally, before either raw-action gate - see the text-completion cutover's own
    // (identically-renumbered) JUDGMENT CALL #2 above for the full rationale (extension-interceptor abort hook +
    // shared extension_prompts table writes), which applies identically here since it is the SAME code path (one
    // `Generate()` function, one assembly, shared by both backends). `oaiMessages`, `oaiMessageExamples`,
    // `worldInfoBefore`, `worldInfoAfter` (locals this cutover's own data flow depends on) are hoisted with safe
    // defaults above that block for exactly the same temporal-dead-zone reason documented there. `system`,
    // `jailbreak`, `description`, `personality`, `scenario` need no such hoisting any more - they are computed for
    // real, unconditionally, by the always-run section above (`promptBias` likewise needed no such hoisting - it is
    // resolved even earlier, before either gate, as part of this function's initial textarea/bias setup, so it
    // already carries its real value regardless of whether the remaining assembly runs). What is ADDITIONALLY
    // skipped for the
    // raw-action case, beyond the assembly itself, is the actual CLIENT-SIDE `prepareOpenAIMessages()` CALL inside
    // the `case 'openai':` block below (the "final generate_data builder" step - the direct analog of
    // `getTextGenGenerationData()` for the textgen case) - its result (`prompt`/`counts`) is simply never computed
    // for this one case, and `generate_data` is set directly from the raw action object instead. This remains safe
    // (does not skip anything read via TDZ downstream): `counts`/`thisPromptBits` are used only to build
    // `additionalPromptStuff` in `finishGenerating()` via `thisPromptBits[Number(thisPromptBits.length - 1)]` -
    // spreading `thisPromptBits[-1]` (`undefined`) into an object literal is a no-op, not a TypeError - verified by
    // reading `finishGenerating()`'s own `additionalPromptStuff` construction, and `thisPromptBits` itself is now
    // hoisted to `[]` above the (skipped) assembly for the same reason every other local on this list is.
    // `openai_messages_count` (set as a side effect of the skipped `prepareOpenAIMessages()` call) is likewise
    // UI-only (an "N messages in context" display, via `setInContextMessages()`) - also skipped here rather than fed
    // a stale prior value, to avoid displaying a wrong number; a pure UI cosmetic, not a correctness concern.
    //
    // JUDGMENT CALL #3 (jsonSchema, chat-completion-SPECIFIC - real, verified, and deliberately gated on): unlike
    // 'textgenerationwebui' (see the text-completion cutover's own JUDGMENT CALL #4 above), a per-call `jsonSchema`
    // (this function's own `jsonSchema` parameter) is a REAL input to chat-completion generation -
    // createGenerationParameters() (public/scripts/chat-completion-settings.js) turns it into `generate_data.json_schema`
    // (src/chat-completion-generation-data.js, mirrored server-side) and even changes `stream`/`isWorkersAIJsonMode`
    // for some sources. `generateQuietPrompt()` (this file) is a REAL caller that can pass a non-null `jsonSchema`
    // through to `Generate('quiet', {..., jsonSchema})` - e.g. any extension/slash-command asking for a
    // schema-constrained quiet generation. `buildRawActionChatCompletionRequest()` (src/endpoints/backends/
    // chat-completions.js) does NOT accept or forward a `jsonSchema` at all - its own doc comment lists `jsonSchema`
    // explicitly as one of the fields "NOT resolved here" (an explicit MVP scope boundary, not an oversight). Routing
    // a schema-bearing quiet call through the raw-action path would silently drop the schema requirement server-side
    // and return an unconstrained completion instead - a real, silent behavior change, not a hypothetical one. So
    // this gate explicitly excludes any call with a `jsonSchema` set, falling through to the legacy
    // `createGenerationParameters()` path (which still honors it) instead. Every OTHER excluded field on that same
    // doc-comment list (getStoppingStrings/groupNames/electronHubReasoningEfforts/toolsPayload/reverseProxyValidated)
    // is either not something `Generate()` itself ever threads through to this call, or is already covered by an
    // existing gate (`toolsPayload` <-> `canPerformToolCalls`, already excluded above) - `jsonSchema` was the one
    // real gap specific to this narrow scope, verified by reading every consumer of this function's own `jsonSchema`
    // parameter, not assumed absent.
    // UPDATE (this task - jsonSchema threading, gap closed): the doc-comment-listed exclusion this JUDGMENT CALL
    // relied on was checked again, not assumed still true - `buildRawActionChatCompletionRequest()`'s own doc
    // comment previously listed `jsonSchema` under "NOT resolved here" alongside `getStoppingStrings`/`groupNames`/
    // `electronHubReasoningEfforts`/`reverseProxyValidated`/`logitBias`, but unlike those (each a genuinely separate
    // subsystem - live model lists, a reverse-proxy confirmation UI, etc.), `createGenerationParameters()`
    // (src/chat-completion-generation-data.js) ALREADY accepted a `jsonSchema` param and turned it into
    // `generate_data.json_schema` - every provider branch in chat-completions.js already reads
    // `request.body.json_schema` off that. `buildRawActionChatCompletionRequest()` itself simply never accepted
    // or forwarded the param - a small, mechanical gap, not missing subsystem design. Fixed by adding a
    // `jsonSchema` param to `buildRawActionChatCompletionRequest()` (forwarded straight into its own
    // `createGenerationParameters()` call) and a `json_schema` field on this function's own raw-action payload
    // below (identical shape - `{name, value, description?, strict?, returnInvalid?}` - no new shape invented).
    // The `!jsonSchema` exclusion on this gate is REMOVED accordingly - see that removal's own UPDATE comment
    // above for the mechanical detail.
    // JUDGMENT CALL #4 ('continue' does reach this gate too, verified not assumed): identical trace to the
    // text-completion cutover's own JUDGMENT CALL #6 above - none of this function's early returns between its
    // start and here exclude 'continue' by name (only 'regenerate'/'swipe'/'quiet'/dryRun/depth are named in
    // processCommands()'s own skip condition), so a plain continue reaches this gate exactly like a normal turn
    // does. Same real edge case applies too (see the text-completion cutover's own JUDGMENT CALL #1 above): a
    // continue's `userMessageText` CAN be non-empty (leftover send-box text), handled by the identical
    // `continueUserTextConflict` guard in chat-completions.js's own route handler.
    // UPDATE (this task - file/media attachment cutover): `!hasPendingFileAttachment()` REMOVED -
    // identical rationale to the text-completion cutover's own removal above. Chat-completion is
    // additionally the ONE backend family with real media/image inlining (`inlineMediaAttachment()`,
    // src/chat-completion-history.js, backed by src/chat-completion-budget.js's `addImage`/`addVideo`/
    // `addAudio`) - already generic over `.extra.media`/`.media_index`/`.inline_image` on whatever
    // chat entry it's given (verified via `buildChatCompletionMessages()`, src/chat-completion-
    // messages.js, which reads those straight off `chat[j].extra` for the in-memory injected turn
    // exactly like a tree-loaded one) - so `.media` (image/video/audio) is fully inlined into this
    // turn's own prompt. `.files` (text attachments) is forwarded and correctly PERSISTED here too,
    // but NOT currently inlined into this turn's prompt - `file-attachment-inline.js` is wired only
    // into the text-completion pipeline, not chat-completion's (verified by grep, not assumed) - a
    // real, pre-existing gap versus the legacy client-assembled path (which DOES inline file text via
    // `coreChat`'s own `appendFileContent()`), not something this task fixes. See the route-level
    // test in chat-completions.test.js for the full accounting.
    let rawActionChatCompletionData = null;
    if (!dryRun && main_api === 'openai'
        && [undefined, 'normal', 'impersonate', 'quiet', 'swipe', 'regenerate', 'continue'].includes(type)
        // UPDATE (this task - jsonSchema threading): `!jsonSchema` REMOVED - see JUDGMENT CALL #3
        // above for the full history of why this was excluded, and the UPDATE note appended to it for
        // why it no longer needs to be. `buildRawActionChatCompletionRequest()` (src/endpoints/backends/
        // chat-completions.js) now accepts a `jsonSchema` param and forwards it verbatim into
        // `createGenerationParameters()`'s existing `json_schema`/`response_format` support - the same
        // support the legacy path already relied on. `jsonSchema` is sent below exactly as this
        // function received it (its own `JsonSchema`-typedef shape - `name`/`value`/`description`/
        // `strict`/`returnInvalid` - unchanged, no new schema shape invented).
        // UPDATE (chunk (c) - client-proxy tool calling): `!canPerformToolCalls` REMOVED - this is
        // the actual point of this chunk. A tool-calling-capable connection is no longer excluded
        // from the raw-action cutover wholesale; `client_tools` (below) advertises the client's own
        // registered tools to the server, and a `pending_tool_calls` hand-off response (see
        // `sendOpenAIRequest()`'s own `rawAction` branch/`finishGenerating()`'s
        // `resolveClientToolHandoffLoop()` below) is how the client still gets to execute them when
        // the backend actually calls one - no fallback to legacy client-side prompt assembly.
    ) {
        // `getCurrentCharacter()?.avatar`/`groupId`/`ownerId` derivation is IDENTICAL to the
        // text-completion raw-action cutover's own (see that block's JUDGMENT CALL #1 above for the
        // full investigation this is based on - same `Generate()` function, same
        // `selected_group`/`getCurrentCharacter()`/`setCharacterId()` primitives, so the same
        // reasoning applies verbatim here): `getCurrentCharacter()?.avatar` already resolves to the
        // correct RESPONDING MEMBER inside a group turn too (generateGroupWrapper() calls
        // setCharacterId(avatar) - this file's own this_avatar source of truth - synchronously before
        // each per-member Generate() call), and `groupId` is `selected_group` itself, already the
        // group's own real id.
        const characterAvatar = getCurrentCharacter()?.avatar;
        const groupId = selected_group || undefined;
        // For a group turn, owner_id addresses the GROUP's own chat/branch storage (matching
        // src/endpoints/chats.js's own `ownerId = group_id ? touchGroupOwner(...).id : avatar...`
        // pattern) - a character avatar would be the WRONG owner here, even though characterAvatar
        // itself is still resolved and sent (as `character_avatar`) for the responding member's own
        // card/prompt resolution. Falls back to the plain per-character ownerId when not in a group,
        // unchanged from before.
        const ownerId = groupId ? String(groupId) : (characterAvatar ? String(characterAvatar).replace('.png', '') : undefined);
        // Same node_id-only addressing as the text-completion cutover above (not assumed) - see that
        // block's own UPDATE comment for the full rationale (`lastMessage`, captured before
        // 'regenerate's own delete-last-message branch, not `chat[chat.length - 1]`).
        const anchorNodeId = isStoredNodeId(lastMessage?.node_id) ? lastMessage.node_id : null;
        // `characterAvatar` is required unconditionally, group turn or not - see the text-completion
        // cutover's own identical precondition/rationale above.
        if (ownerId && characterAvatar) {
            // Same rationale as the text-completion cutover above: omitted (undefined) for any type that doesn't add
            // a new message. Given the scope above, this path is reached for type 'normal'/undefined (where
            // textareaText is the just-sent text, or '' for a depth>0 tool-call follow-up generation, which likewise
            // adds no new user message), for 'impersonate'/'quiet' (where textareaText is unconditionally '' - see
            // the text-completion cutover's own JUDGMENT CALL #3 above), and for 'swipe'/'regenerate' (excluded from
            // that same textareaText-read condition by name - see the text-completion cutover's own JUDGMENT CALL
            // #5 above), so userMessageText is always undefined for all four of these types. 'continue' is the one
            // exception (same as the text-completion cutover above): it CAN be non-empty - sent through unchanged
            // regardless, handled server-side by `continueUserTextConflict`.
            const userMessageText = textareaText !== '' ? textareaText : undefined;
            // Identical mechanism/rationale to the text-completion cutover's own `userMessageExtra`
            // local above - `sentUserMessage` is the same single local, set at most once per
            // `Generate()` call, shared by both raw-action gates.
            const userMessageExtra = userMessageText !== undefined ? sentUserMessage?.extra : undefined;
            // Chunk (c): advertise the client's own ToolManager-registered tools (browser-extension
            // tools that genuinely can't execute server-side - DOM access, extension state, etc.) via
            // the NEW `client_tools` field, exactly `ToolManager.registerFunctionToolsOpenAI()`'s own
            // computed `[{type:'function', function:{name, description, parameters}}, ...]` shape -
            // read straight off a throwaway object rather than reinventing the schema-building logic
            // (that method itself decides, per tool, whether to include it via each tool's own
            // `shouldRegister()`). Gated on `canPerformToolCalls` (this function's own local, computed
            // above from `ToolManager.canPerformToolCalls(type)` - real tool-calling support for this
            // model/source/type/depth) so a connection/model/type that can't actually use tools never
            // advertises any (`clientToolsPayload` stays `undefined`, so `client_tools` is omitted from
            // the JSON body entirely - `JSON.stringify` drops `undefined` values). The server merges
            // this with its own server-native tools (server wins on a name collision - see
            // `buildRawActionChatCompletionRequest()`'s own doc comment, `clientToolSchemas` param) and,
            // if the backend calls one of THESE names, hands off via `pending_tool_calls` instead of
            // trying to execute it itself.
            // THIS TASK (stealth-tool parity - see resolveClientToolHandoffLoop()'s own doc comment
            // below for the full investigation/design): the server can't tell a stealth tool apart
            // from a normal one just by name - `stealth` is a per-TOOL registration flag
            // (`ToolManager.registerFunctionTool()`'s own `stealth` param), never sent to the server
            // before this task. Advertise it as a SEPARATE `stealth_tool_names` list (not an extra key
            // smuggled into `clientToolsPayload`'s own OpenAI-standard tool schema entries) - only
            // ever the names ALREADY in `clientToolsPayload` (a tool that isn't registered at all, or
            // whose `shouldRegister()` said no this turn, was never advertised in the first place, so
            // it has nothing to be "stealth" about server-side). Omitted (`undefined`, dropped by
            // `JSON.stringify`) when there are none, matching `clientToolsPayload` itself.
            let clientToolsPayload;
            let stealthToolNamesPayload;
            if (canPerformToolCalls) {
                const toolsHolder = {};
                await ToolManager.registerFunctionToolsOpenAI(toolsHolder);
                clientToolsPayload = toolsHolder.tools;
                const stealthNames = (clientToolsPayload ?? [])
                    .map(tool => tool?.function?.name)
                    .filter(name => typeof name === 'string' && ToolManager.isStealthTool(name));
                stealthToolNamesPayload = stealthNames.length ? stealthNames : undefined;
            }
            rawActionChatCompletionData = {
                character_avatar: characterAvatar,
                group_id: groupId,
                owner_id: ownerId,
                node_id: anchorNodeId,
                type: type ?? 'normal',
                // is_impersonate/is_continue/is_swipe are NOT sent - see the text-completion cutover's
                // own identical UPDATE comment above (server derives all three from `type` alone).
                user_message: userMessageText,
                // See JUDGMENT CALL above this gate (`!hasPendingFileAttachment()` removal) for the
                // full rationale - a forwarded REFERENCE, not a re-upload. Unlike the text-completion
                // cutover, chat-completion's server-side pipeline actually inlines `.media` too, not
                // just `.files`.
                user_message_extra: userMessageExtra,
                // Chunk (c) - see this block's own comment on `clientToolsPayload` immediately above.
                client_tools: clientToolsPayload,
                // THIS TASK - see this block's own comment on `stealthToolNamesPayload` immediately above.
                stealth_tool_names: stealthToolNamesPayload,
                // See the removed `!jsonSchema` exclusion's own UPDATE comment above this gate - sent
                // exactly as this function received it (`JsonSchema` typedef shape), `undefined` (thus
                // dropped by `JSON.stringify`) when this call has no schema.
                json_schema: jsonSchema,
            };
        }
        // else: no resolvable ownerId/characterAvatar (other precondition) - fall through to the
        // legacy client-assembled path below, unchanged.
    }

    // === Hoisted locals for the (remaining, narrower) prompt-assembly block below ===
    // The assembly below (world info scan, author's note resolution, instruct-mode formatting, the
    // getCombinedPrompt()/prepareOpenAIMessages()-feeding pipeline) is skipped entirely when a
    // raw-action request is going to be sent (see the `if` gate below) - the server resolves the
    // whole prompt itself in that case. Every local this (now smaller) assembly declares that is READ
    // ANYWHERE later in this function (the switch below, finishGenerating(), onSuccess(), or any other
    // function nested in this closure) is hoisted here with a safe, correctly-typed default so
    // skipping the assembly cannot throw a temporal-dead-zone ReferenceError. When the assembly DOES
    // run (raw action not taken - i.e. kobold/novel/koboldhorde, a dryRun, or a legacy
    // textgenerationwebui/openai request that didn't qualify for the raw-action gate), every one of
    // these is overwritten with its real computed value inside the block below, exactly as before -
    // the assembly's own internal logic is unchanged, only the `let`/`const` on its first assignment
    // to each of these names was removed (the declaration now lives here instead).
    // NOTE: `description`, `personality`, `persona`, `scenario`, `mesExamples`, `system`, `jailbreak`,
    // `charDepthPrompt`, `creatorNotes`, `promptReasoning`, and `this_max_context` used to be hoisted
    // here too, but no longer are: the regression fix that moved character-card-fields resolution,
    // `coreChat` construction, and `runGenerationInterceptors()` to run unconditionally (see the
    // "Always-run" section far above) means all of these are now computed for real, unconditionally,
    // before either raw-action gate - there is no longer any TDZ gap for them to default across, so a
    // hoisted placeholder here would be dead, misleading code (and `this_max_context` in particular
    // would have masked the fact that it now always holds a real value even for the raw-action case).
    let adjustedParams;
    let cfgGuidanceScale = null;
    let useCfgPrompt = false;
    let mesExamplesArray = [];
    let worldInfoString = '';
    let worldInfoBefore = '';
    let worldInfoAfter = '';
    let beforeScenarioAnchor = '';
    let afterScenarioAnchor = '';
    let storyString = '';
    let injectedIndices = [];
    let continue_mag = '';
    let oaiMessages = [];
    let oaiMessageExamples = [];
    let examplesString = '';
    let cyclePrompt = '';
    let pinExmString;
    let arrMes = [];
    let count_exm_add = 0;
    let mesSend = [];
    let generatedPromptCache = '';
    let mesSendString = '';
    // Stub default - never actually invoked when raw action is taken: its one external call site
    // (the textgenerationwebui switch case below) is only reached after the `if (rawActionGenerateData)
    // {...; break;}` early-out, i.e. only once the real assembly (which reassigns this to the real
    // function) has run.
    let getCombinedPrompt = async () => '';
    let finalPrompt = '';
    let maxLength = 0;
    let thisPromptBits = [];

    if (!rawActionGenerateData && !rawActionChatCompletionData) {
        // Adjust token limit for Horde
        if (main_api == 'koboldhorde' && (horde_settings.auto_adjust_context_length || horde_settings.auto_adjust_response_length)) {
            try {
                adjustedParams = await adjustHordeGenerationParams(max_context, amount_gen);
            } catch {
                unblockGeneration(type);
                return Promise.resolve();
            }
            if (horde_settings.auto_adjust_context_length) {
                this_max_context = (adjustedParams.maxContextLength - adjustedParams.maxLength);
            }
        }

        // Fetches the combined prompt for both negative and positive prompts
        cfgGuidanceScale = getGuidanceScale();
        useCfgPrompt = cfgGuidanceScale && cfgGuidanceScale.value !== 1;

        // Adjust max context based on CFG prompt to prevent overfitting
        if (useCfgPrompt) {
            const negativePrompt = getCfgPrompt(cfgGuidanceScale, true, true)?.value || '';
            const positivePrompt = getCfgPrompt(cfgGuidanceScale, false, true)?.value || '';
            if (negativePrompt || positivePrompt) {
                const previousMaxContext = this_max_context;
                const [negativePromptTokenCount, positivePromptTokenCount] = await Promise.all([getTokenCountAsync(negativePrompt), getTokenCountAsync(positivePrompt)]);
                const decrement = Math.max(negativePromptTokenCount, positivePromptTokenCount);
                this_max_context -= decrement;
                console.log(`Max context reduced by ${decrement} tokens of CFG prompt (${previousMaxContext} -> ${this_max_context})`);
            }
        }

        console.log(`Core/all messages: ${coreChat.length}/${chat.length}`);

        if ((promptBias && !isUserPromptBias) || power_user.always_force_name2 || main_api == 'novel') {
            force_name2 = true;
        }

        if (isImpersonate) {
            force_name2 = false;
        }

        mesExamplesArray = parseMesExamples(mesExamples, isInstruct);

        // Set non-WI AN
        setFloatingPrompt();

        // Add WI to prompt (and also inject WI to AN value via hijack)
        // Make quiet prompt available for WIAN
        setExtensionPrompt(inject_ids.QUIET_PROMPT, quiet_prompt || '', extension_prompt_types.IN_PROMPT, 0, true);
        const chatForWI = coreChat.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse();
        /** @type {import('./world-info.js').WIGlobalScanData} */
        const globalScanData = {
            personaDescription: persona,
            characterDescription: description,
            characterPersonality: personality,
            characterDepthPrompt: charDepthPrompt,
            scenario: scenario,
            creatorNotes: creatorNotes,
            trigger: GENERATION_TYPE_TRIGGERS.includes(type) ? type : 'normal',
        };
        let worldInfoExamples, worldInfoDepth, outletEntries;
        ({ worldInfoString, worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth, outletEntries } = await getWorldInfoPrompt(chatForWI, this_max_context, dryRun, globalScanData));
        setExtensionPrompt(inject_ids.QUIET_PROMPT, '', extension_prompt_types.IN_PROMPT, 0, true);

        // Add message example WI
        for (const example of worldInfoExamples) {
            const exampleMessage = example.content;

            if (exampleMessage.length === 0) {
                continue;
            }

            const formattedExample = baseChatReplace(exampleMessage);
            const cleanedExample = parseMesExamples(formattedExample, isInstruct);

            // Insert depending on before or after position
            if (example.position === wi_anchor_position.before) {
                mesExamplesArray.unshift(...cleanedExample);
            } else {
                mesExamplesArray.push(...cleanedExample);
            }
        }

        // At this point, the raw message examples can be created
        const mesExamplesRawArray = [...mesExamplesArray];

        if (mesExamplesArray && isInstruct) {
            mesExamplesArray = formatInstructModeExamples(mesExamplesArray, name1, name2);
        }

        if (skipWIAN !== true) {
            console.log('skipWIAN not active, adding WIAN');
            // Add all depth WI entries to prompt
            flushWIInjections();
            if (Array.isArray(worldInfoDepth)) {
                worldInfoDepth.forEach((e) => {
                    const joinedEntries = e.entries.join('\n');
                    setExtensionPrompt(inject_ids.CUSTOM_WI_DEPTH_ROLE(e.depth, e.role), joinedEntries, extension_prompt_types.IN_CHAT, e.depth, false, e.role);
                });
            }
            if (outletEntries && typeof outletEntries === 'object' && Object.keys(outletEntries).length > 0) {
                Object.entries(outletEntries).forEach(([key, value]) => {
                    setExtensionPrompt(inject_ids.CUSTOM_WI_OUTLET(key), value.join('\n'), extension_prompt_types.NONE, 0);
                });
            }
        } else {
            console.log('skipping WIAN');
        }

        // Add persona description to prompt
        addPersonaDescriptionExtensionPrompt();

        // Prepare the system prompt for Text Completion APIs
        if (main_api !== 'openai') {
            if (power_user.sysprompt.enabled) {
                system = power_user.prefer_character_prompt && system
                    ? substituteParams(system, { original: power_user.sysprompt.content ?? '' })
                    : baseChatReplace(power_user.sysprompt.content);
                system = isInstruct ? substituteParams(system, { original: power_user.sysprompt.content ?? '' }) : system;
            } else {
                // Nullify if it's not enabled
                system = '';
            }
        }

        // Collect before / after story string injections
        beforeScenarioAnchor = await getExtensionPrompt(extension_prompt_types.BEFORE_PROMPT);
        afterScenarioAnchor = await getExtensionPrompt(extension_prompt_types.IN_PROMPT);

        const storyStringParams = {
            description: description,
            personality: personality,
            persona: power_user.persona_description_position == persona_description_positions.IN_PROMPT ? persona : '',
            scenario: scenario,
            system: system,
            char: name2,
            user: name1,
            wiBefore: worldInfoBefore,
            wiAfter: worldInfoAfter,
            loreBefore: worldInfoBefore,
            loreAfter: worldInfoAfter,
            anchorBefore: beforeScenarioAnchor.trim(),
            anchorAfter: afterScenarioAnchor.trim(),
            mesExamples: mesExamplesArray.join(''),
            mesExamplesRaw: mesExamplesRawArray.join(''),
        };

        // Render the story string and combine with injections
        storyString = renderStoryString(storyStringParams);
        let combinedStoryString = isInstruct ? formatInstructModeStoryString(storyString) : storyString;

        // Inject the story string as in-chat prompt (if needed)
        const applyStoryStringInject = main_api !== 'openai' && power_user.context.story_string_position === extension_prompt_types.IN_CHAT;
        if (applyStoryStringInject) {
            const depth = power_user.context.story_string_depth ?? 1;
            const role = power_user.context.story_string_role ?? extension_prompt_roles.SYSTEM;
            setExtensionPrompt(inject_ids.STORY_STRING, combinedStoryString, extension_prompt_types.IN_CHAT, depth, false, role);
            // Remove to prevent duplication
            combinedStoryString = '';
        } else {
            setExtensionPrompt(inject_ids.STORY_STRING, '', extension_prompt_types.IN_CHAT, 0);
        }

        // Story string rendered, safe to remove
        if (power_user.strip_examples) {
            mesExamplesArray = [];
        }

        // Inject all Depth prompts. Chat Completion does it separately
        injectedIndices = [];
        if (main_api !== 'openai') {
            injectedIndices = await doChatInject(coreChat, isContinue);
        }

        if (main_api !== 'openai' && power_user.sysprompt.enabled) {
            jailbreak = power_user.prefer_character_jailbreak && jailbreak
                ? substituteParams(jailbreak, { original: power_user.sysprompt.post_history ?? '' })
                : baseChatReplace(power_user.sysprompt.post_history);

            // Only inject the jb if there is one
            if (jailbreak) {
                // When continuing generation of previous output, last user message precedes the message to continue
                if (isContinue) {
                    coreChat.splice(coreChat.length - 1, 0, { mes: jailbreak, is_user: true });
                } else {
                    // This operation will result in the injectedIndices indexes being off by one
                    coreChat.push({ mes: jailbreak, is_user: true });
                    // Add +1 to the elements to correct for the new PHI/Jailbreak message.
                    injectedIndices.forEach(shiftUpByOne);
                }
            }
        }

        let chat2 = [];
        continue_mag = '';
        let userMessageIndices = [];
        const lastUserMessageIndex = coreChat.findLastIndex(x => x.is_user);

        for (let i = coreChat.length - 1, j = 0; i >= 0; i--, j++) {
            if (main_api == 'openai') {
                chat2[i] = coreChat[j].mes;
                if (i === 0 && isContinue) {
                    chat2[i] = chat2[i].slice(0, chat2[i].lastIndexOf(coreChat[j].mes) + coreChat[j].mes.length);
                    continue_mag = coreChat[j].mes;
                }
                continue;
            }

            chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, false);

            if (j === 0 && isInstruct) {
                // Reformat with the first output sequence (if any)
                chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, force_output_sequence.FIRST);
            }

            if (lastUserMessageIndex >= 0 && j === lastUserMessageIndex && isInstruct && !isImpersonate) {
                // Reformat with the last input sequence (if any)
                chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, force_output_sequence.LAST);
            }

            // Do not suffix the message for continuation
            if (i === 0 && isContinue) {
                // Pick something that's very unlikely to be in a message
                const FORMAT_TOKEN = '\u0000\ufffc\u0000\ufffd';

                if (isInstruct) {
                    const originalMessage = String(coreChat[j].mes ?? '');
                    // Work on a temporary shallow copy so we don't mutate the (possibly frozen) original
                    const tempMsg = { ...coreChat[j], mes: originalMessage.replaceAll(FORMAT_TOKEN, '') + FORMAT_TOKEN };
                    // Reformat with the last output sequence (if any)
                    chat2[i] = formatMessageHistoryItem(tempMsg, isInstruct, force_output_sequence.LAST);
                }

                chat2[i] = chat2[i].includes(FORMAT_TOKEN)
                    ? chat2[i].slice(0, chat2[i].lastIndexOf(FORMAT_TOKEN))
                    : chat2[i].slice(0, chat2[i].lastIndexOf(coreChat[j].mes) + coreChat[j].mes.length);
                continue_mag = coreChat[j].mes;
            }

            if (coreChat[j].is_user) {
                userMessageIndices.push(i);
            }
        }

        let addUserAlignment = isInstruct && power_user.instruct.user_alignment_message;
        let userAlignmentMessage = '';

        if (addUserAlignment) {
            const alignmentMessage = {
                name: name1,
                mes: substituteParams(power_user.instruct.user_alignment_message),
                is_user: true,
            };
            userAlignmentMessage = formatMessageHistoryItem(alignmentMessage, isInstruct, force_output_sequence.FIRST);
        }

        oaiMessages = [];
        oaiMessageExamples = [];

        if (main_api === 'openai') {
            oaiMessages = setOpenAIMessages(coreChat);
            oaiMessageExamples = setOpenAIMessageExamples(mesExamplesArray);
        }

        // hack for regeneration of the first message
        if (chat2.length == 0) {
            chat2.push('');
        }

        examplesString = '';
        let chatString = addChatsPreamble(addChatsSeparator(''));
        cyclePrompt = '';

        async function getMessagesTokenCount() {
            const encodeString = [
                combinedStoryString,
                examplesString,
                userAlignmentMessage,
                chatString,
                modifyLastPromptLine(''),
                cyclePrompt,
            ].join('').replace(/\r/gm, '');
            return getTokenCountAsync(encodeString, power_user.token_padding);
        }

        // Force pinned examples into the context
        if (power_user.pin_examples) {
            pinExmString = examplesString = mesExamplesArray.join('');
        }

        // Only add the chat in context if past the greeting message
        if (isContinue && (chat2.length > 1 || main_api === 'openai')) {
            cyclePrompt = chat2.shift();
            // Adjust indices to account for the shift
            injectedIndices = injectedIndices.map(shiftDownByOne).filter(x => x >= 0);
            userMessageIndices = userMessageIndices.map(shiftDownByOne).filter(x => x >= 0);
        }

        // Collect enough messages to fill the context
        arrMes = new Array(chat2.length);
        let tokenCount = await getMessagesTokenCount();
        let lastAddedIndex = 0;

        // Pre-allocate all injections first.
        // If it doesn't fit - user shot himself in the foot
        for (const index of injectedIndices) {
            // not needed for OAI prompting
            if (main_api == 'openai') {
                break;
            }

            const item = chat2[index];

            if (typeof item !== 'string') {
                continue;
            }

            tokenCount += await getTokenCountAsync(item.replace(/\r/gm, ''));
            if (tokenCount < this_max_context) {
                chatString = chatString + item;
                arrMes[index] = item;
                lastAddedIndex = Math.max(lastAddedIndex, index);
            } else {
                break;
            }
        }

        for (let i = 0; i < chat2.length; i++) {
            // not needed for OAI prompting
            if (main_api == 'openai') {
                break;
            }

            // Skip already injected messages
            if (arrMes[i] !== undefined) {
                continue;
            }

            const item = chat2[i];

            if (typeof item !== 'string') {
                continue;
            }

            tokenCount += await getTokenCountAsync(item.replace(/\r/gm, ''));
            if (tokenCount < this_max_context) {
                chatString = chatString + item;
                arrMes[i] = item;
                lastAddedIndex = Math.max(lastAddedIndex, i);
            } else {
                break;
            }
        }

        // Add user alignment message if last message is not a user message
        const stoppedAtUser = userMessageIndices.includes(lastAddedIndex);
        if (addUserAlignment && !stoppedAtUser) {
            tokenCount += await getTokenCountAsync(userAlignmentMessage.replace(/\r/gm, ''));
            chatString = userAlignmentMessage + chatString;
            arrMes.push(userAlignmentMessage);
            injectedIndices.push(arrMes.length - 1);
        }

        // Unsparse the array. Adjust injected indices
        const newArrMes = [];
        const newInjectedIndices = [];
        for (let i = 0; i < arrMes.length; i++) {
            if (arrMes[i] !== undefined) {
                newArrMes.push(arrMes[i]);
                if (injectedIndices.includes(i)) {
                    newInjectedIndices.push(newArrMes.length - 1);
                }
            }
        }

        arrMes = newArrMes;
        injectedIndices = newInjectedIndices;

        if (main_api !== 'openai') {
            setInContextMessages(arrMes.length - injectedIndices.length, type);
        }

        // Estimate how many unpinned example messages fit in the context
        tokenCount = await getMessagesTokenCount();
        count_exm_add = 0;
        if (!power_user.pin_examples) {
            for (let example of mesExamplesArray) {
                tokenCount += await getTokenCountAsync(example.replace(/\r/gm, ''));
                examplesString += example;
                if (tokenCount < this_max_context) {
                    count_exm_add++;
                } else {
                    break;
                }
            }
        }

        mesSend = [];
        console.debug('calling runGenerate');

        if (isContinue) {
            // Coping mechanism for OAI spacing
            if (main_api === 'openai' && !cyclePrompt.endsWith(' ')) {
                cyclePrompt += oai_settings.continue_postfix;
                continue_mag += oai_settings.continue_postfix;
            }
        }


        if (!dryRun) {
            setSendButtonState(true);
        }

        generatedPromptCache = cyclePrompt || '';
        if (generatedPromptCache.length == 0 || type === 'continue') {
            console.debug('generating prompt');
            chatString = '';
            arrMes = arrMes.reverse();
            arrMes.forEach(function (item, i, arr) {
                // OAI doesn't need all of this
                if (main_api === 'openai') {
                    return;
                }

                // Cohee: This removes a newline from the end of the last message in the context
                // Last prompt line will add a newline if it's not a continuation
                // In instruct mode it only removes it if wrap is enabled and it's not a quiet generation
                if (i === arrMes.length - 1 && type !== 'continue') {
                    if (!isInstruct || (power_user.instruct.wrap && type !== 'quiet')) {
                        item = item.replace(/\n?$/, '');
                    }
                }

                mesSend[mesSend.length] = { message: item, extensionPrompts: [] };
            });
        }

        let mesExmString = '';

        function setPromptString() {
            if (main_api == 'openai') {
                return;
            }

            console.debug('--setting Prompt string');
            mesExmString = pinExmString ?? mesExamplesArray.slice(0, count_exm_add).join('');

            if (mesSend.length) {
                mesSend[mesSend.length - 1].message = modifyLastPromptLine(mesSend[mesSend.length - 1].message);
            }
        }

        function modifyLastPromptLine(lastMesString) {
            //#########QUIET PROMPT STUFF PT2##############

            // Add quiet generation prompt at depth 0
            if (quiet_prompt && quiet_prompt.length) {
                // here name1 is forced for all quiet prompts..why?
                const name = name1;
                //checks if we are in instruct, if so, formats the chat as such, otherwise just adds the quiet prompt
                const quietAppend = isInstruct ? formatInstructModeChat(name, quiet_prompt, false, true, '', name1, name2, false) : `\n${quiet_prompt}`;

                //TODO: respect output_sequence vs last_output_sequence settings
                //TODO: decide how to prompt this to clarify who is talking 'Narrator', 'System', etc.
                if (isInstruct) {
                    lastMesString += quietAppend; // + power_user.instruct.output_sequence + '\n';
                } else {
                    lastMesString += quietAppend;
                }


                // Ross: bailing out early prevents quiet prompts from respecting other instruct prompt toggles
                // for sysgen, SD, and summary this is desireable as it prevents the AI from responding as char..
                // but for idle prompting, we want the flexibility of the other prompt toggles, and to respect them as per settings in the extension
                // need a detection for what the quiet prompt is being asked for...

                // Bail out early?
                if (!isInstruct && !quietToLoud) {
                    return lastMesString;
                }
            }


            // Get instruct mode line
            if (isInstruct && !isContinue) {
                const name = (quiet_prompt && !quietToLoud && !isImpersonate) ? (quietName ?? 'System') : (isImpersonate ? name1 : name2);
                const isQuiet = quiet_prompt && type == 'quiet';
                lastMesString += formatInstructModePrompt(name, isImpersonate, promptBias, name1, name2, isQuiet, quietToLoud);
            }

            // Get non-instruct impersonation line
            if (!isInstruct && isImpersonate && !isContinue) {
                const name = name1;
                if (!lastMesString.endsWith('\n')) {
                    lastMesString += '\n';
                }
                lastMesString += name + ':';
            }

            // Add character's name
            // Force name append on continue (if not continuing on user message or first message)
            const isContinuingOnFirstMessage = chat.length === 1 && isContinue;
            if (!isInstruct && force_name2 && !isContinuingOnFirstMessage) {
                if (!lastMesString.endsWith('\n')) {
                    lastMesString += '\n';
                }
                if (!isContinue || !(chat[chat.length - 1]?.is_user)) {
                    lastMesString += `${name2}:`;
                }
            }

            return lastMesString;
        }

        async function checkPromptSize() {
            console.debug('---checking Prompt size');
            setPromptString();
            const jointMessages = mesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');
            const prompt = [
                combinedStoryString,
                mesExmString,
                addChatsPreamble(addChatsSeparator(jointMessages)),
                '\n',
                modifyLastPromptLine(''),
                generatedPromptCache,
            ].join('').replace(/\r/gm, '');
            let thisPromptContextSize = await getTokenCountAsync(prompt, power_user.token_padding);

            if (thisPromptContextSize > this_max_context) {        //if the prepared prompt is larger than the max context size...
                if (count_exm_add > 0) {                            // ..and we have example messages..
                    count_exm_add--;                            // remove the example messages...
                    await checkPromptSize();                            // and try agin...
                } else if (mesSend.length > 0) {                    // if the chat history is longer than 0
                    mesSend.shift();                            // remove the first (oldest) chat entry..
                    await checkPromptSize();                            // and check size again..
                } else {
                    //end
                    console.debug(`---mesSend.length = ${mesSend.length}`);
                }
            }
        }

        if (generatedPromptCache.length > 0 && main_api !== 'openai') {
            console.debug('---Generated Prompt Cache length: ' + generatedPromptCache.length);
            await checkPromptSize();
        } else {
            console.debug('---calling setPromptString ' + generatedPromptCache.length);
            setPromptString();
        }

        // For prompt bit itemization
        mesSendString = '';

        getCombinedPrompt = async function (isNegative) {
            // Only return if the guidance scale doesn't exist or the value is 1
            // Also don't return if constructing the neutral prompt
            if (isNegative && !useCfgPrompt) {
                return;
            }

            // OAI has its own prompt manager. No need to do anything here
            if (main_api === 'openai') {
                return '';
            }

            // Deep clone
            let finalMesSend = structuredClone(mesSend);

            if (useCfgPrompt) {
                const cfgPrompt = getCfgPrompt(cfgGuidanceScale, isNegative);
                if (cfgPrompt.value) {
                    if (cfgPrompt.depth === 0) {
                        finalMesSend[finalMesSend.length - 1].message +=
                            /\s/.test(finalMesSend[finalMesSend.length - 1].message.slice(-1))
                                ? cfgPrompt.value
                                : ` ${cfgPrompt.value}`;
                    } else {
                        // TODO: Make all extension prompts use an array/splice method
                        const lengthDiff = mesSend.length - cfgPrompt.depth;
                        const cfgDepth = lengthDiff >= 0 ? lengthDiff : 0;
                        const cfgMessage = finalMesSend[cfgDepth];
                        if (cfgMessage) {
                            if (!Array.isArray(finalMesSend[cfgDepth].extensionPrompts)) {
                                finalMesSend[cfgDepth].extensionPrompts = [];
                            }
                            finalMesSend[cfgDepth].extensionPrompts.push(`${cfgPrompt.value}\n`);
                        }
                    }
                }
            }

            // Add prompt bias after everything else
            // Always run with continue
            if (!isInstruct && !isImpersonate) {
                if (promptBias.trim().length !== 0) {
                    finalMesSend[finalMesSend.length - 1].message +=
                        /\s/.test(finalMesSend[finalMesSend.length - 1].message.slice(-1))
                            ? promptBias.trimStart()
                            : ` ${promptBias.trimStart()}`;
                }
            }

            // Flattens the multiple prompt objects to a string.
            const combine = () => {
                // Right now, everything is suffixed with a newline
                mesSendString = finalMesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');

                // add a custom dingus (if defined)
                mesSendString = addChatsSeparator(mesSendString);

                // add chat preamble
                mesSendString = addChatsPreamble(mesSendString);

                let combinedPrompt = [
                    combinedStoryString,
                    mesExmString,
                    mesSendString,
                    generatedPromptCache,
                ].join('').replace(/\r/gm, '');

                if (power_user.collapse_newlines) {
                    combinedPrompt = collapseNewlines(combinedPrompt);
                }

                return combinedPrompt;
            };

            finalMesSend.forEach((item, i) => {
                item.injected = injectedIndices.includes(finalMesSend.length - i - 1);
            });

            let data = {
                api: main_api,
                combinedPrompt: null,
                description,
                personality,
                persona,
                scenario,
                char: name2,
                user: name1,
                worldInfoBefore,
                worldInfoAfter,
                beforeScenarioAnchor,
                afterScenarioAnchor,
                storyString,
                mesExmString,
                mesSendString,
                finalMesSend,
                generatedPromptCache,
                main: system,
                jailbreak,
                naiPreamble: nai_settings.preamble,
            };

            // Before returning the combined prompt, give available context related information to all subscribers.
            await eventSource.emit(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, data);

            // If one or multiple subscribers return a value, forfeit the responsibillity of flattening the context.
            return !data.combinedPrompt ? combine() : data.combinedPrompt;
        };

        finalPrompt = await getCombinedPrompt(false);

        const eventData = { prompt: finalPrompt, dryRun: dryRun };
        await eventSource.emit(event_types.GENERATE_AFTER_COMBINE_PROMPTS, eventData);
        finalPrompt = eventData.prompt;

        maxLength = Number(amount_gen); // how many tokens the AI will be requested to generate
        thisPromptBits = [];
    }

    let generate_data;
    switch (main_api) {
        case 'koboldhorde':
        case 'kobold':
            // Real raw-action cutover (see JUDGMENT CALL #7 above `let rawActionGenerateData;`) - now
            // set for `main_api === 'koboldhorde'` too, real and verified (not the previous "excluded
            // by name" state). When set, this same object reaches sendGenerationRequest() below as
            // `generate_data`, which dispatches 'koboldhorde' to generateHordeRawAction() instead of
            // generateHorde() - see that function's own `main_api === 'koboldhorde'` branch. The
            // `horde_settings.auto_adjust_response_length`/adjustedParams block just below is correctly
            // skipped in this case (real MVP scope boundary - see JUDGMENT CALL #7's own note on this),
            // since it's never reached once `break` fires here.
            if (rawActionGenerateData) {
                generate_data = rawActionGenerateData;
                break;
            }

            if (main_api == 'koboldhorde' && horde_settings.auto_adjust_response_length) {
                maxLength = Math.min(maxLength, adjustedParams.maxLength);
                maxLength = Math.max(maxLength, MIN_LENGTH); // prevent validation errors
            }

            generate_data = {
                prompt: finalPrompt,
                gui_settings: true,
                max_length: maxLength,
                max_context_length: max_context,
                api_server: kai_settings.api_server,
            };

            if (kai_settings.preset_settings != 'gui') {
                const isHorde = main_api == 'koboldhorde';
                const presetSettings = koboldai_settings[koboldai_setting_names[kai_settings.preset_settings]];
                const maxContext = (adjustedParams && horde_settings.auto_adjust_context_length) ? adjustedParams.maxContextLength : max_context;
                generate_data = getKoboldGenerationData(finalPrompt, presetSettings, maxLength, maxContext, isHorde, type);
            }
            break;
        case 'textgenerationwebui': {
            // Real raw-action cutover (see the block above `let generate_data;`) - the server resolves
            // the whole request itself for this case, so the just-computed finalPrompt/cfgValues are
            // never sent and never even referenced here.
            if (rawActionGenerateData) {
                generate_data = rawActionGenerateData;
                break;
            }
            const cfgValues = useCfgPrompt ? { guidanceScale: cfgGuidanceScale, negativePrompt: await getCombinedPrompt(true) } : null;
            generate_data = await getTextGenGenerationData(finalPrompt, maxLength, isImpersonate, isContinue, cfgValues, type);
            break;
        }
        case 'novel': {
            // Real raw-action cutover (see JUDGMENT CALL #7 above `let rawActionGenerateData;`) - the
            // server resolves the whole request itself for this case, so the just-computed
            // finalPrompt/cfgValues are never sent and never even referenced here.
            if (rawActionGenerateData) {
                generate_data = rawActionGenerateData;
                break;
            }
            const cfgValues = useCfgPrompt ? { guidanceScale: cfgGuidanceScale } : null;
            const presetSettings = novelai_settings[novelai_setting_names[nai_settings.preset_settings_novel]];
            generate_data = getNovelGenerationData(finalPrompt, presetSettings, maxLength, isImpersonate, isContinue, cfgValues, type);
            break;
        }
        case 'openai': {
            // Real raw-action cutover (see the block above `let generate_data;`) - the server resolves the whole
            // request itself for this case, so the client's own `prepareOpenAIMessages()` call (and the
            // `prompt`/`counts` it would have produced) is skipped entirely; `generate_data.rawAction` is read by
            // sendGenerationRequest()/sendStreamingRequest() and forwarded to sendOpenAIRequest(), which builds the
            // actual request body from it instead of calling createGenerationParameters() (see that function's own
            // "Raw-action chat-completion cutover" comment in chat-completion-settings.js).
            if (rawActionChatCompletionData) {
                generate_data = { rawAction: rawActionChatCompletionData };
                break;
            }
            let [prompt, counts] = await prepareOpenAIMessages({
                name2: name2,
                charDescription: description,
                charPersonality: personality,
                scenario: scenario,
                worldInfoBefore: worldInfoBefore,
                worldInfoAfter: worldInfoAfter,
                extensionPrompts: extension_prompts,
                bias: promptBias,
                type: type,
                quietPrompt: quiet_prompt,
                quietImage: quietImage,
                cyclePrompt: cyclePrompt,
                systemPromptOverride: system,
                jailbreakPromptOverride: jailbreak,
                messages: oaiMessages,
                messageExamples: oaiMessageExamples,
            }, dryRun);
            generate_data = { prompt: prompt };

            // TODO: move these side-effects somewhere else, so this switch-case solely sets generate_data
            // counts will return false if the user has not enabled the token breakdown feature
            if (counts) {
                parseTokenCounts(counts, thisPromptBits);
            }

            if (!dryRun) {
                setInContextMessages(openai_messages_count, type);
            }
            break;
        }
    }

    await eventSource.emit(event_types.GENERATE_AFTER_DATA, generate_data, dryRun);

    if (dryRun) {
        return Promise.resolve();
    }

    /**
     * Saves itemized prompt bits and calls streaming or non-streaming generation API.
     * @returns {Promise<void|*|Awaited<*>|String|{fromStream}|string|undefined|Object>}
     * @throws {Error|object} Error with message text, or Error with response JSON (OAI/Horde), or the actual response JSON (novel|textgenerationwebui|kobold)
     */
    async function finishGenerating() {
        if (power_user.console_log_prompts) {
            console.log(generate_data.prompt);
        }

        console.debug('rungenerate calling API');

        showStopButton();

        //set array object for prompt token itemization of this message
        let currentArrayEntry = Number(thisPromptBits.length - 1);
        const activeSamplerSettings = {
            kobold: kai_settings,
            koboldhorde: kai_settings,
            textgenerationwebui: textgen_settings,
            novel: nai_settings,
            openai: oai_settings,
        }[main_api];
        let additionalPromptStuff = {
            ...thisPromptBits[currentArrayEntry],
            rawPrompt: generate_data.prompt || generate_data.input,
            mesId: getNextMessageId(type),
            allAnchors: await getAllExtensionPrompts(),
            chatInjects: injectedIndices?.map(index => arrMes[arrMes.length - index - 1])?.join('') || '',
            summarizeString: (extension_prompts['1_memory']?.value || ''),
            authorsNoteString: (extension_prompts['2_floating_prompt']?.value || ''),
            smartContextString: (extension_prompts.chromadb?.value || ''),
            chatVectorsString: (extension_prompts['3_vectors']?.value || ''),
            dataBankVectorsString: (extension_prompts['4_vectors_data_bank']?.value || ''),
            worldInfoString: worldInfoString,
            storyString: storyString,
            beforeScenarioAnchor: beforeScenarioAnchor,
            afterScenarioAnchor: afterScenarioAnchor,
            examplesString: examplesString,
            mesSendString: mesSendString,
            generatedPromptCache: generatedPromptCache,
            promptBias: promptBias,
            finalPrompt: finalPrompt,
            charDescription: description,
            charPersonality: personality,
            scenarioText: scenario,
            this_max_context: this_max_context,
            padding: power_user.token_padding,
            main_api: main_api,
            instruction: main_api !== 'openai' && power_user.sysprompt.enabled ? substituteParams(power_user.prefer_character_prompt && system ? system : power_user.sysprompt.content) : '',
            userPersona: (power_user.persona_description_position == persona_description_positions.IN_PROMPT ? (persona || '') : ''),
            tokenizer: getFriendlyTokenizerName(main_api).tokenizerName || '',
            presetName: getPresetManager()?.getSelectedPresetName() || '',
            // JSON-stringified so the existing pool-dedup (poolizeValue/poolDedupIncremental) can dedupe
            // byte-identical configs across consecutive generations for free, no separate dedup logic needed.
            samplerConfigJson: JSON.stringify(activeSamplerSettings ?? {}),
            messagesCount: main_api !== 'openai' ? mesSend.length : oaiMessages.length,
            examplesCount: main_api !== 'openai' ? (pinExmString ? mesExamplesArray.length : count_exm_add) : oaiMessageExamples.length,
            // Per-message content before injection, captured here rather than re-split from rawPrompt later.
            historyParts: main_api === 'openai' ? oaiMessages.map(m => m.content) : mesSend.map(e => e.message),
        };

        //console.log(additionalPromptStuff);
        const itemizedIndex = itemizedPrompts.findIndex((item) => item.mesId === additionalPromptStuff.mesId);

        if (itemizedIndex !== -1) {
            itemizedPrompts[itemizedIndex] = additionalPromptStuff;
        } else {
            itemizedPrompts.push(additionalPromptStuff);
        }

        console.debug(`pushed prompt bits to itemizedPrompts array. Length is now: ${itemizedPrompts.length}`);

        if (isStreamingEnabled() && type !== 'quiet') {
            continue_mag = promptReasoning.removePrefix(continue_mag);
            streamingProcessor = new StreamingProcessor(type, force_name2, generation_started, continue_mag, promptReasoning);
            if (isContinue) {
                // Save reply does add cycle text to the prompt, so it's not needed here
                streamingProcessor.firstMessageText = '';
            }

            streamingProcessor.generator = await sendStreamingRequest(type, generate_data, { jsonSchema });

            hideSwipeButtons();
            let getMessage = await streamingProcessor.generate();
            let messageChunk = cleanUpMessage({
                getMessage: getMessage,
                isImpersonate: isImpersonate,
                isContinue: isContinue,
                displayIncompleteSentences: false,
            });

            if (isContinue) {
                getMessage = continue_mag + getMessage;
            }

            const isStreamFinished = streamingProcessor && !streamingProcessor.isStopped && streamingProcessor.isFinished;
            // Streaming raw-action tool-calling cutover (chunk (b)/(c)'s streaming counterpart) - see
            // forwardAndPersistCompactStreamWithServerTools()'s own doc comment (src/endpoints/backends/
            // chat-completions.js) for the full mechanism. Only ever set for a raw-action request whose
            // server-side loop hit a CLIENT-only tool call (`generate_data?.rawAction` truthy - the
            // exact same field the non-streaming branch below reads for its own, non-streaming
            // `pending_tool_calls` hand-off). Checked BEFORE the legacy `isStreamWithToolCalls` block:
            // the server intentionally never forwards raw `tool_calls` deltas to the client for a
            // request that reaches this hand-off (see that same doc comment, step 3), so
            // `streamingProcessor.toolCalls` is naturally empty in this case and the legacy block below
            // would not fire for it anyway - this check exists to actually resolve the hand-off, not
            // merely to avoid a conflict with it.
            const isStreamWithToolCallHandoff = streamingProcessor && isStreamFinished && streamingProcessor.toolCallHandoff && generate_data?.rawAction;
            if (isStreamWithToolCallHandoff) {
                const lastMessage = chat[chat.length - 1];
                const shouldDeleteMessage = type !== 'swipe' && ['', '...'].includes(lastMessage?.mes) && !lastMessage?.extra?.reasoning && ['', '...'].includes(streamingProcessor?.result);
                if (shouldDeleteMessage) {
                    await deleteLastMessage();
                } else {
                    await streamingProcessor.finalizeIntermediaryMessage(streamingProcessor.messageId, getMessage, { unlockUI: false });
                }
                const handoff = streamingProcessor.toolCallHandoff;
                streamingProcessor = null;
                // Reuses chunk (c)'s EXISTING resolveClientToolHandoffLoop() unchanged - see
                // forwardAndPersistCompactStreamWithServerTools()'s own doc comment for why this is safe: the
                // pending tree node was already persisted server-side before this trailer chunk was
                // ever sent, so there is nothing left for the client to persist, only to resolve.
                const resolved = await resolveClientToolHandoffLoop({ pending_tool_calls: handoff.pending_tool_calls }, generate_data.rawAction);
                // THIS TASK (stealth-tool parity) - a LATER round inside the resolve loop itself hit a
                // stealth call (see resolveClientToolHandoffLoop()'s own `data.aborted` check) - unblock
                // exactly like a first-round abort would (`isStreamWithToolCallAborted` above), no
                // persisted reply.
                if (resolved && resolved.aborted) {
                    unblockGeneration(type);
                    return;
                }
                return resolved;
            }

            // THIS TASK (stealth-tool parity) - the streaming counterpart of the non-streaming
            // `data.aborted` check further below. See resolveClientToolHandoffLoop()'s own doc comment
            // for the full legacy investigation this replicates: the legacy (non-raw-action) loop's
            // `shouldStopGeneration` is true whenever ANY stealth tool call is present in a round
            // (`invocationResult.stealthCalls.length`, unconditionally, via `||` - not merely "every
            // call was stealth"), discarding the WHOLE round (even an already-succeeded non-stealth
            // invocation in the same round) and stopping generation with nothing persisted -
            // `unblockGeneration(type)` then a plain `return`, no toast, no error. The server (see
            // `forwardAndPersistCompactStreamWithServerTools()`'s own `aborted` branch,
            // src/endpoints/backends/chat-completions.js) already decided not to persist anything for
            // this round and signaled that via the `tool_call_aborted` SSE trailer
            // (`streamingProcessor.toolCallAborted`, stashed off `state` the same way
            // `toolCallHandoff` is). Mirror the legacy branch's own UI-unblocking behavior exactly: no
            // persisted reply, no error toast, and the in-progress placeholder message this streaming
            // turn created (chat[]'s last entry) is removed unconditionally - not merely when
            // empty/`shouldDeleteMessage`-eligible like the handoff branch above, since NOTHING from
            // this round is meant to remain visible (see this task's own doc comment on the server's
            // `aborted` branch for the documented narrowing this implies for text-alongside-a-stealth-
            // call).
            const isStreamWithToolCallAborted = streamingProcessor && isStreamFinished && streamingProcessor.toolCallAborted && generate_data?.rawAction;
            if (isStreamWithToolCallAborted) {
                await deleteLastMessage();
                streamingProcessor = null;
                unblockGeneration(type);
                return;
            }

            const isStreamWithToolCalls = streamingProcessor && Array.isArray(streamingProcessor.toolCalls) && streamingProcessor.toolCalls.length;
            if (canPerformToolCalls && isStreamFinished && isStreamWithToolCalls) {
                const lastMessage = chat[chat.length - 1];
                const hasToolCalls = ToolManager.hasToolCalls(streamingProcessor.toolCalls);
                const shouldDeleteMessage = type !== 'swipe' && ['', '...'].includes(lastMessage?.mes) && !lastMessage?.extra?.reasoning && ['', '...'].includes(streamingProcessor?.result);
                hasToolCalls && shouldDeleteMessage && await deleteLastMessage();
                if (hasToolCalls && !shouldDeleteMessage) {
                    await streamingProcessor.finalizeIntermediaryMessage(streamingProcessor.messageId, getMessage, { unlockUI: false });
                }
                const invocationResult = await ToolManager.invokeFunctionTools(streamingProcessor.toolCalls, {
                    reasoningText: streamingProcessor.reasoningHandler.reasoning,
                });
                const shouldStopGeneration = (!invocationResult.invocations.length && shouldDeleteMessage) || invocationResult.stealthCalls.length;
                if (hasToolCalls) {
                    if (shouldStopGeneration) {
                        if (Array.isArray(invocationResult.errors) && invocationResult.errors.length) {
                            ToolManager.showToolCallError(invocationResult.errors);
                        }
                        unblockGeneration(type);
                        streamingProcessor = null;
                        return;
                    }

                    streamingProcessor = null;
                    depth = depth + 1;
                    await ToolManager.saveFunctionToolInvocations(invocationResult.invocations);
                    return Generate('normal', { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage, quietName, depth }, dryRun);
                }
            }

            if (isStreamFinished) {
                await streamingProcessor.onFinishStreaming(streamingProcessor.messageId, getMessage);
                streamingProcessor = null;
                triggerAutoContinue(messageChunk, isImpersonate);
                return Object.defineProperties(new String(getMessage), {
                    'messageChunk': { value: messageChunk },
                    'fromStream': { value: true },
                });
            }
        } else {
            const data = await sendGenerationRequest(type, generate_data, { jsonSchema });
            // Chunk (c): the raw-action chat-completion route can now hand a tool call off to the
            // client instead of returning a normal generation result (`{choices: [...]}`) - see
            // `buildRawActionChatCompletionRequest()`'s own doc comment (server-tools.js/
            // chat-completions.js). Only ever set for `generate_data.rawAction` (the raw-action
            // cutover, see `sendOpenAIRequest()`'s own `rawAction` branch) - every other backend/path
            // never produces this field, so this check is a no-op for them.
            if (data && Array.isArray(data.pending_tool_calls) && data.pending_tool_calls.length && generate_data?.rawAction) {
                const resolved = await resolveClientToolHandoffLoop(data, generate_data.rawAction);
                // THIS TASK (stealth-tool parity) - see the streaming branch's own identical check
                // above for the full rationale (a LATER round inside the resolve loop hit a stealth
                // call).
                if (resolved && resolved.aborted) {
                    unblockGeneration(type);
                    return;
                }
                return resolved;
            }
            // THIS TASK (stealth-tool parity) - the non-streaming counterpart of
            // `isStreamWithToolCallAborted` above; see that branch's own doc comment and
            // resolveClientToolHandoffLoop()'s own doc comment for the full legacy investigation this
            // replicates. No message was ever added to `chat[]` for this branch by the time this line
            // runs (unlike streaming, which creates an in-progress placeholder as tokens arrive) - the
            // non-streaming path only calls `saveReply()` further down in `onSuccess()`, which this
            // early return never reaches - so there is nothing to delete here, only to skip.
            if (data && data.aborted && generate_data?.rawAction) {
                unblockGeneration(type);
                return;
            }
            return data;
        }
    }

    return finishGenerating().then(onSuccess, onError);

    /**
     * Handles the successful response from the generation API.
     * @param data
     * @returns {Promise<String|{fromStream}|*|string|string|void|Awaited<*>|undefined>}
     * @throws {Error} Throws an error if the response data contains an error message
     */
    async function onSuccess(data) {
        if (!data) return;

        if (data?.fromStream) {
            return data;
        }

        let messageChunk = '';

        // if an error was returned in data (textgenwebui), show it and throw it
        if (data.error) {
            unblockGeneration(type);

            if (data?.response) {
                toastr.error(data.response, t`API Error`, { preventDuplicates: true });
            }
            throw new Error(data?.response);
        }

        if (jsonSchema) {
            unblockGeneration(type);
            return extractJsonFromData(data, { returnInvalidJson: jsonSchema.returnInvalid ?? false });
        }

        //const getData = await response.json();
        let getMessage = extractMessageFromData(data);
        let title = extractTitleFromData(data);
        let reasoning = extractReasoningFromData(data);
        let imageUrls = extractImagesFromData(data);
        const reasoningSignature = extractReasoningSignatureFromData(data);
        kobold_horde_model = title;

        const swipes = extractMultiSwipes(data, type);

        messageChunk = cleanUpMessage({
            getMessage: getMessage,
            isImpersonate: isImpersonate,
            isContinue: isContinue,
            displayIncompleteSentences: false,
        });


        reasoning = getRegexedString(reasoning, regex_placement.REASONING);

        if (power_user.trim_spaces) {
            reasoning = reasoning.trim();
        }

        if (isContinue) {
            continue_mag = promptReasoning.removePrefix(continue_mag);
            getMessage = continue_mag + getMessage;
        }

        //Formating
        const displayIncomplete = type === 'quiet' && !quietToLoud;
        getMessage = cleanUpMessage({
            getMessage: getMessage,
            isImpersonate: isImpersonate,
            isContinue: isContinue,
            displayIncompleteSentences: displayIncomplete,
        });

        if (isImpersonate) {
            $('#send_textarea').val(getMessage)[0].dispatchEvent(new Event('input', { bubbles: true }));
            await eventSource.emit(event_types.IMPERSONATE_READY, getMessage);
        } else if (type == 'quiet') {
            unblockGeneration(type);
            return getMessage;
        } else {
            // Without streaming we'll be having a full message on continuation. Treat it as a last chunk.
            if (originalType !== 'continue') {
                ({ type, getMessage } = await saveReply({ type, getMessage, title, swipes, reasoning, imageUrls, reasoningSignature }));
            } else {
                ({ type, getMessage } = await saveReply({ type: 'appendFinal', getMessage, title, swipes, reasoning, imageUrls, reasoningSignature }));
            }

            // This relies on `saveReply` having been called to add the message to the chat, so it must be last.
            parseAndSaveLogprobs(data, continue_mag);
            _stampAssistantNodeId(data.assistant_node_id);
        }

        if (canPerformToolCalls) {
            const hasToolCalls = ToolManager.hasToolCalls(data);
            const shouldDeleteMessage = type !== 'swipe' && ['', '...'].includes(getMessage) && !reasoning;
            hasToolCalls && shouldDeleteMessage && await deleteLastMessage();
            const invocationResult = await ToolManager.invokeFunctionTools(data, { reasoningText: reasoning });
            const shouldStopGeneration = (!invocationResult.invocations.length && shouldDeleteMessage) || invocationResult.stealthCalls.length;
            if (hasToolCalls) {
                if (shouldStopGeneration) {
                    if (Array.isArray(invocationResult.errors) && invocationResult.errors.length) {
                        ToolManager.showToolCallError(invocationResult.errors);
                    }
                    unblockGeneration(type);
                    return;
                }

                depth = depth + 1;
                await ToolManager.saveFunctionToolInvocations(invocationResult.invocations);
                return Generate('normal', { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage, quietName, depth }, dryRun);
            }
        }

        if (type !== 'quiet') {
            playMessageSound();
        }

        const isAborted = abortController && abortController.signal.aborted;
        if (!isAborted && power_user.auto_swipe && generatedTextFiltered(getMessage)) {
            setSendButtonState(false);
            return await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.AUTO_SWIPE, repeated: true, forceMesId: chat.length - 1 });
        }

        console.debug('/api/chats/save called by /Generate');
        // eslint-disable-next-line no-restricted-syntax -- willUseRawAction is only ever false here for the neutral/no-character chat, and saveChat() already no-ops the tree/legacy write for that state; kept for its unconditional token-cache/itemized-prompts flush, unrelated to persistence.
        await saveChatConditional();
        unblockGeneration(type);
        streamingProcessor = null;

        if (type !== 'quiet') {
            triggerAutoContinue(messageChunk, isImpersonate);
        }

        // Don't break the API chain that expects a single string in return
        return Object.defineProperty(new String(getMessage), 'messageChunk', { value: messageChunk });
    }

    /**
     * Exception handler for finishGenerating
     * @param {Error|object} exception Error or response JSON
     * @throws {Error|object} Re-throws the exception
     */
    function onError(exception) {
        // if the response JSON was thrown (novel|textgenerationwebui|kobold), show the error message
        if (typeof exception?.error?.message === 'string') {
            toastr.error(exception.error.message, t`Text generation error`, { timeOut: 10000, extendedTimeOut: 20000 });
        }

        unblockGeneration(type);
        console.log(exception);
        streamingProcessor = null;
        throw exception;
    }
}

/**
 * Stops the generation and any streaming if it is currently running.
 */
export function stopGeneration() {
    let stopped = false;
    if (streamingProcessor) {
        streamingProcessor.onStopStreaming();
        stopped = true;
    }
    if (abortController) {
        abortController.abort('Clicked stop button');
        hideStopButton();
        stopped = true;
    }
    eventSource.emit(event_types.GENERATION_STOPPED);
    return stopped;
}

/**
 * Saves the chat to the server.
 * @param {object} [options] - Additional options.
 * @param {string} [options.chatName] The name of the chat file to save to
 * @param {object} [options.withMetadata] Additional metadata to save with the chat
 * @param {number} [options.mesId] The message ID to save the chat up to
 * @param {boolean} [options.force] Force the saving despite the integrity check result
 * @param {ChatMessage[]} [options.chatData] Chat snapshot to save instead of the current in-memory chat
 * @param {boolean} [options.unique] Ask the server to mint a unique file name if `chatName` collides,
 * instead of asserting a name the caller uniquified against its own fetched chat list (e.g. branching).
 *
 * @returns {Promise<string|void>} The chat name actually saved under (may differ from `chatName` when
 * `unique` caused a rename), or void when nothing was saved.
 */
export async function saveChat({ chatName, withMetadata, mesId, force = false, chatData = undefined, unique = false, heal = false } = {}) {
    if (selected_group) {
        toastr.error(t`Operation was aborted to prevent data corruption.`, t`saveChat called for a group chat`);
        throw new Error('saveChat called for a group chat');
    }

    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('saveChat called with positional arguments. Please use an object instead.');
        [chatName, withMetadata, mesId, force] = arguments;
    }

    const metadata = { ...chat_metadata, ...(withMetadata || {}) };
    const fileName = chatName ?? getCurrentCharacter()?.chat;

    if (getSelectionState().type === 'none' && name2 === neutralCharacterName) {
        // Checking selection state, not `fileName`: a character left selected from before could fall through to a real save under it.
        return;
    }

    // A tree-backed chat needs no name/id pointer to save under: the block below addresses every
    // write by each message's own real node id, falling back to `fileName` only as a last resort
    // that's unreachable once any message has actually persisted. The legacy JSONL path has no such
    // fallback - it truly cannot save without a name.
    const isTreeChat = !!metadata?._tree_stored && !Array.isArray(chatData);
    if (!fileName && !isTreeChat) {
        console.warn('saveChat called without chat_name and no chat file found');
        return;
    }

    charactersStore.update(getCurrentCharacter().avatar, { date_last_chat: Date.now() });

    const trimmedChat = Array.isArray(chatData)
        ? chatData
        : (mesId !== undefined && mesId >= 0 && mesId < chat.length)
            ? chat.slice(0, Number(mesId) + 1)
            : chat.slice();

    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: metadata,
        user_name: 'unused',
        character_name: 'unused',
    };

    try {
        if (isTreeChat) {
            // `heal` is true when this call arrived via getContext().saveChat() (st-context.js) - the
            // one truly generic entry point where a third-party extension may have mutated `chat[]`
            // directly, without stating any chatOp*() of its own, and so can't be assumed to already be
            // in sync - or via StreamingProcessor.onFinishStreaming()'s own no-assistant-node-id
            // fallback, whose trailing message is an unstated mutation for the same reason (see that
            // call site's own comment). Every OTHER first-party save (send, edit, swipe reaching this
            // function via saveChatConditional()) never sets it: their mutation already persisted
            // itself directly via its own chatOp*() call, and a write that fails now says so immediately
            // (_chatOpPost()'s own failure reporting) instead of relying on this function to notice
            // later. chat-store.js's healDirtyMessages() is that diff; it's owner-agnostic, but this
            // function is solo-only (see the guard at the top), so it only ever runs it for the solo
            // case here - see saveChatConditional() for where the identical `heal` flag applies to a
            // group instead.
            if (heal) {
                await healDirtyMessages().catch(error =>
                    console.error('[saveChat] Could not sync unstated changes:', error));
            }

            const addressedByName = chatName !== undefined;
            const treeAvatar = getCurrentCharacter()?.avatar;
            let hasPersistedOpening = false;
            if (treeAvatar) {
                const hasPersisted = trimmedChat.some(m => isStoredNodeId(m?.node_id));

                if (hasPersisted) {
                    hasPersistedOpening = true;
                    const position = getCurrentCharacter()?.chat;
                    const opening = chat[0]?.node_id;
                    const target = addressedByName
                        ? fileName
                        : (chat.some(m => m.node_id === position) ? position
                            : (isStoredNodeId(opening) ? opening : fileName));

                    // Delegates to _postChatMetadata() (this same file, below) instead of POSTing
                    // directly, so this and saveMetadata()'s own calls share one serialized
                    // _metadataSaveChain - see that variable's doc comment for why two unserialized
                    // metadata saves racing each other produces a false-positive integrity 409.
                    await _postChatMetadata({ avatar_url: treeAvatar }, target, metadata);
                }
            }

            if (hasPersistedOpening) {
                _snapshotMessages();
            } else {
                // An opening with no node_id has never touched the tree - opening this chat is a selection, not a write.
                console.debug('[saveChat] Tree chat has no persisted opening; nothing to save yet.');
            }
            return;
        }

        // Slim wire protocol: unchanged messages become lightweight stubs to minimize wire payload.
        const payloadMessages = isTreeChat ? _buildSlimPayload(trimmedChat) : trimmedChat;

        const bodyJson = JSON.stringify({
            ch_name: getCurrentCharacter().name,
            file_name: fileName,
            chat: [chatHeader, ...payloadMessages],
            avatar_url: getCurrentCharacter().avatar,
            force: force,
            unique: unique,
        });
        const saveChatRequest = await compressRequest({
            method: 'POST',
            cache: 'no-cache',
            headers: getRequestHeaders(),
            body: bodyJson,
        });
        const result = await fetch('/api/chats/save', saveChatRequest);

        if (result.ok) {
            const data = await result.json().catch(() => null);
            if (data && typeof data.integrity === 'string') {
                chat_metadata.integrity = data.integrity;
            }

            // The server may have renamed this to stay unique (only asked for via `unique`) - adopt
            // whatever it actually saved under instead of assuming the name this call proposed.
            const savedFileName = (data && typeof data.file_name === 'string' && data.file_name) ? data.file_name : fileName;

            if (Array.isArray(data?.assigned_node_ids)) {
                for (const { index, node_id } of data.assigned_node_ids) {
                    if (index < chat.length) {
                        updateMessage(index, { node_id });
                    }
                }

                // Rows came back, so this chat now lives in the tree - a character with no prior history would otherwise stay treated as file-backed.
                chat_metadata._tree_stored = true;
            }

            if (isTreeChat) {
                _snapshotMessages();
            }
            return savedFileName;
        }

        const errorData = await result.json();
        const isIntegrityError = errorData?.error === 'integrity' && !force;
        if (!isIntegrityError) {
            throw new Error(result.statusText);
        }

        const popupResult = await Popup.show.input(
            t`ERROR: Chat integrity check failed while saving the file.`,
            t`<p>After you click OK, the page will be reloaded to prevent data corruption.</p>
              <p>To confirm an overwrite (and potentially <b>LOSE YOUR DATA</b>), enter <code>OVERWRITE</code> (in all caps) in the box below before clicking OK.</p>`,
            '',
            { okButton: 'OK', cancelButton: false },
        );

        const forceSaveConfirmed = popupResult === 'OVERWRITE';

        if (!forceSaveConfirmed) {
            console.warn('Chat integrity check failed, and user did not confirm the overwrite. Reloading the page.');
            // This reload skips the normal debounced save, so flush the draft synchronously first.
            flushDraftSave();
            window.location.reload();
            return;
        }

        await saveChat({ chatName, withMetadata, mesId, force: true });
    } catch (error) {
        console.error(error);
        toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Chat could not be saved`);
    }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.heal] Whether to reconcile `chat[]` against chatOp*() before saving. True
 * for getContext().saveChat() (st-context.js), the one generic entry point a third-party extension
 * can reach without having stated any chatOp*() of its own - an ordinary first-party call never
 * needed it before, since every mutation already persisted itself directly at its own call site.
 * The one first-party exception is StreamingProcessor.onFinishStreaming()'s own fallback (no
 * assistant_node_id came back - not raw-action, a failed server-side persist, or a stopped stream):
 * that trailing message is a genuine unstated mutation too, so it needs the same reconciliation.
 * See saveChat()'s own use of this same flag for the solo case; healDirtyMessages() (chat-store.js)
 * is owner-agnostic, so the group branch below applies it identically, just without a dedicated
 * function of its own to pass it through to.
 */
export async function saveChatConditional({ heal = false } = {}) {
    try {
        await waitUntilCondition(() => !isChatSaving, DEFAULT_SAVE_EDIT_TIMEOUT, 100);
    } catch {
        console.warn('Timeout waiting for chat to save');
        return;
    }

    try {
        cancelDebouncedChatSave();

        isChatSaving = true;

        if (selected_group) {
            if (heal) {
                await healDirtyMessages().catch(error =>
                    console.error('[saveChatConditional] Could not sync unstated changes:', error));
            }
            // Every message mutation already persisted itself directly via chatOp*() (chat-store.js) at
            // its own call site - this is metadata catch-up only, mirroring what saveChat()'s tree
            // branch does for solo below.
            await saveMetadata();
            // saveGroupChat()'s old shouldSaveGroup=true path bumped this same field the same way
            // (debounced, no reload) after every whole-array resave; keep that bump on its own now that
            // the resave it rode along with is gone.
            await saveGroupField(selected_group, { date_last_chat: Date.now() }, false, false);
        } else {
            await saveChat({ heal });
        }

        // Save token and prompts cache to IndexedDB storage
        saveTokenCache();
        saveItemizedPrompts(getCurrentChatId());
    } catch (error) {
        console.error('Error saving chat', error);
    } finally {
        isChatSaving = false;
    }
}
