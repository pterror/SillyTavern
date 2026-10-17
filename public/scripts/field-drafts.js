/**
 * Unsaved edits of any editor's fields, per (thing, field), kept in browser storage so a reload doesn't lose them.
 * While the user types, the field's text is only a draft; the editor commits it as one action at its commit point,
 * and the draft is cleared once that commit is confirmed. A commit that fails leaves the draft as it was.
 *
 * A draft remembers the stored text it was started from (its base): when what is stored has changed since (another
 * tab or user), the draft is in conflict with it, and the user chooses between the two.
 *
 * Callers pass localStorage, not accountStorage: accountStorage's write is a debounced, network-dependent save that
 * isn't guaranteed to land before a reload that's about to happen.
 */

import { jsonHash } from './hash-utils.js';

const DRAFT_KEY_PREFIX = 'FieldDraft:';
// Per thing, the fields that have a draft, so whether a thing has any is one read.
const INDEX_KEY_PREFIX = 'FieldDraftIndex:';

/**
 * @typedef {object} DraftRef
 * @property {string} kind What sort of thing the field belongs to, e.g. 'world-entry'.
 * @property {string} id Which thing of that sort, unique within its kind.
 * @property {string} field Which field of that thing.
 */

/**
 * @typedef {object} FieldDraft
 * @property {string} text What the user typed.
 * @property {string} base What was stored when the draft was started.
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

/** @param {string} kind @param {string} id */
function indexKey(kind, id) {
    return INDEX_KEY_PREFIX + JSON.stringify([kind, id]);
}

/** @param {DraftStorage} storage @param {string} kind @param {string} id @returns {string[]} */
function readIndex(storage, kind, id) {
    try {
        const fields = JSON.parse(storage.getItem(indexKey(kind, id)) ?? '[]');
        return Array.isArray(fields) ? fields.filter(field => typeof field === 'string') : [];
    } catch {
        return [];
    }
}

/** @param {DraftStorage} storage @param {DraftRef} ref @param {boolean} present */
function updateIndex(storage, ref, present) {
    const fields = readIndex(storage, ref.kind, ref.id);
    const has = fields.includes(ref.field);
    if (has === present) return;
    const next = present ? [...fields, ref.field] : fields.filter(field => field !== ref.field);
    if (next.length) storage.setItem(indexKey(ref.kind, ref.id), JSON.stringify(next));
    else storage.removeItem(indexKey(ref.kind, ref.id));
}

/**
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 * @returns {FieldDraft|null} The field's unsaved edit, or null when it has none.
 */
export function readFieldDraft(storage, ref) {
    if (!isCompleteRef(ref)) return null;
    try {
        const draft = JSON.parse(storage.getItem(buildFieldDraftKey(ref)) ?? 'null');
        return draft && typeof draft.text === 'string' && typeof draft.base === 'string' ? { text: draft.text, base: draft.base } : null;
    } catch {
        return null;
    }
}

/**
 * Keeps `text` as the field's draft, started from `base`.
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 * @param {string} text
 * @param {string} base
 */
export function keepFieldDraft(storage, ref, text, base) {
    if (!isCompleteRef(ref)) return;
    try {
        storage.setItem(buildFieldDraftKey(ref), JSON.stringify({ text, base }));
        updateIndex(storage, ref, true);
    } catch {
        // Browser storage may be unavailable; the field itself still holds the text.
    }
}

/**
 * Keeps what the field holds as its draft, or forgets the draft once the field holds what is stored again. An empty
 * text is a draft like any other: emptying a field is an edit. A draft already started keeps its base.
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 * @param {string} text What the field holds.
 * @param {string} stored What is stored for the field.
 */
export function writeFieldDraft(storage, ref, text, stored) {
    if (!isCompleteRef(ref)) return;
    if (text === stored) {
        clearFieldDraft(storage, ref);
        return;
    }
    keepFieldDraft(storage, ref, text, readFieldDraft(storage, ref)?.base ?? stored);
}

/**
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 */
export function clearFieldDraft(storage, ref) {
    if (!isCompleteRef(ref)) return;
    try {
        storage.removeItem(buildFieldDraftKey(ref));
        updateIndex(storage, ref, false);
    } catch {
        // Nothing to clear.
    }
}

