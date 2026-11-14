import { mergeApart, mergeDraft } from '../draft-merge.js';

/**
 * An edit made against an older version of an entry, laid over what others changed since: per field, whichever side
 * changed it wins; text both changed merges when the changes are apart; a list of names both changed takes both sides'
 * additions and removals. What can't merge is a conflict, with both sides' values.
 */

/** The fields whose values are text a person writes, merged where the two changed different places */
export const TEXT_FIELDS = new Set(['content', 'comment']);

/**
 * @typedef {{ field: string, base: unknown, mine: unknown, theirs: unknown, merged: string | null }} FieldConflict
 * `merged`: for a text field, both texts laid together, a start for merging by hand; else null
 */

const isPlainObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {unknown} one
 * @param {unknown} other
 * @returns {boolean}
 */
export function sameValue(one, other) {
    if (Array.isArray(one) && Array.isArray(other)) return one.length === other.length && one.every((v, i) => sameValue(v, other[i]));
    if (isPlainObject(one) && isPlainObject(other)) {
        const [a, b] = [(one), /** @type {Record<string, unknown>} */ (other)];
        return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => sameValue(a[k], b[k]));
    }
    return Object.is(one, other);
}

const isNames = (/** @type {unknown} */ v) => Array.isArray(v) && v.every(x => typeof x === 'string') && new Set(v).size === v.length;

/**
 * Both sides' additions and removals, mine placed before what follows them in mine
 * @param {string[]} base
 * @param {string[]} mine
 * @param {string[]} theirs
 * @returns {string[]}
 */
function mergedNames(base, mine, theirs) {
    const removed = new Set(base.filter(x => !mine.includes(x)));
    const out = theirs.filter(x => !removed.has(x));
    for (const [i, x] of mine.entries()) {
        if (base.includes(x) || out.includes(x)) continue;
        const next = mine.slice(i + 1).find(y => out.includes(y));
        out.splice(next === undefined ? out.length : out.indexOf(next), 0, x);
    }
    return out;
}

/**
 * @param {string} field the field's path, its names joined with dots
 * @param {unknown} base
 * @param {unknown} mine
 * @param {unknown} theirs
 * @param {FieldConflict[]} conflicts gets each field that can't merge
 * @returns {unknown}
 */
function mergedValue(field, base, mine, theirs, conflicts) {
    if (sameValue(mine, base) || sameValue(mine, theirs)) return theirs;
    if (sameValue(theirs, base)) return mine;
    if (isPlainObject(base) && isPlainObject(mine) && isPlainObject(theirs)) {
        const [b, m, t] = /** @type {Record<string, unknown>[]} */ ([base, mine, theirs]);
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const k of new Set([...Object.keys(t), ...Object.keys(m)])) {
            const v = mergedValue(`${field}.${k}`, b[k], m[k], t[k], conflicts);
            if (v !== undefined) out[k] = v;
        }
        return out;
    }
    if (isNames(base) && isNames(mine) && isNames(theirs)) {
        return mergedNames(/** @type {string[]} */ (base), /** @type {string[]} */ (mine), /** @type {string[]} */ (theirs));
    }
    const text = (/** @type {unknown} */ v) => (v === undefined || v === null ? '' : v);
    if (TEXT_FIELDS.has(field) && [base, mine, theirs].every(v => typeof text(v) === 'string')) {
        const [b, m, t] = /** @type {string[]} */ ([text(base), text(mine), text(theirs)]);
        const apart = mergeApart(b, t, m);
        if (apart !== null) return apart;
        conflicts.push({ field, base, mine, theirs, merged: mergeDraft(b, t, m) });
        return theirs;
    }
    conflicts.push({ field, base, mine, theirs, merged: null });
    return theirs;
}

/**
 * @param {Record<string, unknown>} base the entry as the edit's version had it
 * @param {Record<string, unknown>} mine the edit applied to that
 * @param {Record<string, unknown>} theirs the entry as it is
 * @returns {{ merged: Record<string, unknown> } | { conflicts: FieldConflict[] }}
 */
export function mergeEntry(base, mine, theirs) {
    /** @type {FieldConflict[]} */
    const conflicts = [];
    /** @type {Record<string, unknown>} */
    const merged = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
        const v = mergedValue(k, base[k], mine[k], theirs[k], conflicts);
        if (v !== undefined) merged[k] = v;
    }
    return conflicts.length > 0 ? { conflicts } : { merged };
}

/**
 * With no base to tell what each side changed, every field the edit makes other than it is is a conflict
 * @param {Record<string, unknown>} mine the edit applied to the entry as it is
 * @param {Record<string, unknown>} theirs the entry as it is
 * @returns {FieldConflict[]}
 */
export function unmerged(mine, theirs) {
    return [...new Set([...Object.keys(theirs), ...Object.keys(mine)])]
        .filter(k => !sameValue(mine[k], theirs[k]))
        .map(field => ({ field, base: undefined, mine: mine[field], theirs: theirs[field], merged: TEXT_FIELDS.has(field) && typeof mine[field] === 'string' ? mine[field] : null }));
}

/**
 * @typedef {{ field: number | string, value?: { json: boolean, value: string } | null, list?: number, item?: number, place?: number | null, unknown: boolean }} SlotSince
 */

/**
 * The stored entity as of an earlier version, from the entity now and what changed each field and place since
 * @param {import('../entity-values.js').StoredEntity} entity
 * @param {SlotSince[]} since
 * @returns {import('../entity-values.js').StoredEntity | null} null when the history no longer holds a value it had
 */
export function entityAsOf(entity, since) {
    if (since.some(slot => slot.unknown)) return null;
    const values = new Map(entity.values.map(v => [v.field, v]));
    const places = new Map(entity.items.map(i => [`${i.list}:${i.item}`, i]));
    for (const slot of since) {
        if (slot.value !== undefined) {
            if (slot.value === null) values.delete(slot.field);
            else values.set(slot.field, slot.value.json ? { field: slot.field, json: slot.value.value } : { field: slot.field, text: slot.value.value });
        }
        if (slot.place !== undefined && slot.list !== undefined && slot.item !== undefined) {
            const at = `${slot.list}:${slot.item}`;
            if (slot.place === null) places.delete(at);
            else places.set(at, { list: slot.list, item: slot.item, position: slot.place });
        }
    }
    const items = [...places.values()].sort((a, b) => a.list - b.list || a.position - b.position);
    return { ...entity, values: [...values.values()], items };
}
