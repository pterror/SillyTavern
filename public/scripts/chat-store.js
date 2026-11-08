import { cardToGreetingsModel, getCurrentCharacter, getCurrentChatId, isStoredNodeId, isProvisionalNodeId, provisionalNodeId, redisplayChat, refreshSwipeButtons, updateMessageBlock, _messageSnapshots, markStoredAs, isAsStored, forgetStored, isReplyGenerating } from '../script.js';
import { eventSource, event_types } from './events.js';
import { openingView } from './opening-view.js';
import { chat, chat_metadata } from './chat-state.js';
import { getRequestHeaders } from './request-headers.js';
import { charactersStore } from './character-store.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';
import { selected_group, groupsStore } from './group-chats.js';
import { t } from './i18n.js';
import { uuidv4 } from './utils.js';
import { setStoredAdopter } from './stored-report.js';
import { askToDrop, confirmOf, hasDrops, warnDropped } from './edit-drops.js';
import { ITEMIZED_PROMPT_FLAG } from './itemized-prompts.js';

/**
 * @param {number} i
 * @returns {ChatMessage|undefined}
 */
function _chatAt(i) {
    return chat[i];
}

/**
 * @template T
 * @param {T} obj
 * @returns {T}
 */
export function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Object.isFrozen(obj)) return obj;
    Object.freeze(obj);
    for (const val of Object.values(obj)) {
        if (val !== null && typeof val === 'object') {
            deepFreeze(val);
        }
    }
    return obj;
}

/** @type {WeakMap<object, string>} */
const _storeRefs = new WeakMap();

/**
 * @param {object} message
 * @param {string} ref
 */
export function setStoreRef(message, ref) {
    _storeRefs.set(message, ref);
}

/**
 * @param {object|null|undefined} message
 * @returns {string|undefined}
 */
export function storeRefOf(message) {
    return message ? _storeRefs.get(message) : undefined;
}

/**
 * @param {ChatMessage} from
 * @param {ChatMessage} to
 */
function _carryStoreRef(from, to) {
    const ref = _storeRefs.get(from);
    if (ref !== undefined) _storeRefs.set(to, ref);
}

/** @type {(ref: string) => void} */
let _sendStoredListener = () => {};

/**
 * @param {(ref: string) => void} listener
 */
export function setSendStoredListener(listener) {
    _sendStoredListener = listener;
}

/** @type {(entry: { ref: string, node_id: string, integrity: string|null, notSaved?: true, state?: ChatMetadata }) => void} */
let _metadataStoredListener = () => {};

let _globalVariablesListener = (/** @type {{ set: Record<string, unknown>, unset: string[] }} */ _changes) => {};
let _chatVariablesListener = (/** @type {{ set: Record<string, unknown>, unset: string[] }} */ _changes) => {};

/**
 * @param {(changes: { set: Record<string, unknown>, unset: string[] }) => void} listener
 */
export function setGlobalVariablesListener(listener) {
    _globalVariablesListener = listener;
}

/**
 * @param {(changes: { set: Record<string, unknown>, unset: string[] }) => void} listener
 */
export function setChatVariablesListener(listener) {
    _chatVariablesListener = listener;
}

const _openingMetadataRefs = new Set();

/**
 * @param {(entry: { ref: string, node_id: string, integrity: string|null, notSaved?: true, state?: ChatMetadata }) => void} listener
 */
export function setMetadataStoredListener(listener) {
    _metadataStoredListener = listener;
}

/**
 * @param {unknown} stored
 */
export function adoptStored(stored) {
    if (!Array.isArray(stored)) return;
    for (const entry of stored) {
        if (typeof entry?.ref !== 'string') continue;
        if (entry.variables && typeof entry.variables === 'object') {
            _chatVariablesListener(entry.variables);
            continue;
        }
        if (entry.global_variables && typeof entry.global_variables === 'object') {
            _globalVariablesListener(entry.global_variables);
            continue;
        }
        if (entry.metadata_not_saved === true) {
            _openingMetadataRefs.delete(entry.ref);
            const state = entry.state && typeof entry.state === 'object' ? entry.state : undefined;
            _metadataStoredListener({ ref: entry.ref, node_id: typeof entry.node_id === 'string' ? entry.node_id : '', integrity: null, notSaved: true, state });
            continue;
        }
        if ('integrity' in entry) {
            if (_openingMetadataRefs.delete(entry.ref)) {
                chat_metadata.integrity = typeof entry.integrity === 'string' ? entry.integrity : undefined;
                continue;
            }
            _metadataStoredListener({ ref: entry.ref, node_id: typeof entry.node_id === 'string' ? entry.node_id : '', integrity: typeof entry.integrity === 'string' ? entry.integrity : null });
            continue;
        }
        if (!isStoredNodeId(entry.node_id)) continue;
        _sendStoredListener(entry.ref);
        for (let i = chat.length - 1; i >= 0; i--) {
            if (_storeRefs.get(chat[i]) !== entry.ref) continue;
            if (isProvisionalNodeId(chat[i].node_id)) {
                _adoptOpeningRow(i, entry.node_id);
                break;
            }
            if (chat[i].node_id !== entry.node_id) updateMessage(i, { node_id: entry.node_id });
            _markMessageSaved(i, entry.node_id);
            break;
        }
    }
}

