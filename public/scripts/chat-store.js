import { getCurrentCharacter, getCurrentChatId, isStoredNodeId, isProvisionalNodeId, unstoredGreetingNodeId, composedOpeningNodeId, redisplayChat, refreshSwipeButtons, showMessageCount, updateMessageBlock, updateViewMessageIds, _messageSnapshots, markStoredAs, isAsStored, forgetStored, isReplyGenerating } from '../script.js';
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
import { countedTextHash } from './counted-text.js';
import { arriveChatBox, chatBoxFollowCut, chatBoxLeft, moveChatBox } from './chat-box.js';
import { takeChatLinks } from './chat-links.js';

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
        if (entry.openings && openingsOwnerOf(entry)) {
            void takeOpenings(openingsOwnerOf(entry), entry.openings);
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
                _adoptOpeningRow(i, entry.node_id, _openingsSent.get(entry.ref));
                _openingsSent.delete(entry.ref);
            } else {
                if (chat[i].node_id !== entry.node_id) updateMessage(i, { node_id: entry.node_id });
                _markMessageSaved(i, entry.node_id);
            }
            _waitForCounts([i]);
            break;
        }
    }
}

/**
 * @param {number} mesId
 * @param {string} realId
 * @param {ChatMessage} [sent] the message as its opening request sent it; what the page changed since is not stored yet
 */
