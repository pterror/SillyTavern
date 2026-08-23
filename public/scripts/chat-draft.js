/**
 * Persistence for in-progress, unsent chat input (the "draft" sitting in `#send_textarea`). Before this
 * module existed, unsent input had no persistence mechanism at all - not even the general integrity-conflict
 * `window.location.reload()` in script.js flushed it first, so any forced or accidental refresh silently
 * destroyed whatever the user was mid-typing (task #10, "multi-device robustness").
 *
 * A draft is scoped to the exact chat context it was typed into - `{ type, id, chatId }`, where `id` is the
 * character avatar filename or the group id, and `chatId` is the chat file name from `getCurrentChatId()`.
 * Scoping by the full triple (not just `chatId`) matters because chat file names are not guaranteed globally
 * unique across characters/groups (many are timestamp-derived, e.g. "2024-01-01@01h02m03s"), so `chatId`
 * alone could collide between two unrelated chats. Restoring a draft into the wrong chat would be worse than
 * not restoring it at all, so a mismatched or incomplete context must never resolve to someone else's draft.
 *
 * Dependency-free by design (no jQuery/DOM, no other app modules) so it stays importable in a plain Node test
 * environment - see tests/chat-draft.test.js. Storage is passed in as a `{ getItem, setItem, removeItem }`
 * object the same way random-sort.js takes its seed storage; script.js passes the real `localStorage`.
 * Plain `localStorage` is used rather than `accountStorage` deliberately: `accountStorage.setItem` only
 * queues a debounced, network-dependent settings save (see AccountStorage.js), which cannot be relied on to
 * have landed before a reload that's about to happen - `localStorage.setItem` is synchronous and local, so a
 * flush call immediately before a forced reload is guaranteed to have taken effect by the time the reload
 * fires.
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

/**
 * Builds the storage key a draft is kept under for a given chat context. Exported mainly for tests; callers
 * should generally go through `saveDraft`/`loadDraft`/`clearDraft` instead of poking storage directly.
 * @param {DraftContext} context Chat context to key the draft by.
 * @returns {string} Storage key.
 */
export function buildDraftStorageKey(context) {
    return `${DRAFT_KEY_PREFIX}:${context.type}:${context.id}:${context.chatId}`;
}

/**
 * Returns whether a draft context is complete enough to be usable. Both `saveDraft`/`loadDraft`/`clearDraft`
 * are no-ops when given an incomplete context (e.g. no chat currently loaded), rather than falling back to
 * some ambiguous shared key that different chats could collide on.
 * @param {DraftContext} context Chat context to check.
 * @returns {boolean} True if the context is usable.
 */
function isCompleteContext(context) {
    return Boolean(context) && (context.type === 'character' || context.type === 'group')
        && typeof context.id === 'string' && context.id.length > 0
        && typeof context.chatId === 'string' && context.chatId.length > 0;
}

/**
 * Persists the current textarea content as the draft for a chat context, debounced-save-friendly (safe to
 * call on every keystroke - the caller is expected to debounce). An empty/whitespace-only draft is treated as
 * "nothing to remember" and clears any previously-stored draft instead of persisting an empty string, so a
 * message that gets fully deleted (or just sent - see script.js's Generate()) doesn't leave a phantom empty
 * entry behind.
 * @param {DraftStorage} storage Storage to persist into.
 * @param {DraftContext} context Chat context the draft belongs to.
 * @param {string} text Current textarea content.
 */
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

/**
 * Reads back the persisted draft for a chat context, if any.
 * @param {DraftStorage} storage Storage to read from.
 * @param {DraftContext} context Chat context to look up.
 * @returns {string|null} The persisted draft text, or null if none is stored (or the context is incomplete).
 */
export function loadDraft(storage, context) {
    if (!isCompleteContext(context)) {
        return null;
    }
    return storage.getItem(buildDraftStorageKey(context));
}

/**
 * Removes the persisted draft for a chat context, e.g. once its message has actually been sent.
 * @param {DraftStorage} storage Storage to remove from.
 * @param {DraftContext} context Chat context to clear.
 */
export function clearDraft(storage, context) {
    if (!isCompleteContext(context)) {
        return;
    }
    storage.removeItem(buildDraftStorageKey(context));
}