/**
 * @param {number} mesId
 * @param {string} realId
 */
function _adoptOpeningRow(mesId, realId) {
    const current = chat[mesId];
    const provisional = current.node_id;
    const at = current.swipe_id ?? 0;
    /** @type {Partial<ChatMessage>} */
    const updates = { node_id: realId };
    if (Array.isArray(current.swipe_info)) {
        const swipeInfo = [...current.swipe_info];
        swipeInfo[at] = { ...(swipeInfo[at] ?? {}), node_id: realId };
        updates.swipe_info = swipeInfo;
    }
    updateMessage(mesId, updates);
    forgetStored([provisional]);
    markStoredAs(realId, chat[mesId]);
    if (mesId === 0 && (selected_group == null || selected_group === '')) _setCurrentTarget(getCurrentChatId() ?? '', null);
}

setStoredAdopter(adoptStored);

/**
 * @param {number} mesId
 * @param {Partial<ChatMessage>} updates
 * @returns {ChatMessage|undefined}
 */
export function updateMessage(mesId, updates) {
    const old = _chatAt(mesId);
    if (!old) return old;
    const result = { ...old, ...updates };
    _carryStoreRef(old, result);
    chat[mesId] = result;
    return result;
}

/**
 * @param {number} mesId
 * @param {Record<string, unknown>} values
 */
export function setUnstoredExtra(mesId, values) {
    const old = _chatAt(mesId);
    if (!old) return;
    const wasClean = isAsStored(old);
    const updated = updateMessage(mesId, { extra: { ...(old.extra ?? {}), ...values } });
    if (wasClean && updated && old.node_id != null) markStoredAs(old.node_id, updated);
}

/**
 * @param {number} mesId
 * @param {(string|number)[]} path
 * @param {unknown|((node: unknown) => unknown)} value
 * @returns {ChatMessage|undefined}
 */
export function updateIn(mesId, path, value) {
    const old = _chatAt(mesId);
    if (!old) return old;

    /**
     * @param {any} node
     * @param {number} depth
     * @returns {any}
     */
    const rebuild = (node, depth) => {
        if (depth === path.length) {
            return typeof value === 'function' ? value(node) : value;
        }
        const key = path[depth];
        const src = (node === null || typeof node !== 'object') ? {} : node;
        const copy = Array.isArray(src) ? src.slice() : { ...src };
        copy[key] = rebuild(src[key], depth + 1);
        return copy;
    };

    const result = /** @type {ChatMessage} */ (rebuild(old, 0));
    _carryStoreRef(old, result);
    chat[mesId] = result;
    return result;
}


/** @type {Map<string|undefined, Promise<void>>} */
const _openingRowInFlight = new Map();

/** @typedef {SwipeInfo & {name?: string, is_user?: boolean}} SwipeInfoWithSpeaker */

/**
 * @typedef {object} OpeningAlternative
 * @property {string} mes
 * @property {string} [name]
 * @property {boolean} [is_user]
 * @property {MessageTimestamp} [send_date]
 * @property {ChatMessageExtra} [extra]
 * @property {string} [node_id]
 */

/**
 * @typedef {object} OpeningsResponse
 * @property {number} [total]
 * @property {number} [stored]
 * @property {number} [offset]
 * @property {number} [default_index]
 * @property {OpeningAlternative[]} [alternatives]
 */

// script.js - see .oxlint-cycle-baseline's own history for that precedent.
/**
 * @param {string} chatId
 * @param {string|null} [integrity]
 * @param {{group_id: string}|{avatar_url: string}|null} [owner]
 */
