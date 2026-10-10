/**
 * Persistence for unsent chat input, so a forced/accidental reload doesn't lose it.
 * Draft keys include chatId AND {type, id} because chat file names (often timestamp-derived) are not
 * guaranteed unique across characters/groups, and a wrong-chat restore is worse than no restore.
 * Uses plain localStorage rather than accountStorage: accountStorage's write is a debounced, network-dependent
 * save that isn't guaranteed to land before a reload that's about to happen.
 */

const DRAFT_KEY_PREFIX = 'ChatDraft';

/**
 * @typedef {object} DraftContext
 * @property {'character'|'group'} type Which kind of entity the chat belongs to.
 * @property {string} id Character avatar filename (for `type: 'character'`) or group id (for `type: 'group'`).
 * @property {string} chatId The chat file name, as returned by `getCurrentChatId()`.
 */

/**
 * @typedef {object} DraftStorage
 * @property {(key: string) => string|null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 */

// Exported mainly for tests; callers should go through saveDraft/loadDraft/clearDraft instead.
export function buildDraftStorageKey(context) {
    return `${DRAFT_KEY_PREFIX}:${context.type}:${context.id}:${context.chatId}`;
}

// No-op on an incomplete context rather than falling back to a shared key chats could collide on.
function isCompleteContext(context) {
    return Boolean(context) && (context.type === 'character' || context.type === 'group')
        && typeof context.id === 'string' && context.id.length > 0
        && typeof context.chatId === 'string' && context.chatId.length > 0;
}

// An empty/whitespace-only draft clears any stored draft instead of persisting an empty string.
export function saveDraft(storage, context, text) {
    if (!isCompleteContext(context)) {
        return;
    }
    if (!text || !text.trim()) {
        clearDraft(storage, context);
        return;
    }
    storage.setItem(buildDraftStorageKey(context), text);
}

export function loadDraft(storage, context) {
    if (!isCompleteContext(context)) {
        return null;
    }
    return storage.getItem(buildDraftStorageKey(context));
}

export function clearDraft(storage, context) {
    if (!isCompleteContext(context)) {
        return;
    }
    storage.removeItem(buildDraftStorageKey(context));
}

// Text sent from the box, kept as the box's draft until the server has stored the message (or the send has
// failed and its text is kept with the failed send instead), by storage key.
/** @type {Map<string, string>} */
const heldDrafts = new Map();

/**
 * Keeps `text` as this chat's draft while it is being sent: the box being emptied doesn't clear it.
 * @param {DraftStorage} storage
 * @param {DraftContext} context
 * @param {string} text
 */
export function holdDraft(storage, context, text) {
    if (!isCompleteContext(context) || !text || !text.trim()) {
        return;
    }
    const key = buildDraftStorageKey(context);
    heldDrafts.set(key, text);
    storage.setItem(key, text);
}

/**
 * @param {DraftContext} context
 * @returns {boolean} Whether a sent text is held as this chat's draft.
 */
export function isDraftHeld(context) {
    return isCompleteContext(context) && heldDrafts.has(buildDraftStorageKey(context));
}

/**
 * The sent text no longer needs the draft: clears it, unless the draft has since become something else.
 * @param {DraftStorage} storage
 * @param {DraftContext} context
 * @param {string} text
 */
export function releaseDraft(storage, context, text) {
    if (!isCompleteContext(context)) {
        return;
    }
    const key = buildDraftStorageKey(context);
    if (heldDrafts.get(key) === text) {
        heldDrafts.delete(key);
    }
    if (storage.getItem(key) === text) {
        storage.removeItem(key);
    }
}