function _adoptOpeningRow(mesId, realId, sent) {
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
    const adopted = /** @type {Record<string, unknown>} */ (chat[mesId]);
    markStoredAs(realId, sent === undefined ? adopted : { ...sent, ...Object.fromEntries(PLACE_KEYS.filter(key => key in adopted).map(key => [key, adopted[key]])) });
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

/** @typedef {(nodeId: unknown, extra: Record<string, any>, text: string) => Record<string, any> | null} CountChange */

/**
 * @param {CountChange} change the message's or alternative's new extra; null leaves it
 * @param {number[]} [mesIds] all when not given
 */
function _changeCounts(change, mesIds) {
    for (const mesId of mesIds ?? chat.keys()) {
        const old = _chatAt(mesId);
        if (!old) continue;
        /** @type {Partial<ChatMessage>} */
        const updates = {};
        const own = change(old.node_id, old.extra ?? {}, old.mes);
        if (own) updates.extra = own;
        const infos = /** @type {any[] | undefined} */ (old.swipe_info);
        if (Array.isArray(infos)) {
            const changed = infos.map((info, k) => (info && typeof old.swipes?.[k] === 'string' ? change(info.node_id, info.extra ?? {}, old.swipes[k]) : null));
            if (changed.some(Boolean)) updates.swipe_info = infos.map((info, k) => (changed[k] ? { ...info, extra: changed[k] } : info));
        }
        if (!Object.keys(updates).length) continue;
        const wasClean = isAsStored(old);
        const updated = updateMessage(mesId, updates);
        if (wasClean && updated && typeof old.node_id === 'string') markStoredAs(old.node_id, updated);
        if (updated) showMessageCount(mesId, updated);
    }
}

/**
 * @param {Record<string, any>|undefined} extra
 * @param {unknown} text
 * @returns {boolean} whether the count it holds is the count of this text
 */
export function hasCountOf(extra, text) {
    return typeof extra?.token_count === 'number' && extra.token_count_hash === countedTextHash(extra, text);
}

/**
 * @param {Record<string, any>} extra
 * @param {{ count: number, hash: number, key?: string }} counted
 */
function _counted(extra, { count, hash, key }) {
    const next = { ...extra, token_count: count, token_count_hash: hash, ...(typeof key === 'string' ? { token_count_key: key } : {}) };
    if (typeof key !== 'string') delete next.token_count_key;
    delete next.token_count_waiting;
    return next;
}

/**
 * @param {Record<string, any>} extra
 * @param {string} key
 */
function _waiting(extra, key) {
    const next = { ...extra, token_count_waiting: key };
    delete next.token_count;
    delete next.token_count_hash;
    delete next.token_count_key;
    return next;
}

/**
 * @param {unknown} records counts or waits for counts, by node, as an answer carries them
 */
export function takeMessageCounts(records) {
    if (!records || typeof records !== 'object') return;
    const byNode = /** @type {Record<string, any>} */ (records);
    _changeCounts((nodeId, extra, text) => {
        const record = typeof nodeId === 'string' && Object.hasOwn(byNode, nodeId) ? byNode[nodeId] : null;
        if (!record || typeof record !== 'object') return null;
        if (typeof record.count === 'number') return record.hash === countedTextHash(extra, text) ? _counted(extra, record) : null;
        if (typeof record.waiting !== 'string') return null;
        const arrived = hasCountOf(extra, text) && extra.token_count_key === record.waiting;
        return arrived || extra.token_count_waiting === record.waiting ? null : _waiting(extra, record.waiting);
    });
    claimPushedCounts();
}

/**
 * Takes the values of the macros messages draw, as an answer carries them, and draws those messages again where
 * they changed
 * @param {unknown} records the values, by node: each macro's source to its value
 */
export function takeMessageMacros(records) {
    if (!records || typeof records !== 'object') return;
    const byNode = /** @type {Record<string, Record<string, string | null>>} */ (records);
    const take = (/** @type {unknown} */ nodeId, /** @type {Record<string, any>} */ extra) => {
        const values = typeof nodeId === 'string' && Object.hasOwn(byNode, nodeId) ? byNode[nodeId] : null;
        if (!values || typeof values !== 'object' || JSON.stringify(values) === JSON.stringify(extra.macro_values)) return null;
        return { ...extra, macro_values: values };
    };
    for (const mesId of chat.keys()) {
        const old = _chatAt(mesId);
        if (!old) continue;
        /** @type {Partial<ChatMessage>} */
        const updates = {};
        const own = take(old.node_id, old.extra ?? {});
        if (own) updates.extra = own;
        const infos = /** @type {any[] | undefined} */ (old.swipe_info);
        if (Array.isArray(infos)) {
            const changed = infos.map(info => (info ? take(info.node_id, info.extra ?? {}) : null));
            if (changed.some(Boolean)) updates.swipe_info = infos.map((info, k) => (changed[k] ? { ...info, extra: changed[k] } : info));
        }
        if (!Object.keys(updates).length) continue;
        const wasClean = isAsStored(old);
        const updated = updateMessage(mesId, updates);
        if (wasClean && updated && typeof old.node_id === 'string') markStoredAs(old.node_id, updated);
        if (updated && own) updateMessageBlock(mesId, updated);
    }
}

const UNCLAIMED_COUNTS_MAX = 1000;
/** @type {Map<string, { node_id: string, hash: number, key: string, count: number }>} */
const _unclaimedCounts = new Map();

/**
 * A push can come before the answer that tells the page which node it is for: it waits here until a message
 * waits for it.
 * @param {unknown} pushed counts the server pushes, each for a node's text as one tokenizer counted it
 */
export function takePushedMessageCounts(pushed) {
    if (!Array.isArray(pushed)) return;
    for (const push of pushed) {
        if (typeof push?.node_id !== 'string' || typeof push.count !== 'number') continue;
        _unclaimedCounts.delete(push.node_id);
        _unclaimedCounts.set(push.node_id, push);
    }
    while (_unclaimedCounts.size > UNCLAIMED_COUNTS_MAX) _unclaimedCounts.delete(/** @type {string} */ (_unclaimedCounts.keys().next().value));
    claimPushedCounts();
}

export function claimPushedCounts() {
    if (!_unclaimedCounts.size) return;
    _changeCounts((nodeId, extra, text) => {
        const push = typeof nodeId === 'string' ? _unclaimedCounts.get(nodeId) : undefined;
        const waiting = extra.token_count_waiting;
        if (!push || (waiting !== true && waiting !== push.key) || push.hash !== countedTextHash(extra, text)) return null;
        _unclaimedCounts.delete(push.node_id);
        return _counted(extra, push);
    });
}

/**
 * @param {number[]} mesIds
 */
function _waitForCounts(mesIds) {
    const nodes = new Set(mesIds.map(mesId => _chatAt(mesId)?.node_id));
    _changeCounts((nodeId, extra, text) => (nodes.has(nodeId) && extra.token_count_waiting !== true && !hasCountOf(extra, text) ? { ...extra, token_count_waiting: true } : null), mesIds);
    claimPushedCounts();
}

/**
 * @param {number[]} mesIds
 * @param {{ failed?: boolean }} [options] failed: the text shown is not stored, so no count is coming for it
 */
function _stopWaitingHere(mesIds, { failed = false } = {}) {
    _changeCounts((_nodeId, extra) => {
        if (extra.token_count_waiting !== true && !(failed && extra.token_count_waiting)) return null;
        const next = { ...extra };
        delete next.token_count_waiting;
        return next;
    }, mesIds);
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


/** @type {Map<string|undefined, { done: Promise<'answered' | 'shown' | 'same'>, typing: boolean }>} */
const _openingRowInFlight = new Map();

/** @type {Map<string, ChatMessage>} each unstored opening an opening request sent, by its store ref, until it is adopted */
const _openingsSent = new Map();

/** A message's keys that say where it is shown rather than what it is */
const PLACE_KEYS = ['node_id', 'swipes', 'swipe_id', 'swipe_info', 'swipe_speaker_default'];

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
    const shown = _chatAt(mesId);
    if (!shown || !isProvisionalNodeId(shown.node_id)) return null;
    const owner = _currentOwner();
    if (!owner) return null;
    if (String(shown.mes ?? '').trim() === '') return null;

    let ref = storeRefOf(shown);
    if (ref === undefined) {
        ref = uuidv4();
        setStoreRef(shown, ref);
    }
    _openingsSent.set(ref, JSON.parse(JSON.stringify(shown)));
    const message = {
        name: shown.name ?? getCurrentCharacter()?.name,
        is_user: shown.is_user === true,
        is_system: shown.is_system === true,
        send_date: shown.send_date ?? getMessageTimeStamp(),
        mes: shown.mes,
        extra: shown.extra ?? {},
        ...(typeof shown.original_avatar === 'string' ? { original_avatar: shown.original_avatar } : {}),
        ...(typeof shown.force_avatar === 'string' ? { force_avatar: shown.force_avatar } : {}),
    };
    const opening = { refs: [ref], messages: [message] };
    if ('avatar_url' in owner) return { opening };
    const metadataRef = uuidv4();
    _openingMetadataRefs.add(metadataRef);
    return { opening, page_metadata: { ref: metadataRef, target: null, set: {}, unset: [] } };
}

/**
 * @param {number} [mesId]
 * @returns {Promise<string|null>}
 */
export async function ensureOpeningRow(mesId = 0) {
    const saved = await _storeOpening(mesId, { typing: false });
    return saved !== null && 'node' in saved && isStoredNodeId(saved.node) ? saved.node : null;
}

/**
 * @typedef {{ node: string, shown?: true } | { same: true } | null} EditSaved what saving a message came to: the node it
 *   is now, which with `shown` is the alternative with the text of the edit, that the edit went to; `same` when the
 *   edit, still being typed, has the text of another alternative, so it isn't saved yet; null when nothing was saved
 */

/**
 * Stores the opening shown from the card at `mesId`, as the page shows it
 * @param {number} mesId
 * @param {{ typing: boolean }} options typing: the opening is an edit still being typed
 * @returns {Promise<EditSaved>}
 */
async function _storeOpening(mesId, { typing }) {
    const message = _chatAt(mesId);
    if (!message) return null;
    if (isStoredNodeId(message.node_id)) return { node: message.node_id };

    const provisional = message.node_id;
    const flight = _openingRowInFlight.get(provisional);
    if (flight) {
        const came = await flight.done;
        if (!(came === 'same' && flight.typing && !typing)) return _openingSaved(mesId, came);
        return _storeOpening(mesId, { typing });
    }
    const request = openingForRequest(mesId);
    const owner = _currentOwner();
    if (!request || !owner) return null;
    /** @type {Promise<'answered' | 'shown' | 'same'>} */
    const done = (async () => {
        const response = await fetch('/api/chats/message/select', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ...owner,
                ...request,
                ...(typing ? { typing: true } : {}),
            }),
        });
        const answer = response.ok || response.status === 409 ? await response.json().catch(() => null) : null;
        if (answer?.ok === false && answer.same) return 'same';
        if (response.ok && answer?.shown) {
            await followSameAlternative(mesId, answer.shown);
            return 'shown';
        }
        if (!response.ok) return 'answered';
        adoptStored(answer?.stored);
        takeChatLinks(answer?.links);
        await takeOpenings(owner, answer);
        return 'answered';
    })().catch(error => {
        console.warn('[greetings] Could not give this greeting a row:', error);
        return /** @type {'answered'} */ ('answered');
    }).finally(() => {
        _openingRowInFlight.delete(provisional);
        for (const ref of request.opening.refs) _openingsSent.delete(ref);
    });
    _openingRowInFlight.set(provisional, { done, typing });
    return _openingSaved(mesId, await done);
}

