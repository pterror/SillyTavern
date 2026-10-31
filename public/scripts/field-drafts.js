import { jsonHash } from './hash-utils.js';

const DRAFT_KEY_PREFIX = 'FieldDraft:';
const INDEX_KEY_PREFIX = 'FieldDraftIndex:';

/**
 * @typedef {object} DraftRef
 * @property {string} kind
 * @property {string} id
 * @property {string} field
 */

/**
 * @typedef {object} FieldDraft
 * @property {string} text
 * @property {string} base
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
 * @param {DraftRef} ref
 * @returns {string}
 */
export function buildFieldDraftKey(ref) {
    return DRAFT_KEY_PREFIX + JSON.stringify([ref.kind, ref.id, ref.field]);
}

/**
 * @param {string} kind
 * @param {string} id
 */
function indexKey(kind, id) {
    return INDEX_KEY_PREFIX + JSON.stringify([kind, id]);
}

/**
 * @param {DraftStorage} storage
 * @param {string} kind
 * @param {string} id
 * @returns {string[]}
 */
function readIndex(storage, kind, id) {
    try {
        const fields = JSON.parse(storage.getItem(indexKey(kind, id)) ?? '[]');
        return Array.isArray(fields) ? fields.filter(field => typeof field === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 * @param {boolean} present
 */
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
 * @returns {FieldDraft|null}
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
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 * @param {string} text
 * @param {string} stored
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
 * @returns {boolean}
 */
export function hasFieldDrafts(storage, kind, id) {
    return readIndex(storage, kind, id).length > 0;
}

/**
 * @param {DraftStorage} storage
 * @param {DraftRef} ref
 * @param {string} text
 * @param {string} stored
 * @param {(text: string) => Promise<boolean|void>} commit
 * @returns {Promise<boolean>}
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

/** @typedef {'text'|'line'|'number'|'toggle'} FieldType */

/**
 * @typedef {object} FieldEvent
 * @property {'input'|'change'|'blur'|'keydown'|'close'} type
 * @property {boolean} [user]
 * @property {string} [key]
 * @property {boolean} [shiftKey]
 * @property {boolean} [isComposing]
 */

/**
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
 * @property {() => 'none'|'restored'|'conflict'} restore
 * @property {(event: FieldEvent) => Promise<boolean>} handle
 * @property {() => void} keep
 * @property {() => void} discard
 * @property {() => FieldDraft|null} conflict
 * @property {() => 'clean'|'draft'|'conflict'} state
 */

/**
 * @param {object} options
 * @param {DraftStorage} options.storage
 * @param {DraftRef|null} options.ref
 * @param {FieldType} options.type
 * @param {() => string} options.stored
 * @param {() => string} options.read
 * @param {(text: string) => void} options.show
 * @param {(text: string) => Promise<boolean|void>} options.commit
 * @param {() => void} [options.changed]
 * @returns {FieldDraftBinding}
 */
export function bindFieldDraft({ storage, ref, type, stored, read, show, commit, changed = () => {} }) {
    /** @type {FieldDraft|null} */
    let conflict = null;
    /** @type {Promise<boolean>|null} */
    let inFlight = null;
    let again = /** @type {string|null} */ (null);

    /**
     * @param {string} [held]
     * @returns {Promise<boolean>}
     */
    async function commitNow(held) {
        if (conflict) return false;
        if (inFlight) {
            again = held ?? read();
            return inFlight;
        }
        const text = held ?? read();
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
        if (again !== null) {
            const next = again;
            again = null;
            return commitNow(next);
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
