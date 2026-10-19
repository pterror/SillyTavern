// Upstream's whole-chat save, kept for extensions: saveChat(), saveChatConditional() and saveChatDebounced() (and
// getContext().saveChat()). Upstream's extensions change `chat` themselves (a message's `mes`, `extra`, its swipes; a
// message pushed or spliced out) and then call one of these, so each still stores what upstream's would, but the page
// sends only actions addressed by node id: each change against the message as last stored (`_messageSnapshots`). The
// page never posts the chat array, so the server never has to guess which message an entry of it means.
//
// The app's own code never calls these (an eslint rule says so): it sends the action for what it changed where it
// changed it.

import {
    DEFAULT_SAVE_EDIT_TIMEOUT, getCurrentCharacter, getCurrentChatId, getSelectionState, is_send_press, name2, neutralCharacterName,
} from '../script.js';
import { chat, chat_metadata } from './chat-state.js';
import { charactersStore, this_avatar } from './character-store.js';
import {
    _restoreContinuation, chatOpAddAlternativeBeside, chatOpAppendAfter, chatOpBookmarkNode, chatOpCutNamed, chatOpDeleteAlternativeNode,
    chatOpEdit, chatOpGraft, chatOpPatch, chatOpReadyAlternativeDelete, chatOpSelect, ensureOpeningRow, storeRefOf, updateMessage,
} from './chat-store.js';
import { isFailedSend } from './failed-sends.js';
import { _messageSnapshots, markStoredAs, replyInFlightIndex, streamingProcessor } from './generation.js';
import { editGroup, groupsStore, selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { ITEMIZED_PROMPT_FLAG } from './itemized-prompts.js';
import { saveMetadata } from './metadata-store.js';
import { isProvisionalNodeId, isStoredNodeId, provisionalNodeId } from './node-identity.js';
import { saveTokenCache } from './tokenizers.js';
import { escapeHtml, waitUntilCondition } from './utils.js';

// Read by several sites in script.js (send-button gating, the debounced-save wait loop) and by group-chats.js - only
// ever reassigned here (saveChatConditional()'s own save-in-progress guard).
export let isChatSaving = false;

/** @type {ReturnType<typeof setTimeout>|null} */
let chatSaveTimeout = null;

/** Extra fields reads derive, never stored as a message's own. */
const DERIVED_EXTRA = ['branches', 'bookmark_link', ITEMIZED_PROMPT_FLAG, 'token_count'];
/** An alternative's own fields upstream keeps in its `swipe_info` entry, besides its text and `extra`. */
const SLOT_FIELDS = ['send_date', 'gen_started', 'gen_finished'];
/** Chat metadata keys the server derives: a named save never states them. */
const DERIVED_METADATA = new Set(['integrity', 'main_chat', 'fork_point', '_tree_stored']);

/**
 * Shows what wasn't saved, each on a line of its own.
 * @param {string[]} notSaved
 * @param {string} title
 */
function warnNotSaved(notSaved, title) {
    console.warn('[saveChat] Not saved:', notSaved);
    toastr.warning(notSaved.map(x => escapeHtml(x)).join('<br>'), title, { escapeHtml: false, timeOut: 15000, preventDuplicates: true });
}

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
 * A message's own fields, as stored for the alternative it shows: without its id, its swipes and what reads derive.
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
 * The alternative at slot `k` of a message other than the one it shows, as upstream keeps it: its text, and its
 * `swipe_info` entry's `send_date`, `gen_started`, `gen_finished` and `extra`.
 * @param {ChatMessage} message
 * @param {number} k
 * @returns {Record<string, any>}
 */
function slotOf(message, k) {
    const info = /** @type {Record<string, any>} */ (message.swipe_info?.[k] ?? {});
    /** @type {Record<string, any>} */
    const slot = { mes: message.swipes?.[k] };
    for (const field of SLOT_FIELDS) if (info[field] !== undefined) slot[field] = info[field];
    slot.extra = extraOf(info.extra);
    return JSON.parse(JSON.stringify(slot));
}

/**
 * The shown alternative's slot fields (its text, times and `extra`), as `slotOf()` gives another's.
 * @param {Record<string, any>} content A `contentOf()`.
 * @returns {Record<string, any>}
 */
function shownSlotOf(content) {
    /** @type {Record<string, any>} */
    const slot = { mes: content.mes };
    for (const field of SLOT_FIELDS) if (content[field] !== undefined) slot[field] = content[field];
    slot.extra = extraOf(content.extra);
    return slot;
}

/**
 * A new alternative of a message, at its slot `k`: the message's own fields, with the slot's.
 * @param {ChatMessage} message
 * @param {number} k
 */
function newAlternativeOf(message, k) {
    const content = contentOf(message);
    for (const field of [...SLOT_FIELDS, 'extra']) delete content[field];
    const info = /** @type {Record<string, any>} */ (message.swipe_info?.[k] ?? {});
    if (info.name !== undefined) content.name = info.name;
    if (info.is_user !== undefined) content.is_user = !!info.is_user;
    return { ...content, ...slotOf(message, k) };
}

/**
 * What differs from `before` in `now`: the fields to set and those to unset; null when nothing does.
 * @param {Record<string, any>} before
 * @param {Record<string, any>} now
 * @returns {{ patch: Record<string, any>, unset: string[] } | null}
 */
function patchOf(before, now) {
    /** @type {Record<string, any>} */
    const patch = {};
    /** @type {string[]} */
    const unset = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(now)])) {
        if (JSON.stringify(before[key]) === JSON.stringify(now[key])) continue;
        if (now[key] === undefined) unset.push(key);
        else patch[key] = now[key];
    }
    return Object.keys(patch).length > 0 || unset.length > 0 ? { patch, unset } : null;
}