/**
 * @param {number} mesId
 * @param {'answered' | 'shown' | 'same'} came what the opening's request came to
 * @returns {EditSaved}
 */
function _openingSaved(mesId, came) {
    if (came === 'same') return { same: true };
    const node = _chatAt(mesId)?.node_id;
    if (came === 'shown') return typeof node === 'string' ? { node, shown: true } : null;
    return isStoredNodeId(node) ? { node } : null;
}

/**
 * Shows what the server answered once an edit of message `mesId` went to the alternative with its text, and says so
 * @param {number} mesId
 * @param {any} shown the answer's `shown`: the messages from `mesId` down, and for a first message its openings
 */
export async function followSameAlternative(mesId, shown) {
    const owner = _currentOwner();
    forgetStored(chat.slice(mesId).map(m => m.node_id).filter(isStoredNodeId));
    chat.splice(mesId, chat.length - mesId, ...(Array.isArray(shown.messages) ? shown.messages : []));
    for (const message of chat.slice(mesId)) {
        if (isStoredNodeId(message.node_id)) markStoredAs(message.node_id, message);
    }
    if (owner) await takeOpenings(owner, shown, { render: false });
    takeChatLinks(shown.links);
    if (shown.chat_metadata) (await import('./metadata-store.js')).takeServerState(shown.chat_metadata);
    if (owner) arriveChatBox(owner, shown.draft);
    await redisplayChat({ startIndex: mesId });
    updateViewMessageIds();
    refreshSwipeButtons(true);
    const now = _chatAt(mesId);
    if (now !== undefined) _noticeSameAlternative((now.swipe_id ?? 0) + 1);
}