/**
 * Drops the drafts of every field of a thing: for a thing that is gone.
 * @param {DraftStorage} storage
 * @param {string} kind
 * @param {string} id
 */
export function clearThingDrafts(storage, kind, id) {
    for (const field of readIndex(storage, kind, id)) clearFieldDraft(storage, { kind, id, field });
    try {
        storage.removeItem(indexKey(kind, id));
    } catch {
        // Nothing to clear.
    }
}

/**
 * Drops the drafts of every thing of `kind` whose id starts with `prefix`: for things that went with what held them.
 * Goes over the storage's keys, which browser storage bounds.
 * @param {DraftStorage & { length: number, key: (index: number) => string|null }} storage
 * @param {string} kind
 * @param {string} prefix
 */
export function clearDraftsUnder(storage, kind, prefix) {
    /** @type {string[]} */
    const ids = [];
    let count = 0;
    try {
        count = storage.length;
    } catch {
        // Browser storage may be unavailable; there is nothing in it to clear then.
    }
    for (let i = 0; i < count; i++) {
        try {
            const key = storage.key(i);
            if (!key?.startsWith(INDEX_KEY_PREFIX)) continue;
            const [k, id] = JSON.parse(key.slice(INDEX_KEY_PREFIX.length));
            if (k === kind && typeof id === 'string' && id.startsWith(prefix)) ids.push(id);
        } catch {
            // Not an index this wrote.
        }
    }
    for (const id of ids) clearThingDrafts(storage, kind, id);
}

/**
 * @param {DraftStorage} storage
 * @param {string} kind
 * @param {string} id
 * @returns {boolean} Whether any field of the thing has a draft.
 */
export function hasFieldDrafts(storage, kind, id) {
    return readIndex(storage, kind, id).length > 0;
}

/**
 * Commits a field's text as one action. The text is kept as the draft until the commit is confirmed; then the draft
 * is cleared, unless it has since become something else (typed while the commit was on its way), which then starts
 * from the committed text. A commit that resolves anything but true, or rejects, leaves the draft in place; showing
 * the error is the commit's job.
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 * @param {string} text
 * @param {string} stored What is stored for the field before the commit.
 * @param {(text: string) => Promise<boolean|void>} commit Sends the action; resolves true once it is stored.
 * @returns {Promise<boolean>} Whether the commit was confirmed.
 */
export async function commitFieldDraft(storage, ref, text, stored, commit) {
    keepFieldDraft(storage, ref, text, readFieldDraft(storage, ref)?.base ?? stored);
    let confirmed = false;
    try {
        confirmed = (await commit(text)) === true;
    } catch (error) {
        console.error('A field edit could not be committed; it is kept as a draft', { ref, error });
    }
    const now = confirmed ? readFieldDraft(storage, ref) : null;
    if (now?.text === text) clearFieldDraft(storage, ref);
    else if (now) keepFieldDraft(storage, ref, now.text, text);
    return confirmed;
}

/**
 * @typedef {'text'|'line'|'number'|'toggle'} FieldType `text`: multi-line text; `line`: single-line text; `number`:
 * a number input (its spinner steps are edits of their own); `toggle`: checkboxes, selects and pickers, where one
 * click is one edit.
 */

/**
 * @typedef {object} FieldEvent
 * @property {'input'|'change'|'blur'|'keydown'|'close'} type `close`: the editor is closing or showing something else.
 * @property {boolean} [user] Whether the user made it (an `input` event code fired is a write of its own).
 * @property {string} [key] For `keydown`.
 * @property {boolean} [shiftKey]
 * @property {boolean} [isComposing]
 */

/**
 * What an editor does with an event on one of its fields: keep what the field holds as its draft, commit it, or both.
 * @param {FieldType} type
 * @param {FieldEvent} event
 * @returns {{ draft: boolean, commit: boolean }}
 */
export function fieldEventAction(type, event) {
    switch (event.type) {
        case 'input': {
            const commit = type === 'toggle' || event.user === false;
            return { draft: true, commit };
        }
        case 'change':
            // A text field's own change comes with its blur or Enter; a number's also with each spinner step.
            return { draft: true, commit: true };
        case 'blur':
        case 'close':
            return { draft: false, commit: true };
        case 'keydown':
            return { draft: false, commit: type !== 'text' && event.key === 'Enter' && !event.shiftKey && !event.isComposing };
        default:
            return { draft: false, commit: false };
    }
}

