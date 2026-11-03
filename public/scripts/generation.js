import {
    addChatsPreamble, addChatsSeparator, addPersonaDescriptionExtensionPrompt,
    baseChatReplace, cleanUpMessage,
    deactivateSendButtons, dropLastMessage, depth_prompt_depth_default, depth_prompt_role_default,
    doChatInject, extension_prompts, extension_prompt_types,
    extractJsonFromData, extractMessageFromData, extractMultiSwipes, extractTitleFromData,
    flushWIInjections, formatMessageHistoryItem,
    getBiasStrings, getCharacterCardFields, getCurrentCharacter, getCurrentDraftContext,
    getExtensionPrompt, getExtensionPromptRoleByName, getMaxPromptTokens,
    hideStopButton, hideSwipeButtons, isStreamingEnabled,
    menu_type, name2, online_status,
    parseAndSaveLogprobs, parseMesExamples, processCommands,
    removeDepthPrompts, removeLastMessage, removeMacros, requestedResponseLength, resolveClientToolHandoffLoop, responseLengthFor,
    saveReply, sendGenerationRequest, sendMessageAsUser, sendStreamingRequest, storeSentMessage,
    setCharacterName, setExtensionPrompt, setGenerationProgress, setInContextMessages, setSendButtonState,
    showStopButton, StreamingProcessor, substituteParams, swipe,
    triggerAutoContinue, unblockGeneration, updateMessageBlock, updateMessageItemizedPromptButton,
} from '../script.js';
import { chat, chat_metadata } from './chat-state.js';
import { main_api, max_context } from './generation-params.js';
import { name1 } from './app-selection-state.js';
import { setCharacterId } from './character-store.js';
import { changedMetadata, noteMetadataChangesStored, noteMetadataSent } from './metadata-store.js';
import { changeOps, changesSince } from './state-sync.js';
import { isProvisionalNodeId, isStoredNodeId, provisionalNodeId } from './node-identity.js';
import { setFloatingPrompt } from './authors-note.js';
import { getCfgPrompt, getGuidanceScale } from './cfg-scale.js';
import { oai_settings, openai_messages_count, prepareOpenAIMessages, setOpenAIMessageExamples, setOpenAIMessages } from './chat-completion-settings.js';
import { holdDraft, releaseDraft } from './chat-draft.js';
import { isFailedSend, keepFailedSend, wasSendStored } from './failed-sends.js';
import { updateMessage, setStoreRef, storeRefOf, adoptStored, deepFreeze } from './chat-store.js';
import { appendFileContent, hasPendingFileAttachment } from './chats.js';
import { GENERATION_TYPE_TRIGGERS, inject_ids, SWIPE_DIRECTION, SWIPE_SOURCE } from './constants.js';
import { collectMessageTitles, isSystemChatItem } from './core-chat-predicates.js';
import { eventSource, event_types } from './events.js';
import { extension_settings } from './extension-settings.js';
import { generateGroupWrapper, getGroupDepthPrompts, groupsStore, is_group_generating, selected_group } from './group-chats.js';
import { adjustHordeGenerationParams, horde_settings, isHordeGenerationNotAllowed, MIN_LENGTH } from './horde.js';
import { t } from './i18n.js';
import { force_output_sequence, formatInstructModeChat, formatInstructModeExamples, formatInstructModePrompt, formatInstructModeStoryString } from './instruct-mode.js';
import { getKoboldGenerationData, kai_flags, kai_settings, koboldai_setting_names, koboldai_settings } from './kai-settings.js';
import { adjustNovelInstructionPrompt, getNovelGenerationData, nai_settings, novelai_setting_names, novelai_settings } from './nai-settings.js';
import { user_avatar, getPersonaDescriptionPosition } from './personas.js';
import { collapseNewlines, generatedTextFiltered, persona_description_positions, playMessageSound, power_user, renderStoryString } from './power-user.js';
import { extractReasoningFromData, extractReasoningSignatureFromData, markServerFinishedReply, PromptReasoning } from './reasoning.js';
import { reasoningOf } from './reasoning-block.js';
import { takeStoredReply } from './llamacpp-compact-stream.js';
import { sendSystemMessage, system_message_types } from './system-messages.js';
import { getTextGenGenerationData } from './textgen-settings.js';
import { getPromptTokenCountAsync, getTokenCountAsync, saveTokenCache, showTrimEstimateWarning } from './tokenizers.js';
import { ToolManager } from './tool-calling.js';
import { showTokenizerWarnings, REPLY_NOT_SAVED_EVENT, REPLY_STORED_EVENT } from './tokenizer-notices.js';
import { shiftDownByOne, shiftUpByOne, uuidv4 } from './utils.js';
import { stopServerGenerations, takeStreamStopResult } from './generation-stop.js';
import { getWorldInfoPrompt, wi_anchor_position, world_info_include_names, world_info_overflow_alert } from './world-info.js';
import { pageMacroFacts, variablesCopy, withScratchVariables } from './macros/engine/MacroEnvBuilder.js';

/** @type {StreamingProcessor|null} */
export let streamingProcessor = null;

export let generation_started = new Date();

export let abortController = new AbortController();

export let kobold_horde_model = '';

/** @param {AbortController} controller */
export function setAbortController(controller) {
    abortController = controller;
}

/** @type {Map<string, ChatMessage>} */
export const _messageSnapshots = new Map();

/**
 * @param {string} nodeId
 * @param {ChatMessage} message
 */
export function markStoredAs(nodeId, message) {
    _messageSnapshots.set(nodeId, deepFreeze(JSON.parse(JSON.stringify(message))));
}

/**
 * @param {(string|null|undefined)[]} nodeIds
 */
export function forgetStored(nodeIds) {
    for (const id of nodeIds) if (typeof id === 'string') _messageSnapshots.delete(id);
}

const BUILD_INJECTIONS = new Set([inject_ids.AUTHORS_NOTE, inject_ids.PERSONA_DESCRIPTION, inject_ids.STORY_STRING, inject_ids.QUIET_PROMPT, inject_ids.DEPTH_PROMPT]);

/** @param {string} key */
const isBuildInjection = key => BUILD_INJECTIONS.has(key)
    || key.startsWith(`${inject_ids.DEPTH_PROMPT}_`)
    || key.startsWith(inject_ids.CUSTOM_WI_DEPTH)
    || key.startsWith(inject_ids.CUSTOM_WI_OUTLET(''));

/**
 * @returns {Promise<Record<string, { value: string, position: number, depth: number, scan: boolean, role: number }>>}
 */
async function pageInjections() {
    /** @type {Record<string, { value: string, position: number, depth: number, scan: boolean, role: number }>} */
    const out = {};
    for (const [key, prompt] of Object.entries(extension_prompts)) {
        if (isBuildInjection(key) || !prompt?.value) continue;
        if (typeof prompt.filter === 'function' && !await prompt.filter()) continue;
        out[key] = { value: prompt.value, position: prompt.position, depth: prompt.depth, scan: !!prompt.scan, role: prompt.role };
    }
    return out;
}

/**
 * @param {ChatMessage|null|undefined} message
 */
export function isAsStored(message) {
    if (message == null || typeof message.node_id !== 'string') return false;
    const stored = _messageSnapshots.get(message.node_id);
    return stored !== undefined && JSON.stringify(stored) === JSON.stringify(message);
}

export function _snapshotMessages() {
    const pending = replyInFlightIndex();
    const pendingNode = pending >= 0 ? chat[pending]?.node_id : undefined;
    const kept = isStoredNodeId(pendingNode) ? _messageSnapshots.get(/** @type {string} */ (pendingNode)) : undefined;
    _messageSnapshots.clear();
    for (const [i, msg] of chat.entries()) {
        if (i === pending) continue;
        if (isStoredNodeId(msg.node_id)) markStoredAs(msg.node_id, msg);
    }
    if (kept !== undefined) _messageSnapshots.set(/** @type {string} */ (pendingNode), kept);
}

/** @typedef {{ index: number, anchor: string | null }} ReplyInFlight */
/** @type {ReplyInFlight | null} */
let replyInFlight = null;

/**
 * @returns {number}
 */
function replyInFlightIndex() {
    if (replyInFlight === null) return -1;
    const message = /** @type {ChatMessage | undefined} */ (chat[replyInFlight.index]);
    if (message == null || message.is_user === true) return -1;
    const named = isStoredNodeId(message.node_id) ? message.node_id : null;
    return named === replyInFlight.anchor ? replyInFlight.index : -1;
}

