// A message the user sent that the server didn't store. It stays where it was sent, marked, with a notice
// that never fades: "Save it again" or "Discard". It is kept in browser storage, keyed to the chat, until
// one of them succeeds, so a reload brings it back where it was. If the chat has moved on since (something
// was added after the message it followed, or that message is gone), it is shown at the end instead, never
// moved or sent on its own: "Send here", "Send as reply to that message" (a new branch) or "Discard". If
// the message it followed is only on another branch, the chat shows a notice with a way to go there.
//
// Every retry sends the message's send key (the ref it got when the user sent it), so a send the server
// had stored after all is answered with the stored message instead of being stored twice.

// What it needs from the rest of the page is handed to initFailedSends() rather than imported, so that
// script.js and generation.js can import this module without adding import cycles.
import { chat } from './chat-state.js';
import { eventSource, event_types } from './events.js';
import { getRequestHeaders } from './request-headers.js';

/**
 * @typedef {object} FailedSendsDeps
 * @property {typeof import('../script.js').addOneMessage} addOneMessage
 * @property {typeof import('../script.js').deleteMessage} deleteMessage
 * @property {typeof import('../script.js').getCurrentChatContext} getCurrentChatContext
 * @property {typeof import('../script.js').redisplayChat} redisplayChat
 * @property {typeof import('../script.js').reloadCurrentChat} reloadCurrentChat
 * @property {typeof import('../script.js').updateViewMessageIds} updateViewMessageIds
 * @property {typeof import('./node-navigation.js').switchToNode} switchToNode
 * @property {typeof import('./chat-store.js').chatOpAppendAfter} chatOpAppendAfter
 * @property {typeof import('./chat-store.js').chatOpGraft} chatOpGraft
 * @property {typeof import('./chat-store.js').ensureOpeningRow} ensureOpeningRow
 * @property {typeof import('./chat-store.js').setSendStoredListener} setSendStoredListener
 * @property {typeof import('./chat-store.js').setStoreRef} setStoreRef
 * @property {typeof import('./chat-store.js').storeRefOf} storeRefOf
 * @property {typeof import('./node-identity.js').isStoredNodeId} isStoredNodeId
 * @property {typeof import('./node-identity.js').isProvisionalNodeId} isProvisionalNodeId
 * @property {typeof import('./i18n.js').t} t
 * @property {(text: string) => Promise<boolean>} confirmDiscard
 */

/** @type {FailedSendsDeps} */
let deps;

/**
 * @typedef {object} FailedSend
 * @property {string} key The send key.
 * @property {'append'|'graft'} kind Sent at the end of the chat, or between two messages (`/send at=`).
 * @property {object} message The message as it was on screen, without a node id.
 * @property {string|null} after The node of the message it followed.
 * @property {string|null} before `graft`: the node of the message it preceded.
 * @property {string} afterText The start of the text of the message it followed, to name it by.
 */

/** @typedef {import('./chat-draft.js').DraftContext} DraftContext */

/**
 * How a failed send is shown: at its place (`spot`), at the end because its place is gone (`moved`), or
 * only named, because the message it followed is on another branch (`elsewhere`).
 * @typedef {'spot'|'moved'|'elsewhere'} FailedSendMode
 */

const STORAGE_PREFIX = 'FailedSends';
const AFTER_TEXT_LENGTH = 60;

/** The notices on screen, by send key. @type {Map<string, { toast: JQuery, mode: FailedSendMode }>} */
const notices = new Map();

/** Send keys the server said it stored, this page load. @type {Set<string>} */
const storedKeys = new Set();

/** @param {DraftContext} context */
function storageKey(context) {
    return `${STORAGE_PREFIX}:${context.type}:${context.id}:${context.chatId}`;
}

/**
 * @param {DraftContext|null} context
 * @returns {FailedSend[]}
 */
