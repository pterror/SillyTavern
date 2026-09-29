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
    chat[mesId] = result;
    return result;
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
    chat[mesId] = result;
    return result;
}


/** In-flight ensureOpeningRow() calls, keyed by provisional id, so two callers make one row. */
/** @type {Map<string, Promise<string|null>>} */
const _openingRowInFlight = new Map();

// global.d.ts's SwipeInfo (client-side) has no `name`/`is_user` - TreeSwipeInfo (src/message-tree-db.js,
// server-side) does, and _mergeCardGreetingsIntoOpening()/healDirtyMessages() below both read/write those
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
 * @param {string} nodeId
 * @param {string|null} [integrity]
 * @param {{group_id: string}|{avatar_url: string}|null} [owner]
 */
export function _setCurrentTarget(nodeId, integrity = null, owner = null) {
    chat_metadata.integrity = integrity ?? undefined;
    if (owner) {
        if ('group_id' in owner) {
            groupsStore.update(owner.group_id, { chat_id: nodeId });
        } else {
            charactersStore.update(owner.avatar_url, { chat: nodeId });
        }
        return;
    }
    if (selected_group != null && selected_group !== '') {
        groupsStore.update(selected_group, { chat_id: nodeId });
    } else {
        const avatar = getCurrentCharacter()?.avatar;
        if (avatar != null && avatar !== '') charactersStore.update(avatar, { chat: nodeId });
    }
}

// The only writer of chat[0].node_id — minting a row in more than one place raced (two rows for
// one greeting, two ideas of which was the opening).
/**
 * @param {number} [mesId]
 * @returns {Promise<string|null>}
 */
export async function ensureOpeningRow(mesId = 0) {
    const message = _chatAt(mesId);
    if (!message) return null;
    if (isStoredNodeId(message.node_id)) return message.node_id;
    // Not a tree-backed opening (JSONL chat, or never-saved message); nothing to mint.
    if (!isProvisionalNodeId(message.node_id)) return null;

    const character = getCurrentCharacter();
    const text = typeof message.mes === 'string' ? message.mes : '';
    // No text means no greeting to store — the server refuses it, so skip the round trip.
    if (character?.avatar == null || character.avatar === '' || text.trim() === '') return null;

    const provisional = message.node_id;
    const wasClean = _messageSnapshots.get(provisional) === message;

    let pending = _openingRowInFlight.get(provisional);
    if (!pending) {
        pending = (async () => {
            const response = await fetch('/api/chats/openings/ensure', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar_url: character.avatar,
                    contents: [{
                        name: message.name ?? character.name,
                        is_user: message.is_user === true,
                        is_system: false,
                        send_date: message.send_date ?? getMessageTimeStamp(),
                        mes: text,
                        extra: message.extra ?? {},
                    }],
                }),
            });
            const made = response.ok ? await response.json().catch(() => null) : null;
            return made?.node_ids?.[0] ?? null;
        })().finally(() => _openingRowInFlight.delete(provisional));
        _openingRowInFlight.set(provisional, pending);
    }

    let realId = null;
    try {
        realId = await pending;
    } catch (error) {
        console.warn('[greetings] Could not give this greeting a row:', error);
        return null;
    }
    if (realId == null) return null;

    // Re-read: the await means the opening may have been replaced or the chat moved on.
    const current = _chatAt(mesId);
    if (!current || current.node_id !== provisional) {
        const reread = _chatAt(mesId);
        return isStoredNodeId(reread?.node_id) ? reread.node_id : null;
    }

    // Update the shown slot too, or the save path re-reads it as still-unsaved.
    const at = current.swipe_id ?? 0;
    /** @type {Partial<ChatMessage>} */
    const updates = { node_id: realId };
    if (Array.isArray(current.swipe_info)) {
        const swipeInfo = [...current.swipe_info];
        swipeInfo[at] = { ...(swipeInfo[at] ?? {}), node_id: realId };
        updates.swipe_info = swipeInfo;
    }
    updateMessage(mesId, updates);

    // Move the snapshot to the new key; the old one can never match again.
    _messageSnapshots.delete(provisional);
    if (wasClean && chat[mesId]?.node_id === realId) {
        _messageSnapshots.set(realId, chat[mesId]);
    }

    // Record the position now that the greeting has a row — a load descends from the character's
    // pointer, so leaving it on the old opening would strand this reply on a sibling never visited.
    try {
        await fetch('/api/chats/message/select', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar, node_id: realId, activate: true }),
        });
        _setCurrentTarget(realId, null);
    } catch (error) {
        console.warn('[greetings] The greeting has a row, but the position could not be recorded:', error);
    }

    return realId;
}

