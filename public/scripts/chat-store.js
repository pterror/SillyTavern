// Writer side of the chat store: writes should go through the named actions below rather than
// mutating `chat` directly and asking for a whole-conversation save.

import { cardToGreetingsModel, getCurrentCharacter, getCurrentChatId, isStoredNodeId, isProvisionalNodeId, provisionalNodeId, redisplayChat, updateViewMessageIds, refreshSwipeButtons, updateMessageBlock, _messageSnapshots } from '../script.js';
import { chat, chat_metadata } from './chat-state.js';
import { getRequestHeaders } from './request-headers.js';
import { charactersStore } from './character-store.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';
// A group has no avatar of its own - while one is open it, not getCurrentCharacter(), is the tree
// owner for every chatOp*() below. See _currentOwner().
import { selected_group, groupsStore } from './group-chats.js';
import { t } from './i18n.js';
import { uuidv4 } from './utils.js';
import { setStoredAdopter } from './stored-report.js';
import { askToDrop, confirmOf, hasDrops, warnDropped } from './edit-drops.js';

// Without `noUncheckedIndexedAccess` (a project-wide tsconfig flag, out of scope to flip here since
// it's shared by all 10 chat-strict files), `chat[i]` types as always-`ChatMessage`, never
// `undefined` - even though at runtime an out-of-range/stale `mesId` genuinely produces `undefined`
// at plenty of call sites below (mesId is caller-supplied, not something this module can bound-check
// itself). That mistyping is what made real, load-bearing "does this message exist" guards look like
// dead code to the linter. This helper states the honest, narrower-than-the-array's-own type for a
// single lookup, so the existence checks that follow it mean what they say instead of being deleted.
/**
 * @param {number} i
 * @returns {ChatMessage|undefined}
 */
function _chatAt(i) {
    return chat[i];
}

// Freezes obj and all nested objects/arrays, so no nested mutation can bypass updateMessage().
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

// The ref the page sent the server for a message it asked the server to store, until the server's
// `stored` entry for it arrives. Kept off the message itself so extensions never see it and it is never saved.
/** @type {WeakMap<object, string>} */
const _storeRefs = new WeakMap();

/**
 * Records the ref to send the server with the request that stores this message.
 * @param {object} message
 * @param {string} ref A fresh uuidv4() per message.
 */
export function setStoreRef(message, ref) {
    _storeRefs.set(message, ref);
}

/**
 * @param {object|null|undefined} message
 * @returns {string|undefined} The ref setStoreRef() gave this message.
 */
export function storeRefOf(message) {
    return message ? _storeRefs.get(message) : undefined;
}

/** @param {ChatMessage} from @param {ChatMessage} to */
function _carryStoreRef(from, to) {
    const ref = _storeRefs.get(from);
    if (ref !== undefined) _storeRefs.set(to, ref);
}

/** @type {(ref: string) => void} */
let _sendStoredListener = () => {};

/**
 * Sets what is told each time the server says it stored a sent message, by the message's ref (its send key),
 * whether or not the message is still on screen.
 * @param {(ref: string) => void} listener
 */
export function setSendStoredListener(listener) {
    _sendStoredListener = listener;
}

/** @type {(entry: { ref: string, node_id: string, integrity: string|null, notSaved?: true }) => void} */
let _metadataStoredListener = () => {};

/** Refs of the metadata a group chat's greetings were stored with (ensureOpeningRow()), until the answer comes. */
const _openingMetadataRefs = new Set();

/**
 * Sets what is told when the server says it stored chat metadata keys the page sent under a ref (an entry of
 * `stored` with `integrity`), or couldn't (`notSaved`; `node_id` where they were to go, '' for the tree's root).
 * @param {(entry: { ref: string, node_id: string, integrity: string|null, notSaved?: true }) => void} listener
 */
export function setMetadataStoredListener(listener) {
    _metadataStoredListener = listener;
}