export function _setCurrentTarget(chatId, integrity = null, owner = null) {
    chat_metadata.integrity = integrity ?? undefined;
    if (owner) {
        if ('group_id' in owner) {
            groupsStore.update(owner.group_id, { chat_id: chatId });
        } else {
            charactersStore.update(owner.avatar_url, { chat: chatId });
        }
        return;
    }
    if (selected_group != null && selected_group !== '') {
        groupsStore.update(selected_group, { chat_id: chatId });
    } else {
        const avatar = getCurrentCharacter()?.avatar;
        if (avatar != null && avatar !== '') charactersStore.update(avatar, { chat: chatId });
    }
}

/**
 * @param {number} mesId
 * @returns {{ opening: { refs: string[], messages: object[] }, page_metadata?: object } | null}
 */
export function openingForRequest(mesId) {
    if (!isProvisionalNodeId(_chatAt(mesId)?.node_id)) return null;
    const inGroup = selected_group != null && selected_group !== '';
    const character = getCurrentCharacter();
    if (!inGroup && (character?.avatar == null || character.avatar === '')) return null;
    let from = mesId;
    let to = mesId + 1;
    if (inGroup) {
        from = 0;
        to = 0;
        while (to < chat.length && isProvisionalNodeId(_chatAt(to)?.node_id)) to++;
    }
    if (String(_chatAt(from)?.mes ?? '').trim() === '') return null;

    /** @type {string[]} */
    const refs = [];
    /** @type {object[]} */
    const messages = [];
    for (let i = from; i < to; i++) {
        const shown = _chatAt(i);
        let ref = storeRefOf(shown);
        if (ref === undefined) {
            ref = uuidv4();
            setStoreRef(shown, ref);
        }
        refs.push(ref);
        messages.push({
            name: shown.name ?? character?.name,
            is_user: shown.is_user === true,
            is_system: shown.is_system === true,
            send_date: shown.send_date ?? getMessageTimeStamp(),
            mes: shown.mes,
            extra: shown.extra ?? {},
        });
    }
    if (!inGroup) return { opening: { refs, messages } };
    const metadataRef = uuidv4();
    _openingMetadataRefs.add(metadataRef);
    return { opening: { refs, messages }, page_metadata: { ref: metadataRef, target: null, set: {}, unset: [] } };
}

/**
 * @param {number} [mesId]
 * @returns {Promise<string|null>}
 */
export async function ensureOpeningRow(mesId = 0) {
    const message = _chatAt(mesId);
    if (!message) return null;
    if (isStoredNodeId(message.node_id)) return message.node_id;

    const inGroup = selected_group != null && selected_group !== '';
    const provisional = inGroup ? _chatAt(0)?.node_id : message.node_id;
    let pending = _openingRowInFlight.get(provisional);
    if (!pending) {
        const request = openingForRequest(mesId);
        if (!request) return null;
        pending = (async () => {
            const response = await fetch('/api/chats/message/select', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(inGroup
                    ? { group_id: selected_group, ...request }
                    : { avatar_url: getCurrentCharacter()?.avatar, ...request }),
            });
            const answer = response.ok ? await response.json().catch(() => null) : null;
            adoptStored(answer?.stored);
            if (!inGroup) await takeOpenings(getCurrentCharacter()?.avatar, answer);
        })().finally(() => _openingRowInFlight.delete(provisional));
        _openingRowInFlight.set(provisional, pending);
    }

    try {
        await pending;
    } catch (error) {
        console.warn('[greetings] Could not give this greeting a row:', error);
        return null;
    }
    const stored = _chatAt(mesId)?.node_id;
    return isStoredNodeId(stored) ? stored : null;
}

/**
 * @param {string} text
 */
export async function rememberCardOpening(text) {
    const character = getCurrentCharacter();
    if ((selected_group != null && selected_group !== '') || character?.avatar == null || character.avatar === '' || typeof text !== 'string' || text.length === 0) return;
    const index = cardToGreetingsModel(character).greetings.indexOf(text);
    if (index < 0) return;
    try {
        const response = await fetch('/api/chats/openings/choose', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar, text, index }),
        });
        if (!response.ok) throw new Error(`/api/chats/openings/choose responded ${response.status}`);
        await takeOpenings(character.avatar, await response.json().catch(() => null));
    } catch (error) {
        console.warn('[greetings] Could not remember the chosen greeting:', error);
        toastr.warning(t`The chat couldn't remember the greeting you switched to, so reopening it will show the default greeting.`, t`Greeting not remembered`);
    }
}

