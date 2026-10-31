import { cardToGreetingsModel, getCurrentCharacter, getCurrentChatId, isStoredNodeId, isProvisionalNodeId, provisionalNodeId, redisplayChat, updateViewMessageIds, refreshSwipeButtons, updateMessageBlock, _messageSnapshots, markStoredAs, isAsStored, forgetStored, isReplyGenerating } from '../script.js';
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

/** @type {(entry: { ref: string, node_id: string, integrity: string|null, notSaved?: true }) => void} */
let _metadataStoredListener = () => {};
let _stateChangedListener = () => {};

let _globalVariablesListener = (/** @type {{ set: Record<string, unknown>, unset: string[] }} */ _changes) => {};

/**
 * @param {(changes: { set: Record<string, unknown>, unset: string[] }) => void} listener
 */
export function setGlobalVariablesListener(listener) {
    _globalVariablesListener = listener;
}

/**
 * @param {() => void} listener
 */
export function setStateChangedListener(listener) {
    _stateChangedListener = listener;
}

const _openingMetadataRefs = new Set();

/**
 * @param {(entry: { ref: string, node_id: string, integrity: string|null, notSaved?: true }) => void} listener
 */
export function setMetadataStoredListener(listener) {
    _metadataStoredListener = listener;
}

/**
 * @param {unknown} stored
 */
export function adoptStored(stored) {
    if (!Array.isArray(stored)) return;
    let stateChanged = false;
    for (const entry of stored) {
        if (typeof entry?.ref !== 'string') continue;
        if (entry.state_changed === true) {
            stateChanged = true;
            continue;
        }
        if (entry.global_variables && typeof entry.global_variables === 'object') {
            _globalVariablesListener(entry.global_variables);
            continue;
        }
        if (entry.metadata_not_saved === true) {
            _openingMetadataRefs.delete(entry.ref);
            _metadataStoredListener({ ref: entry.ref, node_id: typeof entry.node_id === 'string' ? entry.node_id : '', integrity: null, notSaved: true });
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
    if (stateChanged) _stateChangedListener();
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
 * @property {string|null} [default_node_id]
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
                    : { avatar_url: getCurrentCharacter()?.avatar, ...request, activate: true }),
            });
            const answer = response.ok ? await response.json().catch(() => null) : null;
            adoptStored(answer?.stored);
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
    } catch (error) {
        console.warn('[greetings] Could not remember the chosen greeting:', error);
        toastr.warning(t`The chat couldn't remember the greeting you switched to, so reopening it will show the default greeting.`, t`Greeting not remembered`);
    }
}

/**
 * @param {object} [options]
 * @param {{from: string, to: string, index?: number}|null} [options.greetingEdit]
 * @param {{from: string, to: string, index?: number}[]} [options.greetingEdits]
 * @param {{ openings: OpeningsResponse|null, card_openings: OpeningsResponse|null }|null} [options.openings]
 */