/**
 * Takes on the node ids the server reports for the messages it stored: each `{ ref, node_id }` goes to
 * the message on screen holding that ref, which is then saved as far as the page is concerned. A greeting
 * shown without a row takes on its row as ensureOpeningRow() gives it one. An entry with `integrity` reports
 * chat metadata keys stored instead, one with `metadata_not_saved` keys the server couldn't store.
 * @param {unknown} stored The answer's `stored` list.
 */
export function adoptStored(stored) {
    if (!Array.isArray(stored)) return;
    for (const entry of stored) {
        if (typeof entry?.ref !== 'string') continue;
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
}

/**
 * A greeting shown without a row now has one: its shown slot takes the row's id, and a character's chat is now
 * at it, as ensureOpeningRow() leaves them.
 * @param {number} mesId
 * @param {string} realId
 */
function _adoptOpeningRow(mesId, realId) {
    const current = chat[mesId];
    const provisional = current.node_id;
    const wasClean = _messageSnapshots.get(provisional) === current;
    const at = current.swipe_id ?? 0;
    /** @type {Partial<ChatMessage>} */
    const updates = { node_id: realId };
    if (Array.isArray(current.swipe_info)) {
        const swipeInfo = [...current.swipe_info];
        swipeInfo[at] = { ...(swipeInfo[at] ?? {}), node_id: realId };
        updates.swipe_info = swipeInfo;
    }
    updateMessage(mesId, updates);
    _messageSnapshots.delete(provisional);
    if (wasClean) _messageSnapshots.set(realId, chat[mesId]);
    if (mesId === 0 && (selected_group == null || selected_group === '')) _setCurrentTarget(getCurrentChatId() ?? '', null);
}

setStoredAdopter(adoptStored);

// The only write path for messages; mutating a frozen message directly throws TypeError.
/**
 * @param {number} mesId
 * @param {Partial<ChatMessage>} updates
 * @returns {ChatMessage|undefined}
 */
export function updateMessage(mesId, updates) {
    const old = _chatAt(mesId);
    if (!old) return old;
    const result = deepFreeze({ ...old, ...updates });
    _carryStoreRef(old, result);
    chat[mesId] = result;
    return result;
}

/**
 * Sets `extra` fields that are derived for display and never stored (a token count), without the message counting as
 * changed against what was last stored.
 * @param {number} mesId
 * @param {Record<string, unknown>} values
 */
export function setUnstoredExtra(mesId, values) {
    const old = _chatAt(mesId);
    if (!old) return;
    const wasClean = old.node_id != null && _messageSnapshots.get(old.node_id) === old;
    const updated = updateMessage(mesId, { extra: { ...(old.extra ?? {}), ...values } });
    if (wasClean && updated) _messageSnapshots.set(old.node_id, updated);
}

// Write path for nested fields; updateMessage() only shallow-merges, so writing through `extra`
// via `{ ...old }` would still throw. Copies only the nodes along `path`, sharing the rest.
// `path`/`value` address arbitrary nested structure inside a ChatMessage (any depth, array or
// object) - genuinely untypeable beyond `unknown`, so `rebuild()`'s intermediate nodes are `any`.
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
        // A missing level is created as an object, matching the old mutating code's behavior.
        const src = (node === null || typeof node !== 'object') ? {} : node;
        const copy = Array.isArray(src) ? src.slice() : { ...src };
        copy[key] = rebuild(src[key], depth + 1);
        return copy;
    };

    const result = /** @type {ChatMessage} */ (deepFreeze(rebuild(old, 0)));
    _carryStoreRef(old, result);
    chat[mesId] = result;
    return result;
}


/** In-flight ensureOpeningRow() calls, keyed by provisional id, so two callers make one row. */
/** @type {Map<string|undefined, Promise<void>>} */
const _openingRowInFlight = new Map();