/**
 * @param {string|null|undefined} avatar the character whose tree the openings are
 * @param {unknown} answer an answer carrying `openings` and `card_openings`
 * @param {{ render?: boolean }} [options]
 */
export async function takeOpenings(avatar, answer, { render = true } = {}) {
    if (!answer || typeof answer !== 'object' || !('openings' in answer)) return;
    if (selected_group != null && selected_group !== '') return;
    const character = getCurrentCharacter();
    if (character?.avatar == null || character.avatar === '' || character.avatar !== avatar) return;
    const state = /** @type {import('./opening-view.js').OpeningState} */ (answer);
    const view = openingView({ openings: state.openings, card_openings: state.card_openings ?? null }, {
        first: _chatAt(0),
        count: chat.length,
        speaker: character.name,
        sendDate: getMessageTimeStamp(),
        provisionalId: provisionalNodeId,
        isStored: isStoredNodeId,
        isProvisional: isProvisionalNodeId,
    });
    if (view.kind === 'keep') return;
    if (view.kind === 'clear') {
        forgetStored([chat[0].node_id]);
        chat.splice(0, chat.length);
        if (render) await redisplayChat();
        return;
    }
    if (view.kind === 'show') {
        chat.push(/** @type {ChatMessage} */ (view.message));
        markStoredAs(view.message.node_id, chat[0]);
        if (!render) return;
        await redisplayChat();
        await eventSource.emit(event_types.MESSAGE_RECEIVED, 0, 'first_message');
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, 0, 'first_message');
        return;
    }
    const current = /** @type {ChatMessage} */ (_chatAt(0));
    const wasClean = isAsStored(current);
    updateMessage(0, /** @type {Partial<ChatMessage>} */ (view.updates));
    const updated = /** @type {ChatMessage} */ (_chatAt(0));
    if (updated.node_id !== current.node_id) forgetStored([current.node_id]);
    if ((wasClean || view.shownChanged) && typeof updated.node_id === 'string' && updated.node_id !== '') markStoredAs(updated.node_id, updated);
    if (!render) return;
    if (view.shownChanged) updateMessageBlock(0, updated);
    refreshSwipeButtons(true);
}

/** @typedef {Error & {status: number}} HttpError */

/**
 * @param {unknown} error
 * @returns {error is HttpError}
 */
function _hasHttpStatus(error) {
    return error instanceof Error && typeof (/** @type {*} */ (error).status) === 'number';
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{attempts?: number, baseDelayMs?: number}} [options]
 * @returns {Promise<T>}
 */
async function _retryTransient(fn, { attempts = 3, baseDelayMs = 500 } = {}) {
    /** @type {unknown} */
    let lastError;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (_hasHttpStatus(error) && error.status >= 400 && error.status < 500) throw error;
            if (i < attempts - 1) {
                await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(2, i)));
            }
        }
    }
    throw lastError;
}

/** @returns {{group_id: string}|{avatar_url: string}|null} */
function _currentOwner() {
    if (selected_group != null && selected_group !== '') return { group_id: selected_group };
    const avatar = getCurrentCharacter()?.avatar;
    return avatar != null && avatar !== '' ? { avatar_url: avatar } : null;
}

let _lastChatOpFailureToastAt = 0;
function _reportChatOpFailure() {
    const now = Date.now();
    if (now - _lastChatOpFailureToastAt < 10_000) return;
    _lastChatOpFailureToastAt = now;
    toastr.error(t`Could not save your last change. Check your connection and try again.`, t`Save failed`);
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {boolean} [silent]
 * @returns {Promise<any>}
 */
async function _chatOpPost(path, body, silent = false) {
    const owner = _currentOwner();
    if (!owner) throw new Error('no character or group is selected');
    /** @type {any} */
    let answer;
    try {
        answer = await _retryTransient(async () => {
            const response = await fetch(path, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ ...owner, ...body }),
            });
            if (!response.ok) {
                const error = /** @type {HttpError} */ (new Error(`${path} responded ${response.status}`));
                error.status = response.status;
                throw error;
            }
            return response.json().catch(() => ({}));
        });
    } catch (error) {
        if (!silent) _reportChatOpFailure();
        throw error;
    }
    if ('avatar_url' in owner) await takeOpenings(owner.avatar_url, answer);
    return answer;
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {number[]} answered
 * @returns {Promise<any>}
 */