function readEntries(context) {
    if (!context) return [];
    try {
        const parsed = JSON.parse(localStorage.getItem(storageKey(context)) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter(entry => typeof entry?.key === 'string' && entry.message) : [];
    } catch {
        return [];
    }
}

/**
 * @param {DraftContext} context
 * @param {FailedSend[]} entries
 */
function writeEntries(context, entries) {
    try {
        if (entries.length) {
            localStorage.setItem(storageKey(context), JSON.stringify(entries));
        } else {
            localStorage.removeItem(storageKey(context));
        }
    } catch {
        toastr.error(deps.t`Your unsaved message can't be kept for after a reload: the browser's storage is unavailable or full. Save it or copy its text before reloading.`, deps.t`Message not kept`, { timeOut: 0, extendedTimeOut: 0 });
    }
}

/** @param {DraftContext|null} a @param {DraftContext|null} b */
function sameContext(a, b) {
    return !!a && !!b && storageKey(a) === storageKey(b);
}

/** @param {string} key */
function indexOfKey(key) {
    return chat.findIndex(message => deps.storeRefOf(message) === key);
}

/** @param {object} message */
function plainMessage(message) {
    const plain = JSON.parse(JSON.stringify(message));
    delete plain.node_id;
    return plain;
}

/** @param {string} text */
function shortText(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > AFTER_TEXT_LENGTH ? `${flat.slice(0, AFTER_TEXT_LENGTH)}…` : flat;
}

/**
 * Keeps a send the server didn't store, and shows it as not saved when its chat is open.
 * @param {object} params
 * @param {string|undefined} params.key The message's send key.
 * @param {'append'|'graft'} params.kind
 * @param {DraftContext|null} [params.context] The chat it was sent in; the open one when left out.
 * @param {object} [params.message] The message, when it may no longer be on screen.
 */
export function keepFailedSend({ key, kind, context = undefined, message = undefined }) {
    context ??= deps.getCurrentChatContext();
    if (typeof key !== 'string' || storedKeys.has(key) || !context) return;

    const open = sameContext(context, deps.getCurrentChatContext());
    const index = open ? indexOfKey(key) : -1;
    const shown = index >= 0 ? chat[index] : message;
    if (!shown) return;

    const previous = index > 0 ? chat[index - 1] : null;
    /** @type {FailedSend} */
    const entry = {
        key,
        kind,
        message: plainMessage(shown),
        after: previous?.node_id ?? null,
        before: kind === 'graft' && index >= 0 ? chat[index + 1]?.node_id ?? null : null,
        afterText: shortText(previous?.mes),
    };
    writeEntries(context, [...readEntries(context).filter(e => e.key !== key), entry]);

    if (index >= 0) {
        showNotice(entry, 'spot');
        markShown();
    }
}

/**
 * @param {object|undefined} message
 * @returns {boolean} Whether this message is a send the server hasn't stored yet.
 */
export function isFailedSend(message) {
    const key = deps.storeRefOf(message);
    return typeof key === 'string' && readEntries(deps.getCurrentChatContext()).some(entry => entry.key === key);
}

/**
 * @param {string|undefined} key
 * @returns {boolean} Whether the server said it stored the send with this key.
 */
export function wasSendStored(key) {
    return typeof key === 'string' && storedKeys.has(key);
}

/** @param {string} key */
function forget(key) {
    const context = deps.getCurrentChatContext();
    if (context) {
        const entries = readEntries(context);
        if (entries.some(entry => entry.key === key)) {
            writeEntries(context, entries.filter(entry => entry.key !== key));
        }
    }
    clearNotice(key);
    markShown();
}

/** @param {string} key */
function clearNotice(key) {
    const notice = notices.get(key);
    if (!notice) return;
    notices.delete(key);
    toastr.clear(notice.toast, { force: true });
}

/** Marks the failed sends on screen, and unmarks what no longer is one. */
function markShown() {
    const keys = new Set(readEntries(deps.getCurrentChatContext()).map(entry => entry.key));
    $('#chat .mes.failed_send').each(function () {
        const index = Number($(this).attr('mesid'));
        if (!keys.has(deps.storeRefOf(chat[index]) ?? '')) {
            $(this).removeClass('failed_send').removeAttr('title').find('.failed_send_note').remove();
        }
    });
    for (const entry of readEntries(deps.getCurrentChatContext())) {
        const index = indexOfKey(entry.key);
        if (index < 0) continue;
        const element = $(`#chat .mes[mesid="${index}"]`);
        element.addClass('failed_send').attr('title', deps.t`Not saved`);
        const note = notices.get(entry.key)?.mode === 'moved' ? writtenAfterNote(entry) : '';
        const noteElement = element.find('.failed_send_note');
        if (!note) {
            noteElement.remove();
        } else if (noteElement.length) {
            noteElement.text(note);
        } else {
            element.find('.mes_block').prepend($('<div class="failed_send_note"></div>').text(note));
        }
    }
}

/** @param {FailedSend} entry */
function writtenAfterNote(entry) {
    return entry.after && chat.some(message => message.node_id === entry.after)
        ? deps.t`Not saved. Written after "${entry.afterText}".`
        : deps.t`Not saved. Written after a message that's no longer there.`;
}

/**
 * @param {FailedSend} entry
 * @param {FailedSendMode} mode
 */
function showNotice(entry, mode) {
    const existing = notices.get(entry.key);
    if (existing?.mode === mode) return;
    clearNotice(entry.key);

    const afterOnScreen = !!entry.after && chat.some(message => message.node_id === entry.after);
    /** @type {string} */
    let text;
    /** @type {[string, () => Promise<void>][]} */
    let actions;
    if (mode === 'spot') {
        text = deps.t`Your message couldn't be saved. It stays here, also after a reload, until you save it or discard it.`;
        actions = [[deps.t`Save it again`, () => saveHere(entry, mode)], [deps.t`Discard`, () => discard(entry)]];
    } else if (mode === 'moved') {
        text = afterOnScreen
            ? deps.t`Your message couldn't be saved. It was written after "${entry.afterText}", which is no longer the end of this chat.`
            : deps.t`Your message couldn't be saved. It was written after a message that's no longer there.`;
        actions = [[deps.t`Send here`, () => saveHere(entry, mode)]];
        if (afterOnScreen && deps.isStoredNodeId(entry.after)) actions.push([deps.t`Send as reply to that message`, () => replyTo(entry)]);
        actions.push([deps.t`Discard`, () => discard(entry)]);
    } else {
        text = deps.t`You have an unsaved message on another branch of this chat.`;
        actions = [[deps.t`Go to it`, () => jumpTo(entry)]];
    }

    const toast = toastr.error(text, mode === 'elsewhere' ? deps.t`Unsaved message` : deps.t`Message not saved`, { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: false });
    const message = $('<div></div>').text(text);
    const buttons = actions.map(([label, run]) => $('<button type="button" class="menu_button"></button>').text(label).on('click', async () => {
        buttons.forEach(button => button.prop('disabled', true));
        try {
            await run();
        } finally {
            buttons.forEach(button => button.prop('disabled', false));
        }
    }));
    toast.find('.toast-message').empty().append(message, ...buttons);
    notices.set(entry.key, { toast, mode });
}

/** @param {string} key @param {string} text */
function setNoticeText(key, text) {
    notices.get(key)?.toast.find('.toast-message > div').first().text(text);
}

/**
 * The nearest stored message before `index`, giving an unstored opening its row first.
 * @param {number} index
 * @returns {Promise<string|null>}
 */
async function storedBefore(index) {
    for (let i = index - 1; i >= 0; i--) {
        if (deps.isProvisionalNodeId(chat[i]?.node_id)) await deps.ensureOpeningRow(i);
        if (deps.isStoredNodeId(chat[i]?.node_id)) return chat[i].node_id;
    }
    return null;
}

/**
 * Stores the message where it is shown.
 * @param {FailedSend} entry
 * @param {FailedSendMode} mode
 */
async function saveHere(entry, mode) {
    const index = indexOfKey(entry.key);
    if (index < 0) {
        await placeFailedSends();
        return;
    }
    let saved = false;
    let reload = false;
    try {
        if (entry.kind === 'graft' && mode === 'spot' && index + 1 < chat.length) {
            saved = deps.isStoredNodeId(await deps.chatOpGraft(index, { silent: true }));
            reload = saved;
        } else {
            const after = await storedBefore(index);
            if (after) {
                const result = await deps.chatOpAppendAfter(after, index, index + 1, { silent: true });
                saved = deps.isStoredNodeId(result.node_ids[0]);
                reload = result.already_stored.length > 0;
            }
        }
    } catch (error) {
        console.error('Saving the message again failed:', error);
    }
    if (!saved) {
        setNoticeText(entry.key, deps.t`Saving it again didn't work. Your message is still kept here, also after a reload.`);
        return;
    }
    forget(entry.key);
    if (reload) await deps.reloadCurrentChat();
}

/**
 * Stores the message as a reply to the message it was written after, which starts a branch there, and goes to it.
 * @param {FailedSend} entry
 */
async function replyTo(entry) {
    const index = indexOfKey(entry.key);
    if (index < 0 || !deps.isStoredNodeId(entry.after)) return;
    /** @type {string|undefined} */
    let nodeId;
    try {
        nodeId = (await deps.chatOpAppendAfter(entry.after, index, index + 1, { silent: true })).node_ids[0];
    } catch (error) {
        console.error('Saving the message as a reply failed:', error);
    }
    if (!deps.isStoredNodeId(nodeId)) {
        setNoticeText(entry.key, deps.t`Saving it didn't work. Your message is still kept here, also after a reload.`);
        return;
    }
    forget(entry.key);
    await deps.deleteMessage(indexOfKey(entry.key), undefined, false, false, false);
    if (!await deps.switchToNode(nodeId)) {
        toastr.success(deps.t`Your message was saved as a reply to "${entry.afterText}", on a branch of its own.`);
    }
}

/** @param {FailedSend} entry */
async function discard(entry) {
    if (!await deps.confirmDiscard(deps.t`Discard this unsaved message? Its text will be gone.`)) return;
    const index = indexOfKey(entry.key);
    forget(entry.key);
    if (index >= 0) await deps.deleteMessage(index, undefined, false, false, false);
}

/** @param {FailedSend} entry */
async function jumpTo(entry) {
    if (entry.after && await deps.switchToNode(entry.after)) {
        await placeFailedSends();
        return;
    }
    toastr.error(deps.t`The branch with your unsaved message couldn't be opened.`);
}

/**
 * @param {string} nodeId
 * @returns {Promise<boolean|null>} Whether the node exists; null when that couldn't be asked.
 */
async function nodeExists(nodeId) {
    try {
        const response = await fetch('/api/chats/ancestry', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ node_id: nodeId }),
        });
        if (response.status === 404) return false;
        return response.ok ? true : null;
    } catch {
        return null;
    }
}