/**
 * @param {ChatMessage} message
 * @param {number} k
 * @returns {string|null} The stored node slot `k` names.
 */
function slotId(message, k) {
    const id = message.swipe_info?.[k]?.node_id;
    return isStoredNodeId(id) ? /** @type {string} */ (id) : null;
}

/**
 * The stored nodes a message holds: the one it shows (null when that is a swipe not stored yet) and every other
 * alternative's, by slot.
 * @param {ChatMessage} message
 */
function alternativesOf(message) {
    const swipes = Array.isArray(message.swipes) ? message.swipes : [];
    const selected = Number.isInteger(message.swipe_id) ? /** @type {number} */ (message.swipe_id) : 0;
    const own = isStoredNodeId(message.node_id) ? /** @type {string} */ (message.node_id) : null;
    // The message's id is its shown slot's unless another slot is that message (a swipe not stored yet is shown).
    const claimed = own !== null && swipes.some((_, k) => k !== selected && slotId(message, k) === own);
    const shown = swipes.length === 0 ? own : slotId(message, selected) ?? (claimed ? null : own);
    /** @type {Map<string, number>} */
    const slots = new Map();
    for (let k = 0; k < swipes.length; k++) {
        const id = k === selected ? shown : slotId(message, k);
        if (id !== null) slots.set(id, k);
    }
    return { swipes, selected, shown, slots };
}

/**
 * Whether a generation is running: its reply is the server's to store.
 */
function generating() {
    return is_send_press || streamingProcessor !== null || replyInFlightIndex() >= 0;
}