async function _chatOpPostAnswering(path, body, answered) {
    const owner = _currentOwner();
    if (!owner) throw new Error('no character or group is selected');
    /** @type {any} */
    let answer;
    try {
        answer = await _retryTransient(async () => {
            const response = await fetch(path, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ ...owner, ...body }),
            });
            if (!response.ok && !answered.includes(response.status)) {
                const error = /** @type {HttpError} */ (new Error(`${path} responded ${response.status}`));
                error.status = response.status;
                throw error;
            }
            return response.json().catch(() => ({}));
        });
    } catch (error) {
        _reportChatOpFailure();
        throw error;
    }
    if ('avatar_url' in owner) await takeOpenings(owner.avatar_url, answer);
    return answer;
}

/**
 * @param {number} mesId
 * @param {string|null|undefined} nodeId
 */
function _markMessageSaved(mesId, nodeId) {
    const live = mesId < chat.length ? chat[mesId] : null;
    if (live?.node_id != null && live.node_id !== '' && live.node_id === nodeId) {
        markStoredAs(live.node_id, live);
    }
}

/** @typedef {ChatMessage & {swipe_speaker_default?: {name?: string, is_user?: boolean}}} ChatMessageWithSpeakerDefault */

/**
 * @param {ChatMessageWithSpeakerDefault} msg
 * @param {string} [text]
 * @returns {Partial<ChatMessageWithSpeakerDefault>}
 */
function _messageContent(msg, text = msg.mes) {
    const content = { ...msg, mes: text };
    delete content.node_id;
    delete content.swipes;
    delete content.swipe_info;
    delete content.swipe_id;
    delete content.swipe_speaker_default;
    return content;
}

const DERIVED_EXTRA = ['branches', 'bookmark_link', ITEMIZED_PROMPT_FLAG, 'token_count', 'text_token_count'];

/**
 * @param {unknown} extra
 * @returns {Record<string, unknown>}
 */
function extraOf(extra) {
    const own = extra && typeof extra === 'object' && !Array.isArray(extra) ? { ...extra } : {};
    for (const key of DERIVED_EXTRA) delete own[key];
    return own;
}

/**
 * @param {ChatMessage} message
 * @returns {Record<string, any>}
 */
function contentOf(message) {
    /** @type {Record<string, any>} */
    const content = { ...message };
    for (const key of ['node_id', 'swipes', 'swipe_id', 'swipe_info', 'swipe_speaker_default']) delete content[key];
    if ('extra' in content) content.extra = extraOf(content.extra);
    return JSON.parse(JSON.stringify(content));
}

/**
 * @param {Record<string, any>} before
 * @param {Record<string, any>} now
 * @returns {{ patch: Record<string, any>, unset: string[] } | null}
 */
function patchOf(before, now) {
    /** @type {Record<string, any>} */
    const patch = {};
    /** @type {string[]} */
    const unset = [];
    const isMap = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const differ = (/** @type {Record<string, any>} */ a, /** @type {Record<string, any>} */ b, /** @type {string} */ prefix) => {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
            if (prefix === '' && key === 'extra' && isMap(a[key]) && isMap(b[key])) differ(a[key], b[key], 'extra.');
            else if (b[key] === undefined) unset.push(prefix + key);
            else patch[prefix + key] = b[key];
        }
    };
    differ(before, now, '');
    return Object.keys(patch).length > 0 || unset.length > 0 ? { patch, unset } : null;
}

/**
 * @param {ChatMessage} msg
 * @returns {{ node_id: string, patch?: Record<string, any>, unset?: string[], content?: Record<string, any> } | null}
 */
function _editOf(msg) {
    const nodeId = /** @type {string} */ (msg.node_id);
    const stored = _messageSnapshots.get(nodeId);
    if (stored === undefined) return { node_id: nodeId, content: _messageContent(msg) };
    const change = patchOf(contentOf(stored), contentOf(msg));
    return change === null ? null : { node_id: nodeId, ...change };
}

/**
 * @param {number} mesId
 */
function _refuseGenerating(mesId) {
    toastr.warning(t`Message #${mesId} is still being generated, so the change to it wasn't saved.`, t`Not saved yet`, { preventDuplicates: true });
}