/**
 * @param {number} mesId
 */
export function isReplyGenerating(mesId) {
    if (replyInFlightIndex() === mesId) return true;
    return streamingProcessor !== null && streamingProcessor.messageId === mesId && !streamingProcessor.isFinished;
}

/** @type {{ index: number, nodeId: string } | null} */
let swipeAnchor = null;

/**
 * @param {number} mesId
 * @param {string} nodeId
 */
export function beginSwipeReply(mesId, nodeId) {
    swipeAnchor = { index: mesId, nodeId };
}

/**
 * @param {number} mesId
 * @param {string} nodeId
 */
export function stampReplyNode(mesId, nodeId) {
    if (!nodeId) return;
    replyInFlight = null;
    swipeAnchor = null;
    const msg = /** @type {ChatMessage | undefined} */ (chat[mesId]);
    if (msg == null || msg.is_user === true) return;
    const selected = msg.swipe_id ?? 0;
    /** @type {Partial<ChatMessage>} */
    const updates = { node_id: nodeId };
    const swipeInfoEntry = Array.isArray(msg.swipe_info) ? /** @type {SwipeInfo | undefined} */ (msg.swipe_info[selected]) : undefined;
    if (swipeInfoEntry != null && !isStoredNodeId(swipeInfoEntry.node_id)) {
        const newSwipeInfo = [...msg.swipe_info];
        newSwipeInfo[selected] = { ...newSwipeInfo[selected], node_id: nodeId };
        updates.swipe_info = newSwipeInfo;
    }
    const already = msg.node_id === nodeId;
    updateMessage(mesId, updates);
    const stamped = /** @type {ChatMessage | undefined} */ (chat[mesId]);
    if (!already && isStoredNodeId(stamped?.node_id)) {
        markStoredAs(stamped.node_id, stamped);
    }
    if (stamped) updateMessageItemizedPromptButton(stamped, { messageId: mesId });
}

/** @type {import('./state-sync.js').MetadataChanges|null} */
let replyChangesInFlight = null;
/** @type {Map<string, import('./state-sync.js').MetadataChanges>} */
const replyChangesNotSaved = new Map();

/** @param {string} nodeId */
function _stampAssistantNodeId(nodeId) {
    stampReplyNode(chat.length - 1, nodeId);
    _noteReplyChangesStored(replyChangesInFlight);
    replyChangesInFlight = null;
}

/** @param {import('./state-sync.js').MetadataChanges|null|undefined} changes */
function _noteReplyChangesStored(changes) {
    chat_metadata.tainted = true;
    const stored = changes ?? { set: {}, unset: [], variables: { set: {}, unset: [] } };
    noteMetadataChangesStored({ ...stored, set: { ...stored.set, tainted: true } });
}

/** @type {string|null} */
let notSavedGenerationId = null;
window.addEventListener(REPLY_NOT_SAVED_EVENT, (/** @type {any} */ event) => {
    notSavedGenerationId = event.detail?.generationId ?? null;
});

function _markReplyNotSaved() {
    replyInFlight = null;
    swipeAnchor = null;
    const generationId = notSavedGenerationId;
    notSavedGenerationId = null;
    const changes = replyChangesInFlight;
    replyChangesInFlight = null;
    if (generationId == null) return;
    if (changes) replyChangesNotSaved.set(generationId, changes);
    const mesId = chat.length - 1;
    const msg = /** @type {ChatMessage | undefined} */ (chat[mesId]);
    if (msg == null) return;
    updateMessage(mesId, { extra: { ...msg.extra, reply_not_saved: generationId } });
}

window.addEventListener(REPLY_STORED_EVENT, (/** @type {any} */ event) => {
    const { generationId, node_id: nodeId, mes } = event.detail ?? {};
    const mesId = chat.findIndex(m => m.extra?.reply_not_saved === generationId);
    if (mesId < 0 || !isStoredNodeId(nodeId)) return;
    const changes = replyChangesNotSaved.get(generationId);
    replyChangesNotSaved.delete(generationId);
    _noteReplyChangesStored(changes);
    const msg = /** @type {ChatMessage} */ (chat[mesId]);
    const extra = { ...msg.extra };
    delete extra.reply_not_saved;
    /** @type {Partial<ChatMessage>} */
    const updates = { node_id: nodeId, extra };
    const selected = msg.swipe_id ?? 0;
    const swipeInfoEntry = Array.isArray(msg.swipe_info) ? /** @type {SwipeInfo | undefined} */ (msg.swipe_info[selected]) : undefined;
    if (swipeInfoEntry != null) {
        const swipeInfo = [...msg.swipe_info];
        swipeInfo[selected] = { ...swipeInfo[selected], node_id: nodeId };
        updates.swipe_info = swipeInfo;
    }
    const updated = updateMessage(mesId, updates);
    const shown = typeof mes === 'string' ? applyStoredReply(mesId, { mes, extra: event.detail?.extra ?? {} }) : updated;
    if (shown) {
        markStoredAs(nodeId, shown);
        updateMessageBlock(mesId, shown);
    }
});

/**
 * @param {number} mesId
 * @param {{mes: string, extra?: Record<string, any>}|null|undefined} stored
 * @param {{received?: boolean}} [options]
 * @returns {ChatMessage|null}
 */
export function applyStoredReply(mesId, stored, { received = false } = {}) {
    if (!stored || typeof stored.mes !== 'string') return null;
    const msg = /** @type {ChatMessage | undefined} */ (chat[mesId]);
    if (msg == null || msg.is_user === true) return null;
    const storedExtra = stored.extra && typeof stored.extra === 'object' ? stored.extra : {};
    /** @type {Partial<ChatMessage>} */
    const updates = { mes: stored.mes, extra: structuredClone(storedExtra) };
    const selected = msg.swipe_id ?? 0;
    if (Array.isArray(msg.swipes)) {
        const swipes = [...msg.swipes];
        swipes[selected] = stored.mes;
        updates.swipes = swipes;
    }
    const swipeInfoEntry = Array.isArray(msg.swipe_info) ? /** @type {SwipeInfo | undefined} */ (msg.swipe_info[selected]) : undefined;
    if (swipeInfoEntry != null) {
        const swipeInfo = [...msg.swipe_info];
        swipeInfo[selected] = { ...swipeInfoEntry, extra: structuredClone(storedExtra) };
        updates.swipe_info = swipeInfo;
    }
    const updated = updateMessage(mesId, updates);
    if (received) markServerFinishedReply(mesId);
    const activations = storedExtra.activations;
    if (received && world_info_overflow_alert && activations?.cut?.some(c => c.why === 'budget')) {
        toastr.warning(t`World info budget reached after ${activations.entries?.length ?? 0} entries.`, t`World Info`);
    }
    if (updated) updateMessageItemizedPromptButton(updated, { messageId: mesId });
    return updated ?? null;
}

/**
 * @param {string|null|undefined} mes
 * @param {Record<string, any>|null|undefined} extra
 */
function _showStoredReplyText(mes, extra) {
    if (typeof mes !== 'string') return;
    const mesId = chat.length - 1;
    const updated = applyStoredReply(mesId, { mes, extra: extra ?? {} });
    if (updated) updateMessageBlock(mesId, updated);
}

/** @param {{assistantNodeId?: string|null}} params */
export async function finishStreamedReplyPersistence({ assistantNodeId }) {
    const stop = await takeStreamStopResult();
    if (isStoredNodeId(assistantNodeId)) {
        _stampAssistantNodeId(assistantNodeId);
    } else if (stop !== undefined) {
        if (stop && isStoredNodeId(stop.node_id)) {
            _showStoredReplyText(stop.mes, stop.extra);
            _stampAssistantNodeId(stop.node_id);
        } else {
            if (!stop || stop.state === 'stopping') {
                console.warn('[stop] The server did not confirm the stop; the saved reply may differ until the chat is reloaded.', stop);
            }
            _markReplyNotSaved();
        }
    } else {
        _markReplyNotSaved();
    }
}

/**
 * @typedef {object} JsonSchema
 * @property {string} name
 * @property {object} value
 * @property {string} [description]
 * @property {boolean} [strict]
 * @property {boolean} [returnInvalid]
 * @typedef {object} GenerateOptions
 * @property {boolean} [automatic_trigger]
 * @property {boolean} [force_name2]
 * @property {string} [quiet_prompt]
 * @property {boolean} [quietToLoud]
 * @property {boolean} [skipWIAN]
 * @property {string} [force_avatar]
 * @property {AbortSignal} [signal]
 * @property {string} [quietImage]
 * @property {string} [quietName]
 * @property {number} [depth]
 * @property {JsonSchema|null} [jsonSchema]
 */