/**
 * Stores what changed in the open chat since the page last stored it, as node-addressed actions (see this file's
 * header). Per kind of change, as upstream's whole save would persist it:
 * - a stored message's own fields (`mes`, `extra`, ...): an edit of its node, of the fields that changed;
 * - another swipe's text or `swipe_info` (`send_date`, `gen_started`, `gen_finished`, `extra`): an edit of that
 *   swipe's node;
 * - a swipe added (no id): a new alternative beside the message; a swipe removed: that alternative deleted (with what
 *   is below it, as deleting a swipe here does); a swipe chosen (`swipe_id`): it is chosen, on the chat's last stored
 *   message only (anywhere else it would switch the branch the rest of the chat is on);
 * - a message pushed after the last stored one: appended there; one spliced in between two stored ones: put between
 *   them; a message removed: cut from the chat's path;
 * - `chat_metadata`: its changed keys.
 * Nothing the page must not write is sent: a reply being generated, a send being stored, a reply the server couldn't
 * store, a send that failed. What can't be addressed unambiguously (a node named twice, a message the page has no
 * stored copy of, a removal while a reply is generated, ...) is refused, and a warning names each.
 * @param {object} options
 * @param {number} options.upTo Only messages before this index are looked at (upstream's `mesId`); none is deleted.
 * @param {ChatMessage[]|null} options.chatData Messages to store in place of `chat` (upstream's `chatData`): only their
 * edits, by node id.
 * @returns {Promise<void>}
 */