/** @param {FailedSend} entry */
function materialize(entry) {
    const message = structuredClone(entry.message);
    deps.setStoreRef(message, entry.key);
    return message;
}

let placing = Promise.resolve();

/**
 * Shows the open chat's failed sends: each at its place when the chat still has it, otherwise at the end
 * (or named, when the message it followed is on another branch). Runs once at a time.
 * @returns {Promise<void>}
 */
export function placeFailedSends() {
    placing = placing.then(placeNow, placeNow);
    return placing;
}

async function placeNow() {
    const context = deps.getCurrentChatContext();
    const entries = readEntries(context);
    const keys = new Set(entries.map(entry => entry.key));
    for (const key of [...notices.keys()]) {
        if (!keys.has(key)) clearNotice(key);
    }

    for (const entry of entries) {
        const index = indexOfKey(entry.key);
        if (index >= 0) {
            if (deps.isStoredNodeId(chat[index].node_id)) {
                forget(entry.key);
            } else if (!notices.has(entry.key)) {
                showNotice(entry, 'spot');
            }
            continue;
        }

        if (entry.kind === 'append' && entry.after && chat.length && chat[chat.length - 1].node_id === entry.after) {
            chat.push(materialize(entry));
            deps.addOneMessage(chat[chat.length - 1]);
            showNotice(entry, 'spot');
            continue;
        }

        const afterAt = entry.after ? chat.findIndex(message => message.node_id === entry.after) : -1;
        if (entry.kind === 'graft' && afterAt >= 0 && entry.before && chat[afterAt + 1]?.node_id === entry.before) {
            chat.splice(afterAt + 1, 0, materialize(entry));
            await deps.redisplayChat({ startIndex: afterAt + 1 });
            deps.updateViewMessageIds();
            showNotice(entry, 'spot');
            continue;
        }

        if (afterAt < 0 && deps.isStoredNodeId(entry.after) && await nodeExists(entry.after)) {
            showNotice(entry, 'elsewhere');
            continue;
        }

        chat.push(materialize(entry));
        deps.addOneMessage(chat[chat.length - 1]);
        showNotice(entry, 'moved');
    }
    markShown();
}

