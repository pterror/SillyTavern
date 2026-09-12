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