// global.d.ts's SwipeInfo (client-side) has no `name`/`is_user` - TreeSwipeInfo (src/message-tree-db.js,
// server-side) does, and _mergeCardGreetingsIntoOpening() below reads/writes those
// same fields on client-side swipe_info entries built from card alternatives. Real cross-file gap in
// global.d.ts, not owned by this file - typed locally rather than editing that shared ambient declaration.
/** @typedef {SwipeInfo & {name?: string, is_user?: boolean}} SwipeInfoWithSpeaker */

/** @typedef {object} OpeningAlternative
 * @property {string} mes
 * @property {string} [name]
 * @property {boolean} [is_user]
 * @property {MessageTimestamp} [send_date]
 * @property {ChatMessageExtra} [extra]
 * @property {string} [node_id]
 */

/** @typedef {object} OpeningsResponse
 * @property {number} [total]
 * @property {number} [stored]
 * @property {number} [offset]
 * @property {string|null} [default_node_id]
 * @property {OpeningAlternative[]} [alternatives]
 */

// The only writer of chat_metadata.integrity and the live target pointer (charactersStore's `chat`
// for solo, the current group's `chat_id` for a group) — every call replaces both together so the
// two can never drift out of pairing the way ensureOpeningRow()/switchToNode()/switchToAlternativePath()
// used to. `integrity` omitted/null means unknown, matching setNodeMetadata/setChatMetadata's own
// falsy-`expected_integrity` semantics (the next write goes through unconditionally). `owner` overrides
// the ambient selected_group/getCurrentCharacter() inference (same shape as _currentOwner()'s return
// below) for a caller whose target isn't necessarily the currently open one - see deleteGroupChatByName()
// (group-chats.js), which can repoint a group that isn't selected_group.
// This file's own import of group-chats.js's selected_group/groupsStore, alongside group-chats.js's
// import of this function, is the same bidirectional pattern chat-store.js already has with
// script.js - see .oxlint-cycle-baseline's own history for that precedent.
/**
 * @param {string} chatId The current chat's compat id: its current chat's `b<id>`, else `s<session>.<tree>` ('' none).
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
 * What a request that stores the greeting(s) shown at chat[mesId] without a row sends (`opening`, and for a group the
 * metadata ref its new integrity is answered under): a character's greeting, or a group chat's members' greetings in
 * a row. adoptStored() takes on the answer.
 * @param {number} mesId
 * @returns {{ opening: { refs: string[], messages: object[] }, page_metadata?: object } | null} Null when there is no
 * such greeting to store (or no text: the server refuses an empty greeting).
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

// The only writer of chat[0].node_id — minting a row in more than one place raced (two rows for
// one greeting, two ideas of which was the opening).
/**
 * Gives a greeting shown without a row its row, in one request that also makes it the chat's position.
 * @param {number} [mesId]
 * @returns {Promise<string|null>}
 */