/** @param {number} mesId */
export async function chatOpEdit(mesId) {
    if (isReplyGenerating(mesId)) {
        _refuseGenerating(mesId);
        return false;
    }
    const msg = _chatAt(mesId);
    if (isProvisionalNodeId(msg?.node_id)) {
        const inGroup = selected_group != null && selected_group !== '';
        const asCard = provisionalNodeId(msg.name, msg.mes);
        if (!inGroup && (msg.swipe_info ?? []).some(info => info.node_id === asCard)) {
            await rememberCardOpening(msg.mes);
            return true;
        }
        return isStoredNodeId(await ensureOpeningRow(mesId));
    }
    if (!isStoredNodeId(msg?.node_id)) return false;
    if (typeof msg.mes === 'string' && msg.mes.length === 0) return false;

    const edit = _editOf(msg);
    if (edit !== null) await _chatOpPost('/api/chats/message/edit', edit);
    _markMessageSaved(mesId, msg.node_id);
    return true;
}

/**
 * @param {ChatMessage|null|undefined} message
 * @returns {boolean}
 */
export function isComposedSlot(message) {
    if (!message || !Array.isArray(message.swipes) || message.node_id != null) return false;
    const slotNode = message.swipe_info?.[message.swipe_id ?? 0]?.node_id;
    return slotNode == null || slotNode === '';
}

/**
 * @param {number} mesId
 * @returns {Promise<string|null>}
 */
export async function chatOpStoreComposed(mesId) {
    const msg = _chatAt(mesId);
    if (!isComposedSlot(msg) || typeof msg.mes !== 'string' || msg.mes.length === 0) return null;

    /** @type {string|null} */
    let nodeId = null;
    if (mesId === 0) {
        updateMessage(0, { node_id: provisionalNodeId(msg.name, msg.mes) });
        nodeId = await ensureOpeningRow(0);
        if (nodeId === null) updateMessage(0, { node_id: undefined });
    } else {
        /** @type {string|null} */
        let after = null;
        for (let i = mesId - 1; i >= 0; i--) {
            if (isProvisionalNodeId(_chatAt(i)?.node_id)) await ensureOpeningRow(i);
            const id = _chatAt(i)?.node_id;
            if (isStoredNodeId(id)) { after = id; break; }
        }
        if (after === null) return null;
        const result = await _chatOpPost('/api/chats/message/append', { after_node_id: after, messages: [_messageContent(msg)], send_keys: [null] });
        nodeId = result.node_ids?.[0] ?? null;
        if (isStoredNodeId(nodeId)) updateMessage(mesId, { node_id: nodeId });
    }
    if (!isStoredNodeId(nodeId)) return null;

    const stored = /** @type {ChatMessage} */ (_chatAt(mesId));
    const at = stored.swipe_id ?? 0;
    const swipeInfo = [...(stored.swipe_info ?? [])];
    swipeInfo[at] = { ...(swipeInfo[at] ?? {}), node_id: nodeId };
    updateMessage(mesId, { swipe_info: swipeInfo });
    _markMessageSaved(mesId, nodeId);
    return nodeId;
}

/**
 * @param {number[]} mesIds
 * @param {boolean} [silent]
 */
export async function chatOpEditMany(mesIds, silent = false) {
    for (const mesId of mesIds) {
        if (isProvisionalNodeId(_chatAt(mesId)?.node_id)) await ensureOpeningRow(mesId);
    }

    /** @type {{node_id: string, content: Partial<ChatMessageWithSpeakerDefault>, _mesId: number}[]} */
    const edits = [];
    for (const mesId of mesIds) {
        if (isReplyGenerating(mesId)) {
            _refuseGenerating(mesId);
            continue;
        }
        const msg = _chatAt(mesId);
        if (!isStoredNodeId(msg?.node_id)) continue;
        if (typeof msg.mes === 'string' && msg.mes.length === 0) continue;
        const edit = _editOf(msg);
        if (edit !== null) edits.push({ ...edit, _mesId: mesId });
    }
    if (!edits.length) return 0;

    const result = await _chatOpPost('/api/chats/message/edit-batch', {
        edits: edits.map(({ _mesId, ...edit }) => edit),
    }, silent);

    const refused = new Set((result.refused ?? []).map((/** @type {any} */ r) => r.node_id));
    for (const edit of edits) {
        if (!refused.has(edit.node_id)) _markMessageSaved(edit._mesId, edit.node_id);
    }
    if (refused.size) {
        console.warn('[chat] Some messages were not changed:', result.refused);
    }
    return result.applied ?? 0;
}

/**
 * @param {number} fromIndex
 * @param {number} [toIndex]
 * @param {{ silent?: boolean }} [options]
 * @returns {Promise<string[]>}
 */