/**
 * @typedef {object} FieldDraftBinding
 * @property {() => 'none'|'restored'|'conflict'} restore Puts the field's draft back into it; a draft started from a
 * stored text that has changed since is held as a conflict instead, until {@link FieldDraftBinding.keep} or
 * {@link FieldDraftBinding.discard}.
 * @property {(event: FieldEvent) => Promise<boolean>} handle Acts on an event; resolves whether nothing is left
 * unsaved.
 * @property {() => void} keep In a conflict: the draft goes into the field, now started from what is stored.
 * @property {() => void} discard In a conflict: the draft is dropped and the field shows what is stored.
 * @property {() => FieldDraft|null} conflict The draft in conflict, if any.
 * @property {() => 'clean'|'draft'|'conflict'} state
 */

/**
 * Binds one field to its draft: typing keeps the draft, a commit point sends it as one action. Two commit points
 * while one commit is on its way send one more commit after it, with what the field holds then.
 * @param {object} options
 * @param {DraftStorage} options.storage
 * @param {DraftRef|null} options.ref
 * @param {FieldType} options.type
 * @param {() => string} options.stored What is stored for the field, as the field shows it.
 * @param {() => string} options.read What the field holds.
 * @param {(text: string) => void} options.show Puts a text into the field.
 * @param {(text: string) => Promise<boolean|void>} options.commit Sends the field's text; resolves true once stored.
 * @param {() => void} [options.changed] Called whenever the field's state may have changed.
 * @returns {FieldDraftBinding}
 */
export function bindFieldDraft({ storage, ref, type, stored, read, show, commit, changed = () => {} }) {
    /** @type {FieldDraft|null} */
    let conflict = null;
    /** @type {Promise<boolean>|null} */
    let inFlight = null;
    let again = false;

    /** @returns {Promise<boolean>} */
    async function commitNow() {
        if (conflict) return false;
        if (inFlight) {
            again = true;
            return inFlight;
        }
        const text = read();
        const base = stored();
        if (text === base) {
            if (readFieldDraft(storage, ref)?.text === text) clearFieldDraft(storage, ref);
            changed();
            return true;
        }
        inFlight = commitFieldDraft(storage, ref, text, base, commit);
        let confirmed = false;
        try {
            confirmed = await inFlight;
        } finally {
            inFlight = null;
            changed();
        }
        if (again) {
            again = false;
            return commitNow();
        }
        return confirmed;
    }

    return {
        restore() {
            const draft = readFieldDraft(storage, ref);
            if (!draft) return 'none';
            const now = stored();
            if (draft.text === now) {
                clearFieldDraft(storage, ref);
                return 'none';
            }
            if (draft.base !== now) {
                conflict = draft;
                changed();
                return 'conflict';
            }
            show(draft.text);
            changed();
            return 'restored';
        },
        async handle(event) {
            if (conflict) return false;
            const action = fieldEventAction(type, event);
            if (action.draft) writeFieldDraft(storage, ref, read(), stored());
            if (action.commit) return commitNow();
            changed();
            return !readFieldDraft(storage, ref);
        },
        keep() {
            if (!conflict) return;
            const { text } = conflict;
            conflict = null;
            keepFieldDraft(storage, ref, text, stored());
            show(text);
            changed();
        },
        discard() {
            if (!conflict) return;
            conflict = null;
            clearFieldDraft(storage, ref);
            show(stored());
            changed();
        },
        conflict: () => conflict,
        state() {
            if (conflict) return 'conflict';
            return readFieldDraft(storage, ref) || read() !== stored() ? 'draft' : 'clean';
        },
    };
}

/**
 * Sets back in `target` what went from `before` to `after`, except what has changed again since: what a commit that
 * failed had set in the page's copy of a thing.
 * @param {any} target
 * @param {any} before
 * @param {any} after
 */
export function revertChanges(target, before, after) {
    const isObject = (/** @type {unknown} */ value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const was = before[key];
        const set = after[key];
        if (jsonHash(was) === jsonHash(set)) continue;
        if (isObject(was) && isObject(set) && isObject(target[key])) {
            revertChanges(target[key], was, set);
            continue;
        }
        if (jsonHash(target[key]) !== jsonHash(set)) continue;
        if (key in before) target[key] = structuredClone(was);
        else delete target[key];
    }
}
