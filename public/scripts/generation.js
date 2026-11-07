import {
    cleanUpMessage, deactivateSendButtons, dropLastMessage, extension_prompts, extractJsonFromData, extractMessageBias, extractMessageFromData,
    extractMultiSwipes, extractTitleFromData, getCurrentCharacter, getCurrentDraftContext, hideStopButton, hideSwipeButtons,
    online_status, parseAndSaveLogprobs, processCommands, removeLastMessage, removeMacros, resolveClientToolHandoffLoop,
    saveReply, sendMessageAsUser, setGenerationProgress, setSendButtonState, showStopButton, storeSentMessage,
    StreamingProcessor, substituteParams, swipe, triggerAutoContinue, unblockGeneration, updateMessageBlock,
    updateMessageItemizedPromptButton, takePendingSettingsChanges, noteSettingsChangesSaved, settingsChangesConflicted,
    returnPendingSettingsChanges,
} from '../script.js';
import { chat, chat_metadata } from './chat-state.js';
import { name1 } from './app-selection-state.js';
import { changedMetadata, noteMetadataChangesStored, noteMetadataSent } from './metadata-store.js';
import { changeOps, changesSince } from './state-sync.js';
import { isProvisionalNodeId, isStoredNodeId, provisionalNodeId } from './node-identity.js';
import { holdDraft, releaseDraft } from './chat-draft.js';
import { isFailedSend, keepFailedSend, wasSendStored } from './failed-sends.js';
import { updateMessage, setStoreRef, storeRefOf, adoptStored, deepFreeze } from './chat-store.js';
import { hasPendingFileAttachment } from './chats.js';
import { inject_ids, SWIPE_DIRECTION, SWIPE_SOURCE } from './constants.js';
import { eventSource, event_types } from './events.js';
import { generateGroupWrapper, is_group_generating, selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { user_avatar } from './personas.js';
import { generatedTextFiltered, playMessageSound, power_user } from './power-user.js';
import { extractReasoningFromData, extractReasoningSignatureFromData, markServerFinishedReply, PromptReasoning } from './reasoning.js';
import { reasoningOf } from './reasoning-block.js';
import { takeStoredReply } from './llamacpp-compact-stream.js';
import { sendSystemMessage, system_message_types } from './system-messages.js';
import { ToolManager } from './tool-calling.js';
import { REPLY_NOT_SAVED_EVENT, REPLY_STORED_EVENT } from './tokenizer-notices.js';
import { uuidv4 } from './utils.js';
import { stopServerGenerations, takeStreamStopResult } from './generation-stop.js';
import { sendGeneration, settingsSavedOf, wholeReplyOf } from './generation-request.js';
import { getRequestHeaders } from './request-headers.js';
import { world_info_overflow_alert } from './world-info.js';
import { pageMacroFacts } from './macros/engine/MacroEnvBuilder.js';
import { takeMessageCount } from './tokenizers.js';

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
 * @param {{mes: string, extra?: Record<string, any>, counted_with?: any}|null|undefined} stored
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
    if (typeof storedExtra.token_count === 'number') {
        takeMessageCount((typeof storedExtra.reasoning === 'string' ? storedExtra.reasoning : '') + stored.mes, storedExtra.token_count, stored.counted_with);
    }
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
 * The chat a generation is in, as the server names it.
 * @returns {{ character_avatar: string, group_id: string|undefined }|null}
 */
function generationOwner() {
    const avatar = getCurrentCharacter()?.avatar;
    if (typeof avatar !== 'string' || avatar === '') return null;
    return { character_avatar: avatar, group_id: selected_group != null ? String(selected_group) : undefined };
}

/**
 * @typedef {object} BuiltPrompt
 * @property {string} connection
 * @property {string|{ role: string, content: unknown }[]} prompt
 * @property {import('./itemized-prompts.js').PromptItemization} itemization
 * @property {{ identifier: string, tokens: number, messages: { role: string, content: unknown, tokens: number }[] }[]|null} prompt_manager
 */

/**
 * Sends a generation action with the settings changes the server hasn't seen yet, which it applies first.
 * @param {object} body
 * @param {AbortSignal} signal
 * @param {string} [url]
 * @returns {Promise<import('./generation-request.js').GenerationAnswer>}
 */
export async function sendCarryingSettings(body, signal, url = undefined) {
    const changes = takePendingSettingsChanges();
    try {
        const answer = await sendGeneration({ ...body, settings_changes: changes }, signal, url);
        if (changes) await noteSettingsChangesSaved(answer.settingsSaved ?? {}, changes.keys);
        return answer;
    } catch (error) {
        await settleCarriedSettings(changes, /** @type {any} */ (error));
        throw error;
    }
}

/**
 * What became of settings changes an action carried that didn't succeed: taken if the server applied them, reloaded
 * if it refused them, and saved again if they never reached it.
 * @param {ReturnType<typeof takePendingSettingsChanges>} changes
 * @param {{ settings_saved?: any, settings_conflict?: string[]|null }|null|undefined} failure
 */
async function settleCarriedSettings(changes, failure) {
    if (!changes) return;
    if (failure?.settings_saved) await noteSettingsChangesSaved(failure.settings_saved, changes.keys);
    else if (failure && 'settings_conflict' in failure) await settingsChangesConflicted(failure.settings_conflict ?? undefined);
    else returnPendingSettingsChanges(changes);
}

/**
 * The prompt the next reply would be sent with, as the server builds it, without sending it.
 * @param {string} [type]
 * @returns {Promise<BuiltPrompt|null>} Null when no chat is open.
 */
export async function buildPrompt(type = 'normal') {
    const owner = generationOwner();
    if (!owner) return null;
    let nodeId = null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isStoredNodeId(chat[i]?.node_id)) {
            nodeId = chat[i].node_id;
            break;
        }
    }
    const changes = takePendingSettingsChanges();
    let response;
    try {
        response = await fetch('/api/generation/prompt', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ...owner, node_id: nodeId, type,
                macro_facts: pageMacroFacts(),
                extension_prompts: await pageInjections(),
                settings_changes: changes,
            }),
        });
    } catch (error) {
        await settleCarriedSettings(changes, null);
        throw error;
    }
    const answer = await response.json().catch(() => ({}));
    const settingsSaved = settingsSavedOf(response);
    if (!response.ok) {
        await settleCarriedSettings(changes, { settings_saved: settingsSaved, ...(answer?.settings_not_saved ? { settings_conflict: answer.conflictingKeys ?? null } : {}) });
        throw new Error(answer?.error?.message ?? response.statusText);
    }
    if (changes) await noteSettingsChangesSaved(settingsSaved ?? {}, changes.keys);
    return answer;
}