/** @param {number} mesId */
function onEdited(mesId) {
    const message = chat[Number(mesId)];
    const key = deps.storeRefOf(message);
    const context = deps.getCurrentChatContext();
    if (!key || !context) return;
    const entries = readEntries(context);
    const entry = entries.find(e => e.key === key);
    if (!entry) return;
    entry.message = plainMessage(message);
    writeEntries(context, entries);
    markShown();
}

/** A failed send the user deleted from the chat is discarded. */
function onDeleted() {
    for (const entry of readEntries(deps.getCurrentChatContext())) {
        const notice = notices.get(entry.key);
        if (notice && notice.mode !== 'elsewhere' && indexOfKey(entry.key) < 0) forget(entry.key);
    }
}

/**
 * Another tab changed this chat's failed sends: one that is gone was saved or discarded there, so the chat
 * is read again; one that is new is shown.
 * @param {StorageEvent} event
 */
async function onOtherTab(event) {
    const context = deps.getCurrentChatContext();
    if (!context || event.key !== storageKey(context)) return;
    const keys = new Set(readEntries(context).map(entry => entry.key));
    const goneFromScreen = [...notices.entries()].some(([key, notice]) => notice.mode !== 'elsewhere' && !keys.has(key) && indexOfKey(key) >= 0);
    if (goneFromScreen) {
        await deps.reloadCurrentChat();
        return;
    }
    await placeFailedSends();
}

/** @param {FailedSendsDeps} dependencies */
export function initFailedSends(dependencies) {
    deps = dependencies;
    deps.setSendStoredListener((key) => {
        storedKeys.add(key);
        if (notices.has(key) || readEntries(deps.getCurrentChatContext()).some(entry => entry.key === key)) forget(key);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => placeFailedSends());
    eventSource.on(event_types.MESSAGE_EDITED, onEdited);
    eventSource.on(event_types.MESSAGE_DELETED, onDeleted);
    window.addEventListener('storage', (event) => { onOtherTab(event); });
}
