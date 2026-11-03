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
 * @property {typeof import('./node-identity.js').provisionalNodeId} provisionalNodeId
 * @property {typeof import('./i18n.js').t} t
 * @property {(text: string) => Promise<boolean>} confirmDiscard
 */

/** @type {FailedSendsDeps} */
let deps;

/**
 * @typedef {object} FailedSend
 * @property {string} key
 * @property {'append'|'graft'} kind
 * @property {object} message
 * @property {string|null} after
 * @property {string|null} before
 * @property {string} afterText
 * @property {boolean} [pending]
 */

/** @typedef {import('./chat-draft.js').DraftContext} DraftContext */
/** @typedef {{ type: string, id: string }} Owner */

/** @typedef {'spot'|'moved'|'elsewhere'} FailedSendMode */

const STORAGE_PREFIX = 'FailedSends';
const AFTER_TEXT_LENGTH = 60;

/** @type {Map<string, { toast: JQuery, mode: FailedSendMode }>} */
const notices = new Map();

/** @type {Set<string>} */
const storedKeys = new Set();

/**
 * @param {{ type: string, id: string }} owner
 */
function storageKey(owner) {
    return `${STORAGE_PREFIX}:${owner.type}:${owner.id}`;
}

/**
 * @param {Owner|null} context
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
 * @param {Owner} context
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

/**
 * @param {Owner|null} a
 * @param {Owner|null} b
 */
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

/** @type {Map<string, DraftContext>} */
const recordedIn = new Map();

/**
 * @param {'append'|'graft'} kind
 * @param {object} shown
 * @param {number} index
 * @param {string} key
 * @returns {FailedSend}
 */
function entryFor(kind, shown, index, key) {
    const previous = index > 0 ? chat[index - 1] : null;
    return {
        key,
        kind,
        message: plainMessage(shown),
        after: previous?.node_id ?? null,
        before: kind === 'graft' && index >= 0 ? chat[index + 1]?.node_id ?? null : null,
        afterText: shortText(previous?.mes),
        pending: true,
    };
}

/**
 * @param {object} params
 * @param {string|undefined} params.key
 * @param {'append'|'graft'} params.kind
 */
export function recordSend({ key, kind }) {
    const context = deps.getCurrentChatContext();
    const index = typeof key === 'string' ? indexOfKey(key) : -1;
    if (typeof key !== 'string' || !context || index < 0) return;
    recordedIn.set(key, context);
    writeEntries(context, [...readEntries(context).filter(e => e.key !== key), entryFor(kind, chat[index], index, key)]);
}

/**
 * @param {object} params
 * @param {string|undefined} params.key
 * @param {'append'|'graft'} params.kind
 * @param {object} [params.message]
 */
export function keepFailedSend({ key, kind, message = undefined }) {
    if (typeof key !== 'string' || storedKeys.has(key)) return;
    const context = recordedIn.get(key) ?? deps.getCurrentChatContext();
    if (!context) return;

    const open = sameContext(context, deps.getCurrentChatContext());
    const index = open ? indexOfKey(key) : -1;
    const entries = readEntries(context);
    const recorded = entries.find(e => e.key === key);
    const shown = index >= 0 ? chat[index] : message;
    if (!recorded && !shown) return;
    /** @type {FailedSend} */
    const entry = index >= 0 || !recorded
        ? { ...entryFor(recorded?.kind ?? kind, shown, index, key), pending: false }
        : { ...recorded, message: shown ? plainMessage(shown) : recorded.message, pending: false };
    writeEntries(context, [...entries.filter(e => e.key !== key), entry]);

    if (index >= 0) {
        showNotice(entry, 'spot');
        markShown();
    }
}

/**
 * @param {object|undefined} message
 * @returns {boolean}
 */
export function isFailedSend(message) {
    const key = deps.storeRefOf(message);
    return typeof key === 'string' && readEntries(deps.getCurrentChatContext()).some(entry => entry.key === key && !entry.pending);
}

/**
 * @param {string|undefined} key
 * @returns {boolean}
 */
export function wasSendStored(key) {
    return typeof key === 'string' && storedKeys.has(key);
}