/**
 * @param {string} type
 * @param {GenerateOptions} options
 * @returns {Promise<any>}
 */
export async function Generate(type, options = {}) {
    /** @type {PendingSend[]} */
    const pendingSends = [];
    const replyBefore = replyInFlight;
    try {
        return await generateOnce(type, options, pendingSends);
    } finally {
        if (replyInFlight !== replyBefore) replyInFlight = null;
        swipeAnchor = null;
        await settlePendingSends(pendingSends);
    }
}

/**
 * @param {string} type
 * @param {GenerateOptions} options
 * @param {PendingSend[]} pendingSends
 * @returns {Promise<any>}
 */
async function generateOnce(type, options = {}, pendingSends = []) {
    const { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage, quietName, jsonSchema = null, responseLength, depth = 0 } = options;
    const metadataAtStart = changedMetadata();
    setGenerationProgress(0);
    generation_started = new Date();

    await eventSource.emit(event_types.GENERATION_STARTED, type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_avatar, signal, quietImage }, false);

    if (signal == null) {
        abortController = new AbortController();
    }

    const isImpersonate = type == 'impersonate';
    const isContinue = type == 'continue';

    if (!(depth || type == 'regenerate' || type == 'swipe' || type == 'quiet')) {
        const interruptedByCommand = await processCommands(String($('#send_textarea').val()));

        if (interruptedByCommand) {
            unblockGeneration(type);
            return Promise.resolve();
        }
    }

    const unsavedReply = /** @type {ChatMessage | undefined} */ (chat[chat.length - 1]);
    if (type !== 'quiet' && type !== 'impersonate' && typeof unsavedReply?.extra?.reply_not_saved === 'string') {
        toastr.error(t`The last reply isn't saved yet. Use "Save it again" on its notice first, or delete it.`, t`Reply not saved`, { preventDuplicates: true });
        unblockGeneration(type);
        return Promise.resolve();
    }
    if (type !== 'quiet' && type !== 'impersonate' && isFailedSend(unsavedReply)) {
        toastr.error(t`Your last message isn't saved yet. Save it or discard it on its notice first.`, t`Message not saved`, { preventDuplicates: true });
        unblockGeneration(type);
        return Promise.resolve();
    }

    hideSwipeButtons();
    chat_metadata.tainted = true;

    if (selected_group != null && !is_group_generating) {
        return generateGroupWrapper(false, type, { ...options, signal: abortController.signal });
    }

    if (online_status === 'no_connection') {
        setSendButtonState(false);
        return Promise.resolve();
    }

    const owner = generationOwner();
    if (!owner) {
        unblockGeneration(type);
        return Promise.resolve();
    }

    const lastMessage = /** @type {ChatMessage | undefined} */ (chat[chat.length - 1]);
    const lastMessageIndex = chat.length - 1;

    let textareaText;
    /** @type {import('./chat-draft.js').DraftContext|null} */
    let sentDraftContext = null;
    if (type !== 'regenerate' && type !== 'swipe' && type !== 'quiet' && !isImpersonate && !depth) {
        setSendButtonState(true);
        textareaText = String($('#send_textarea').val());
        sentDraftContext = getCurrentDraftContext();
        if (sentDraftContext) {
            holdDraft(localStorage, sentDraftContext, textareaText);
        }
        $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        textareaText = '';
        if (lastMessage?.is_user !== true && type !== 'quiet' && type !== 'swipe' && !isImpersonate && !depth && chat.length) {
            forgetStored([chat[chat.length - 1]?.node_id]);
            chat.length = chat.length - 1;
            await removeLastMessage();
            await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
        }
    }

    if (isContinue && chat.length) {
        const prevFinished = lastMessage?.gen_finished;
        const prevStarted = lastMessage?.gen_started;

        if (prevFinished != null && prevStarted != null) {
            const timePassed = Number(prevFinished) - Number(prevStarted);
            generation_started = new Date(Date.now() - timePassed);
            updateMessage(chat.length - 1, { gen_started: generation_started });
        }
    }

    deactivateSendButtons();

    const messageBias = isImpersonate || isContinue ? '' : substituteParams(extractMessageBias(textareaText));
    const noAttachTypes = ['regenerate', 'swipe', 'impersonate', 'quiet', 'continue'];
    let sentUserMessage;
    if ((textareaText != '' || (hasPendingFileAttachment() && !noAttachTypes.includes(type))) && automatic_trigger !== true && type !== 'quiet' && !depth) {
        if (messageBias && !removeMacros(textareaText)) {
            sendSystemMessage(system_message_types.GENERIC, ' ', { bias: messageBias });
        } else {
            sentUserMessage = await sendMessageAsUser(textareaText, messageBias, /** @type {number} */ (/** @type {unknown} */ (null)), false, name1, user_avatar, true);
        }
    }

    if (sentDraftContext && textareaText) {
        releaseDraft(localStorage, sentDraftContext, textareaText);
    }
    const sentKey = storeRefOf(sentUserMessage);
    if (sentUserMessage && sentKey !== undefined) {
        pendingSends.push({ key: sentKey, message: sentUserMessage });
    }

    const promptReasoning = new PromptReasoning();
    const continued = isContinue ? chat[chat.length - 1] : undefined;
    if (continued) {
        promptReasoning.addToMessage(continued.mes ?? '', reasoningOf(continued.extra), true, continued.extra?.reasoning_duration ?? null);
    }

    const sentMessage = sentUserMessageForRequest(sentUserMessage);
    /** @type {{ tools?: import('./tool-calling.js').ToolDefinitionOpenAI[] }} */
    const toolsHolder = {};
    if (depth < ToolManager.RECURSE_LIMIT) {
        await ToolManager.registerFunctionToolsOpenAI(toolsHolder);
    }
    const stealthToolNames = (toolsHolder.tools ?? []).map(tool => tool.function.name).filter(name => typeof name === 'string' && ToolManager.isStealthTool(name));
    const action = {
        ...owner,
        ...rawActionWritesFor(type, lastMessage, lastMessageIndex, metadataAtStart),
        user_message: sentMessage,
        user_message_ref: sentMessage !== undefined ? storeRefOf(sentUserMessage) : undefined,
        macro_facts: pageMacroFacts(),
        response_length: typeof responseLength === 'number' && responseLength > 0 ? responseLength : undefined,
        extension_prompts: await pageInjections(),
        client_tools: toolsHolder.tools,
        stealth_tool_names: stealthToolNames.length ? stealthToolNames : undefined,
        json_schema: jsonSchema ?? undefined,
        skip_wian: skipWIAN === true ? true : undefined,
        force_name2: force_name2 === true ? true : undefined,
        ...quietPromptRequest(quiet_prompt, quietToLoud, quietName, quietImage),
    };

    setSendButtonState(true);

    /**
     * @returns {Promise<any>}
     * @throws {Error|object}
     */
    async function finishGenerating() {
        showStopButton();

        if (type !== 'quiet' && !isImpersonate) {
            const onMessage = type === 'swipe' || isContinue;
            const index = onMessage ? chat.length - 1 : chat.length;
            const named = onMessage ? chat[index]?.node_id : null;
            replyInFlight = { index, anchor: isStoredNodeId(named) ? /** @type {string} */ (named) : null };
        }

        const answer = await sendCarryingSettings(action, abortController.signal);
        connection = answer.connection;

        if (answer.stream && type !== 'quiet') {
            streamingProcessor = new StreamingProcessor(type, force_name2 === true, generation_started, '', promptReasoning, connection);
            if (isContinue) {
                streamingProcessor.firstMessageText = '';
            }
            streamingProcessor.generator = answer.stream;

            hideSwipeButtons();
            const getMessage = await streamingProcessor.generate();
            const messageChunk = cleanUpMessage({
                getMessage: getMessage,
                isImpersonate: isImpersonate,
                isContinue: isContinue,
                displayIncompleteSentences: false,
                api: connection,
            });

            const isStreamFinished = !streamingProcessor.isStopped && streamingProcessor.isFinished;
            if (isStreamFinished && streamingProcessor.toolCallHandoff) {
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
                const resolved = await resolveClientToolHandoffLoop({ pending_tool_calls: handoff.pending_tool_calls }, owner);
                if (resolved && resolved.aborted) {
                    unblockGeneration(type);
                    return;
                }
                return resolved;
            }

            if (isStreamFinished && streamingProcessor.toolCallAborted) {
                await dropLastMessage();
                streamingProcessor = null;
                unblockGeneration(type);
                return;
            }

            if (isStreamFinished) {
                await streamingProcessor.onFinishStreaming(streamingProcessor.messageId, getMessage);
                streamingProcessor = null;
                triggerAutoContinue(messageChunk, isImpersonate, connection);
                return Object.defineProperties(new String(getMessage), {
                    'messageChunk': { value: messageChunk },
                    'fromStream': { value: true },
                });
            }
            return;
        }

        /** @type {any} */
        const data = answer.stream ? await wholeReplyOf(answer.stream) : answer.data;
        adoptStored(data?.stored);
        if (data && Array.isArray(data.pending_tool_calls) && data.pending_tool_calls.length) {
            /** @type {any} */
            const resolved = await resolveClientToolHandoffLoop(data, owner);
            if (resolved && resolved.aborted) {
                unblockGeneration(type);
                return;
            }
            return resolved;
        }
        if (data && data.aborted) {
            unblockGeneration(type);
            return;
        }
        return data;
    }

    /** @type {string} */
    let connection = '';
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

        if (jsonSchema) {
            unblockGeneration(type);
            return extractJsonFromData(data, { mainApi: connection, returnInvalidJson: jsonSchema.returnInvalid ?? false });
        }

        let getMessage = extractMessageFromData(data, connection);
        const title = extractTitleFromData(data, connection);
        let reasoning = extractReasoningFromData(data, { mainApi: connection });
        const reasoningSignature = extractReasoningSignatureFromData(data, { mainApi: connection });
        kobold_horde_model = title;

        const swipes = extractMultiSwipes(data, type, connection);

        const messageChunk = cleanUpMessage({
            getMessage: getMessage,
            isImpersonate: isImpersonate,
            isContinue: isContinue,
            displayIncompleteSentences: false,
            api: connection,
        });

        if (power_user.trim_spaces) {
            reasoning = reasoning.trim();
        }

        const displayIncomplete = type === 'quiet' && quietToLoud !== true;
        getMessage = cleanUpMessage({
            getMessage: getMessage,
            isImpersonate: isImpersonate,
            isContinue: isContinue,
            displayIncompleteSentences: displayIncomplete,
            api: connection,
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
            if (type !== 'continue') {
                ({ type, getMessage } = await saveReply({ type, getMessage, title, swipes, reasoning, reasoningSignature, storedReply, storedNodeId }));
            } else {
                ({ type, getMessage } = await saveReply({ type: 'appendFinal', getMessage, title, swipes, reasoning, reasoningSignature, storedReply, storedNodeId }));
            }

            parseAndSaveLogprobs(data, '', connection);
            if (isStoredNodeId(data.assistant_node_id)) {
                _stampAssistantNodeId(data.assistant_node_id);
            } else {
                _markReplyNotSaved();
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

        unblockGeneration(type);
        streamingProcessor = null;

        if (type !== 'quiet') {
            triggerAutoContinue(messageChunk, isImpersonate, connection);
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