/**
 * @typedef {object} PendingSend
 * @property {string} key
 * @property {ChatMessage} message
 */

/**
 * @param {PendingSend[]} pendingSends
 */
async function settlePendingSends(pendingSends) {
    for (const pending of pendingSends) {
        if (wasSendStored(pending.key)) continue;
        const index = chat.findIndex(message => storeRefOf(message) === pending.key);
        if (index === -1) {
            keepFailedSend({ key: pending.key, kind: 'append', message: pending.message });
            continue;
        }
        await storeSentMessage(index);
    }
}

/**
 * @typedef {object} RawActionWrites
 * @property {string|null} node_id
 * @property {string} type
 * @property {{ refs: string[], messages: object[] }} [opening]
 * @property {{ refs: string[], messages: object[] }} [page_messages]
 * @property {{ ref: string } & import('./state-sync.js').MetadataChanges} [page_metadata]
 * @property {{ key: string, variable?: true, value?: unknown }[]} [reply_changes]
 */

/**
 * @param {number} from
 * @param {number} to
 * @param {(message: ChatMessage) => object} contentOf
 * @returns {{ refs: string[], messages: object[] }}
 */
function messagesWithRefs(from, to, contentOf) {
    /** @type {string[]} */
    const refs = [];
    /** @type {object[]} */
    const messages = [];
    for (let i = from; i < to; i++) {
        let ref = storeRefOf(chat[i]);
        if (ref === undefined) {
            ref = uuidv4();
            setStoreRef(chat[i], ref);
        }
        refs.push(ref);
        messages.push(contentOf(chat[i]));
    }
    return { refs, messages };
}

/**
 * @param {ChatMessage|undefined} sent
 * @returns {object|undefined}
 */
function sentUserMessageForRequest(sent) {
    const key = storeRefOf(sent);
    if (sent === undefined || key === undefined) return undefined;
    let message = sent;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (storeRefOf(chat[i]) === key) {
            message = chat[i];
            break;
        }
    }
    const content = { ...message };
    delete content.node_id;
    delete content.swipes;
    delete content.swipe_info;
    delete content.swipe_id;
    return content;
}

/**
 * @param {string|undefined} quietPrompt
 * @param {boolean|undefined} quietToLoud
 * @param {string|undefined} quietName
 * @param {string|undefined} quietImage
 * @returns {{ quiet_prompt?: string, quiet_to_loud?: boolean, quiet_name?: string, quiet_image?: string }}
 */
function quietPromptRequest(quietPrompt, quietToLoud, quietName, quietImage) {
    if (typeof quietPrompt !== 'string' || quietPrompt === '') return {};
    return {
        quiet_prompt: quietPrompt,
        quiet_to_loud: quietToLoud === true ? true : undefined,
        quiet_name: typeof quietName === 'string' && quietName !== '' ? quietName : undefined,
        quiet_image: typeof quietImage === 'string' && quietImage !== '' ? quietImage : undefined,
    };
}

/**
 * @param {string} type
 * @param {ChatMessage|undefined} lastMessage
 * @param {number} lastMessageIndex
 * @param {import('./state-sync.js').MetadataChanges|null} atStart
 * @returns {RawActionWrites}
 */
function rawActionWritesFor(type, lastMessage, lastMessageIndex, atStart) {
    const end = Math.min(lastMessageIndex + 1, chat.length);
    /** @type {RawActionWrites} */
    const writes = { node_id: null, type };
    const inGroup = selected_group != null && selected_group !== '';

    let lastStored = -1;
    for (let i = end - 1; i >= 0; i--) {
        if (isStoredNodeId(chat[i]?.node_id)) {
            lastStored = i;
            break;
        }
    }
    let from = lastStored + 1;
    if (lastStored >= 0) {
        writes.node_id = chat[lastStored].node_id;
    } else if (end > 0) {
        if (chat[0].node_id == null || chat[0].node_id === '') {
            updateMessage(0, { node_id: provisionalNodeId(chat[0].name, chat[0].mes) });
        }
        let openingEnd = 0;
        while (openingEnd < end && isProvisionalNodeId(chat[openingEnd]?.node_id) && (inGroup || openingEnd === 0)) openingEnd++;
        if (openingEnd > 0 && String(chat[0].mes ?? '').trim() !== '') {
            const speaker = getCurrentCharacter()?.name;
            writes.opening = messagesWithRefs(0, openingEnd, message => ({
                name: message.name ?? speaker, is_user: message.is_user === true, is_system: message.is_system === true,
                send_date: message.send_date ?? new Date().toISOString(), mes: message.mes, extra: message.extra ?? {},
            }));
            from = openingEnd;
        }
    }

    let stop = from;
    while (stop < end && typeof chat[stop]?.extra?.reply_not_saved !== 'string' && !isFailedSend(chat[stop])) stop++;
    if (stop > from) writes.page_messages = messagesWithRefs(from, stop, message => message);
    if (stop < end) {
        toastr.warning(t`${end - stop} message(s) after an unsaved message weren't saved: save or discard that message first.`, t`Not saved`, { preventDuplicates: true });
    }

    const swipedFrom = type === 'swipe' && swipeAnchor !== null && swipeAnchor.index === lastMessageIndex && !isStoredNodeId(lastMessage?.node_id)
        ? swipeAnchor.nodeId
        : null;
    if (swipedFrom !== null) {
        writes.node_id = swipedFrom;
        delete writes.opening;
        delete writes.page_messages;
    } else if (isStoredNodeId(lastMessage?.node_id)) {
        writes.node_id = lastMessage.node_id;
        delete writes.opening;
        delete writes.page_messages;
    } else if (type === 'regenerate' && lastMessage != null) {
        writes.type = 'normal';
    }

    const now = changedMetadata();
    const repliless = type === 'quiet' || type === 'impersonate';
    const produced = repliless ? null : changesSince(atStart, now, chat_metadata);
    const changes = repliless ? now : atStart;
    if (changes || writes.opening) {
        const ref = uuidv4();
        const sent = changes ?? { set: {}, unset: [], variables: { set: {}, unset: [] } };
        noteMetadataSent(ref, sent);
        writes.page_metadata = { ref, ...sent };
    }
    if (produced) writes.reply_changes = changeOps(produced);
    replyChangesInFlight = produced ?? null;
    return writes;
}

/**
 * @param {string} type
 * @param {GenerateOptions} options
 * @param {boolean} dryRun
 * @returns {Promise<any>}
 */
export async function Generate(type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage, quietName, jsonSchema = null, depth = 0 } = {}, dryRun = false) {
    /** @type {PendingSend[]} */
    const pendingSends = [];
    const replyBefore = replyInFlight;
    try {
        return await generateOnce(type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage, quietName, jsonSchema, depth }, dryRun, pendingSends);
    } finally {
        if (replyInFlight !== replyBefore) replyInFlight = null;
        swipeAnchor = null;
        await settlePendingSends(pendingSends);
    }
}

/**
 * @param {string} type
 * @param {GenerateOptions} options
 * @param {boolean} dryRun
 * @param {PendingSend[]} pendingSends
 * @returns {Promise<any>}
 */
