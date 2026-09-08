/**
 * The writer side of the chat store: everything that can put new bytes into a message that a save
 * round-trips. Nothing outside this module can reach updateMessage()/updateIn() - not by convention,
 * by having no import of them at all - so a mistake shaped like tonight's two bugs (a display or
 * computation pass reaching the persisting writer with derived content) cannot happen from
 * script.js's side of this boundary; it can only happen from inside a function that already lives
 * here, where the whole point is that every write is named for the real thing that caused it
 * (an edit was confirmed, a swipe was chosen, a reply was appended), not guessed at afterward.
 *
 * script.js (and everything importing from it) still calls the named actions below directly -
 * chatOpEdit(), chatOpAppend(), ensureOpeningRow(), etc. - the same as before this file existed; only
 * the raw updateMessage()/updateIn() primitives themselves moved. This is the first slice of a larger
 * migration, not the finished thing: _saveTreeChat() and roughly fifty other callers in script.js
 * still mutate `chat` directly and ask for a whole-conversation save (see that function's own doc
 * comment) rather than going through a named action here, and until every one of those is converted,
 * script.js still imports updateMessage()/updateIn() directly for their sake - so it is not yet true
 * that new script.js code structurally cannot reach the writer. What IS true today: the disciplined,
 * already-named-action call sites migrated here (ensureOpeningRow and the chatOp* family) can never
 * regress into writing derived/computed content, because they are the only code that ever will run in
 * this file, and this file's own header is the first thing anyone editing it reads.
 */

import { chat, chat_metadata, name2, getCurrentCharacter, getCurrentChatId, getRequestHeaders, isStoredNodeId, isProvisionalNodeId, provisionalNodeId, charactersStore, saveActiveChat, redisplayChat, updateViewMessageIds, refreshSwipeButtons, updateMessageBlock, _messageSnapshots } from '../script.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';

/**
 * Deep-freezes an object and all nested objects/arrays. After freezing, any attempt
 * to mutate a property at any level throws a TypeError, enforcing the immutable-message
 * contract all the way down — no nested mutation site can silently bypass updateMessage().
 * @param {*} obj
 * @returns {*} The same object, now frozen
 */