export async function _mergeCardGreetingsIntoOpening({ greetingEdit = null, greetingEdits, openings = null } = {}) {
    const edits = Array.isArray(greetingEdits) ? greetingEdits : (greetingEdit ? [greetingEdit] : []);
    const opening = _chatAt(0);
    const character = getCurrentCharacter();
    if (opening?.node_id == null || opening.node_id === '' || character?.avatar == null || character.avatar === '') return;
    const speaker = character.name;

    /**
     * @param {{offset?: number, limit?: number, around?: object}} body
     * @returns {Promise<OpeningsResponse|null>}
     */
    const ask = async (body) => {
        if (openings) return body.offset === undefined ? openings.openings : openings.card_openings;
        try {
            const response = await fetch('/api/chats/openings', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: character.avatar, ...body }),
            });
            return response.ok ? await response.json().catch(() => null) : null;
        } catch (error) {
            console.warn('[greetings] Could not read openings:', error);
            return null;
        }
    };

    const head = await ask({});
    if (!head) return;
    const storedCount = head.stored ?? 0;
    const total = head.total ?? 0;

    const cardOnlyCount = total - storedCount;
    const tail = cardOnlyCount > 0 ? await ask({ offset: storedCount, limit: cardOnlyCount }) : null;
    if (cardOnlyCount > 0 && !tail) return;

    const current = _chatAt(0);
    if (current?.node_id == null || current.node_id === '' || current.node_id !== opening.node_id) return;

    /** @type {(string|null)[]} */
    const keptSwipes = new Array(total).fill(null);
    /** @type {(SwipeInfoWithSpeaker|null)[]} */
    const keptInfo = new Array(total).fill(null);
    /**
     * @param {OpeningsResponse|null} window
     * @param {number} start
     */
    const place = (window, start) => (window?.alternatives ?? []).forEach((alt, k) => {
        const at = start + k;
        if (at < 0 || at >= total) return;
        keptSwipes[at] = alt.mes;
        keptInfo[at] = {
            send_date: alt.send_date, extra: alt.extra ?? {},
            name: alt.name, is_user: alt.is_user,
            node_id: alt.node_id != null && alt.node_id !== '' ? alt.node_id : provisionalNodeId(alt.name ?? speaker, alt.mes),
        };
    });
    place(head, head.offset ?? 0);
    place(tail, tail?.offset ?? storedCount);

    const swipes = Array.isArray(current.swipes) ? current.swipes : [current.mes ?? ''];
    const shownWas = current.swipe_id ?? 0;
    const shownText = Array.isArray(current.swipes) ? current.swipes[shownWas] : current.mes;
    if (isStoredNodeId(current.node_id) && !openings && !keptInfo.some(info => info?.node_id === current.node_id)) {
        const around = await ask({ around: { name: current.name, is_user: current.is_user, mes: current.mes } });
        if (around) place(around, around.offset ?? 0);
        if (_chatAt(0) !== current) return;
    }
    const shownAt = isStoredNodeId(current.node_id)
        ? keptInfo.findIndex(info => info?.node_id === current.node_id)
        : (typeof shownText === 'string' ? keptSwipes.indexOf(shownText) : -1);

    const unchanged = keptSwipes.length === swipes.length
        && keptSwipes.every((x, k) => x === swipes[k])
        && keptInfo.every((info, k) => (info?.node_id ?? null) === (current.swipe_info?.[k]?.node_id ?? null))
        && shownAt === shownWas;
    if (unchanged) return;

    /**
     * @param {OpeningAlternative} alt
     * @param {number} serverIndex
     * @returns {number}
     */
    const placeOpening = (alt, serverIndex) => {
        if (!isStoredNodeId(alt.node_id)) return keptSwipes.indexOf(alt.mes);
        if (serverIndex >= storedCount) return -1;
        if (typeof keptSwipes[serverIndex] !== 'string') {
            keptSwipes[serverIndex] = alt.mes;
            keptInfo[serverIndex] = {
                send_date: alt.send_date, extra: alt.extra ?? {},
                name: alt.name, is_user: alt.is_user,
                node_id: alt.node_id,
            };
        }
        return keptSwipes[serverIndex] === alt.mes ? serverIndex : -1;
    };

    const placeDefault = () => {
        const alternatives = head.alternatives ?? [];
        let k = head.default_chosen === true ? (head.default_index ?? -1) - (head.offset ?? 0) : -1;
        if (k >= alternatives.length) k = -1;
        if (k < 0) k = alternatives.findIndex(a => isStoredNodeId(a.node_id) && a.node_id === head.default_node_id);
        if (k < 0) {
            const { greetings, defaultIndex } = cardToGreetingsModel(character);
            const preferredText = greetings.filter(text => typeof text === 'string' && text.length > 0)[defaultIndex ?? 0];
            k = alternatives.findIndex(a => a.mes === preferredText);
        }
        if (k < 0) k = 0;
        return k < alternatives.length ? placeOpening(alternatives[k], (head.offset ?? 0) + k) : -1;
    };

    /**
     * @returns {Promise<number|null>}
     */
    const placeLanding = async () => {
        try {
            const response = await fetch('/api/chats/openings/land', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: character.avatar, shown_text: shownText, index: shownWas, edits }),
            });
            const landing = response.ok ? await response.json().catch(() => null) : null;
            if (!landing) {
                console.warn('[greetings] Could not find where the chat lands:', response.status);
                return null;
            }
            if (!landing.opening) return -1;
            const at = placeOpening(landing.opening, landing.index);
            return at >= 0 ? at : null;
        } catch (error) {
            console.warn('[greetings] Could not find where the chat lands:', error);
            return null;
        }
    };

    let landAt = shownAt;
    if (shownAt < 0 && !isStoredNodeId(current.node_id)) {
        const landing = await placeLanding();
        if (landing === null) {
            toastr.warning(t`The chat couldn't follow the greeting change, so it shows the greeting it would open on.`, t`Greeting not followed`);
        }
        landAt = landing ?? -1;
        if (landAt < 0) landAt = placeDefault();
        if (_chatAt(0) !== current) return;
    }

    if (landAt < 0 && !isStoredNodeId(current.node_id)) {
        if ((head.total ?? 0) > 0) return;
        forgetStored([current.node_id]);
        chat.splice(0, chat.length);
        await redisplayChat();
        return;
    }

    /** @type {Partial<ChatMessage>} */
    const updates = { swipes: keptSwipes, swipe_info: /** @type {SwipeInfo[]} */ (keptInfo) };
    if (landAt >= 0) {
        updates.swipe_id = landAt;
        if (landAt !== shownAt) {
            const info = keptInfo[landAt];
            updates.mes = keptSwipes[landAt];
            updates.name = info?.name ?? speaker;
            updates.is_user = info?.is_user === true;
            updates.send_date = info?.send_date ?? current.send_date;
            updates.extra = info?.extra ?? {};
            updates.node_id = info?.node_id ?? provisionalNodeId(updates.name, updates.mes);
        }
    }

    const wasClean = isAsStored(current);
    updateMessage(0, updates);
    if (updates.node_id != null && updates.node_id !== current.node_id) {
        forgetStored([current.node_id]);
    }
    const updated = _chatAt(0);
    if ((wasClean || updates.node_id != null) && updated?.node_id != null && updated.node_id !== '') {
        markStoredAs(updated.node_id, updated);
    }
    if (updates.mes !== undefined && updated) {
        updateMessageBlock(0, updated);
    }
    refreshSwipeButtons(true);
}