async function storeChatChanges({ upTo, chatData }) {
    /** @type {string[]} */
    const notSaved = [];
    const live = chatData === null;
    const messages = live ? chat : chatData;
    const end = Math.min(upTo, messages.length);
    const whole = live && end === chat.length;
    const busy = generating();
    const pending = live ? replyInFlightIndex() : -1;
    const name = (/** @type {number} */ i, /** @type {number} [k] */ k) => (k === undefined ? t`message #${i}` : t`swipe ${k + 1} of message #${i}`);

    // Messages the page doesn't write: the server stores them (or stores them again).
    const inFlight = (/** @type {number} */ i) => {
        const m = messages[i];
        if (!live) return false;
        if (i === pending) return true;
        if (isStoredNodeId(m.node_id)) return false;
        if (typeof m.extra?.reply_not_saved === 'string' || isFailedSend(m) || storeRefOf(m) !== undefined) return true;
        return busy && i === chat.length - 1 && m.is_user !== true;
    };

    const counts = new Map();
    for (let i = 0; i < end; i++) {
        const id = messages[i]?.node_id;
        if (isStoredNodeId(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    let lastStored = -1;
    for (let i = 0; i < end; i++) if (isStoredNodeId(messages[i]?.node_id) && !inFlight(i)) lastStored = i;

    /** @type {{ node_id: string, patch: Record<string, any>, unset: string[], what: string, mesId: number }[]} */
    const edits = [];
    /** @type {{ mesId: number, k: number, content: Record<string, any> }[]} */
    const added = [];
    /** @type {{ mesId: number, id: string }[]} */
    const removedAlternatives = [];
    /** @type {{ mesId: number, id: string, newSlot: number|null }|null} */
    let chosen = null;
    /** Messages each change of which was stated, to take as stored once all of them are. @type {Set<number>} */
    const planned = new Set();
    /** Ids a message of the page holds (shown or as a swipe): never taken for removed. @type {Set<string>} */
    const held = new Set();

    for (let i = 0; i < end; i++) {
        const m = messages[i];
        if (!m || typeof m !== 'object') continue;
        if (inFlight(i)) {
            if (isStoredNodeId(m.node_id)) held.add(m.node_id);
            for (const id of alternativesOf(m).slots.keys()) held.add(id);
            continue;
        }
        if (isProvisionalNodeId(m.node_id)) {
            // A card greeting with no row: stored once its text was changed (as a new opening).
            const at = m.swipe_id ?? 0;
            const said = /** @type {any} */ (m.swipe_info?.[at])?.name ?? m.name;
            if (live && m.node_id !== provisionalNodeId(said, m.mes)) {
                if (!await chatOpEdit(i).catch(() => false)) notSaved.push(name(i));
            }
            continue;
        }
        if (!isStoredNodeId(m.node_id)) continue;
        const nodeId = /** @type {string} */ (m.node_id);
        const { swipes, shown, slots } = alternativesOf(m);
        held.add(nodeId);
        for (const id of slots.keys()) held.add(id);
        if (counts.get(nodeId) > 1) {
            notSaved.push(t`${name(i)}: another message names the same stored message`);
            continue;
        }
        const stored = _messageSnapshots.get(nodeId);
        if (stored === undefined) {
            notSaved.push(t`${name(i)}: the page has no stored copy to compare it with`);
            continue;
        }
        const before = alternativesOf(stored);
        const now = contentOf(m);
        let complete = true;

        /** The stored fields of an alternative of the stored message, as its slot (null when it wasn't loaded). */
        const storedSlot = (/** @type {string} */ id) => {
            if (id === nodeId) return shownSlotOf(contentOf(stored));
            const k0 = before.slots.get(id);
            return k0 === undefined || typeof stored.swipes?.[k0] !== 'string' ? null : slotOf(stored, k0);
        };
        const edit = (/** @type {string} */ id, /** @type {{ patch: Record<string, any>, unset: string[] }|null} */ change, /** @type {string} */ what) => {
            if (change === null) return;
            if (typeof change.patch.mes === 'string' && change.patch.mes === '') {
                notSaved.push(t`${what}: its text was emptied`);
                complete = false;
                return;
            }
            edits.push({ node_id: id, ...change, what, mesId: i });
        };

        // The shown alternative.
        if (shown === nodeId) {
            edit(nodeId, patchOf(contentOf(stored), now), name(i));
        } else {
            const lastOne = i === lastStored;
            if (!live || !lastOne) {
                notSaved.push(live
                    ? t`${name(i)}: the swipe shown was changed, but other messages follow it (that would switch the branch they are on)`
                    : t`${name(i)}: the swipe shown was changed`);
                complete = false;
            } else if (shown === null) {
                chosen = { mesId: i, id: '', newSlot: m.swipe_id ?? 0 };
            } else {
                const base = storedSlot(shown);
                if (base === null) {
                    notSaved.push(t`${name(i)}: the swipe shown isn't one the page has a stored copy of`);
                    complete = false;
                } else {
                    edit(shown, patchOf(base, shownSlotOf(now)), name(i, m.swipe_id ?? 0));
                    chosen = { mesId: i, id: shown, newSlot: null };
                }
            }
        }

        // The other swipes: edited by their own ids, added when they have none.
        for (let k = 0; k < swipes.length; k++) {
            if (k === (m.swipe_id ?? 0) || typeof swipes[k] !== 'string') continue;
            const id = slotId(m, k);
            if (id === null) {
                if (swipes[k].length === 0) continue;
                if (!live) {
                    notSaved.push(t`${name(i, k)}: a new swipe`);
                    complete = false;
                } else {
                    added.push({ mesId: i, k, content: newAlternativeOf(m, k) });
                }
                continue;
            }
            const base = storedSlot(id);
            // A swipe not loaded when the page stored the message (filled in since) has nothing to compare with.
            if (base === null) continue;
            edit(id, patchOf(base, slotOf(m, k)), name(i, k));
        }

        // Swipes removed: their alternatives deleted. Not when the message no longer carries swipes at all (it was
        // replaced whole), or when swipes were also added without ids (a list rebuilt: which is which can't be told).
        const gone = [...before.slots.keys()].filter(id => id !== nodeId && id !== shown && !slots.has(id));
        if (gone.length) {
            if (!live || !Array.isArray(m.swipes) || added.some(a => a.mesId === i)) {
                notSaved.push(t`${name(i)}: ${gone.length} swipe(s) left out weren't deleted (which swipes were meant can't be told)`);
                complete = false;
            } else {
                for (const id of gone) removedAlternatives.push({ mesId: i, id });
            }
        }
        if (complete) planned.add(i);
    }

    // 1. Edits, by node id, in one request.
    const refused = await chatOpPatch(edits.map(({ node_id, patch, unset }) => ({ node_id, patch, unset }))).catch(error => {
        console.error('[saveChat] Could not store the edits:', error);
        return edits.map(e => ({ node_id: e.node_id, reason: 'the request failed' }));
    });
    for (const r of refused) {
        const e = edits.find(x => x.node_id === r.node_id);
        if (e) {
            notSaved.push(`${e.what}: ${r.reason}`);
            planned.delete(e.mesId);
        }
    }

    // 2. Swipes added: alternatives beside their message, which takes their ids.
    for (const { mesId, k, content } of added) {
        const message = chat[mesId];
        const id = isStoredNodeId(message?.node_id)
            ? await chatOpAddAlternativeBeside(/** @type {string} */ (message.node_id), content).catch(() => null)
            : null;
        if (!isStoredNodeId(id)) {
            notSaved.push(name(mesId, k));
            planned.delete(mesId);
            continue;
        }
        const swipeInfo = [...(message.swipe_info ?? [])];
        swipeInfo[k] = { ...(swipeInfo[k] ?? {}), node_id: id };
        updateMessage(mesId, { swipe_info: swipeInfo });
    }

    // 3. Swipes removed.
    for (const { mesId, id } of removedAlternatives) {
        const ticket = await chatOpReadyAlternativeDelete(id).catch(() => null);
        const deleted = ticket !== null && await chatOpDeleteAlternativeNode(id, chat[mesId]?.node_id, ticket).catch(() => false);
        if (!deleted) {
            notSaved.push(t`${name(mesId)}: a swipe left out wasn't deleted`);
            planned.delete(mesId);
        }
    }

    // 4. Messages removed: the stored ones the page held and holds no more, cut from the chat's path (the server cuts
    // only what its path for this tab holds). Not for a part of the chat (`mesId`), and not while a reply is generated:
    // the page shows less of the chat then than the server has; they stay the page's to cut on the next save.
    const removed = [..._messageSnapshots.keys()].filter(id => isStoredNodeId(id) && !held.has(id) && !messages.some(m => m?.node_id === id));
    if (removed.length && whole && busy) {
        console.info(`[saveChat] ${removed.length} message(s) left out of the chat are cut on the next save, once the reply being generated is stored.`);
    } else if (removed.length && whole) {
        const cut = await chatOpCutNamed(removed).catch(error => {
            console.error('[saveChat] Could not delete the messages left out:', error);
            return { not_on_path: [], refused: removed.map(id => ({ node_id: id, reason: 'the request failed' })) };
        });
        if (cut.refused.length) notSaved.push(t`${cut.refused.length} message(s) left out of the chat weren't deleted`);
    }

    // 5. A swipe chosen on the chat's last stored message.
    if (chosen !== null) {
        const { mesId, newSlot } = chosen;
        let id = chosen.id;
        if (newSlot !== null) {
            const message = chat[mesId];
            const beside = isStoredNodeId(message?.node_id) ? /** @type {string} */ (message.node_id) : null;
            id = beside === null ? '' : await chatOpAddAlternativeBeside(beside, contentOf(message)).catch(() => null) ?? '';
            if (isStoredNodeId(id)) {
                const swipeInfo = [...(message.swipe_info ?? [])];
                swipeInfo[newSlot] = { ...(swipeInfo[newSlot] ?? {}), node_id: id };
                updateMessage(mesId, { swipe_info: swipeInfo });
            }
        }
        const followed = chat.slice(mesId + 1).some(m => !isStoredNodeId(m.node_id));
        let ok = isStoredNodeId(id);
        if (ok && followed) {
            ok = await chatOpSelect(mesId, chat[mesId].swipe_id ?? 0).catch(() => false);
        } else if (ok) {
            updateMessage(mesId, { node_id: id });
            // As swiping does: the chat goes on below the chosen swipe as far as the tree has it.
            await _restoreContinuation(mesId).catch(() => false);
        }
        if (!ok) {
            notSaved.push(t`${name(mesId)}: the swipe shown wasn't chosen`);
            planned.delete(mesId);
        }
    }

    // 6. Messages added: each run after the stored message before it, or between it and the one after.
    if (live) {
        let a = 0;
        while (a < end) {
            if (isStoredNodeId(chat[a].node_id) || isProvisionalNodeId(chat[a].node_id) || inFlight(a)) {
                a++;
                continue;
            }
            let b = a;
            while (b + 1 < end && !isStoredNodeId(chat[b + 1].node_id) && !isProvisionalNodeId(chat[b + 1].node_id) && !inFlight(b + 1)) b++;
            await storeAddedRun(a, b, notSaved, inFlight);
            a = b + 1;
        }
    } else {
        for (let i = 0; i < end; i++) {
            if (!isStoredNodeId(messages[i]?.node_id)) notSaved.push(t`${name(i)}: it isn't stored, and the messages saved aren't the open chat's`);
        }
    }

    // What every change was stated for is as stored now.
    for (const i of planned) {
        const m = chat[i];
        if (live && isStoredNodeId(m?.node_id)) markStoredAs(/** @type {string} */ (m.node_id), m);
    }

    if (notSaved.length) warnNotSaved(notSaved, t`Not saved`);
}

/**
 * Stores the messages `chat[a..b]` an extension added (none of them stored): after the stored message before them, or
 * between it and the stored one after them. A chat with nothing stored takes the first as its opening.
 * @param {number} a
 * @param {number} b
 * @param {string[]} notSaved What isn't stored is added here.
 * @param {(i: number) => boolean} inFlight
 */
async function storeAddedRun(a, b, notSaved, inFlight) {
    const what = t`${b - a + 1} message(s) from #${a}`;
    let from = a;
    let prev = a - 1;
    if (prev >= 0 && inFlight(prev)) {
        notSaved.push(t`${what}: they follow a message the server hasn't stored`);
        return;
    }
    if (prev >= 0 && isProvisionalNodeId(chat[prev].node_id)) await ensureOpeningRow(prev).catch(() => null);
    if (prev < 0 && !chat.some(x => isStoredNodeId(x.node_id))) {
        // A chat with nothing stored: its first message is its opening.
        updateMessage(a, { node_id: provisionalNodeId(chat[a].name, chat[a].mes) });
        if (!isStoredNodeId(await ensureOpeningRow(a).catch(() => null))) {
            notSaved.push(what);
            return;
        }
        prev = a;
        from = a + 1;
        if (from > b) return;
    }
    const after = prev >= 0 && isStoredNodeId(chat[prev].node_id) ? /** @type {string} */ (chat[prev].node_id) : null;
    if (after === null) {
        notSaved.push(t`${what}: nothing stored comes before them`);
        return;
    }
    try {
        if (!chat.slice(b + 1).some(x => isStoredNodeId(x.node_id))) {
            const ids = (await chatOpAppendAfter(after, from, b + 1, { silent: true })).node_ids;
            if (ids.length !== b + 1 - from) notSaved.push(what);
            return;
        }
        // Put between two stored messages, the last first, so each has a stored message after it.
        for (let k = b; k >= from; k--) {
            if (!isStoredNodeId(await chatOpGraft(k, { silent: true }))) {
                notSaved.push(t`message #${k}`);
                return;
            }
        }
    } catch (error) {
        console.error('[saveChat] Could not store the messages added:', error);
        notSaved.push(what);
    }
}

/**
 * Upstream's save of the chat under another name (`chatName`): a chat of its own holding `messages`. Here a chat is a
 * bookmark: one labelled so at their last message, when every one of them is stored as the page has it; otherwise
 * nothing (which isn't stored is named in a warning).
 * @param {string} label
 * @param {ChatMessage[]} messages
 * @param {Record<string, unknown>} withMetadata
 * @returns {Promise<string|undefined>} The bookmark's compat chat id.
 */
async function storeNamedChat(label, messages, withMetadata) {
    /** @type {string[]} */
    const notSaved = [];
    for (const [i, m] of messages.entries()) {
        const id = m?.node_id;
        const stored = isStoredNodeId(id) ? _messageSnapshots.get(/** @type {string} */ (id)) : undefined;
        if (stored === undefined) notSaved.push(t`message #${i}: it isn't stored`);
        else if (patchOf(contentOf(stored), contentOf(m)) !== null) notSaved.push(t`message #${i}: it differs from the stored one, which the open chat shows`);
    }
    const unstorable = notSaved.length > 0;
    const metadata = Object.keys(withMetadata).filter(key => !DERIVED_METADATA.has(key) && JSON.stringify(withMetadata[key]) !== JSON.stringify(chat_metadata[key]));
    if (metadata.length) notSaved.push(t`chat metadata ${metadata.join(', ')}: a chat's metadata is the open chat's where they meet`);
    const last = messages[messages.length - 1];
    let id = null;
    if (!unstorable && isStoredNodeId(last?.node_id)) {
        id = await chatOpBookmarkNode(/** @type {string} */ (last.node_id), label).catch(() => null);
        if (id === null) notSaved.push(t`the chat "${label}" could not be made`);
    } else if (messages.length === 0) {
        notSaved.push(t`the chat "${label}" has no messages`);
    }
    if (notSaved.length) warnNotSaved(notSaved, id === null ? t`Chat "${label}" not saved` : t`Not saved`);
    return id ?? undefined;
}

/** Compat saves run one after another, each comparing against what the one before stored. */
let saveChain = Promise.resolve();

/**
 * Saves the chat, as upstream's does for the code that changed `chat` itself: what changed goes to the server as
 * actions addressed by node id (see storeChatChanges()), never the chat itself. The app's own code doesn't call it.
 * @param {object} [options] - Additional options.
 * @param {string} [options.chatName] The name of the chat to save to: another than the open one is a bookmark of
 * that name at the last message saved (storeNamedChat()).
 * @param {object} [options.withMetadata] Additional metadata to save with the chat
 * @param {number} [options.mesId] The message ID to save the chat up to: only messages up to it are looked at
 * @param {boolean} [options.force] Accepted as upstream's; a node-addressed change has no integrity to override
 * @param {ChatMessage[]} [options.chatData] Chat snapshot to save instead of the current in-memory chat
 * @param {boolean} [options.unique] Accepted; a bookmark's label may repeat, so it never collides
 * @returns {Promise<string|void>} The chat saved: its compat chat id.
 */
export async function saveChat({ chatName, withMetadata, mesId, force = false, chatData = undefined, unique = false } = {}) {
    if (selected_group != null) {
        toastr.error(t`Operation was aborted to prevent data corruption.`, t`saveChat called for a group chat`);
        throw new Error('saveChat called for a group chat');
    }

    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('saveChat called with positional arguments. Please use an object instead.');
        [chatName, withMetadata, mesId, force] = arguments;
    }
    void force;
    void unique;

    if (getSelectionState().type === 'none' && name2 === neutralCharacterName) {
        // Checking selection state, not the chat name: a character left selected from before could fall through to a real save under it.
        return;
    }
    const character = getCurrentCharacter();
    if (!character) return;
    charactersStore.update(character.avatar, { date_last_chat: Date.now() });
    return storeCompat({ chatName, withMetadata, mesId, chatData });
}

/**
 * The compat save of the open chat (a character's or a group's), or of a named one.
 * @param {{ chatName?: string, withMetadata?: object, mesId?: number, chatData?: ChatMessage[] }} options
 * @returns {Promise<string|void>}
 */
function storeCompat({ chatName, withMetadata, mesId, chatData }) {
    const run = async () => {
        const open = getCurrentChatId();
        const extra = withMetadata && typeof withMetadata === 'object' ? /** @type {Record<string, unknown>} */ (withMetadata) : {};
        const upTo = mesId !== undefined && mesId >= 0 && mesId < chat.length ? Number(mesId) + 1 : chat.length;
        try {
            if (chatName !== undefined && chatName !== '' && chatName !== open) {
                const messages = Array.isArray(chatData) ? chatData : chat.slice(0, upTo);
                return await storeNamedChat(chatName, messages, extra);
            }
            await storeChatChanges({ upTo, chatData: Array.isArray(chatData) ? chatData : null });
            Object.assign(chat_metadata, Object.fromEntries(Object.entries(extra).filter(([key]) => !DERIVED_METADATA.has(key))));
            await saveMetadata();
            return getCurrentChatId() ?? undefined;
        } catch (error) {
            console.error(error);
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Chat could not be saved`);
        }
    };
    const chained = saveChain.then(run, run);
    saveChain = chained.then(() => undefined, () => undefined);
    return chained;
}

/**
 * Saves the open chat as upstream does: saveChat() for a character's, the same node-addressed actions for a group's.
 * Waits for a save already running.
 * @param {object} [_options] Kept for callers that pass `{ heal }`; every save stores what changed.
 */
export async function saveChatConditional(_options = {}) {
    try {
        await waitUntilCondition(() => !isChatSaving, DEFAULT_SAVE_EDIT_TIMEOUT, 100);
    } catch {
        console.warn('Timeout waiting for chat to save');
        return;
    }

    try {
        cancelDebouncedChatSave();
        isChatSaving = true;
        if (selected_group != null) {
            await storeCompat({});
        } else {
            await saveChat();
        }
        // Save token cache to IndexedDB storage
        saveTokenCache();
    } catch (error) {
        console.error('Error saving chat', error);
    } finally {
        isChatSaving = false;
    }
}

/**
 * Cancels the debounced chat save if it is currently pending.
 */
export function cancelDebouncedChatSave() {
    if (chatSaveTimeout) {
        clearTimeout(chatSaveTimeout);
        chatSaveTimeout = null;
    }
}

/**
 * True while a save asked for through saveChatDebounced() (by an extension) hasn't run yet.
 * @returns {boolean} Whether a chat save is currently scheduled.
 */
export function isChatSaveScheduled() {
    return !!chatSaveTimeout;
}

/** The saved state the scheduled save is for, so a save for another chat never runs on this one. */
let scheduledFor = { avatar: /** @type {string|undefined} */ (undefined), group: /** @type {string|null|undefined} */ (undefined) };

/**
 * Upstream's debounced saveChatConditional(), for extensions.
 */
export function saveChatDebounced() {
    scheduledFor = { avatar: this_avatar, group: selected_group };
    cancelDebouncedChatSave();
    chatSaveTimeout = setTimeout(runScheduledSave, DEFAULT_SAVE_EDIT_TIMEOUT);
}

async function runScheduledSave() {
    chatSaveTimeout = null;
    if (scheduledFor.group !== selected_group) {
        console.warn('Chat save timeout triggered, but group changed. Aborting.');
        return;
    }
    if (scheduledFor.avatar !== this_avatar) {
        console.warn('Chat save timeout triggered, but the selected character changed. Aborting.');
        return;
    }
    await saveChatConditional();
}

/**
 * Runs a save an extension scheduled (saveChatDebounced()) now, when one is, before something reads what the server
 * stores (an export, a reload).
 */
export async function flushScheduledChatSave() {
    if (!isChatSaveScheduled()) return;
    cancelDebouncedChatSave();
    await runScheduledSave();
}

/**
 * Upstream's save of a group's chat (group-chats.js exports it): the open group's, as saveChatConditional() saves it.
 * The open chat is the only one the page holds, so a call for any other group saves nothing, with a warning.
 * @param {string} groupId Group ID
 * @param {boolean} shouldSaveGroup Whether to save the group after saving the chat
 * @param {boolean} [_force=false] Kept for upstream callers: a node-addressed change has no integrity to override
 * @returns {Promise<void>}
 */
export async function saveGroupChat(groupId, shouldSaveGroup, _force = false) {
    if (!groupsStore.has(groupId)) {
        console.warn('Group not found', groupId);
        return;
    }
    if (groupId !== selected_group) {
        console.warn('saveGroupChat: only the open group\'s chat is held by the page; nothing was saved for', groupId);
    } else {
        await saveChatConditional();
    }
    if (shouldSaveGroup) {
        await editGroup(groupId, false, false);
    }
}