/**
 * @param {number} place the alternative's number, as the swipe counter shows it
 */
function _noticeSameAlternative(place) {
    toastr.info(t`The text is the same as alternative ${place}, so the message shows that one.`, t`Same as alternative ${place}`);
}

/**
 * Asks the server to remember the card greeting an alternative is as the chat's opening, which the page shows already:
 * the chat box moves to it as it is asked (`moveChatBox`). Only an alternative the server named a card greeting (its
 * swipe info's `greeting`: the greeting's id, its character and its text's hash) is one.
 * @param {(SwipeInfo & { greeting?: { id?: unknown, avatar?: unknown, hash?: unknown } | null }) | undefined} info the alternative's swipe info
 * @returns {Promise<boolean>} false when the server didn't take it
 */
export async function rememberCardOpening(info) {
    const owner = _currentOwner();
    const greeting = info?.greeting;
    if (!owner || !greeting || !Number.isInteger(greeting.id) || typeof greeting.avatar !== 'string' || greeting.avatar === '') return true;
    const move = moveChatBox({ chat: owner });
    try {
        const response = await fetch('/api/chats/openings/choose', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ ...owner, greeting_avatar: greeting.avatar, greeting_id: greeting.id, expected_hash: greeting.hash, leaving: move.leaving }),
        });
        if (!response.ok) throw new Error(`/api/chats/openings/choose responded ${response.status}`);
        const answer = await response.json().catch(() => null);
        chatBoxLeft(answer?.left);
        await takeOpenings(owner, answer);
        move.arrive(answer?.draft);
        return true;
    } catch (error) {
        move.undo();
        console.warn('[greetings] Could not remember the chosen greeting:', error);
        return false;
    }
}

/**
 * @param {{ avatar_url: string } | { group_id: string } | null | undefined} a
 * @param {{ avatar_url: string } | { group_id: string } | null | undefined} b
 * @returns {boolean} whether both name the same chat's owner
 */
function sameOwner(a, b) {
    if (!a || !b) return false;
    return 'avatar_url' in a ? 'avatar_url' in b && a.avatar_url === b.avatar_url : 'group_id' in b && a.group_id === b.group_id;
}

/**
 * @param {unknown} named an answer or push naming the chat its openings are of: `avatar` or `group_id`
 * @returns {{ avatar_url: string } | { group_id: string } | null}
 */
