// Writer side of the chat store: writes should go through the named actions below rather than
// mutating `chat` directly and asking for a whole-conversation save.

import { chat, chat_metadata, name2, getCurrentCharacter, getCurrentChatId, getRequestHeaders, isStoredNodeId, isProvisionalNodeId, provisionalNodeId, charactersStore, redisplayChat, updateViewMessageIds, refreshSwipeButtons, updateMessageBlock, _messageSnapshots } from '../script.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';
// A group has no avatar of its own - while one is open it, not getCurrentCharacter(), is the tree
// owner for every chatOp*() below. See _currentOwner().
import { selected_group } from './group-chats.js';
import { t } from './i18n.js';

// Freezes obj and all nested objects/arrays, so no nested mutation can bypass updateMessage().
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
export function updateMessage(mesId, updates) {
    const old = chat[mesId];
    if (!old) return old;
    const result = deepFreeze({ ...old, ...updates });
    chat[mesId] = result;
    return result;
}

// Write path for nested fields; updateMessage() only shallow-merges, so writing through `extra`
// via `{ ...old }` would still throw. Copies only the nodes along `path`, sharing the rest.
export function updateIn(mesId, path, value) {
    const old = chat[mesId];
    if (!old) return old;

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

    const result = deepFreeze(rebuild(old, 0));
    chat[mesId] = result;
    return result;
}


/** In-flight ensureOpeningRow() calls, keyed by provisional id, so two callers make one row. */
const _openingRowInFlight = new Map();

// The only writer of chat[0].node_id — minting a row in more than one place raced (two rows for
// one greeting, two ideas of which was the opening).
export async function ensureOpeningRow(mesId = 0) {
    const message = chat[mesId];
    if (!message) return null;
    if (isStoredNodeId(message.node_id)) return message.node_id;
    // Not a tree-backed opening (JSONL chat, or never-saved message); nothing to mint.
    if (!isProvisionalNodeId(message.node_id)) return null;

    const character = getCurrentCharacter();
    const text = typeof message.mes === 'string' ? message.mes : '';
    // No text means no greeting to store — the server refuses it, so skip the round trip.
    if (!character?.avatar || !text.trim()) return null;

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
                        name: message.name ?? character.name ?? name2,
                        is_user: !!message.is_user,
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
    if (!realId) return null;

    // Re-read: the await means the opening may have been replaced or the chat moved on.
    const current = chat[mesId];
    if (!current || current.node_id !== provisional) {
        return isStoredNodeId(chat[mesId]?.node_id) ? chat[mesId].node_id : null;
    }

    // Update the shown slot too, or the save path re-reads it as still-unsaved.
    const at = current.swipe_id ?? 0;
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
        charactersStore.update(character.avatar, { chat: realId });
    } catch (error) {
        console.warn('[greetings] The greeting has a row, but the position could not be recorded:', error);
    }

    return realId;
}