/**
 * @param {number} mesId
 * @param {{redraw?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
export async function _restoreContinuation(mesId, { redraw = true } = {}) {
    const message = _chatAt(mesId);
    if (!isStoredNodeId(message?.node_id)) return false;

    let payload;
    try {
        const response = await fetch('/api/chats/message/select', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ node_id: message.node_id, chat_name: getCurrentChatId() }),
        });
        if (!response.ok) return false;
        payload = await response.json();
    } catch (error) {
        console.warn('[restore] Could not fetch what follows:', error);
        return false;
    }

    await _takeStateFrom(payload);
    const following = payload?.messages ?? [];
    if (!following.length && chat.length === mesId + 1) return false;

    const replaced = chat.splice(mesId + 1, chat.length - (mesId + 1), ...following);
    forgetStored(replaced.map(m => m.node_id));
    for (const m of following) if (isStoredNodeId(m?.node_id)) markStoredAs(m.node_id, m);
    if (redraw) {
        await redisplayChat({ startIndex: mesId });
        updateViewMessageIds();
        refreshSwipeButtons(true);
    }
    return true;
}

/**
 * @param {{ chat_metadata?: ChatMetadata } | null | undefined} answer
 */
async function _takeStateFrom(answer) {
    if (!answer?.chat_metadata) return;
    const { takeServerState } = await import('./metadata-store.js');
    takeServerState(answer.chat_metadata);
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

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{attempts?: number, baseDelayMs?: number}} [options]
 * @returns {Promise<T>}
 */