export async function chatOpAppend(fromIndex, toIndex = chat.length, { silent = false } = {}) {
    /** @type {string|null} */
    let after = null;
    for (let i = fromIndex - 1; i >= 0; i--) {
        if (isProvisionalNodeId(_chatAt(i)?.node_id)) await ensureOpeningRow(i);
        const nodeId = _chatAt(i)?.node_id;
        if (isStoredNodeId(nodeId)) { after = nodeId; break; }
    }
    if (after == null || after === '') return [];

    return (await chatOpAppendAfter(after, fromIndex, toIndex, { silent })).node_ids;
}

/**
 * @param {string} after
 * @param {number} fromIndex
 * @param {number} [toIndex]
 * @param {{ silent?: boolean }} [options]
 * @returns {Promise<{ node_ids: string[], already_stored: string[] }>}
 */
export async function chatOpAppendAfter(after, fromIndex, toIndex = chat.length, { silent = false } = {}) {
    const messages = chat.slice(fromIndex, toIndex);
    const sendKeys = messages.map(message => storeRefOf(message) ?? null);
    const result = await _chatOpPost('/api/chats/message/append', {
        after_node_id: after,
        messages,
        send_keys: sendKeys,
    }, silent);
    /** @type {string[]} */
    const ids = result.node_ids ?? [];
    ids.forEach((node_id, offset) => {
        const index = fromIndex + offset;
        if (index < chat.length) updateMessage(index, { node_id });
        _markMessageSaved(index, node_id);
        const sendKey = sendKeys[offset];
        if (sendKey != null) _sendStoredListener(sendKey);
    });
    return { node_ids: ids, already_stored: result.already_stored ?? [] };
}

/**
 * @param {number} mesId
 * @param {{ silent?: boolean }} [options]
 * @returns {Promise<string|null>}
 */