// Brings the card's current greetings into an already-open chat's opening alternatives. Nothing is
// written here: an appended slot carries a provisional id, marking it as card-only text; it gains a
// row only if someone uses it.
export async function _mergeCardGreetingsIntoOpening() {
    if (!chat_metadata?._tree_stored) return;

    const opening = chat[0];
    const character = getCurrentCharacter();
    if (!opening?.node_id || !character?.avatar) return;
    const speaker = character.name ?? name2;

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

    const cardOnlyCount = (head.total ?? 0) - (head.stored ?? 0);
    if (cardOnlyCount <= 0) return;

    const tail = await ask({ offset: head.stored, limit: cardOnlyCount });
    const extras = (tail?.alternatives ?? []).filter(a => !a.node_id);
    if (!extras.length) return;

    const current = chat[0];
    if (!current?.node_id || current.node_id !== opening.node_id) return;

    const swipes = Array.isArray(current.swipes) ? [...current.swipes] : [current.mes ?? ''];
    const swipeInfo = Array.isArray(current.swipe_info)
        ? [...current.swipe_info]
        : [{ send_date: current.send_date, extra: current.extra ?? {}, node_id: current.node_id }];

    // Rebuild the card-only tail instead of appending — otherwise edited/removed card text lingers.
    const keptSwipes = [];
    const keptInfo = [];
    for (let k = 0; k < swipes.length; k++) {
        const isStored = isStoredNodeId(swipeInfo[k]?.node_id);
        const isHole = typeof swipes[k] !== 'string';
        if (isStored || isHole) {
            keptSwipes.push(swipes[k]);
            keptInfo.push(swipeInfo[k] ?? null);
        }
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

    swipes.length = 0;
    swipes.push(...keptSwipes);
    swipeInfo.length = 0;
    swipeInfo.push(...keptInfo);

    // Whatever is being shown must survive the rebuild.
    const shownWas = current.swipe_id ?? 0;
    const shownText = current.swipes?.[shownWas];
    let shownAt = swipes.indexOf(shownText);

    const updates = { swipes, swipe_info: swipeInfo };

    if (shownAt >= 0) {
        updates.swipe_id = shownAt;
    } else if (!isStoredNodeId(current.node_id) && swipes.length) {
        // Card-only greeting on screen was edited/removed elsewhere; keep the position and sync
        // mes/slot to match rather than guessing which new greeting it became.
        shownAt = Math.min(shownWas, swipes.length - 1);
        if (typeof swipes[shownAt] === 'string') {
            updates.swipe_id = shownAt;
            updates.mes = swipes[shownAt];
            updates.name = swipeInfo[shownAt]?.name ?? speaker;
            updates.node_id = swipeInfo[shownAt]?.node_id
                ?? provisionalNodeId(updates.name, swipes[shownAt]);
        }
    }

    // Reading isn't an edit — following the card shouldn't mint a row.
    const wasClean = _messageSnapshots.get(current.node_id) === current;
    updateMessage(0, updates);
    if (updates.node_id && updates.node_id !== current.node_id) {
        _messageSnapshots.delete(current.node_id);
    }
    if ((wasClean || updates.node_id) && chat[0]?.node_id) {
        _messageSnapshots.set(chat[0].node_id, chat[0]);
    }
    // Refresh the message block too, not just swipe buttons, or the edit appears to do nothing.
    if (updates.mes !== undefined && chat[0]) {
        updateMessageBlock(0, chat[0]);
    }
    refreshSwipeButtons(true);
}

// Re-fetches what followed an overswiped message, since the nodes are still in the tree.
export async function _restoreContinuation(mesId) {
    const message = chat[mesId];
    if (!chat_metadata?._tree_stored) return;
    // A provisional-id opening has no row, so nothing can follow it.
    if (!isStoredNodeId(message?.node_id)) return;

    let payload;
    try {
        const response = await fetch('/api/chats/continuation', {
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

/** Whether a given slot on a message is a blank nobody has typed into yet. */
export function _isBlankSlot(message, at) {
    if (!Array.isArray(message?.swipes)) return false;
    if (typeof message.swipes[at] !== 'string' || message.swipes[at].length > 0) return false;
    return !message.swipe_info?.[at]?.node_id;
}

// Named actions for writes a chat can make — prefer these over _saveTreeChat's snapshot-diff guessing.

/**
 * Retries the SAME request on a transient failure (network error, 5xx) instead of asking something
 * else to guess what changed - a dropped write is still that exact write. A 4xx is a real, immediate
 * refusal (bad request, not found, conflict) and is never retried, since a retry can't change it.
 */
async function _retryTransient(fn, { attempts = 3, baseDelayMs = 500 } = {}) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (error?.status >= 400 && error.status < 500) throw error;
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
 * @param {() => Promise<any>} fn
 * @param {{attempts?: number, baseDelayMs?: number}} [options]
 */
export async function retryTransient(fn, options) {
    return _retryTransient(fn, options);
}

// The tree owner for whatever's currently open: a group by its own id (mirrors the server's ownerOf()
// in src/endpoints/chats.js, which checks body.group_id before body.avatar_url) or, absent a group, the
// selected character by avatar. getCurrentCharacter() alone is wrong while a group is open - it names
// whichever member is mid-turn (generateGroupWrapper() calls setCharacterId() per activated member),
// not the group whose tree every message in this chat actually belongs to.
function _currentOwner() {
    if (selected_group) return { group_id: selected_group };
    const avatar = getCurrentCharacter()?.avatar;
    return avatar ? { avatar_url: avatar } : null;
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
 * @param {boolean} [silent] Skip the generic failure toast - only for a caller that already reports
 * this same failure itself with something more specific (e.g. chatOpEditMany()'s token-count backfill
 * caller); everyone else gets it by default, since most call sites report nothing on their own.
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
                const error = new Error(`${path} responded ${response.status}`);
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
export function _markMessageSaved(mesId, nodeId) {
    const live = mesId < chat.length ? chat[mesId] : null;
    if (live?.node_id && live.node_id === nodeId) {
        _messageSnapshots.set(live.node_id, live);
    }
}

// Strips swipe machinery and node_id — a single row, not a set.
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
export async function chatOpEdit(mesId) {
    const msg = chat[mesId];
    if (!isStoredNodeId(msg?.node_id)) return false;
    if (typeof msg.mes === 'string' && msg.mes.length === 0) return false;

    await _chatOpPost('/api/chats/message/edit', { node_id: msg.node_id, content: _messageContent(msg) });
    _markMessageSaved(mesId, msg.node_id);
    return true;
}

// Batches edits across messages into a single request instead of N round trips that could end up
// half applied.
// @param {boolean} [silent] Forwarded to _chatOpPost() - true for a caller that already reports a
// failure itself, so the generic one doesn't also fire for the same failure.
export async function chatOpEditMany(mesIds, silent = false) {
    const edits = [];
    for (const mesId of mesIds) {
        const msg = chat[mesId];
        if (!isStoredNodeId(msg?.node_id)) continue;
        if (typeof msg.mes === 'string' && msg.mes.length === 0) continue;
        edits.push({ node_id: msg.node_id, content: _messageContent(msg), _mesId: mesId });
    }
    if (!edits.length) return 0;

    const result = await _chatOpPost('/api/chats/message/edit-batch', {
        edits: edits.map(({ node_id, content }) => ({ node_id, content })),
    }, silent);

    // Only mark accepted edits saved — a partial refusal shouldn't mark everything saved.
    const refused = new Set((result.refused ?? []).map(r => r.node_id));
    for (const edit of edits) {
        if (!refused.has(edit.node_id)) _markMessageSaved(edit._mesId, edit.node_id);
    }
    if (refused.size) {
        console.warn('[chat] Some messages were not changed:', result.refused);
    }
    return result.applied ?? 0;
}

// An opening with no row yet earns one here, since an append must name the row it attaches to.
export async function chatOpAppend(fromIndex) {
    let after = null;
    for (let i = fromIndex - 1; i >= 0; i--) {
        if (isProvisionalNodeId(chat[i]?.node_id)) await ensureOpeningRow(i);
        if (isStoredNodeId(chat[i]?.node_id)) { after = chat[i].node_id; break; }
    }
    if (!after) return [];

    const result = await _chatOpPost('/api/chats/message/append', {
        after_node_id: after,
        messages: chat.slice(fromIndex),
    });
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
// @returns {Promise<boolean>} Whether anything in `chat[]` has a real, persisted node_id at all -
// i.e. whether there's something for the caller to address a metadata write onto.
export async function healDirtyMessages() {
    let lastPersisted = null;
    let firstNewIndex = -1;

    for (let i = 0; i < chat.length; i++) {
        let msg = chat[i];

        if (!msg?.node_id) {
            if (firstNewIndex < 0) firstNewIndex = i;
            continue;
        }

        let justEnsured = false;
        if (isProvisionalNodeId(msg.node_id)) {
            const at = msg.swipe_id ?? 0;
            const said = msg.swipe_info?.[at]?.name ?? msg.name;
            const written = msg.node_id !== provisionalNodeId(said, msg.mes);
            const followed = chat.length > i + 1;
            if (written || followed) {
                const realId = await ensureOpeningRow(i);
                if (realId && chat[i]?.node_id === realId) {
                    msg = chat[i];
                    justEnsured = true;
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

        if (hasSlots
            && typeof msg.swipes[selected] === 'string'
            && msg.swipes[selected].length === 0
            && !msg.swipe_info[selected]?.node_id) {
            continue;
        }

        let newSelectedId = null;
        let learnedIds = null;
        if (hasSlots) {
            for (let k = 0; k < msg.swipes.length; k++) {
                if (typeof msg.swipes[k] !== 'string') continue;
                if (msg.swipes[k].length === 0) continue;
                if (msg.swipe_info[k]?.node_id) continue;

                const createdId = await chatOpAddAlternative(i, msg.swipes[k]);
                if (!createdId) continue;

                learnedIds = learnedIds ?? [...msg.swipe_info];
                learnedIds[k] = { ...(learnedIds[k] || {}), node_id: createdId };
                if (k === selected) newSelectedId = createdId;
            }
        }
        if (learnedIds && i < chat.length) {
            updateMessage(i, { swipe_info: learnedIds });
        }

        if (newSelectedId) {
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

    if (lastPersisted && firstNewIndex >= 0) {
        await chatOpAppend(firstNewIndex);
    }

    return !!lastPersisted;
}

// Splices a new message in between two existing ones. Nothing to graft before when mesId lands at
// the tail (nothing follows it yet) — that's a plain append, so delegate rather than duplicate it.
export async function chatOpGraft(mesId) {
    const msg = chat[mesId];
    if (!msg) return null;
    if (mesId + 1 >= chat.length) return (await chatOpAppend(mesId))[0] ?? null;

    let after = null;
    for (let i = mesId - 1; i >= 0; i--) {
        if (isProvisionalNodeId(chat[i]?.node_id)) await ensureOpeningRow(i);
        if (isStoredNodeId(chat[i]?.node_id)) { after = chat[i].node_id; break; }
    }
    if (!after) return null;

    const before = chat[mesId + 1]?.node_id;
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
export async function chatOpDegraft(firstMesId, lastMesId = firstMesId) {
    const firstMsg = chat[firstMesId];
    const lastMsg = chat[lastMesId];
    if (!isStoredNodeId(firstMsg?.node_id) || !isStoredNodeId(lastMsg?.node_id)) return false;

    const after = chat[lastMesId + 1];
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
export async function chatOpSwapAdjacent(sourceMesId, targetMesId) {
    const sourceMsg = chat[sourceMesId];
    const targetMsg = chat[targetMesId];
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
export async function chatOpAddAlternative(mesId, text) {
    const msg = chat[mesId];
    if (!isStoredNodeId(msg?.node_id) || typeof text !== 'string' || !text.length) return null;

    const created = await _chatOpPost('/api/chats/message/alternative', {
        sibling_node_id: msg.node_id,
        contents: [_messageContent(msg, text)],
    });
    return created?.node_ids?.[0] ?? null;
}

// Ends the path here rather than moving the chat's position: a load descends from the pointer to a
// leaf, so a mid-tree position is walked straight past. Nothing is removed — swiping back restores it.
export async function chatOpEndPath(mesId) {
    const msg = chat[mesId];
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

export async function chatOpSelect(mesId, swipeId) {
    const msg = chat[mesId];
    const nodeId = msg?.swipe_info?.[swipeId]?.node_id;
    if (!isStoredNodeId(nodeId)) return false;

    await _chatOpPost('/api/chats/message/select', { node_id: nodeId });
    if (msg.node_id !== nodeId) updateMessage(mesId, { node_id: nodeId });
    _markMessageSaved(mesId, nodeId);
    return true;
}

// Shared persistence call behind both chatOpDeleteAlternative() and chatOpDeleteAlternativeNode() below.
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
export async function chatOpDeleteAlternative(mesId, swipeId) {
    const msg = chat[mesId];
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
export async function chatOpDeleteAlternativeNode(nodeId, currentNodeId) {
    if (nodeId === currentNodeId) return false;
    return _deleteAlternativeNode(nodeId);
}
