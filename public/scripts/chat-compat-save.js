// The app's own code never calls these (an eslint rule says so): it sends the action for what it changed where it

import {
    DEFAULT_SAVE_EDIT_TIMEOUT, getCurrentCharacter, getCurrentChatId, getSelectionState, is_send_press, name2, neutralCharacterName,
} from '../script.js';
import { chat, chat_metadata } from './chat-state.js';
import { charactersStore, this_avatar } from './character-store.js';
import {
    _restoreContinuation, chatOpAddAlternativeBeside, chatOpAppendAfter, chatOpBookmarkNode, chatOpCutNamed, chatOpDeleteAlternativeNode,
    chatOpEdit, chatOpGraft, chatOpPatch, chatOpReadyAlternativeDelete, chatOpSelect, contentOf, ensureOpeningRow, extraOf, patchOf,
    storeRefOf, updateMessage,
} from './chat-store.js';
import { isFailedSend } from './failed-sends.js';
import { _messageSnapshots, markStoredAs, replyInFlightIndex, streamingProcessor } from './generation.js';
import { editGroup, groupsStore, selected_group } from './group-chats.js';
import { t } from './i18n.js';
import { saveMetadata } from './metadata-store.js';
import { isProvisionalNodeId, isStoredNodeId, provisionalNodeId } from './node-identity.js';
import { saveTokenCache } from './tokenizers.js';
import { escapeHtml, waitUntilCondition } from './utils.js';

export let isChatSaving = false;

/** @type {ReturnType<typeof setTimeout>|null} */
let chatSaveTimeout = null;

const SLOT_FIELDS = ['send_date', 'gen_started', 'gen_finished'];
const DERIVED_METADATA = new Set(['integrity', 'main_chat', 'fork_point', '_tree_stored']);

/**
 * @param {string[]} notSaved
 * @param {string} title
 */
function warnNotSaved(notSaved, title) {
    console.warn('[saveChat] Not saved:', notSaved);
    toastr.warning(notSaved.map(x => escapeHtml(x)).join('<br>'), title, { escapeHtml: false, timeOut: 15000, preventDuplicates: true });
}


/**
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
 * @param {Record<string, any>} content
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
 * @param {ChatMessage} message
 * @param {number} k
 * @returns {string|null}
 */
function slotId(message, k) {
    const id = message.swipe_info?.[k]?.node_id;
    return isStoredNodeId(id) ? /** @type {string} */ (id) : null;
}

/**
 * @param {ChatMessage} message
 */
function alternativesOf(message) {
    const swipes = Array.isArray(message.swipes) ? message.swipes : [];
    const selected = Number.isInteger(message.swipe_id) ? /** @type {number} */ (message.swipe_id) : 0;
    const own = isStoredNodeId(message.node_id) ? /** @type {string} */ (message.node_id) : null;
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

function generating() {
    return is_send_press || streamingProcessor !== null || replyInFlightIndex() >= 0;
}

/**
 * @param {object} options
 * @param {number} options.upTo
 * @param {ChatMessage[]|null} options.chatData
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
    const name = (/** @type {number} */ i, /** @type {number} */ k) => (k === undefined ? t`message #${i}` : t`swipe ${k + 1} of message #${i}`);

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
    /** @type {Set<number>} */
    const planned = new Set();
    /** @type {Set<string>} */
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
            if (base === null) continue;
            edit(id, patchOf(base, slotOf(m, k)), name(i, k));
        }

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

    for (const { mesId, id } of removedAlternatives) {
        const ticket = await chatOpReadyAlternativeDelete(id).catch(() => null);
        const deleted = ticket !== null && await chatOpDeleteAlternativeNode(id, chat[mesId]?.node_id, ticket).catch(() => false);
        if (!deleted) {
            notSaved.push(t`${name(mesId)}: a swipe left out wasn't deleted`);
            planned.delete(mesId);
        }
    }

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
            await _restoreContinuation(mesId).catch(() => false);
        }
        if (!ok) {
            notSaved.push(t`${name(mesId)}: the swipe shown wasn't chosen`);
            planned.delete(mesId);
        }
    }

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

    for (const i of planned) {
        const m = chat[i];
        if (live && isStoredNodeId(m?.node_id)) markStoredAs(/** @type {string} */ (m.node_id), m);
    }

    if (notSaved.length) warnNotSaved(notSaved, t`Not saved`);
}

/**
 * @param {number} a
 * @param {number} b
 * @param {string[]} notSaved
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
 * @param {string} label
 * @param {ChatMessage[]} messages
 * @param {Record<string, unknown>} withMetadata
 * @returns {Promise<string|undefined>}
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

let saveChain = Promise.resolve();

/**
 * @param {object} [options]
 * @param {string} [options.chatName]
 * @param {object} [options.withMetadata]
 * @param {number} [options.mesId]
 * @param {boolean} [options.force]
 * @param {ChatMessage[]} [options.chatData]
 * @param {boolean} [options.unique]
 * @returns {Promise<string|void>}
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
        return;
    }
    const character = getCurrentCharacter();
    if (!character) return;
    charactersStore.update(character.avatar, { date_last_chat: Date.now() });
    return storeCompat({ chatName, withMetadata, mesId, chatData });
}

/**
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
 * @param {object} [_options]
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
        saveTokenCache();
    } catch (error) {
        console.error('Error saving chat', error);
    } finally {
        isChatSaving = false;
    }
}

export async function storePageChatChanges() {
    await saveChatConditional();
}

export function cancelDebouncedChatSave() {
    if (chatSaveTimeout) {
        clearTimeout(chatSaveTimeout);
        chatSaveTimeout = null;
    }
}

/**
 * @returns {boolean}
 */
export function isChatSaveScheduled() {
    return !!chatSaveTimeout;
}

let scheduledFor = { avatar: /** @type {string|undefined} */ (undefined), group: /** @type {string|null|undefined} */ (undefined) };

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
 * @param {string} groupId
 * @param {boolean} shouldSaveGroup
 * @param {boolean} [_force=false]
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