// Brings the card's current greetings into an already-open chat's opening alternatives. Nothing is
// written here: an appended slot carries a provisional id, marking it as card-only text; it gains a
// row only if someone uses it.
/**
 * @param {object} [options]
 * @param {{from: string, to: string, index?: number}|null} [options.greetingEdit] The one card greeting whose text just changed, if that's what happened; `index` is its position in the card's greeting list.
 * @param {{from: string, to: string, index?: number}[]} [options.greetingEdits] Every card greeting whose text just changed, in the order the changes were made; when given, used instead of `greetingEdit`.
 */
export async function _mergeCardGreetingsIntoOpening({ greetingEdit = null, greetingEdits } = {}) {
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
        let k = alternatives.findIndex(a => isStoredNodeId(a.node_id) && a.node_id === head.default_node_id);
        if (k < 0) {
            const { greetings, defaultIndex } = cardToGreetingsModel(character);
            const preferredText = greetings.filter(text => typeof text === 'string' && text.length > 0)[defaultIndex ?? 0];
            k = alternatives.findIndex(a => a.mes === preferredText);
        }
        if (k < 0) k = 0;
        return k < alternatives.length ? placeOpening(alternatives[k], (head.offset ?? 0) + k) : -1;
    };

    /** @param {string} text */
    const placeText = async (text) => {
        const at = keptSwipes.indexOf(text);
        if (at >= 0) return at;
        // A stored opening outside the loaded window: ask for the window around it.
        const around = await ask({ around: { name: speaker, is_user: false, mes: text } });
        const k = (around?.alternatives ?? []).findIndex(a => isStoredNodeId(a.node_id) && a.mes === text);
        return k < 0 ? -1 : placeOpening(around.alternatives[k], (around.offset ?? 0) + k);
    };

    /**
     * The card-only opening the card greeting at `index` became, found by position: the card's greetings before
     * and after it are matched, in order, against the server's card-only openings (which skip empty, stored and
     * repeated greetings), and the one opening they leave between them is it. -1 when they don't leave exactly one.
     * @param {number} index
     */
    const placeCardPosition = (index) => {
        const cardTexts = cardToGreetingsModel(character).greetings;
        if (!Number.isInteger(index) || index < 0 || index >= cardTexts.length) return -1;
        let before = 0;
        for (let j = 0; j < index && before < extras.length; j++) {
            if (cardTexts[j] === extras[before].mes) before++;
        }
        let after = 0;
        for (let j = cardTexts.length - 1; j > index && before + after < extras.length; j--) {
            if (cardTexts[j] === extras[extras.length - 1 - after].mes) after++;
        }
        if (before + after + 1 !== extras.length) return -1;
        return keptSwipes.indexOf(extras[before].mes);
    };

    let landAt = shownAt;
    if (shownAt < 0 && !isStoredNodeId(current.node_id)) {
        // The card greeting on screen is gone: follow it to its new text if it was edited (by position on the
        // card when its new text isn't among the openings), otherwise show the default.
        // With several greetings changed from the shown text, the shown text was left only once the last of them was.
        const edit = edits.findLast(e => e.from === shownText);
        if (edit) {
            landAt = await placeText(edit.to);
            if (landAt < 0 && edit.index !== undefined) landAt = placeCardPosition(edit.index);
        }
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
/** @param {number} mesId */
export async function _restoreContinuation(mesId) {
    const message = _chatAt(mesId);
    // A provisional-id opening has no row, so nothing can follow it.
    if (!isStoredNodeId(message?.node_id)) return;

    let payload;
    try {
        const response = await fetch('/api/chats/message/select', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ node_id: message.node_id, chat_name: getCurrentChatId() }),
        });
        if (!response.ok) return;
        payload = await response.json();
    } catch (error) {
        console.warn('[restore] Could not fetch what follows:', error);
        return;
    }

    const following = payload?.messages ?? [];
    if (!following.length && chat.length === mesId + 1) return;

    chat.splice(mesId + 1, chat.length - (mesId + 1), ...following);
    await redisplayChat({ startIndex: mesId });
    updateViewMessageIds();
    refreshSwipeButtons(true);
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
/** @param {number} mesId */
export async function chatOpEdit(mesId) {
    const msg = _chatAt(mesId);
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
/** @param {number} fromIndex */
export async function chatOpAppend(fromIndex) {
    /** @type {string|null} */
    let after = null;
    for (let i = fromIndex - 1; i >= 0; i--) {
        if (isProvisionalNodeId(_chatAt(i)?.node_id)) await ensureOpeningRow(i);
        const nodeId = _chatAt(i)?.node_id;
        if (isStoredNodeId(nodeId)) { after = nodeId; break; }
    }
    if (after == null || after === '') return [];

    const result = await _chatOpPost('/api/chats/message/append', {
        after_node_id: after,
        messages: chat.slice(fromIndex),
    });
    /** @type {string[]} */
    const ids = result.node_ids ?? [];
    ids.forEach((node_id, offset) => {
        const index = fromIndex + offset;
        if (index < chat.length) updateMessage(index, { node_id });
        _markMessageSaved(index, node_id);
    });
    return ids;
}

// The one remaining reason `chat[]` can hold a change no chatOp*() has stated: getContext().saveChat()
// (st-context.js) is a generic API, and a third-party extension using it can mutate `chat[]` directly -
// edit `.mes`, add a swipe, push a trailing message - with no way to require it call a specific chatOp*()
// instead, since arbitrary extension code can't be forced to state what it meant. First-party code never
// has this problem: every edit/swipe/append already calls its own chatOp*() at its own call site, and a
// write that fails now says so immediately (_reportChatOpFailure() above) rather than leaving `chat[]`
// silently out of sync for something to notice later - so an ordinary first-party save never runs this.
// saveChatConditional()'s and saveChat()'s own `heal` parameter is what calls it, and only
// getContext().saveChat() (st-context.js) ever passes that flag as true - see its own doc comment there.
//
// Finds every message whose content differs from its last confirmed-saved snapshot and persists it via
// the matching chatOp*() (a changed swipe slot with no node_id -> chatOpAddAlternative + chatOpSelect if
// it's the shown one, otherwise -> chatOpEdit), plus a trailing run with no node_id at all -> one batched
// chatOpAppend(). A snapshot already matching means nothing to do.
//
// A provisional (card-only) opening id is solo-only - ensureOpeningRow() needs a character to mint
// against, and is a safe no-op here for anything that isn't provisional (a group's opening is already a
// real row by the time this runs - see _bootstrapGroupChat(), group-chats.js).
/**
 * @returns {Promise<boolean>} Whether anything in `chat[]` has a real, persisted node_id at all -
 * i.e. whether there's something for the caller to address a metadata write onto.
 */
export async function healDirtyMessages() {
    /** @type {string|null} */
    let lastPersisted = null;
    let firstNewIndex = -1;

    // The opening row is a special case of "no node_id at all": unlike every other position, it has
    // no earlier persisted message to anchor a chatOpAppend() onto - the loop below's `lastPersisted`
    // guard can never fire for it (see this function's own module-level heal-call site in
    // generation.js for why this matters: a genuinely brand-new chat's greeting can reach here with
    // no node_id - e.g. _openingFromTree()'s (or _bootstrapGroupChat()'s) own eager-materialize call
    // having failed - and a lone entry at index 0 would otherwise leave `lastPersisted` null forever).
    // Same treatment ensureOpeningRow() already gives a PROVISIONAL greeting - stamp the same
    // provisional id `_openingFromTree()` would have (script.js), then let ensureOpeningRow() mint
    // the real row, so it flows through the exact same, already-tested materialization path.
    const opening = _chatAt(0);
    if (opening && (opening.node_id == null || opening.node_id === '')) {
        updateMessage(0, { node_id: provisionalNodeId(opening.name, opening.mes) });
        await ensureOpeningRow(0);
    }

    for (let i = 0; i < chat.length; i++) {
        let msg = _chatAt(i);

        if (msg?.node_id == null || msg.node_id === '') {
            if (firstNewIndex < 0) firstNewIndex = i;
            continue;
        }

        let justEnsured = false;
        if (isProvisionalNodeId(msg.node_id)) {
            const at = msg.swipe_id ?? 0;
            const said = /** @type {SwipeInfoWithSpeaker|undefined} */ (msg.swipe_info?.[at])?.name ?? msg.name;
            const written = msg.node_id !== provisionalNodeId(said, msg.mes);
            const followed = chat.length > i + 1;
            if (written || followed) {
                const realId = await ensureOpeningRow(i);
                if (realId != null && realId !== '') {
                    const reread = _chatAt(i);
                    if (reread?.node_id === realId) {
                        msg = reread;
                        justEnsured = true;
                    }
                }
            }
        }

        if (!isStoredNodeId(msg.node_id)) continue;

        lastPersisted = msg.node_id;

        const seen = _messageSnapshots.get(msg.node_id);
        if (seen === msg) continue;

        if (seen && JSON.stringify(seen) === JSON.stringify(msg)) {
            _markMessageSaved(i, msg.node_id);
            continue;
        }

        const hasSlots = Array.isArray(msg.swipes) && Array.isArray(msg.swipe_info);
        const selected = msg.swipe_id ?? 0;
        // Narrowed once here since `hasSlots` (a `const` alias of the `Array.isArray()` pair) doesn't
        // keep `msg.swipes`/`msg.swipe_info` narrowed at every later, independent access below.
        const swipes = hasSlots ? /** @type {string[]} */ (msg.swipes) : [];
        /** @type {SwipeInfoWithSpeaker[]} */
        const swipeInfo = hasSlots ? /** @type {SwipeInfoWithSpeaker[]} */ (msg.swipe_info) : [];

        if (hasSlots
            && typeof swipes[selected] === 'string'
            && swipes[selected].length === 0
            && (swipeInfo[selected].node_id == null || swipeInfo[selected].node_id === '')) {
            continue;
        }

        /** @type {string|null} */
        let newSelectedId = null;
        /** @type {SwipeInfoWithSpeaker[]|null} */
        let learnedIds = null;
        if (hasSlots) {
            for (let k = 0; k < swipes.length; k++) {
                if (typeof swipes[k] !== 'string') continue;
                if (swipes[k].length === 0) continue;
                if (swipeInfo[k].node_id != null && swipeInfo[k].node_id !== '') continue;

                const createdId = await chatOpAddAlternative(i, swipes[k]);
                if (createdId == null || createdId === '') continue;

                learnedIds = learnedIds ?? [...swipeInfo];
                learnedIds[k] = { ...learnedIds[k], node_id: createdId };
                if (k === selected) newSelectedId = createdId;
            }
        }
        if (learnedIds && i < chat.length) {
            updateMessage(i, { swipe_info: learnedIds });
        }

        if (newSelectedId != null) {
            await chatOpSelect(i, selected);
            lastPersisted = newSelectedId;
        } else {
            if (typeof msg.mes === 'string' && msg.mes.length === 0) continue;
            if (justEnsured) {
                _markMessageSaved(i, msg.node_id);
                continue;
            }
            await chatOpEdit(i);
        }
    }

    if (lastPersisted != null && firstNewIndex >= 0) {
        await chatOpAppend(firstNewIndex);
    }

    return lastPersisted != null;
}

// Splices a new message in between two existing ones. Nothing to graft before when mesId lands at
// the tail (nothing follows it yet) — that's a plain append, so delegate rather than duplicate it.
/** @param {number} mesId */
export async function chatOpGraft(mesId) {
    const msg = _chatAt(mesId);
    if (!msg) return null;
    if (mesId + 1 >= chat.length) return (await chatOpAppend(mesId))[0] ?? null;

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

    const result = await _chatOpPost('/api/chats/message/graft', {
        after_node_id: after,
        before_node_id: before,
        content: _messageContent(msg),
    });
    updateMessage(mesId, { node_id: result.node_id });
    _markMessageSaved(mesId, result.node_id);
    return result.node_id;
}

// Removes a contiguous run of messages [firstMesId..lastMesId] from the default path. Nothing follows
// the range — deleting to the end of the chat — is the already-correct tail-delete case, so this
// delegates to chatOpEndPath rather than duplicate that logic.
/**
 * @param {number} firstMesId
 * @param {number} [lastMesId]
 */
export async function chatOpDegraft(firstMesId, lastMesId = firstMesId) {
    const firstMsg = _chatAt(firstMesId);
    const lastMsg = _chatAt(lastMesId);
    if (!isStoredNodeId(firstMsg?.node_id) || !isStoredNodeId(lastMsg?.node_id)) return false;

    const after = _chatAt(lastMesId + 1);
    if (!isStoredNodeId(after?.node_id)) {
        return chatOpEndPath(firstMesId - 1);
    }

    await _chatOpPost('/api/chats/message/degraft', {
        first_node_id: firstMsg.node_id,
        last_node_id: lastMsg.node_id,
    });
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

// Ends the path here rather than moving the chat's position: a load descends from the pointer to a
// leaf, so a mid-tree position is walked straight past. Nothing is removed — swiping back restores it.
/** @param {number} mesId */
export async function chatOpEndPath(mesId) {
    const msg = _chatAt(mesId);
    if (!isStoredNodeId(msg?.node_id)) return false;

    await _chatOpPost('/api/chats/message/end-path', { node_id: msg.node_id });
    return true;
}

// Same operation as chatOpEndPath(), for when every message was just deleted and there is no
// chat[] entry left to name - ends the path at the owner's own anchor instead.
export async function chatOpEndPathAtAnchor() {
    await _chatOpPost('/api/chats/message/end-path', { end_at_anchor: true });
    return true;
}

/**
 * @param {number} mesId
 * @param {number} swipeId
 */
export async function chatOpSelect(mesId, swipeId) {
    const msg = _chatAt(mesId);
    const nodeId = msg?.swipe_info?.[swipeId]?.node_id;
    if (!isStoredNodeId(nodeId) || msg == null) return false;

    await _chatOpPost('/api/chats/message/select', { node_id: nodeId });
    if (msg.node_id !== nodeId) updateMessage(mesId, { node_id: nodeId });
    _markMessageSaved(mesId, nodeId);
    return true;
}

// Shared persistence call behind both chatOpDeleteAlternative() and chatOpDeleteAlternativeNode() below.
/** @param {string|null|undefined} nodeId */
async function _deleteAlternativeNode(nodeId) {
    if (!isStoredNodeId(nodeId)) return false;

    await _chatOpPost('/api/chats/message/alternative/delete', { node_id: nodeId });
    return true;
}

// Deletes an unused alternative (swipe) outright. This only ever handles the NON-shown case: if
// `swipeId` names the currently-selected swipe (`msg.node_id`, not the swipe-specific id this reads
// off `swipe_info`), it refuses WITHOUT contacting the server — the caller (deleteSwipe()) is
// responsible for calling chatOpSelect() FIRST to swipe away from it, which already persists that
// selection change on its own. On success, the caller is also responsible for updating its own local
// `swipes`/`swipe_info` arrays for display — this function's only job is the persistence call.
/**
 * @param {number} mesId
 * @param {number} swipeId
 */
export async function chatOpDeleteAlternative(mesId, swipeId) {
    const msg = _chatAt(mesId);
    const nodeId = msg?.swipe_info?.[swipeId]?.node_id;
    if (nodeId === msg?.node_id) return false;
    return _deleteAlternativeNode(nodeId);
}

// Deletes a swipe's node by its raw id, for callers that can no longer look it up by (mesId, swipeId)
// because something already spliced it out of `chat[]`'s swipe_info before this runs. Used by
// deleteSwipe()'s SHOWN-swipe branch: after swipe() finishes swapping the message onto a different
// alternative (persisting that selection change itself, via its own switchToAlternativePath() ->
// chatOpSelect-equivalent path), the OLD node is no longer the current default child and becomes
// eligible for deletion — but its swipe_info entry was already removed from `chat[mesId]` before
// swipe() ran, so it must be captured by the caller beforehand and passed in here directly.
// `currentNodeId` is the live node to compare against (pass `chat[mesId]?.node_id` fresh, not a stale
// copy) — if it still matches `nodeId`, the selection never actually moved (e.g. swipe() bailed out
// early), and this refuses locally without contacting the server, same guarantee as
// chatOpDeleteAlternative() above.
/**
 * @param {string|null|undefined} nodeId
 * @param {string|null|undefined} currentNodeId
 */
export async function chatOpDeleteAlternativeNode(nodeId, currentNodeId) {
    if (nodeId === currentNodeId) return false;
    return _deleteAlternativeNode(nodeId);
}