export async function chatOpGraft(mesId, { silent = false } = {}) {
    const msg = _chatAt(mesId);
    if (!msg) return null;
    if (mesId + 1 >= chat.length) return (await chatOpAppend(mesId, undefined, { silent }))[0] ?? null;

    /** @type {string|null} */
    let after = null;
    for (let i = mesId - 1; i >= 0; i--) {
        if (isProvisionalNodeId(_chatAt(i)?.node_id)) await ensureOpeningRow(i);
        const nodeId = _chatAt(i)?.node_id;
        if (isStoredNodeId(nodeId)) { after = nodeId; break; }
    }
    if (after == null || after === '') return null;

    const before = _chatAt(mesId + 1)?.node_id;
    if (!isStoredNodeId(before)) return null;

    const sendKey = storeRefOf(msg);
    const result = await _chatOpPost('/api/chats/message/graft', {
        after_node_id: after,
        before_node_id: before,
        content: _messageContent(msg),
        send_key: sendKey,
    }, silent);
    updateMessage(mesId, { node_id: result.node_id });
    _markMessageSaved(mesId, result.node_id);
    if (sendKey !== undefined) _sendStoredListener(sendKey);
    return result.node_id;
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {boolean} ask
 * @returns {Promise<EditTicket | null>}
 */
async function _editConfirm(path, body, ask) {
    const preview = await _chatOpPost(path, { ...body, preview: true });
    const drops = preview?.drops ?? { bookmarks: [], changes: [] };
    if (hasDrops(drops) && ask && !await askToDrop(drops, t)) return null;
    return { confirm: confirmOf(drops), drops };
}

/**
 * @typedef {object} EditTicket
 * @property {{ bookmarks: string[], changes: string[] }} confirm
 * @property {import('./edit-drops.js').Drops} drops
 */

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {EditTicket} ticket
 * @param {boolean} ask
 * @returns {Promise<any | null>}
 */
async function _applyConfirmed(path, body, ticket, ask) {
    let { confirm, drops } = ticket;
    for (;;) {
        const answer = await _chatOpPostAnswering(path, { ...body, confirm }, [409]);
        if (answer?.ok !== false) {
            if (!ask && hasDrops(drops)) warnDropped(drops, t);
            return answer;
        }
        if (answer.reason !== 'confirm' || !answer.drops) {
            _reportChatOpFailure();
            throw new Error(`${path} was refused: ${answer.reason}`);
        }
        drops = answer.drops;
        if (ask && !await askToDrop(drops, t)) return null;
        confirm = confirmOf(drops);
    }
}

/**
 * @param {number} firstMesId
 * @param {number} lastMesId
 * @param {{ ask?: boolean }} [options]
 * @returns {Promise<boolean | null>}
 */
export async function chatOpCut(firstMesId, lastMesId, { ask = false } = {}) {
    let from = firstMesId;
    let to = lastMesId;
    while (from <= to && !isStoredNodeId(_chatAt(from)?.node_id)) from++;
    while (to >= from && !isStoredNodeId(_chatAt(to)?.node_id)) to--;
    if (from > to) return null;
    const first = _chatAt(from)?.node_id;
    const last = _chatAt(to)?.node_id;
    const body = { first_node_id: first, last_node_id: last };
    const ticket = await _editConfirm('/api/chats/message/cut', body, ask);
    if (!ticket) return false;
    const answer = await _applyConfirmed('/api/chats/message/cut', body, ticket, ask);
    if (!answer) return false;
    forgetStored(chat.slice(from, to + 1).map(m => m.node_id));
    _takeCopies(answer.copied, to + 1);
    return true;
}

/**
 * @param {unknown} copied
 * @param {number} from
 */
function _takeCopies(copied, from) {
    if (!copied || typeof copied !== 'object') return;
    const copies = /** @type {Record<string, unknown>} */ (copied);
    for (let i = from; i < chat.length; i++) {
        const old = chat[i]?.node_id;
        const copy = old == null ? undefined : copies[old];
        if (typeof copy !== 'string' || old == null) continue;
        const stored = _messageSnapshots.get(old);
        /** @type {Partial<ChatMessage>} */
        const updates = { node_id: copy };
        const at = chat[i].swipe_id ?? 0;
        if (Array.isArray(chat[i].swipe_info) && chat[i].swipe_info[at]?.node_id === old) {
            const swipeInfo = [...chat[i].swipe_info];
            swipeInfo[at] = { ...swipeInfo[at], node_id: copy };
            updates.swipe_info = swipeInfo;
        }
        updateMessage(i, updates);
        forgetStored([old]);
        if (stored !== undefined) {
            const storedInfo = Array.isArray(stored.swipe_info) ? [...stored.swipe_info] : undefined;
            if (storedInfo && storedInfo[at]?.node_id === old) storedInfo[at] = { ...storedInfo[at], node_id: copy };
            markStoredAs(copy, { ...stored, node_id: copy, ...(storedInfo ? { swipe_info: storedInfo } : {}) });
        }
    }
}

/**
 * @param {{ node_id: string, patch?: Record<string, unknown>, unset?: string[] }[]} edits
 * @returns {Promise<{ node_id: string, reason: string }[]>}
 */
export async function chatOpPatch(edits) {
    if (!edits.length) return [];
    const answer = await _chatOpPostAnswering('/api/chats/message/edit-batch', { edits }, [409]);
    return Array.isArray(answer?.refused) ? answer.refused : [];
}

/**
 * @param {number} mesId
 * @param {string} text
 * @returns {Promise<string|null>}
 */
export async function chatOpAddAlternative(mesId, text) {
    const msg = _chatAt(mesId);
    if (typeof text !== 'string' || !text.length) return null;
    if (mesId === 0 && msg && !isStoredNodeId(msg.node_id) && _currentOwner()) {
        const created = await _chatOpPost('/api/chats/message/alternative', { opening: true, contents: [_messageContent(msg, text)] });
        return created?.node_ids?.[0] ?? null;
    }
    if (!isStoredNodeId(msg?.node_id)) return null;

    const created = await _chatOpPost('/api/chats/message/alternative', {
        sibling_node_id: msg.node_id,
        contents: [_messageContent(msg, text)],
    });
    return created?.node_ids?.[0] ?? null;
}

/**
 * @param {string|null|undefined} nodeId
 * @param {{ ask?: boolean }} [options]
 * @returns {Promise<EditTicket | null>}
 */
export async function chatOpReadyAlternativeDelete(nodeId, { ask = false } = {}) {
    if (!isStoredNodeId(nodeId)) return null;
    return _editConfirm('/api/chats/message/alternative/delete', { node_id: nodeId }, ask);
}

/**
 * @param {string|null|undefined} nodeId
 * @param {string|null|undefined} currentNodeId
 * @param {EditTicket} ticket
 * @param {{ ask?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function chatOpDeleteAlternativeNode(nodeId, currentNodeId, ticket, { ask = false } = {}) {
    if (nodeId === currentNodeId || !isStoredNodeId(nodeId)) return false;
    return !!await _applyConfirmed('/api/chats/message/alternative/delete', { node_id: nodeId }, ticket, ask);
}
