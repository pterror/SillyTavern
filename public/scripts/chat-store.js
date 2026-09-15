// Writer side of the chat store: writes should go through the named actions below rather than
// mutating `chat` directly and asking for a whole-conversation save.

import { chat, chat_metadata, name2, getCurrentCharacter, getCurrentChatId, getRequestHeaders, isStoredNodeId, isProvisionalNodeId, provisionalNodeId, charactersStore, saveActiveChat, redisplayChat, updateViewMessageIds, refreshSwipeButtons, updateMessageBlock, _messageSnapshots } from '../script.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';

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
            body: JSON.stringify({ avatar_url: character.avatar, node_id: realId }),
        });
        charactersStore.update(character.avatar, { chat: realId });
        await saveActiveChat(character.avatar, realId);
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

/** Posts one operation. Throws on refusal, so a caller cannot mistake a refusal for a write. */
async function _chatOpPost(path, body) {
    const avatar = getCurrentCharacter()?.avatar;
    if (!avatar) throw new Error('no character is selected');
    const response = await fetch(path, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar, ...body }),
    });
    if (!response.ok) throw new Error(`${path} responded ${response.status}`);
    return response.json().catch(() => ({}));
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
export async function chatOpEditMany(mesIds) {
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
    });

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

export async function chatOpSelect(mesId, swipeId) {
    const msg = chat[mesId];
    const nodeId = msg?.swipe_info?.[swipeId]?.node_id;
    if (!isStoredNodeId(nodeId)) return false;

    await _chatOpPost('/api/chats/message/select', { node_id: nodeId });
    if (msg.node_id !== nodeId) updateMessage(mesId, { node_id: nodeId });
    _markMessageSaved(mesId, nodeId);
    return true;
}