export async function retryTransient(fn, options) {
    return _retryTransient(fn, options);
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
    try {
        return await _retryTransient(async () => {
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
    try {
        return await _retryTransient(async () => {
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
}

/**
 * @param {number} mesId
 * @param {string|null|undefined} nodeId
 */
export function _markMessageSaved(mesId, nodeId) {
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

const DERIVED_EXTRA = ['branches', 'bookmark_link', ITEMIZED_PROMPT_FLAG, 'token_count'];

/**
 * @param {unknown} extra
 * @returns {Record<string, unknown>}
 */
export function extraOf(extra) {
    const own = extra && typeof extra === 'object' && !Array.isArray(extra) ? { ...extra } : {};
    for (const key of DERIVED_EXTRA) delete own[key];
    return own;
}

/**
 * @param {ChatMessage} message
 * @returns {Record<string, any>}
 */
export function contentOf(message) {
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
export function patchOf(before, now) {
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
        if (!isStoredNodeId(await ensureOpeningRow(mesId))) return false;
        await _mergeCardGreetingsIntoOpening();
        return true;
    }
    if (!isStoredNodeId(msg?.node_id)) return false;
    if (typeof msg.mes === 'string' && msg.mes.length === 0) return false;

    const edit = _editOf(msg);
    if (edit !== null) await _chatOpPost('/api/chats/message/edit', edit);
    _markMessageSaved(mesId, msg.node_id);
    if (mesId === 0 && (selected_group == null || selected_group === '')) await _mergeCardGreetingsIntoOpening();
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
    if (mesId === 0 && (selected_group == null || selected_group === '')) await _mergeCardGreetingsIntoOpening();
    return nodeId;
}

/**
 * @param {number[]} mesIds
 * @param {boolean} [silent]
 */
export async function chatOpEditMany(mesIds, silent = false) {
    let ensuredOpening = false;
    for (const mesId of mesIds) {
        if (!isProvisionalNodeId(_chatAt(mesId)?.node_id)) continue;
        if (isStoredNodeId(await ensureOpeningRow(mesId))) ensuredOpening = true;
    }
    if (ensuredOpening) await _mergeCardGreetingsIntoOpening();

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
 * @param {string[]} nodeIds
 * @returns {Promise<{ not_on_path: string[], refused: { node_id: string, reason: string }[] }>}
 */
export async function chatOpCutNamed(nodeIds) {
    const answer = await _chatOpPostAnswering('/api/chats/message/cut-many', { node_ids: nodeIds }, [409]);
    if (answer?.drops && hasDrops(answer.drops)) warnDropped(answer.drops, t);
    forgetStored(nodeIds);
    _takeCopies(answer?.copied, 0);
    return {
        not_on_path: Array.isArray(answer?.not_on_path) ? answer.not_on_path : [],
        refused: Array.isArray(answer?.refused) ? answer.refused : [],
    };
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
 * @param {string} siblingNodeId
 * @param {Record<string, unknown>} content
 * @returns {Promise<string|null>}
 */
export async function chatOpAddAlternativeBeside(siblingNodeId, content) {
    const created = await _chatOpPost('/api/chats/message/alternative', { sibling_node_id: siblingNodeId, contents: [content] });
    return created?.node_ids?.[0] ?? null;
}

/**
 * @param {string} nodeId
 * @param {string} label
 * @returns {Promise<string|null>}
 */
export async function chatOpBookmarkNode(nodeId, label) {
    const answer = await _chatOpPostAnswering('/api/chats/bookmark', { node_id: nodeId, label }, [409]);
    return answer?.ok === true && typeof answer.id === 'string' ? answer.id : null;
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
 * @param {number} mesId
 * @param {number} swipeId
 */
export async function chatOpSelect(mesId, swipeId) {
    const msg = _chatAt(mesId);
    const nodeId = msg?.swipe_info?.[swipeId]?.node_id;
    if (!isStoredNodeId(nodeId) || msg == null) return false;

    await _takeStateFrom(await _chatOpPost('/api/chats/message/select', { node_id: nodeId }));
    if (msg.node_id !== nodeId) updateMessage(mesId, { node_id: nodeId });
    _markMessageSaved(mesId, nodeId);
    return true;
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
