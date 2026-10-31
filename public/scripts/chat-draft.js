const DRAFT_KEY_PREFIX = 'ChatDraft';

/**
 * @typedef {object} DraftContext
 * @property {'character'|'group'} type
 * @property {string} id
 * @property {string} chatId
 */

/**
 * @typedef {object} DraftStorage
 * @property {(key: string) => string|null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 */

export function buildDraftStorageKey(context) {
    return `${DRAFT_KEY_PREFIX}:${context.type}:${context.id}:${context.chatId}`;
}

function isCompleteContext(context) {
    return Boolean(context) && (context.type === 'character' || context.type === 'group')
        && typeof context.id === 'string' && context.id.length > 0
        && typeof context.chatId === 'string' && context.chatId.length > 0;
}

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

/** @type {Map<string, string>} */
const heldDrafts = new Map();

/**
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
 * @returns {boolean}
 */
export function isDraftHeld(context) {
    return isCompleteContext(context) && heldDrafts.has(buildDraftStorageKey(context));
}

/**
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
