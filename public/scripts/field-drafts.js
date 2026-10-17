/**
 * Unsaved edits of any editor's fields, per (thing, field), kept in browser storage so a reload doesn't lose them.
 * While the user types, the field's text is only a draft; the editor commits it as one action at its commit point,
 * and the draft is cleared once that commit is confirmed. A commit that fails leaves the draft as it was.
 *
 * Callers pass localStorage, not accountStorage: accountStorage's write is a debounced, network-dependent save that
 * isn't guaranteed to land before a reload that's about to happen.
 */

const DRAFT_KEY_PREFIX = 'FieldDraft:';

/**
 * @typedef {object} DraftRef
 * @property {string} kind What sort of thing the field belongs to, e.g. 'world-entry'.
 * @property {string} id Which thing of that sort, unique within its kind.
 * @property {string} field Which field of that thing.
 */

/**
 * @typedef {object} DraftStorage
 * @property {(key: string) => string|null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 */

/** @param {DraftRef} ref */
function isCompleteRef(ref) {
    return Boolean(ref)
        && typeof ref.kind === 'string' && ref.kind.length > 0
        && typeof ref.id === 'string' && ref.id.length > 0
        && typeof ref.field === 'string' && ref.field.length > 0;
}

/**
 * The storage key of a field's draft. The parts are JSON-encoded, so no id or field name can collide with another's.
 * @param {DraftRef} ref
 * @returns {string}
 */
export function buildFieldDraftKey(ref) {
    return DRAFT_KEY_PREFIX + JSON.stringify([ref.kind, ref.id, ref.field]);
}

/**
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 * @returns {string|null} The field's unsaved text, or null when it has none.
 */
export function readFieldDraft(storage, ref) {
    if (!isCompleteRef(ref)) return null;
    try {
        return storage.getItem(buildFieldDraftKey(ref));
    } catch {
        return null;
    }
}

/**
 * Keeps what the field holds as its draft, or forgets the draft once the field holds what is stored again.
 * An empty text is a draft like any other: emptying a field is an edit.
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 * @param {string} text What the field holds.
 * @param {string} stored What is stored for the field.
 */
export function writeFieldDraft(storage, ref, text, stored) {
    if (!isCompleteRef(ref)) return;
    const key = buildFieldDraftKey(ref);
    try {
        if (text === stored) storage.removeItem(key);
        else storage.setItem(key, text);
    } catch {
        // Browser storage may be unavailable; the field itself still holds the text.
    }
}

/**
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 */
export function clearFieldDraft(storage, ref) {
    if (!isCompleteRef(ref)) return;
    try {
        storage.removeItem(buildFieldDraftKey(ref));
    } catch {
        // Nothing to clear.
    }
}

/**
 * Commits a field's text as one action. The text is kept as the draft until the commit is confirmed; then the draft
 * is cleared, unless it has since become something else (typed while the commit was on its way). A commit that
 * resolves false or rejects leaves the draft in place; showing the error is the commit's job.
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 * @param {string} text
 * @param {(text: string) => Promise<boolean|void>} commit Sends the action; resolves true once it is stored.
 * @returns {Promise<boolean>} Whether the commit was confirmed.
 */
export async function commitFieldDraft(storage, ref, text, commit) {
    if (isCompleteRef(ref)) {
        try {
            storage.setItem(buildFieldDraftKey(ref), text);
        } catch {
            // Browser storage may be unavailable; the field itself still holds the text.
        }
    }
    let confirmed = false;
    try {
        confirmed = (await commit(text)) === true;
    } catch (error) {
        console.error('A field edit could not be committed; it is kept as a draft', { ref, error });
        confirmed = false;
    }
    if (confirmed && readFieldDraft(storage, ref) === text) {
        clearFieldDraft(storage, ref);
    }
    return confirmed;
}