export function openingsOwnerOf(named) {
    const n = /** @type {{ avatar?: unknown, group_id?: unknown } | null} */ (named && typeof named === 'object' ? named : null);
    if (typeof n?.group_id === 'string' && n.group_id !== '') return { group_id: n.group_id };
    if (typeof n?.avatar === 'string' && n.avatar !== '') return { avatar_url: n.avatar };
    return null;
}

/**
 * @param {{ avatar_url: string } | { group_id: string } | null | undefined} owner the chat whose tree the openings are
 * @param {unknown} answer an answer carrying `openings` and `card_openings`
 * @param {{ render?: boolean }} [options]
 */
export async function takeOpenings(owner, answer, { render = true } = {}) {
    if (!answer || typeof answer !== 'object' || !('openings' in answer)) return;
    if (!sameOwner(owner, _currentOwner())) return;
    const character = 'avatar_url' in /** @type {object} */ (owner) ? getCurrentCharacter() : null;
    const avatar = owner && 'avatar_url' in owner ? owner.avatar_url : null;
    const state = /** @type {import('./opening-view.js').OpeningState} */ (answer);
    const view = openingView({ openings: state.openings, card_openings: state.card_openings ?? null }, {
        first: _chatAt(0),
        count: chat.length,
        speaker: character?.name ?? '',
        sendDate: getMessageTimeStamp(),
        greetingNodeId: alt => unstoredGreetingNodeId(alt, avatar),
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
        claimPushedCounts();
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
    claimPushedCounts();
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

/**
 * @returns {{ group_id: string } | { avatar_url: string } | null}
 */
export function currentChatOwner() {
    return _currentOwner();
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
    adoptStored(answer?.stored);
    takeMessageCounts(answer?.message_counts);
    takeMessageMacros(answer?.message_macros);
    takeChatLinks(answer?.links);
    await takeOpenings(owner, answer);
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
    adoptStored(answer?.stored);
    takeMessageCounts(answer?.message_counts);
    takeMessageMacros(answer?.message_macros);
    takeChatLinks(answer?.links);
    await takeOpenings(owner, answer);
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

const DERIVED_EXTRA = ['branches', 'bookmark_link', ITEMIZED_PROMPT_FLAG, 'token_count', 'token_count_hash', 'token_count_key', 'token_count_waiting', 'text_token_count', 'macro_values'];

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
    for (const key of PLACE_KEYS) delete content[key];
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

/**
 * Saves the message as the page shows it: a card greeting not stored in the tree saves as a new stored opening. An edit
 * with the text of another of the message's alternatives isn't stored; once it is finished the message goes to that
 * alternative, as the server answers.
 * @param {number} mesId
 * @param {{ typing?: boolean }} [options] typing: the edit is still being typed
 * @returns {Promise<EditSaved>}
 */
export async function chatOpEdit(mesId, { typing = false } = {}) {
    if (isReplyGenerating(mesId)) {
        _refuseGenerating(mesId);
        return null;
    }
    let msg = _chatAt(mesId);
    if (isProvisionalNodeId(msg?.node_id)) {
        const opening = await _storeOpening(mesId, { typing });
        if (opening === null || !('node' in opening) || opening.shown) return opening;
        // The row may have been made by a request already under way, from the text before this edit: the edit goes onto it.
        msg = _chatAt(mesId);
    }
    if (!isStoredNodeId(msg?.node_id)) return null;
    if (typeof msg.mes === 'string' && msg.mes.length === 0) return null;

    const edit = _editOf(msg);
    if (edit !== null) {
        _waitForCounts([mesId]);
        /** @type {any} */
        let answer;
        try {
            answer = await _chatOpPostAnswering('/api/chats/message/edit', { ...edit, ...(typing ? { typing: true } : {}) }, [409]);
        } catch (error) {
            _stopWaitingHere([mesId], { failed: true });
            throw error;
        }
        if (answer?.ok === false) {
            _stopWaitingHere([mesId], { failed: true });
            if (answer.same) return { same: true };
            _reportChatOpFailure();
            throw new Error(`The edit was refused: ${answer.reason}`);
        }
        if (answer?.shown) {
            await followSameAlternative(mesId, answer.shown);
            const node = _chatAt(mesId)?.node_id;
            return typeof node === 'string' ? { node, shown: true } : null;
        }
        _stopWaitingHere([mesId]);
    }
    _markMessageSaved(mesId, msg.node_id);
    return { node: /** @type {string} */ (msg.node_id) };
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
        updateMessage(0, { node_id: composedOpeningNodeId() });
        const saved = await _storeOpening(0, { typing: false });
        if (saved !== null && 'node' in saved && saved.shown) return saved.node;
        nodeId = saved !== null && 'node' in saved && isStoredNodeId(saved.node) ? saved.node : null;
        if (nodeId === null) updateMessage(0, { node_id: undefined });
    } else {
        const after = appendTarget(mesId);
        if (after === null) return null;
        const result = await _chatOpPost('/api/chats/message/append', { ...(typeof after === 'string' ? { after_node_id: after, typed: true } : after), messages: [_messageContent(msg)], send_keys: [null] });
        if (result?.shown) {
            await followSameAlternative(mesId, result.shown);
            return _chatAt(mesId)?.node_id ?? null;
        }
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

    const edited = edits.map(edit => edit._mesId);
    _waitForCounts(edited);
    let result;
    try {
        result = await _chatOpPost('/api/chats/message/edit-batch', {
            edits: edits.map(({ _mesId, ...edit }) => edit),
        }, silent);
    } catch (error) {
        _stopWaitingHere(edited, { failed: true });
        throw error;
    }
    _stopWaitingHere(edited);

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
    const under = appendTarget(fromIndex);
    if (under === null) return [];
    return (await chatOpAppendAfter(under, fromIndex, toIndex, { silent })).node_ids;
}

/**
 * @param {number} index
 * @returns {string | NonNullable<ReturnType<typeof openingForRequest>> | null}
 */
export function appendTarget(index) {
    for (let i = index - 1; i >= 0; i--) {
        const nodeId = _chatAt(i)?.node_id;
        if (isStoredNodeId(nodeId)) return nodeId;
        if (isProvisionalNodeId(nodeId)) return openingForRequest(i);
    }
    return null;
}

/**
 * @param {string | NonNullable<ReturnType<typeof openingForRequest>>} after a stored message, or the unstored opening to store with the messages
 * @param {number} fromIndex
 * @param {number} [toIndex]
 * @param {{ silent?: boolean }} [options]
 * @returns {Promise<{ node_ids: string[], already_stored: string[] }>}
 */
export async function chatOpAppendAfter(after, fromIndex, toIndex = chat.length, { silent = false } = {}) {
    const messages = chat.slice(fromIndex, toIndex);
    const sendKeys = messages.map(message => storeRefOf(message) ?? null);
    const result = await _chatOpPost('/api/chats/message/append', {
        ...(typeof after === 'string' ? { after_node_id: after } : after),
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

    const after = appendTarget(mesId);
    if (typeof after !== 'string') return null;

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
    chatBoxFollowCut(answer.draft);
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
 * @param {{ next?: boolean, typed?: boolean }} [options] next: right after the alternative shown (an opening shown from
 *     the card goes first, so it follows that greeting); otherwise last. typed: the text is an edit of the message, so
 *     with the text of another of its alternatives it goes to that one, not stored
 * @returns {Promise<string | { shown: object } | null>} the new alternative's node; `shown`: the answer saying which
 *     alternative a typed one went to (`followSameAlternative`)
 */
export async function chatOpAddAlternative(mesId, text, { next = false, typed = false } = {}) {
    const msg = _chatAt(mesId);
    if (typeof text !== 'string' || !text.length) return null;
    /** @type {any} */
    let created;
    if (mesId === 0 && msg && !isStoredNodeId(msg.node_id) && _currentOwner()) {
        created = await _chatOpPost('/api/chats/message/alternative', { opening: true, contents: [_messageContent(msg, text)], ...(next ? { place: { first: true } } : {}), ...(typed ? { typed: true } : {}) });
    } else {
        if (!isStoredNodeId(msg?.node_id)) return null;
        created = await _chatOpPost('/api/chats/message/alternative', {
            sibling_node_id: msg.node_id,
            contents: [_messageContent(msg, text)],
            ...(next ? { place: { after: msg.node_id } } : {}),
            ...(typed ? { typed: true } : {}),
        });
    }
    if (created?.shown) return { shown: created.shown };
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