async function generateOnce(type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage, quietName, jsonSchema = null, depth = 0 } = {}, dryRun = false, pendingSends = []) {
    const metadataAtStart = changedMetadata();
    setGenerationProgress(0);
    generation_started = new Date();

    await eventSource.emit(event_types.GENERATION_STARTED, type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage }, dryRun);

    if (signal == null) {
        abortController = new AbortController();
    }

    const isInstruct = power_user.instruct.enabled && main_api !== 'openai';
    const isImpersonate = type == 'impersonate';

    if (!(dryRun || depth || type == 'regenerate' || type == 'swipe' || type == 'quiet')) {
        const interruptedByCommand = await processCommands(String($('#send_textarea').val()));

        if (interruptedByCommand) {
            unblockGeneration(type);
            return Promise.resolve();
        }
    }

    if (main_api == 'kobold' && kai_settings.streaming_kobold && !kai_flags.can_use_streaming) {
        toastr.error(t`Streaming is enabled, but the version of Kobold used does not support token streaming.`, undefined, { timeOut: 10000, preventDuplicates: true });
        unblockGeneration(type);
        return Promise.resolve();
    }

    const unsavedReply = /** @type {ChatMessage | undefined} */ (chat[chat.length - 1]);
    if (!dryRun && type !== 'quiet' && type !== 'impersonate' && typeof unsavedReply?.extra?.reply_not_saved === 'string') {
        toastr.error(t`The last reply isn't saved yet. Use "Save it again" on its notice first, or delete it.`, t`Reply not saved`, { preventDuplicates: true });
        unblockGeneration(type);
        return Promise.resolve();
    }
    if (!dryRun && type !== 'quiet' && type !== 'impersonate' && isFailedSend(unsavedReply)) {
        toastr.error(t`Your last message isn't saved yet. Save it or discard it on its notice first.`, t`Message not saved`, { preventDuplicates: true });
        unblockGeneration(type);
        return Promise.resolve();
    }

    if (isHordeGenerationNotAllowed()) {
        unblockGeneration(type);
        return Promise.resolve();
    }

    if (!dryRun) {
        hideSwipeButtons();
        chat_metadata.tainted = true;
    }

    if (selected_group != null && !is_group_generating) {
        if (!dryRun) {
            return generateGroupWrapper(false, type, { quiet_prompt, force_avatar, signal: abortController.signal, quietImage, jsonSchema });
        }

        const group = groupsStore.get(selected_group);

        /** @type {string[]} */
        const enabledMembers = (group?.members ?? []).reduce((acc, member) => {
            const isDisabled = group?.disabled_members.includes(member) ?? false;
            if (!isDisabled && !acc.includes(member)) {
                acc.push(member);
            }
            return acc;
        }, /** @type {string[]} */ ([]));

        if (enabledMembers.length > 0) {
            if (menu_type != 'character_edit') setCharacterId(enabledMembers[0]);
            setCharacterName('');
        } else {
            console.log('No enabled members found');
            unblockGeneration(type);
            return Promise.resolve();
        }
    }

    if (typeof quiet_prompt === 'string' && quiet_prompt !== '') {
        quiet_prompt = substituteParams(quiet_prompt);
        quiet_prompt = main_api == 'novel' && quietToLoud !== true ? adjustNovelInstructionPrompt(quiet_prompt) : quiet_prompt;
    }

    const hasBackendConnection = online_status !== 'no_connection';

    if (!dryRun && !hasBackendConnection) {
        setSendButtonState(false);
        return Promise.resolve();
    }

    let lastMessage = /** @type {ChatMessage | undefined} */ (chat[chat.length - 1]);
    let lastMessageIndex = chat.length - 1;

    let textareaText;
    /** @type {import('./chat-draft.js').DraftContext|null} */
    let sentDraftContext = null;
    if (type !== 'regenerate' && type !== 'swipe' && type !== 'quiet' && !isImpersonate && !dryRun && !depth) {
        setSendButtonState(true);
        textareaText = String($('#send_textarea').val());
        sentDraftContext = getCurrentDraftContext();
        if (sentDraftContext) {
            holdDraft(localStorage, sentDraftContext, textareaText);
        }
        $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        textareaText = '';
        if (chat.length && lastMessage?.is_user === true) {
            //do nothing? why does this check exist?
        } else if (type !== 'quiet' && type !== 'swipe' && !isImpersonate && !dryRun && !depth && chat.length) {
            forgetStored([chat[chat.length - 1]?.node_id]);
            chat.length = chat.length - 1;
            await removeLastMessage();
            await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
        }
    }

    const isContinue = type == 'continue';
    const isSwipe = type == 'swipe' || type == 'regenerate';
    void isSwipe;

    if (isContinue && chat.length) {
        const prevFinished = lastMessage?.gen_finished;
        const prevStarted = lastMessage?.gen_started;

        if (prevFinished != null && prevStarted != null) {
            const timePassed = Number(prevFinished) - Number(prevStarted);
            generation_started = new Date(Date.now() - timePassed);
            updateMessage(chat.length - 1, { gen_started: generation_started });
        }
    }

    if (!dryRun) {
        deactivateSendButtons();
    }

    let { messageBias, promptBias, isUserPromptBias } = getBiasStrings(textareaText, type);


    const noAttachTypes = [
        'regenerate',
        'swipe',
        'impersonate',
        'quiet',
        'continue',
    ];
    let sentUserMessage;

    const rawActionCharacterAvatar = getCurrentCharacter()?.avatar;
    const rawActionGroupId = selected_group != null ? selected_group : undefined;
    const rawActionOwnerId = rawActionGroupId != null
        ? String(rawActionGroupId)
        : (rawActionCharacterAvatar != null ? String(rawActionCharacterAvatar).replace('.png', '') : undefined);
    const willUseRawAction = !dryRun
        && ['textgenerationwebui', 'kobold', 'novel', 'koboldhorde', 'openai'].includes(main_api)
        && [undefined, 'normal', 'impersonate', 'quiet', 'swipe', 'regenerate', 'continue'].includes(type)
        && rawActionOwnerId != null && rawActionCharacterAvatar != null;

    if ((textareaText != '' || (hasPendingFileAttachment() && !noAttachTypes.includes(type))) && automatic_trigger !== true && type !== 'quiet' && !dryRun && !depth) {
        if (messageBias && !removeMacros(textareaText)) {
            sendSystemMessage(system_message_types.GENERIC, ' ', { bias: messageBias });
        } else {
            sentUserMessage = await sendMessageAsUser(textareaText, messageBias, /** @type {number} */ (/** @type {unknown} */ (null)), false, name1, user_avatar, willUseRawAction);
        }
    } else if (textareaText == '' && automatic_trigger !== true && !dryRun && [undefined, 'normal'].includes(type) && main_api == 'openai' && oai_settings.send_if_empty.trim().length > 0 && !depth) {
        sentUserMessage = await sendMessageAsUser(oai_settings.send_if_empty.trim(), messageBias, /** @type {number} */ (/** @type {unknown} */ (null)), false, name1, user_avatar, willUseRawAction);
    }

    if (sentDraftContext && textareaText) {
        releaseDraft(localStorage, sentDraftContext, textareaText);
    }
    const sentKey = storeRefOf(sentUserMessage);
    if (sentUserMessage && willUseRawAction && sentKey !== undefined) {
        pendingSends.push({ key: sentKey, message: sentUserMessage });
    }
    if (sentUserMessage && !willUseRawAction && isFailedSend(sentUserMessage)) {
        unblockGeneration(type);
        return Promise.resolve();
    }

    const canUseTools = ToolManager.isToolCallingSupported();
    const canPerformToolCalls = !dryRun && ToolManager.canPerformToolCalls(type) && depth < ToolManager.RECURSE_LIMIT;

    const originalType = type;

    const variables = willUseRawAction ? variablesCopy() : null;
    const evaluateHere = (/** @type {() => any} */ fn) => (variables ? withScratchVariables(variables, fn) : fn());
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
    } = evaluateHere(() => getCharacterCardFields());

    removeDepthPrompts();
    const groupDepthPrompts = evaluateHere(() => getGroupDepthPrompts(/** @type {string} */ (selected_group), /** @type {string} */ (getCurrentCharacter()?.avatar)));
    const allowWIScan = /** @type {{allowWIScan?: boolean}} */ (extension_settings.note).allowWIScan;

    if (selected_group != null && Array.isArray(groupDepthPrompts) && groupDepthPrompts.length > 0) {
        groupDepthPrompts.forEach((value, index) => {
            const role = getExtensionPromptRoleByName(value.role);
            setExtensionPrompt(inject_ids.DEPTH_PROMPT_INDEX(index), value.text, extension_prompt_types.IN_CHAT, value.depth, allowWIScan, role);
        });
    } else {
        const depthPromptText = charDepthPrompt || '';
        const depthPromptExt = /** @type {{depth?: number, role?: "system"|"user"|"assistant"} | undefined} */ (getCurrentCharacter()?.data.extensions.depth_prompt);
        const depthPromptDepth = depthPromptExt?.depth ?? depth_prompt_depth_default;
        const depthPromptRole = getExtensionPromptRoleByName(depthPromptExt?.role ?? depth_prompt_role_default);
        setExtensionPrompt(inject_ids.DEPTH_PROMPT, depthPromptText, extension_prompt_types.IN_CHAT, depthPromptDepth, allowWIScan, depthPromptRole);
    }

    const substitutedFirstMessage = chat.length ? evaluateHere(() => substituteParams(chat[0].mes ?? '')) : null;

    let coreChat = chat.filter(x => !isSystemChatItem(x) || (canUseTools && Array.isArray(x.extra?.tool_invocations)));
    if (type === 'swipe') {
        coreChat.pop();
    }

    coreChat = await Promise.all(coreChat.map(async (/** @type {ChatMessage} */ chatItem, index) => {
        const message = chatItem === chat[0] ? substitutedFirstMessage : chatItem.mes;
        const residentId = chat.indexOf(chatItem);
        let text = await appendFileContent(chatItem, message ?? '');
        if (residentId >= 0) {
            chatItem = chat[residentId];
        }

        text = `${text}${collectMessageTitles(chatItem)}`;

        return {
            ...chatItem,
            mes: text,
            index,
        };
    }));

    const promptReasoning = new PromptReasoning();
    for (let i = coreChat.length - 1; i >= 0; i--) {
        const isPrefix = isContinue && i === coreChat.length - 1;

        const isOtherGroupMember = selected_group != null && coreChat[i].name !== name2;
        const reasoning = reasoningOf(coreChat[i].extra);

        coreChat[i] = {
            ...coreChat[i],
            mes: isOtherGroupMember
                ? coreChat[i].mes
                : promptReasoning.addToMessage(
                    coreChat[i].mes ?? '',
                    reasoning,
                    isPrefix,
                    coreChat[i].extra?.reasoning_duration ?? null,
                ),
        };
        if (promptReasoning.isLimitReached()) {
            break;
        }
    }

    let this_max_context = getMaxPromptTokens();

    let rawActionGenerateData = null;
    if (!dryRun && (main_api === 'textgenerationwebui' || main_api === 'kobold' || main_api === 'novel' || main_api === 'koboldhorde')
        && [undefined, 'normal', 'impersonate', 'quiet', 'swipe', 'regenerate', 'continue'].includes(type)
    ) {
        const characterAvatar = getCurrentCharacter()?.avatar;
        const groupId = selected_group != null ? selected_group : undefined;
        const ownerId = groupId != null ? String(groupId) : (characterAvatar != null ? String(characterAvatar).replace('.png', '') : undefined);
        const rawActionWrites = rawActionWritesFor(type, lastMessage, lastMessageIndex, metadataAtStart);
        if (ownerId != null && characterAvatar != null) {
            const sentMessage = sentUserMessageForRequest(sentUserMessage);
            rawActionGenerateData = {
                character_avatar: characterAvatar,
                group_id: groupId,
                owner_id: ownerId,
                ...rawActionWrites,
                user_message: sentMessage,
                user_message_ref: sentMessage !== undefined ? storeRefOf(sentUserMessage) : undefined,
                macro_facts: pageMacroFacts(),
                response_length: requestedResponseLength(),
                extension_prompts: await pageInjections(),
                streaming: main_api === 'kobold'
                    ? (kai_settings.streaming_kobold && kai_flags.can_use_streaming && type !== 'quiet')
                    : undefined,
                can_abort: main_api === 'kobold' ? kai_flags.can_use_streaming : undefined,
                ...quietPromptRequest(quiet_prompt, quietToLoud, quietName, quietImage),
            };
        }
    }

    let rawActionChatCompletionData = null;
    if (!dryRun && main_api === 'openai'
        && [undefined, 'normal', 'impersonate', 'quiet', 'swipe', 'regenerate', 'continue'].includes(type)
    ) {
        const characterAvatar = getCurrentCharacter()?.avatar;
        const groupId = selected_group != null ? selected_group : undefined;
        const ownerId = groupId != null ? String(groupId) : (characterAvatar != null ? String(characterAvatar).replace('.png', '') : undefined);
        const rawActionWrites = rawActionWritesFor(type, lastMessage, lastMessageIndex, metadataAtStart);
        if (ownerId != null && characterAvatar != null) {
            const sentMessage = sentUserMessageForRequest(sentUserMessage);
            /** @type {import('./tool-calling.js').ToolDefinitionOpenAI[]|undefined} */
            let clientToolsPayload;
            /** @type {string[]|undefined} */
            let stealthToolNamesPayload;
            if (canPerformToolCalls) {
                /** @type {{tools?: import('./tool-calling.js').ToolDefinitionOpenAI[]}} */
                const toolsHolder = {};
                await ToolManager.registerFunctionToolsOpenAI(toolsHolder);
                clientToolsPayload = toolsHolder.tools;
                const stealthNames = (clientToolsPayload ?? [])
                    .map(tool => tool.function.name)
                    .filter(name => typeof name === 'string' && ToolManager.isStealthTool(name));
                stealthToolNamesPayload = stealthNames.length ? stealthNames : undefined;
            }
            rawActionChatCompletionData = {
                character_avatar: characterAvatar,
                group_id: groupId,
                owner_id: ownerId,
                ...rawActionWrites,
                user_message: sentMessage,
                user_message_ref: sentMessage !== undefined ? storeRefOf(sentUserMessage) : undefined,
                macro_facts: pageMacroFacts(),
                response_length: requestedResponseLength(),
                extension_prompts: await pageInjections(),
                client_tools: clientToolsPayload,
                stealth_tool_names: stealthToolNamesPayload,
                json_schema: jsonSchema,
                ...quietPromptRequest(quiet_prompt, quietToLoud, quietName, quietImage),
            };
        }
    }

    /** @type {{maxContextLength: number, maxLength: number}|undefined} */
    let adjustedParams;
    /** @type {{type: number, value: number}|null|undefined} */
    let cfgGuidanceScale = null;
    let useCfgPrompt = false;
    /** @type {string[]} */
    let mesExamplesArray = [];
    let worldInfoBefore = '';
    let worldInfoAfter = '';
    let beforeScenarioAnchor = '';
    let afterScenarioAnchor = '';
    let storyString = '';
    /** @type {number[]} */
    let injectedIndices = [];
    let continue_mag = '';
    /** @type {{content: string}[]} */
    let oaiMessages = [];
    /** @type {object[]} */
    let oaiMessageExamples = [];
    let examplesString = '';
    let cyclePrompt = '';
    /** @type {string|undefined} */
    let pinExmString;
    /** @type {(string|undefined)[]} */
    let arrMes = [];
    let count_exm_add = 0;
    /** @type {{message: string, extensionPrompts: string[], injected?: boolean}[]} */
    let mesSend = [];
    let generatedPromptCache = '';
    let mesSendString = '';
    /** @type {(isNegative: boolean) => Promise<string|undefined>} */
    let getCombinedPrompt = async () => '';
    let finalPrompt = '';
    let maxLength = 0;

    if (!rawActionGenerateData && !rawActionChatCompletionData) {
        if (main_api == 'koboldhorde' && (horde_settings.auto_adjust_context_length || horde_settings.auto_adjust_response_length)) {
            try {
                adjustedParams = await adjustHordeGenerationParams(max_context, responseLengthFor(main_api));
            } catch {
                unblockGeneration(type);
                return Promise.resolve();
            }
            if (horde_settings.auto_adjust_context_length) {
                this_max_context = (adjustedParams.maxContextLength - adjustedParams.maxLength);
            }
        }

        cfgGuidanceScale = getGuidanceScale();
        useCfgPrompt = !!(cfgGuidanceScale && cfgGuidanceScale.value !== 1);

        if (cfgGuidanceScale && useCfgPrompt) {
            const negativePrompt = getCfgPrompt(cfgGuidanceScale, true, true).value || '';
            const positivePrompt = getCfgPrompt(cfgGuidanceScale, false, true).value || '';
            if (negativePrompt || positivePrompt) {
                // eslint-disable-next-line no-restricted-syntax -- counted on the page from before the ban: to move to the server (thin-client step 10, unfinished)
                const [negativePromptTokenCount, positivePromptTokenCount] = await Promise.all([getTokenCountAsync(negativePrompt), getTokenCountAsync(positivePrompt)]);
                const decrement = Math.max(negativePromptTokenCount, positivePromptTokenCount);
                this_max_context -= decrement;
            }
        }


        if ((promptBias && !isUserPromptBias) || power_user.always_force_name2 || main_api == 'novel') {
            force_name2 = true;
        }

        if (isImpersonate) {
            force_name2 = false;
        }

        mesExamplesArray = parseMesExamples(mesExamples, isInstruct);

        setFloatingPrompt();

        setExtensionPrompt(inject_ids.QUIET_PROMPT, quiet_prompt ?? '', extension_prompt_types.IN_PROMPT, 0, true);
        const chatForWI = coreChat.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : (x.mes ?? '')).reverse();
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
        ({ worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth, outletEntries } = await getWorldInfoPrompt(chatForWI, this_max_context, dryRun, globalScanData));
        setExtensionPrompt(inject_ids.QUIET_PROMPT, '', extension_prompt_types.IN_PROMPT, 0, true);

        for (const example of worldInfoExamples) {
            const exampleMessage = example.content;

            if (exampleMessage.length === 0) {
                continue;
            }

            const formattedExample = baseChatReplace(exampleMessage);
            const cleanedExample = parseMesExamples(formattedExample, isInstruct);

            if (example.position === wi_anchor_position.before) {
                mesExamplesArray.unshift(...cleanedExample);
            } else {
                mesExamplesArray.push(...cleanedExample);
            }
        }

        const mesExamplesRawArray = [...mesExamplesArray];

        if (isInstruct) {
            mesExamplesArray = formatInstructModeExamples(mesExamplesArray, name1, name2);
        }

        if (skipWIAN !== true) {
            flushWIInjections();
            if (Array.isArray(worldInfoDepth)) {
                worldInfoDepth.forEach((e) => {
                    const joinedEntries = e.entries.join('\n');
                    setExtensionPrompt(inject_ids.CUSTOM_WI_DEPTH_ROLE(e.depth, e.role), joinedEntries, extension_prompt_types.IN_CHAT, e.depth, false, e.role);
                });
            }
            if (Object.keys(outletEntries).length > 0) {
                Object.entries(outletEntries).forEach(([key, value]) => {
                    setExtensionPrompt(inject_ids.CUSTOM_WI_OUTLET(key), value.join('\n'), extension_prompt_types.NONE, 0);
                });
            }
        }

        addPersonaDescriptionExtensionPrompt();

        if (main_api !== 'openai') {
            if (power_user.sysprompt.enabled) {
                system = power_user.prefer_character_prompt && system
                    ? substituteParams(system, { original: power_user.sysprompt.content })
                    : baseChatReplace(power_user.sysprompt.content);
                system = isInstruct ? substituteParams(system, { original: power_user.sysprompt.content }) : system;
            } else {
                system = '';
            }
        }

        beforeScenarioAnchor = await getExtensionPrompt(extension_prompt_types.BEFORE_PROMPT);
        afterScenarioAnchor = await getExtensionPrompt(extension_prompt_types.IN_PROMPT);

        const storyStringParams = {
            description: description,
            personality: personality,
            persona: getPersonaDescriptionPosition() == persona_description_positions.IN_PROMPT ? persona : '',
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

        storyString = renderStoryString(storyStringParams);
        let combinedStoryString = isInstruct ? formatInstructModeStoryString(storyString) : storyString;

        const applyStoryStringInject = main_api !== 'openai' && power_user.context.story_string_position === extension_prompt_types.IN_CHAT;
        if (applyStoryStringInject) {
            const depth = power_user.context.story_string_depth;
            const role = power_user.context.story_string_role;
            setExtensionPrompt(inject_ids.STORY_STRING, combinedStoryString, extension_prompt_types.IN_CHAT, depth, false, role);
            combinedStoryString = '';
        } else {
            setExtensionPrompt(inject_ids.STORY_STRING, '', extension_prompt_types.IN_CHAT, 0);
        }

        if (power_user.strip_examples) {
            mesExamplesArray = [];
        }

        injectedIndices = [];
        if (main_api !== 'openai') {
            injectedIndices = await doChatInject(coreChat, isContinue);
        }

        if (main_api !== 'openai' && power_user.sysprompt.enabled) {
            jailbreak = power_user.prefer_character_jailbreak && jailbreak
                ? substituteParams(jailbreak, { original: power_user.sysprompt.post_history })
                : baseChatReplace(power_user.sysprompt.post_history);

            if (jailbreak) {
                if (isContinue) {
                    coreChat.splice(coreChat.length - 1, 0, { mes: jailbreak, is_user: true });
                } else {
                    coreChat.push({ mes: jailbreak, is_user: true });
                    injectedIndices.forEach(shiftUpByOne);
                }
            }
        }

        /** @type {string[]} */
        let chat2 = [];
        continue_mag = '';
        let userMessageIndices = [];
        let lastUserMessageIndex = -1;
        for (let i = coreChat.length - 1; i >= 0; i--) {
            if (coreChat[i].is_user === true) {
                lastUserMessageIndex = i;
                break;
            }
        }

        for (let i = coreChat.length - 1, j = 0; i >= 0; i--, j++) {
            if (main_api == 'openai') {
                const coreMes = coreChat[j].mes ?? '';
                chat2[i] = coreMes;
                if (i === 0 && isContinue) {
                    chat2[i] = chat2[i].slice(0, chat2[i].lastIndexOf(coreMes) + coreMes.length);
                    continue_mag = coreMes;
                }
                continue;
            }

            chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, false);

            if (j === 0 && isInstruct) {
                chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, force_output_sequence.FIRST);
            }

            if (lastUserMessageIndex >= 0 && j === lastUserMessageIndex && isInstruct && !isImpersonate) {
                chat2[i] = formatMessageHistoryItem(coreChat[j], isInstruct, force_output_sequence.LAST);
            }

            if (i === 0 && isContinue) {
                const FORMAT_TOKEN = '\u0000\ufffc\u0000\ufffd';

                if (isInstruct) {
                    const originalMessage = String(coreChat[j].mes ?? '');
                    const tempMsg = { ...coreChat[j], mes: originalMessage.replaceAll(FORMAT_TOKEN, '') + FORMAT_TOKEN };
                    chat2[i] = formatMessageHistoryItem(tempMsg, isInstruct, force_output_sequence.LAST);
                }

                const coreMes = coreChat[j].mes ?? '';
                chat2[i] = chat2[i].includes(FORMAT_TOKEN)
                    ? chat2[i].slice(0, chat2[i].lastIndexOf(FORMAT_TOKEN))
                    : chat2[i].slice(0, chat2[i].lastIndexOf(coreMes) + coreMes.length);
                continue_mag = coreMes;
            }

            if (coreChat[j].is_user === true) {
                userMessageIndices.push(i);
            }
        }

        let addUserAlignment = isInstruct && power_user.instruct.user_alignment_message !== '';
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
            oaiMessages = /** @type {{content: string}[]} */ (setOpenAIMessages(coreChat));
            oaiMessageExamples = setOpenAIMessageExamples(mesExamplesArray);
        }

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
            // eslint-disable-next-line no-restricted-syntax -- counted on the page from before the ban: to move to the server (thin-client step 10, unfinished)
            return getPromptTokenCountAsync(encodeString, /** @type {undefined} */ (/** @type {unknown} */ (power_user.token_padding)));
        }

        if (power_user.pin_examples) {
            pinExmString = examplesString = mesExamplesArray.join('');
        }

        if (isContinue && (chat2.length > 1 || main_api === 'openai')) {
            cyclePrompt = chat2.shift() ?? '';
            injectedIndices = injectedIndices.map(shiftDownByOne).filter(x => x >= 0);
            userMessageIndices = userMessageIndices.map(shiftDownByOne).filter(x => x >= 0);
        }

        arrMes = new Array(chat2.length);
        let tokenCount = await getMessagesTokenCount();
        let lastAddedIndex = 0;

        for (const index of injectedIndices) {
            if (main_api == 'openai') {
                break;
            }

            const item = chat2[index];

            if (typeof item !== 'string') {
                continue;
            }

            // eslint-disable-next-line no-restricted-syntax -- counted on the page from before the ban: to move to the server (thin-client step 10, unfinished)
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
            if (main_api == 'openai') {
                break;
            }

            if (arrMes[i] !== undefined) {
                continue;
            }

            const item = chat2[i];

            if (typeof item !== 'string') {
                continue;
            }

            // eslint-disable-next-line no-restricted-syntax -- counted on the page from before the ban: to move to the server (thin-client step 10, unfinished)
            tokenCount += await getTokenCountAsync(item.replace(/\r/gm, ''));
            if (tokenCount < this_max_context) {
                chatString = chatString + item;
                arrMes[i] = item;
                lastAddedIndex = Math.max(lastAddedIndex, i);
            } else {
                break;
            }
        }

        const stoppedAtUser = userMessageIndices.includes(lastAddedIndex);
        if (addUserAlignment && !stoppedAtUser) {
            // eslint-disable-next-line no-restricted-syntax -- counted on the page from before the ban: to move to the server (thin-client step 10, unfinished)
            tokenCount += await getTokenCountAsync(userAlignmentMessage.replace(/\r/gm, ''));
            chatString = userAlignmentMessage + chatString;
            arrMes.push(userAlignmentMessage);
            injectedIndices.push(arrMes.length - 1);
        }

        /** @type {string[]} */
        const newArrMes = [];
        const newInjectedIndices = [];
        for (let i = 0; i < arrMes.length; i++) {
            const item = arrMes[i];
            if (item !== undefined) {
                newArrMes.push(item);
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

        tokenCount = await getMessagesTokenCount();
        count_exm_add = 0;
        if (!power_user.pin_examples) {
            for (let example of mesExamplesArray) {
                // eslint-disable-next-line no-restricted-syntax -- counted on the page from before the ban: to move to the server (thin-client step 10, unfinished)
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

        if (isContinue) {
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
            chatString = '';
            /** @type {string[]} */
            const finalArrMes = /** @type {string[]} */ (arrMes.reverse());
            arrMes = finalArrMes;
            finalArrMes.forEach(function (item, i, arr) {
                if (main_api === 'openai') {
                    return;
                }

                if (i === finalArrMes.length - 1 && type !== 'continue') {
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

            mesExmString = pinExmString ?? mesExamplesArray.slice(0, count_exm_add).join('');

            if (mesSend.length) {
                mesSend[mesSend.length - 1].message = modifyLastPromptLine(mesSend[mesSend.length - 1].message);
            }
        }

        /**
         * @param {string} lastMesString
         * @returns {string}
         */
        function modifyLastPromptLine(lastMesString) {
            if (quiet_prompt != null && quiet_prompt.length > 0) {
                const name = name1;
                const quietAppend = isInstruct ? formatInstructModeChat(name, quiet_prompt, false, true, '', name1, name2, false) : `\n${quiet_prompt}`;

                if (isInstruct) {
                    lastMesString += quietAppend;
                } else {
                    lastMesString += quietAppend;
                }


                if (!isInstruct && quietToLoud !== true) {
                    return lastMesString;
                }
            }


            if (isInstruct && !isContinue) {
                const name = (quiet_prompt != null && quiet_prompt !== '' && quietToLoud !== true && !isImpersonate) ? (quietName ?? 'System') : (isImpersonate ? name1 : name2);
                const isQuiet = quiet_prompt != null && quiet_prompt !== '' && type == 'quiet';
                lastMesString += formatInstructModePrompt(name, isImpersonate, promptBias, name1, name2, isQuiet, quietToLoud === true);
            }

            if (!isInstruct && isImpersonate && !isContinue) {
                const name = name1;
                if (!lastMesString.endsWith('\n')) {
                    lastMesString += '\n';
                }
                lastMesString += name + ':';
            }

            const isContinuingOnFirstMessage = chat.length === 1 && isContinue;
            if (!isInstruct && force_name2 === true && !isContinuingOnFirstMessage) {
                if (!lastMesString.endsWith('\n')) {
                    lastMesString += '\n';
                }
                if (!isContinue || chat[chat.length - 1]?.is_user !== true) {
                    lastMesString += `${name2}:`;
                }
            }

            return lastMesString;
        }

        async function checkPromptSize() {
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
            // eslint-disable-next-line no-restricted-syntax -- counted on the page from before the ban: to move to the server (thin-client step 10, unfinished)
            let thisPromptContextSize = await getPromptTokenCountAsync(prompt, /** @type {undefined} */ (/** @type {unknown} */ (power_user.token_padding)));

            if (thisPromptContextSize > this_max_context) {
                if (count_exm_add > 0) {
                    count_exm_add--;
                    await checkPromptSize();
                } else if (mesSend.length > 0) {
                    mesSend.shift();
                    await checkPromptSize();
                } else {
                    //end
                }
            }
        }

        if (generatedPromptCache.length > 0 && main_api !== 'openai') {
            await checkPromptSize();
        } else {
            setPromptString();
        }

        if (!dryRun && main_api !== 'openai') {
            showTrimEstimateWarning();
        }

        mesSendString = '';

        getCombinedPrompt = async function (isNegative) {
            if (isNegative && !useCfgPrompt) {
                return;
            }

            if (main_api === 'openai') {
                return '';
            }

            let finalMesSend = structuredClone(mesSend);

            if (useCfgPrompt && cfgGuidanceScale) {
                const cfgPrompt = getCfgPrompt(cfgGuidanceScale, isNegative);
                if (cfgPrompt.value) {
                    if (cfgPrompt.depth === 0) {
                        finalMesSend[finalMesSend.length - 1].message +=
                            /\s/.test(finalMesSend[finalMesSend.length - 1].message.slice(-1))
                                ? cfgPrompt.value
                                : ` ${cfgPrompt.value}`;
                    } else {
                        const lengthDiff = mesSend.length - cfgPrompt.depth;
                        const cfgDepth = lengthDiff >= 0 ? lengthDiff : 0;
                        const cfgMessage = /** @type {{message: string, extensionPrompts: string[]} | undefined} */ (finalMesSend[cfgDepth]);
                        if (cfgMessage != null) {
                            if (!Array.isArray(cfgMessage.extensionPrompts)) {
                                cfgMessage.extensionPrompts = [];
                            }
                            cfgMessage.extensionPrompts.push(`${cfgPrompt.value}\n`);
                        }
                    }
                }
            }

            if (!isInstruct && !isImpersonate) {
                if (promptBias.trim().length !== 0) {
                    finalMesSend[finalMesSend.length - 1].message +=
                        /\s/.test(finalMesSend[finalMesSend.length - 1].message.slice(-1))
                            ? promptBias.trimStart()
                            : ` ${promptBias.trimStart()}`;
                }
            }

            const combine = () => {
                mesSendString = finalMesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');

                mesSendString = addChatsSeparator(mesSendString);

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
                combinedPrompt: /** @type {string | null} */ (null),
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

            return data.combinedPrompt == null ? combine() : data.combinedPrompt;
        };

        finalPrompt = await getCombinedPrompt(false) ?? '';

        const eventData = { prompt: finalPrompt, dryRun: dryRun };
        await eventSource.emit(event_types.GENERATE_AFTER_COMBINE_PROMPTS, eventData);
        finalPrompt = eventData.prompt;

        maxLength = Number(responseLengthFor(main_api));
    }

    /** @type {any} */
    let generate_data;
    switch (main_api) {
        case 'koboldhorde':
        case 'kobold':
            if (rawActionGenerateData) {
                generate_data = rawActionGenerateData;
                break;
            }

            if (main_api == 'koboldhorde' && horde_settings.auto_adjust_response_length && adjustedParams) {
                maxLength = Math.min(maxLength, adjustedParams.maxLength);
                maxLength = Math.max(maxLength, MIN_LENGTH);
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
            if (rawActionGenerateData) {
                generate_data = rawActionGenerateData;
                break;
            }
            const cfgValues = useCfgPrompt ? { guidanceScale: cfgGuidanceScale, negativePrompt: await getCombinedPrompt(true) } : null;
            generate_data = await getTextGenGenerationData(finalPrompt, maxLength, isImpersonate, isContinue, cfgValues, type);
            break;
        }
        case 'novel': {
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
            if (rawActionChatCompletionData) {
                generate_data = { rawAction: rawActionChatCompletionData };
                break;
            }
            const [prompt] = await prepareOpenAIMessages({
                name2: name2,
                charDescription: description,
                charPersonality: personality,
                scenario: scenario,
                worldInfoBefore: worldInfoBefore,
                worldInfoAfter: worldInfoAfter,
                extensionPrompts: extension_prompts,
                bias: promptBias,
                type: type,
                quietPrompt: quiet_prompt ?? '',
                quietImage: quietImage ?? '',
                cyclePrompt: cyclePrompt,
                systemPromptOverride: system,
                jailbreakPromptOverride: jailbreak,
                messages: oaiMessages,
                messageExamples: /** @type {string[]} */ (/** @type {unknown} */ (oaiMessageExamples)),
            }, dryRun);
            generate_data = { prompt: prompt };

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
     * @returns {Promise<void|*|Awaited<*>|String|{fromStream}|string|undefined|Object>}
     * @throws {Error|object}
     */
    async function finishGenerating() {
        if (power_user.console_log_prompts) {
            console.log(generate_data.prompt);
        }


        showStopButton();

        const rawAction = rawActionGenerateData ?? rawActionChatCompletionData;
        if (rawAction !== null && type !== 'quiet' && !isImpersonate) {
            const onMessage = type === 'swipe' || isContinue;
            const index = onMessage ? chat.length - 1 : chat.length;
            const named = onMessage ? chat[index]?.node_id : null;
            replyInFlight = { index, anchor: isStoredNodeId(named) ? /** @type {string} */ (named) : null };
        }

        if (isStreamingEnabled() && type !== 'quiet') {
            continue_mag = promptReasoning.removePrefix(continue_mag);
            streamingProcessor = new StreamingProcessor(type, force_name2 === true, generation_started, continue_mag, promptReasoning);
            if (isContinue) {
                streamingProcessor.firstMessageText = '';
            }

            streamingProcessor.generator = await sendStreamingRequest(type, generate_data, { jsonSchema: jsonSchema ?? undefined });

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

            const isStreamFinished = !streamingProcessor.isStopped && streamingProcessor.isFinished;
            const isStreamWithToolCallHandoff = isStreamFinished && streamingProcessor.toolCallHandoff && generate_data?.rawAction;
            if (isStreamWithToolCallHandoff) {
                const lastMessage = chat[chat.length - 1];
                const shouldDeleteMessage = type !== 'swipe' && ['', '...'].includes(lastMessage.mes ?? '') && (lastMessage.extra?.reasoning ?? '') === '' && ['', '...'].includes(streamingProcessor.result);
                if (shouldDeleteMessage) {
                    await dropLastMessage();
                } else {
                    await streamingProcessor.finalizeIntermediaryMessage(streamingProcessor.messageId, getMessage, { unlockUI: false });
                }
                const handoff = streamingProcessor.toolCallHandoff;
                streamingProcessor = null;
                /** @type {any} */
                const resolved = await resolveClientToolHandoffLoop({ pending_tool_calls: handoff?.pending_tool_calls ?? [] }, generate_data.rawAction);
                if (resolved && resolved.aborted) {
                    unblockGeneration(type);
                    return;
                }
                return resolved;
            }

            const isStreamWithToolCallAborted = isStreamFinished && streamingProcessor.toolCallAborted && generate_data?.rawAction;
            if (isStreamWithToolCallAborted) {
                await dropLastMessage();
                streamingProcessor = null;
                unblockGeneration(type);
                return;
            }

            const isStreamWithToolCalls = Array.isArray(streamingProcessor.toolCalls) && streamingProcessor.toolCalls.length > 0;
            if (canPerformToolCalls && isStreamFinished && isStreamWithToolCalls) {
                const lastMessage = chat[chat.length - 1];
                const hasToolCalls = ToolManager.hasToolCalls(streamingProcessor.toolCalls);
                const shouldDeleteMessage = type !== 'swipe' && ['', '...'].includes(lastMessage.mes ?? '') && (lastMessage.extra?.reasoning ?? '') === '' && ['', '...'].includes(streamingProcessor.result);
                hasToolCalls && shouldDeleteMessage && await dropLastMessage();
                if (hasToolCalls && !shouldDeleteMessage) {
                    await streamingProcessor.finalizeIntermediaryMessage(streamingProcessor.messageId, getMessage, { unlockUI: false });
                }
                const invocationResult = await ToolManager.invokeFunctionTools(streamingProcessor.toolCalls, {
                    reasoningText: /** @type {null} */ (/** @type {unknown} */ (streamingProcessor.reasoningHandler.reasoning)),
                });
                const shouldStopGeneration = (!invocationResult.invocations.length && shouldDeleteMessage) || invocationResult.stealthCalls.length > 0;
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
            /** @type {any} */
            const data = await sendGenerationRequest(type, generate_data, { jsonSchema: jsonSchema ?? undefined });
            adoptStored(data?.stored);
            if (data && Array.isArray(data.pending_tool_calls) && data.pending_tool_calls.length && generate_data?.rawAction) {
                /** @type {any} */
                const resolved = await resolveClientToolHandoffLoop(data, generate_data.rawAction);
                if (resolved && resolved.aborted) {
                    unblockGeneration(type);
                    return;
                }
                return resolved;
            }
            if (data && data.aborted && generate_data?.rawAction) {
                unblockGeneration(type);
                return;
            }
            return data;
        }
    }

    return finishGenerating().then(onSuccess, onError);

    /**
     * @param {any} data
     * @returns {Promise<String|{fromStream}|*|string|string|void|Awaited<*>|undefined>}
     * @throws {Error}
     */
    async function onSuccess(data) {
        if (!data) return;

        if (data?.fromStream) {
            return data;
        }

        let messageChunk = '';

        if (data.error) {
            unblockGeneration(type);

            if (data?.response) {
                toastr.error(data.response, t`API Error`, { preventDuplicates: true });
            }
            throw new Error(data?.response);
        }

        showTokenizerWarnings(data.warnings);

        if (jsonSchema) {
            unblockGeneration(type);
            return extractJsonFromData(data, { returnInvalidJson: jsonSchema.returnInvalid ?? false });
        }

        let getMessage = extractMessageFromData(data);
        let title = extractTitleFromData(data);
        let reasoning = extractReasoningFromData(data);
        const reasoningSignature = extractReasoningSignatureFromData(data);
        kobold_horde_model = title;

        const swipes = extractMultiSwipes(data, type);

        messageChunk = cleanUpMessage({
            getMessage: getMessage,
            isImpersonate: isImpersonate,
            isContinue: isContinue,
            displayIncompleteSentences: false,
        });


        if (power_user.trim_spaces) {
            reasoning = reasoning.trim();
        }

        if (isContinue) {
            continue_mag = promptReasoning.removePrefix(continue_mag);
            getMessage = continue_mag + getMessage;
        }

        const displayIncomplete = type === 'quiet' && quietToLoud !== true;
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
            const storedReply = data.assistant_message ?? takeStoredReply(data.assistant_node_id);
            const storedNodeId = isStoredNodeId(data.assistant_node_id) ? data.assistant_node_id : null;
            if (originalType !== 'continue') {
                ({ type, getMessage } = await saveReply({ type, getMessage, title, swipes, reasoning, reasoningSignature, storedReply, storedNodeId }));
            } else {
                ({ type, getMessage } = await saveReply({ type: 'appendFinal', getMessage, title, swipes, reasoning, reasoningSignature, storedReply, storedNodeId }));
            }

            parseAndSaveLogprobs(data, continue_mag);
            if (isStoredNodeId(data.assistant_node_id)) {
                _stampAssistantNodeId(data.assistant_node_id);
            } else {
                _markReplyNotSaved();
            }
        }

        if (canPerformToolCalls) {
            const hasToolCalls = ToolManager.hasToolCalls(data);
            const shouldDeleteMessage = type !== 'swipe' && ['', '...'].includes(getMessage) && !reasoning;
            hasToolCalls && shouldDeleteMessage && await dropLastMessage();
            const invocationResult = await ToolManager.invokeFunctionTools(data, { reasoningText: /** @type {null} */ (/** @type {unknown} */ (reasoning)) });
            const shouldStopGeneration = (!invocationResult.invocations.length && shouldDeleteMessage) || invocationResult.stealthCalls.length > 0;
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

        const isAborted = abortController.signal.aborted;
        if (!isAborted && power_user.auto_swipe && generatedTextFiltered(getMessage)) {
            setSendButtonState(false);
            return await swipe(/** @type {SwipeEvent} */ (/** @type {unknown} */ (null)), SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.AUTO_SWIPE, repeated: true, forceMesId: chat.length - 1 });
        }

        saveTokenCache();
        unblockGeneration(type);
        streamingProcessor = null;

        if (type !== 'quiet') {
            triggerAutoContinue(messageChunk, isImpersonate);
        }

        return Object.defineProperty(new String(getMessage), 'messageChunk', { value: messageChunk });
    }

    /**
     * @param {Error|object} exception
     * @throws {Error|object}
     */
    function onError(exception) {
        const errorResponse = /** @type {any} */ (exception);
        const message = typeof errorResponse?.error?.message === 'string'
            ? errorResponse.error.message
            : (errorResponse?.error === true && typeof errorResponse?.message === 'string' ? errorResponse.message : null);
        if (message) {
            toastr.error(message, t`Text generation error`, { timeOut: 10000, extendedTimeOut: 20000 });
        }

        unblockGeneration(type);
        console.log(exception);
        streamingProcessor = null;
        throw exception;
    }
}

export function stopGeneration() {
    let stopped = false;
    stopServerGenerations();
    if (streamingProcessor) {
        streamingProcessor.onStopStreaming();
        stopped = true;
    }
    abortController.abort('Clicked stop button');
    hideStopButton();
    stopped = true;
    eventSource.emit(event_types.GENERATION_STOPPED);
    return stopped;
}