function deepFreeze(obj) {
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

/**
 * The single write path for chat messages. Replaces the message at `mesId` with a
 * new deep-frozen object incorporating the given updates. Any attempt to mutate the
 * message at any nesting level throws TypeError — this is the only correct way to
 * change a message.
 *
 * @param {number} mesId Index in the chat array
 * @param {object} updates Partial message to shallow-merge (use spread for nested objects)
 * @returns {object} The new frozen message
 */
export function updateMessage(mesId, updates) {
    const old = chat[mesId];
    if (!old) return old;
    const result = deepFreeze({ ...old, ...updates });
    chat[mesId] = result;
    return result;
}

/**
 * The write path for nested fields. `updateMessage` shallow-merges, so it can only replace
 * whole top-level properties - `{ ...old }` leaves `extra` pointing at the original frozen
 * object, and touching it throws.
 *
 * This copies only the nodes along `path` and shares every other subtree with the old message,
 * so the cost is the depth of the write, not the size of the message. `deepFreeze` stops at
 * anything already frozen, so the freeze walk is the same few nodes.
 *
 *   updateIn(id, ['extra', 'media_index'], 3);
 *   updateIn(id, ['extra', 'media'], list => [...(list ?? []), item]);
 *
 * @param {number} mesId Index in the chat array
 * @param {(string|number)[]} path Property path to write, from the message root
 * @param {*|((current: *) => *)} value New value, or a function from the current value to it
 * @returns {object} The new frozen message, or the existing value if there is no such message
 */
export function updateIn(mesId, path, value) {
    const old = chat[mesId];
    if (!old) return old;

    const rebuild = (node, depth) => {
        if (depth === path.length) {
            return typeof value === 'function' ? value(node) : value;
        }
        const key = path[depth];
        // A missing level is created as an object, matching what the old mutating code did
        // when it wrote through an absent `extra`.
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

/**
 * Turns the opening's provisional id into a real row, and is the ONLY thing that ever writes
 * chat[0].node_id.
 *
 * A greeting earns a row by being used, not by being shown, so the row is minted here - at the
 * moment something genuinely needs one: replying into the chat, labelling the node, forking at it,
 * or saving an edit to it. Everywhere else is happy with the provisional id.
 *
 * Being the single writer is the point. When several places could each mint one, they raced: two
 * rows for one greeting, two ideas of which was the opening, and a swipe_info still naming a third.
 * Here the id, the slot bookkeeping and the snapshot all move together, so there is no window in
 * which they disagree.
 *
 * @param {number} [mesId] index into `chat`; only an opening can be provisional
 * @returns {Promise<string|null>} the real node id, or null when there cannot be one
 */
export async function ensureOpeningRow(mesId = 0) {
    const message = chat[mesId];
    if (!message) return null;
    if (isStoredNodeId(message.node_id)) return message.node_id;
    // No id at all means this is not a tree-backed opening (a JSONL chat, or a message that has
    // simply never been saved); minting an opening for it would be inventing one.
    if (!isProvisionalNodeId(message.node_id)) return null;

    const character = getCurrentCharacter();
    const text = typeof message.mes === 'string' ? message.mes : '';
    // An opening with no text is not a greeting - the server refuses to store one, so asking is only
    // a round trip that comes back null.
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

    // The slot that is showing IS this row now, so it stops being card-only in the same breath as the
    // message adopting the id. Leaving the slot behind is what let the save path read the shown
    // greeting as an alternative still waiting to be created.
    const at = current.swipe_id ?? 0;
    const updates = { node_id: realId };
    if (Array.isArray(current.swipe_info)) {
        const swipeInfo = [...current.swipe_info];
        swipeInfo[at] = { ...(swipeInfo[at] ?? {}), node_id: realId };
        updates.swipe_info = swipeInfo;
    }
    updateMessage(mesId, updates);

    // The row now holds exactly what the message holds, so an opening that was in step with storage
    // still is - under its new key. Dropping the old key keeps the map from carrying an entry nothing
    // can ever match again.
    _messageSnapshots.delete(provisional);
    if (wasClean && chat[mesId]?.node_id === realId) {
        _messageSnapshots.set(realId, chat[mesId]);
    }

    // Now that there is a row, there is somewhere to stand, and this is the only moment at which that
    // becomes true - so recording it belongs here rather than at the swipe.
    //
    // Swiping onto a card-only greeting deliberately persists nothing: there is no id a reload could
    // resolve. But the moment the greeting earns a row, the character is still pointing at whichever
    // opening it was on before, and a load descends from the pointer - so the conversation being
    // started here would come back under a greeting nobody chose, with the reply hanging off a
    // sibling the load never visits.
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

/**
 * Brings the card's current greetings into an already-open chat's opening alternatives.
 *
 * A loaded chat builds its opening swipes from stored siblings, so a greeting that has never been
 * used has no row and would not appear at all - which is why editing one showed nothing, even after a
 * reload. The openings endpoint computes the union, and card-only entries sort after the stored ones,
 * so exactly those can be asked for once their count is known.
 *
 * Nothing is written. An appended slot carries a provisional id, which is what marks it as text that
 * lives on the card and nowhere else; it gains a row if someone uses it.
 */
export async function _mergeCardGreetingsIntoOpening() {
    if (!chat_metadata?._tree_stored) return;

    const opening = chat[0];
    const character = getCurrentCharacter();
    if (!opening?.node_id || !character?.avatar) return;
    // Found while moving this function here: `speaker` below was never defined in this function's
    // scope at all (a real, live ReferenceError waiting to happen whenever `extra.name`/the reconciled
    // slot's own name came back falsy) - matches how _openingFromTree() derives the same fallback.
    const speaker = character.name ?? name2;

    // The server reads the card's greetings itself now (chats.js's `_cardGreetingsFromDisk`) - this
    // used to build that array here (raw, unregexed text under the card's own speaker name - identity
    // is the message as stored, and getting either of those wrong once made every existing greeting
    // compare as new, which is how a 943-greeting card produced hundreds of phantom alternatives) and
    // ship it on every call. Nothing here needs that any more, just which character to read.
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

    // Same reasoning as _openingFromTree: this used to bail unless the character had chat history,
    // which has nothing to do with whether its card's greetings belong in this opening.
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

    // Rebuild the card-only tail rather than appending to it. A slot with a node_id is a real row and
    // stays untouched; a slot without one is card text, and editing a greeting means the old text is
    // no longer on the card. Appending alone would leave the old version sitting there forever.
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
        // A provisional id, not a bare absent one: the save path reads a slot with no id at all as a
        // new alternative to create, which is the opposite of what a card greeting means.
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
        // The greeting on screen was card-only and the card no longer says it - it was edited or
        // removed while this chat sat open. Nothing was ever stored for it, so there is nothing to
        // lose, but the message cannot be left pointing at a slot that now holds different text: `mes`
        // said one greeting, the slot said another, and the chat log showed the mismatch.
        //
        // The card gives no way to tell an edit from a deletion-plus-addition, so this does not try to
        // guess which new greeting the old one became. It keeps the position and makes the three
        // agree.
        shownAt = Math.min(shownWas, swipes.length - 1);
        if (typeof swipes[shownAt] === 'string') {
            updates.swipe_id = shownAt;
            updates.mes = swipes[shownAt];
            updates.name = swipeInfo[shownAt]?.name ?? speaker;
            updates.node_id = swipeInfo[shownAt]?.node_id
                ?? provisionalNodeId(updates.name, swipes[shownAt]);
        }
    }

    // Reading is not an edit, so a message that was saved stays saved. An opening that merely followed
    // the card is not an edit either: it has no row and asking for one is exactly what showing a
    // greeting must not do.
    const wasClean = _messageSnapshots.get(current.node_id) === current;
    updateMessage(0, updates);
    if (updates.node_id && updates.node_id !== current.node_id) {
        _messageSnapshots.delete(current.node_id);
    }
    if ((wasClean || updates.node_id) && chat[0]?.node_id) {
        _messageSnapshots.set(chat[0].node_id, chat[0]);
    }
    // Changing which greeting the opening holds has to reach the screen. Only the swipe buttons were
    // being refreshed, so editing the greeting a chat was sitting on updated `mes`, the slot list and
    // the id, and left the message on screen still reading the text from before the edit - which looked
    // exactly like the edit having done nothing at all.
    if (updates.mes !== undefined && chat[0]) {
        updateMessageBlock(0, chat[0]);
    }
    refreshSwipeButtons(true);
}

/**
 * Puts back what follows a message, re-derived from the tree.
 *
 * Overswiping a message truncates the visible conversation to it, so you are sitting at that point
 * ready to say something else. Leaving that blank slot has to restore what was there. It is fetched
 * rather than remembered: the nodes never went anywhere, only the client's view of them.
 *
 * @param {number} mesId
 */
export async function _restoreContinuation(mesId) {
    const message = chat[mesId];
    if (!chat_metadata?._tree_stored) return;
    // An opening with only a provisional id has no row, so nothing can follow it and there is nothing
    // to put back. Asking would be a lookup for an id no row answers to.
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

// ---------------------------------------------------------------------------
//  The writes a chat can make.
//
//  One function per thing that can happen to a conversation, each naming the row it acts on and
//  owning the bookkeeping that goes with it: the id the message ends up carrying, and recording it as
//  in step with storage. Call one at the moment the thing happens and there is nothing to work out
//  afterwards.
//
//  This is where the knowledge belongs. A save that compares the conversation against a snapshot can
//  only guess which of these took place, and guesses wrong in a way that costs writes - see
//  _saveTreeChat below, which is now a compatibility path for callers that mutate `chat` and ask for
//  a save without saying what they did. Our own code should call these directly and never go near it.
// ---------------------------------------------------------------------------

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

/**
 * Records that this message is in step with the row it names.
 *
 * Reads the live object rather than a caller's copy, since updateMessage() may have replaced it.
 */
function _markMessageSaved(mesId, nodeId) {
    const live = mesId < chat.length ? chat[mesId] : null;
    if (live?.node_id && live.node_id === nodeId) {
        _messageSnapshots.set(live.node_id, live);
    }
}

/**
 * One message's content, with the swipe machinery and its own node_id stripped - it is a single row,
 * not a set, and the row it belongs to is already named by the op's own `node_id` field.
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

/**
 * This message's text changed. Writes it to the row the message names.
 *
 * Never sends an edit that would empty a message: the route refuses one outright, so posting it can
 * only come back 409, and mirroring the rule here means no client state can produce the request.
 *
 * @returns {Promise<boolean>} true when the row now holds this message's content
 */
export async function chatOpEdit(mesId) {
    const msg = chat[mesId];
    if (!isStoredNodeId(msg?.node_id)) return false;
    if (typeof msg.mes === 'string' && msg.mes.length === 0) return false;

    await _chatOpPost('/api/chats/message/edit', { node_id: msg.node_id, content: _messageContent(msg) });
    _markMessageSaved(mesId, msg.node_id);
    return true;
}

/**
 * One change that spans many messages, sent as one thing.
 *
 * Attributing a run of messages to a persona, or hiding a range, is a single act the reader took, and
 * goes as a single request. Sending it as one edit per message is N round trips for one decision, and
 * N chances to end up half applied.
 *
 * @param {number[]} mesIds the messages whose current content should be written
 * @returns {Promise<number>} how many the store accepted
 */
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

    // Only the ones the store took are in step with it. A refusal is named, so the rest stay dirty
    // rather than every message being marked saved because the request as a whole came back ok.
    const refused = new Set((result.refused ?? []).map(r => r.node_id));
    for (const edit of edits) {
        if (!refused.has(edit.node_id)) _markMessageSaved(edit._mesId, edit.node_id);
    }
    if (refused.size) {
        console.warn('[chat] Some messages were not changed:', result.refused);
    }
    return result.applied ?? 0;
}

/**
 * These messages are new and follow what is already there. Appends them after the last stored node
 * above them.
 *
 * An opening that has no row yet earns one here, because an append has to name the row it attaches
 * to - that is the one moment a greeting being replied to becomes a greeting that was used.
 *
 * @param {number} fromIndex first of the new messages
 * @returns {Promise<string[]>} the ids they were given
 */
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

/**
 * Another alternative belongs alongside this message. Adds it as a sibling and tells the caller which
 * row it turned out to be - which may be one that already existed, since asserting the same
 * alternative twice is the same statement made twice.
 *
 * @returns {Promise<string|null>} the sibling's row id
 */
export async function chatOpAddAlternative(mesId, text) {
    const msg = chat[mesId];
    if (!isStoredNodeId(msg?.node_id) || typeof text !== 'string' || !text.length) return null;

    const created = await _chatOpPost('/api/chats/message/alternative', {
        sibling_node_id: msg.node_id,
        contents: [_messageContent(msg, text)],
    });
    return created?.node_ids?.[0] ?? null;
}

/**
 * The conversation ends at this message. Whatever followed stops being shown.
 *
 * This is what cutting a chat back to a point is, and what deleting from the end is. Nothing is
 * removed: the messages below keep their rows and their own continuations, and swiping or selecting
 * back onto one brings all of it back.
 *
 * It has to be said on the message rather than by moving the chat's position, because a load descends
 * from wherever the chat points down to a leaf and reads the conversation off that leaf's parents. A
 * position part-way up is walked straight past, which is why truncating by moving it did nothing.
 *
 * @returns {Promise<boolean>} true when the conversation now ends here
 */
export async function chatOpEndPath(mesId) {
    const msg = chat[mesId];
    if (!isStoredNodeId(msg?.node_id)) return false;

    await _chatOpPost('/api/chats/message/end-path', { node_id: msg.node_id });
    return true;
}

/**
 * This alternative is the one being shown. Points the fork at it and moves the message onto its row.
 *
 * @returns {Promise<boolean>} true when the selection was recorded
 */
export async function chatOpSelect(mesId, swipeId) {
    const msg = chat[mesId];
    const nodeId = msg?.swipe_info?.[swipeId]?.node_id;
    if (!isStoredNodeId(nodeId)) return false;

    await _chatOpPost('/api/chats/message/select', { node_id: nodeId });
    if (msg.node_id !== nodeId) updateMessage(mesId, { node_id: nodeId });
    _markMessageSaved(mesId, nodeId);
    return true;
}