export async function ensureOpeningRow(mesId = 0) {
    const message = _chatAt(mesId);
    if (!message) return null;
    if (isStoredNodeId(message.node_id)) return message.node_id;

    const inGroup = selected_group != null && selected_group !== '';
    // A group's greetings are stored together, so one request covers all of them.
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
 * Records on the server that the open chat was switched to this card greeting, which has no row, so reopening the
 * chat shows it rather than the default greeting.
 * @param {string} text The greeting's text.
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

// Brings the card's current greetings into an already-open chat's opening alternatives. Nothing is
// written here: an appended slot carries a provisional id, marking it as card-only text; it gains a
// row only if someone uses it.
/**
 * @param {object} [options]
 * @param {{from: string, to: string, index?: number}|null} [options.greetingEdit] The one card greeting whose text just changed, if that's what happened; `index` is its position in the card's greeting list.
 * @param {{from: string, to: string, index?: number}[]} [options.greetingEdits] Every card greeting whose text just changed, in the order the changes were made; when given, used instead of `greetingEdit`.
 * @param {{ openings: OpeningsResponse|null, card_openings: OpeningsResponse|null }|null} [options.openings] The
 * character's openings when already read: `openings` as /api/chats/openings answers an empty body, `card_openings`
 * as it answers `{ offset: stored, limit: card-only count }`.
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

    const cardOnlyCount = (head.total ?? 0) - storedCount;
    const tail = cardOnlyCount > 0 ? await ask({ offset: storedCount, limit: cardOnlyCount }) : null;
    if (cardOnlyCount > 0 && !tail) return;
    const extras = (tail?.alternatives ?? []).filter(a => a.node_id == null || a.node_id === '');

    const current = _chatAt(0);
    if (current?.node_id == null || current.node_id === '' || current.node_id !== opening.node_id) return;

    const swipes = Array.isArray(current.swipes) ? [...current.swipes] : [current.mes ?? ''];
    // A hole (a swipe slot dropped in the rebuild below) is kept in swipe_info as `null`, not
    // omitted, to keep the two arrays index-aligned - so this array's element type is nullable.
    /** @type {(SwipeInfoWithSpeaker|null)[]} */
    const swipeInfo = Array.isArray(current.swipe_info)
        ? [...current.swipe_info]
        : [{ send_date: current.send_date, extra: current.extra ?? {}, node_id: current.node_id }];

    // Stored openings come first, at the same positions as on the server, so a slot here can be
    // addressed by the server's index; the card-only tail after them is rebuilt from the card.
    /** @type {string[]} */
    const keptSwipes = [];
    /** @type {(SwipeInfoWithSpeaker|null)[]} */
    const keptInfo = [];
    for (let k = 0; k < storedCount; k++) {
        const isStored = isStoredNodeId(swipeInfo[k]?.node_id) && typeof swipes[k] === 'string';
        keptSwipes.push(isStored ? swipes[k] : null);
        keptInfo.push(isStored ? swipeInfo[k] : null);
    }

    const known = new Set(keptSwipes.filter(x => typeof x === 'string'));
    for (const extra of extras) {
        if (known.has(extra.mes)) continue;
        known.add(extra.mes);
        keptSwipes.push(extra.mes);
        // Provisional id, not absent — an absent id reads as a new alternative to create.
        keptInfo.push({
            send_date: extra.send_date, extra: extra.extra ?? {},
            name: extra.name, is_user: extra.is_user,
            node_id: provisionalNodeId(extra.name ?? speaker, extra.mes),
        });
    }

    const unchanged = keptSwipes.length === swipes.length
        && keptSwipes.every((x, k) => x === swipes[k]);
    if (unchanged) return;

    // Whatever is being shown must survive the rebuild.
    const shownWas = current.swipe_id ?? 0;
    const shownText = Array.isArray(current.swipes) ? current.swipes[shownWas] : current.mes;
    const shownAt = typeof shownText === 'string' ? keptSwipes.indexOf(shownText) : -1;

    /**
     * Where `alt` sits in keptSwipes, filling its slot if it's a hole; -1 if it has no slot.
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

    // The fallback picks exactly what a fresh load (script.js's _openingFromTree()) would.
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
     * Where the server says the shown card greeting landed among the character's full openings, applied here.
     * @returns {Promise<number|null>} -1 when there is nowhere to land; null when it couldn't be found out or applied.
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
        // The card greeting on screen isn't among the loaded openings: the server works out where it landed.
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
        // No greeting left to open on, the same as loading a chat for a card with none.
        _messageSnapshots.delete(current.node_id);
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

    // Reading isn't an edit — following the card shouldn't mint a row.
    const wasClean = _messageSnapshots.get(current.node_id) === current;
    updateMessage(0, updates);
    if (updates.node_id != null && updates.node_id !== current.node_id) {
        _messageSnapshots.delete(current.node_id);
    }
    // updateMessage() above may have replaced chat[0] - re-read rather than reuse `current`.
    const updated = _chatAt(0);
    if ((wasClean || updates.node_id != null) && updated?.node_id != null && updated.node_id !== '') {
        _messageSnapshots.set(updated.node_id, updated);
    }
    // Refresh the message block too, not just swipe buttons, or the edit appears to do nothing.
    if (updates.mes !== undefined && updated) {
        updateMessageBlock(0, updated);
    }
    refreshSwipeButtons(true);
}

// Re-fetches what followed an overswiped message, since the nodes are still in the tree.
// With `redraw: false` only `chat` changes and the caller redraws from mesId + 1.
/**
 * @param {number} mesId
 * @param {{redraw?: boolean}} [options]
 * @returns {Promise<boolean>} Whether what follows mesId changed.
 */
export async function _restoreContinuation(mesId, { redraw = true } = {}) {
    const message = _chatAt(mesId);
    // A provisional-id opening has no row, so nothing can follow it.
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

    chat.splice(mesId + 1, chat.length - (mesId + 1), ...following);
    if (redraw) {
        await redisplayChat({ startIndex: mesId });
        updateViewMessageIds();
        refreshSwipeButtons(true);
    }
    return true;
}

/**
 * Takes the state where the session now is from an answer that moved it (`chat_metadata`), when it carries one.
 * @param {{ chat_metadata?: ChatMetadata } | null | undefined} answer
 */
async function _takeStateFrom(answer) {
    if (!answer?.chat_metadata) return;
    const { takeServerState } = await import('./metadata-store.js');
    takeServerState(answer.chat_metadata);
}

/**
 * Whether a given slot on a message is a blank nobody has typed into yet.
 * @param {ChatMessage|null|undefined} message
 * @param {number} at
 * @returns {boolean}
 */
export function _isBlankSlot(message, at) {
    if (!Array.isArray(message?.swipes)) return false;
    if (typeof message.swipes[at] !== 'string' || message.swipes[at].length > 0) return false;
    const nodeId = message.swipe_info?.[at]?.node_id;
    return nodeId == null || nodeId === '';
}

// Named actions for writes a chat can make — prefer these over _saveTreeChat's snapshot-diff guessing.

/** @typedef {Error & {status: number}} HttpError */

/**
 * @param {unknown} error
 * @returns {error is HttpError}
 */
function _hasHttpStatus(error) {
    return error instanceof Error && typeof (/** @type {*} */ (error).status) === 'number';
}

/**
 * Retries the SAME request on a transient failure (network error, 5xx) instead of asking something
 * else to guess what changed - a dropped write is still that exact write. A 4xx is a real, immediate
 * refusal (bad request, not found, conflict) and is never retried, since a retry can't change it.
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
 * Public export of the exact same retry policy `_chatOpPost()` uses below (transient network/5xx
 * errors retried with backoff, a 4xx refusal thrown immediately) - for a caller that must persist by
 * raw node id and an explicit owner instead of through a `chatOp*()` (which always reads/writes
 * `chat[]`/`getCurrentCharacter()`, i.e. whatever's CURRENTLY open - wrong for a caller whose target
 * chat may no longer be the one on screen). See public/scripts/horde.js's `persistHordeRawActionReply()`
 * for the real caller and why it can't use `chatOp*()` directly.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{attempts?: number, baseDelayMs?: number}} [options]
 * @returns {Promise<T>}
 */
export async function retryTransient(fn, options) {
    return _retryTransient(fn, options);
}

// The tree owner for whatever's currently open: a group by its own id (mirrors the server's ownerOf()
// in src/endpoints/chats.js, which checks body.group_id before body.avatar_url) or, absent a group, the
// selected character by avatar. getCurrentCharacter() alone is wrong while a group is open - it names
// whichever member is mid-turn (generateGroupWrapper() calls setCharacterId() per activated member),
// not the group whose tree every message in this chat actually belongs to.
/** @returns {{group_id: string}|{avatar_url: string}|null} */
function _currentOwner() {
    if (selected_group != null && selected_group !== '') return { group_id: selected_group };
    const avatar = getCurrentCharacter()?.avatar;
    return avatar != null && avatar !== '' ? { avatar_url: avatar } : null;
}

// A dropped write used to rely on some LATER save eventually noticing and catching up (a diff-scan
// against `chat[]` - the same shape this whole codebase spent tonight removing as _saveTreeChat()).
// _retryTransient() already covers a transient blip; once that's exhausted, or a 4xx refuses outright,
// the honest thing is to say so immediately, not stay silent and hope something notices later. Rate-
// limited so a burst of failures (e.g. several ops during one dropped connection) produces one toast,
// not a flood.
let _lastChatOpFailureToastAt = 0;
function _reportChatOpFailure() {
    const now = Date.now();
    if (now - _lastChatOpFailureToastAt < 10_000) return;
    _lastChatOpFailureToastAt = now;
    toastr.error(t`Could not save your last change. Check your connection and try again.`, t`Save failed`);
}

/**
 * Posts one operation. Throws on refusal, so a caller cannot mistake a refusal for a write.
 * Each chat-op endpoint has its own response shape (`node_ids`, `refused`/`applied`, `node_id`, ...),
 * read directly by each call site below - genuinely dynamic per-endpoint, so this returns `any`.
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {boolean} [silent] Skip the generic failure toast - only for a caller that already reports
 * this same failure itself with something more specific (e.g. chatOpEditMany()'s token-count backfill
 * caller); everyone else gets it by default, since most call sites report nothing on their own.
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
 * Posts one operation as `_chatOpPost()` does, but answers the body of a refusal with one of `answered` statuses
 * (an edit refused for a reason the caller handles) instead of throwing.
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

// Reads the live object, not the caller's copy — updateMessage() may have replaced it.
/**
 * @param {number} mesId
 * @param {string|null|undefined} nodeId
 */
export function _markMessageSaved(mesId, nodeId) {
    const live = mesId < chat.length ? chat[mesId] : null;
    if (live?.node_id != null && live.node_id !== '' && live.node_id === nodeId) {
        _messageSnapshots.set(live.node_id, live);
    }
}

// ChatMessage (global.d.ts, client-facing) has no `swipe_speaker_default` - TreeChatMessage
// (src/message-tree-db.js, server-side) does, and a message loaded off the tree can carry it. Real
// gap in that shared ambient declaration, not owned by this file - typed locally instead.
/** @typedef {ChatMessage & {swipe_speaker_default?: {name?: string, is_user?: boolean}}} ChatMessageWithSpeakerDefault */

/**
 * Strips swipe machinery and node_id — a single row, not a set.
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

// Never sends an edit that would empty a message — the route refuses it outright with a 409.
// A card greeting with no row yet is saved as a new stored opening with the edited text; the card's own
// greeting is untouched and is offered again among the openings.
/** @param {number} mesId */
export async function chatOpEdit(mesId) {
    const msg = _chatAt(mesId);
    if (isProvisionalNodeId(msg?.node_id)) {
        if (!isStoredNodeId(await ensureOpeningRow(mesId))) return false;
        await _mergeCardGreetingsIntoOpening();
        return true;
    }
    if (!isStoredNodeId(msg?.node_id)) return false;
    if (typeof msg.mes === 'string' && msg.mes.length === 0) return false;

    await _chatOpPost('/api/chats/message/edit', { node_id: msg.node_id, content: _messageContent(msg) });
    _markMessageSaved(mesId, msg.node_id);
    return true;
}

// Batches edits across messages into a single request instead of N round trips that could end up
// half applied.
/**
 * @param {number[]} mesIds
 * @param {boolean} [silent] Forwarded to _chatOpPost() - true for a caller that already reports a
 * failure itself, so the generic one doesn't also fire for the same failure.
 */
export async function chatOpEditMany(mesIds, silent = false) {
    // A card greeting with no row gets its stored row first, so the edit has a row to land on.
    let ensuredOpening = false;
    for (const mesId of mesIds) {
        if (!isProvisionalNodeId(_chatAt(mesId)?.node_id)) continue;
        if (isStoredNodeId(await ensureOpeningRow(mesId))) ensuredOpening = true;
    }
    if (ensuredOpening) await _mergeCardGreetingsIntoOpening();

    /** @type {{node_id: string, content: Partial<ChatMessageWithSpeakerDefault>, _mesId: number}[]} */
    const edits = [];
    for (const mesId of mesIds) {
        const msg = _chatAt(mesId);
        if (!isStoredNodeId(msg?.node_id)) continue;
        if (typeof msg.mes === 'string' && msg.mes.length === 0) continue;
        edits.push({ node_id: msg.node_id, content: _messageContent(msg), _mesId: mesId });
    }
    if (!edits.length) return 0;

    const result = await _chatOpPost('/api/chats/message/edit-batch', {
        edits: edits.map(({ node_id, content }) => ({ node_id, content })),
    }, silent);

    // Only mark accepted edits saved — a partial refusal shouldn't mark everything saved.
    const refused = new Set((result.refused ?? []).map((/** @type {any} */ r) => r.node_id));
    for (const edit of edits) {
        if (!refused.has(edit.node_id)) _markMessageSaved(edit._mesId, edit.node_id);
    }
    if (refused.size) {
        console.warn('[chat] Some messages were not changed:', result.refused);
    }
    return result.applied ?? 0;
}

// An opening with no row yet earns one here, since an append must name the row it attaches to.
/**
 * Stores chat[fromIndex..toIndex) after the nearest stored message before them.
 * @param {number} fromIndex
 * @param {number} [toIndex] Exclusive end; the rest of the chat when left out.
 * @param {{ silent?: boolean }} [options] `silent`: for a caller that reports the failure itself.
 * @returns {Promise<string[]>} The stored node ids; empty when there is no stored message to follow.
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
 * Stores chat[fromIndex..toIndex) after the stored node `after`, each with its send key when it has one.
 * @param {string} after
 * @param {number} fromIndex
 * @param {number} [toIndex] Exclusive end; the rest of the chat when left out.
 * @param {{ silent?: boolean }} [options] `silent`: for a caller that reports the failure itself.
 * @returns {Promise<{ node_ids: string[], already_stored: string[] }>} `already_stored`: the nodes of
 * messages whose send was stored before, wherever that was.
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

// Splices a new message in between two existing ones. Nothing to graft before when mesId lands at
// the tail (nothing follows it yet) — that's a plain append, so delegate rather than duplicate it.
/**
 * @param {number} mesId
 * @param {{ silent?: boolean }} [options] `silent`: for a caller that reports the failure itself.
 * @returns {Promise<string|null>} The stored node id; null when there is nothing stored on either side to place it between.
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
 * What an edit would drop besides its messages (bookmarks, state changes), asked of the server, and for `ask` (a
 * delete the user asked for here) whether the user goes on: the edit's `confirm`, or null when the user said no.
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
 * @typedef {object} EditTicket What an edit drops and the confirm naming exactly that.
 * @property {{ bookmarks: string[], changes: string[] }} confirm
 * @property {import('./edit-drops.js').Drops} drops
 */

/**
 * Applies an edit with what `_editConfirm()` answered. When what it drops changed meanwhile (someone else edited the
 * tree), the new drops are asked about again (`ask`) or applied; drops nobody was asked about are shown as a warning.
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {EditTicket} ticket
 * @param {boolean} ask
 * @returns {Promise<any | null>} The answer, or null when the user said no.
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
 * Cuts messages [firstMesId..lastMesId] out of this chat (upstream's delete of messages: they leave this chat, other
 * branches keep what they share). What goes with them besides (bookmarks, state changes) is asked about first with
 * `ask` (the user's own delete here), else applied and shown as a warning. The chat's later messages that are now
 * copies (other branches shared them) take their copies' ids; the caller removes the cut messages from `chat`.
 * @param {number} firstMesId
 * @param {number} lastMesId
 * @param {{ ask?: boolean }} [options]
 * @returns {Promise<boolean | null>} true when cut, false when the user said no, null when nothing stored was named.
 */
export async function chatOpCut(firstMesId, lastMesId, { ask = false } = {}) {
    // Messages not stored yet at either end of the range have nothing to cut on the server.
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
    const copied = answer.copied && typeof answer.copied === 'object' ? answer.copied : {};
    for (let i = to + 1; i < chat.length; i++) {
        const copy = copied[chat[i]?.node_id];
        if (typeof copy !== 'string') continue;
        updateMessage(i, { node_id: copy });
        _markMessageSaved(i, copy);
    }
    return true;
}

// Swaps two adjacent on-path messages. Which one is "upper" (closer to the start) is determined by
// index, not argument order — the caller passes source/target in whichever order the user dragged.
// The server doesn't mint new node_ids for this op (the two rows just trade parents), so the client's
// own chat[] swap is still the right way to reflect it locally — only the persistence mechanism
// changes versus the old unconditional array-slot swap.
/**
 * @param {number} sourceMesId
 * @param {number} targetMesId
 */
export async function chatOpSwapAdjacent(sourceMesId, targetMesId) {
    const sourceMsg = _chatAt(sourceMesId);
    const targetMsg = _chatAt(targetMesId);
    if (!isStoredNodeId(sourceMsg?.node_id) || !isStoredNodeId(targetMsg?.node_id)) return null;

    const upperMesId = Math.min(sourceMesId, targetMesId);
    const lowerMesId = Math.max(sourceMesId, targetMesId);
    const upperNodeId = chat[upperMesId].node_id;
    const lowerNodeId = chat[lowerMesId].node_id;

    await _chatOpPost('/api/chats/message/swap-adjacent', {
        upper_node_id: upperNodeId,
        lower_node_id: lowerNodeId,
    });

    [chat[sourceMesId], chat[targetMesId]] = [chat[targetMesId], chat[sourceMesId]];
    return true;
}

// May return an existing row — asserting the same alternative twice is the same statement twice.
/**
 * @param {number} mesId
 * @param {string} text
 * @returns {Promise<string|null>}
 */
export async function chatOpAddAlternative(mesId, text) {
    const msg = _chatAt(mesId);
    if (!isStoredNodeId(msg?.node_id) || typeof text !== 'string' || !text.length) return null;

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
 * Readies the delete of an alternative (a swipe) and everything below it: what it would drop besides (bookmarks,
 * state changes) is asked about first with `ask` (the user's own delete here). Null when the user said no or the
 * alternative isn't stored; else what `chatOpDeleteAlternativeNode()` takes.
 * @param {string|null|undefined} nodeId
 * @param {{ ask?: boolean }} [options]
 * @returns {Promise<EditTicket | null>}
 */
export async function chatOpReadyAlternativeDelete(nodeId, { ask = false } = {}) {
    if (!isStoredNodeId(nodeId)) return null;
    return _editConfirm('/api/chats/message/alternative/delete', { node_id: nodeId }, ask);
}

/**
 * Deletes an alternative (a swipe) and everything below it, readied by `chatOpReadyAlternativeDelete()`. Refuses
 * without asking the server while it is still the shown one (`currentNodeId`): the caller moves the selection off
 * it first.
 * @param {string|null|undefined} nodeId
 * @param {string|null|undefined} currentNodeId
 * @param {EditTicket} ticket
 * @param {{ ask?: boolean }} [options]
 * @returns {Promise<boolean>} Whether it was deleted.
 */
export async function chatOpDeleteAlternativeNode(nodeId, currentNodeId, ticket, { ask = false } = {}) {
    if (nodeId === currentNodeId || !isStoredNodeId(nodeId)) return false;
    return !!await _applyConfirmed('/api/chats/message/alternative/delete', { node_id: nodeId }, ticket, ask);
}