/** @param {string} key */
function forget(key) {
    const context = recordedIn.get(key) ?? deps.getCurrentChatContext();
    recordedIn.delete(key);
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

/**
 * @param {string} key
 * @param {string} text
 */
function setNoticeText(key, text) {
    notices.get(key)?.toast.find('.toast-message > div').first().text(text);
}

/**
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
 * @returns {Promise<boolean|null>}
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
 * @param {{ fromOtherTab?: boolean }} [options]
 * @returns {Promise<void>}
 */
function placeFailedSends(options = {}) {
    const run = () => placeNow(options);
    placing = placing.then(run, run);
    return placing;
}

/**
 * @param {Owner} context
 * @param {FailedSend} entry
 * @returns {FailedSend}
 */
function withStoredGreeting(context, entry) {
    if (!deps.isProvisionalNodeId(entry.after)) return entry;
    const greeting = chat.find(message => deps.isStoredNodeId(message.node_id) && deps.provisionalNodeId(message.name, message.mes) === entry.after);
    if (!greeting) return entry;
    const updated = { ...entry, after: greeting.node_id };
    writeEntries(context, readEntries(context).map(e => e.key === entry.key ? updated : e));
    return updated;
}

/**
 * @param {DraftContext} context
 * @param {FailedSend} entry
 * @returns {FailedSend}
 */
function markFailed(context, entry) {
    const failed = { ...entry, pending: false };
    writeEntries(context, readEntries(context).map(e => e.key === entry.key ? failed : e));
    return failed;
}

/** @param {{ fromOtherTab?: boolean }} [options] */
async function placeNow({ fromOtherTab = false } = {}) {
    const context = deps.getCurrentChatContext();
    const entries = readEntries(context);
    const keys = new Set(entries.map(entry => entry.key));
    for (const key of [...notices.keys()]) {
        if (!keys.has(key)) clearNotice(key);
    }

    for (const kept of entries) {
        const recorded = context ? withStoredGreeting(context, kept) : kept;
        const index = indexOfKey(recorded.key);
        if (index >= 0 && deps.isStoredNodeId(chat[index].node_id)) {
            forget(recorded.key);
            continue;
        }
        if (recorded.pending && (recordedIn.has(recorded.key) || fromOtherTab)) continue;
        const entry = recorded.pending ? markFailed(context, recorded) : recorded;
        if (index >= 0) {
            if (!notices.has(entry.key)) showNotice(entry, 'spot');
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

function onDeleted() {
    for (const entry of readEntries(deps.getCurrentChatContext())) {
        const notice = notices.get(entry.key);
        if (notice && notice.mode !== 'elsewhere' && indexOfKey(entry.key) < 0) forget(entry.key);
    }
}

/**
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
    await placeFailedSends({ fromOtherTab: true });
}

const KEYS_PER_OPEN = 100;


/**
 * @param {Owner} owner
 * @returns {string[]}
 */
export function keptSendKeys(owner) {
    /** @type {string[]} */
    const keys = [];
    keys.push(...readEntries(owner).map(e => e.key));
    return keys.slice(0, KEYS_PER_OPEN);
}

/**
 * @param {Owner} owner
 * @param {string[]} keys
 */
export function forgetStoredSends(owner, keys) {
    if (!keys.length) return;
    const stored = new Set(keys);
    keys.forEach(key => storedKeys.add(key));
    const entries = readEntries(owner);
    const left = entries.filter(e => !stored.has(e.key));
    if (left.length !== entries.length) writeEntries(owner, left);
    keys.forEach(key => { recordedIn.delete(key); clearNotice(key); });
}

/** @param {FailedSendsDeps} dependencies */
export function initFailedSends(dependencies) {
    deps = dependencies;
    deps.setSendStoredListener((key) => {
        storedKeys.add(key);
        if (recordedIn.has(key) || notices.has(key) || readEntries(deps.getCurrentChatContext()).some(entry => entry.key === key)) forget(key);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => placeFailedSends());
    eventSource.on(event_types.MESSAGE_EDITED, onEdited);
    eventSource.on(event_types.MESSAGE_DELETED, onDeleted);
    window.addEventListener('storage', (event) => { onOtherTab(event); });
}
