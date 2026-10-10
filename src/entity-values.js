import { textEdit } from './text-edit.js';

/**
 * An entity's values as the engine stores them, and the records turning stored values into new ones: the library's
 * and world info's entities alike.
 */

/** A list item's text is the text value of this field. */
export function itemField(list, item) {
    return 1024 + item * 8 + list;
}

/** Positions of a list's items are this far apart, so an item fits between two without moving others. */
export const POSITION_GAP = 2 ** 20;

/**
 * @typedef {object} StoredEntity What `Store.libraryEntities` answers.
 * @property {bigint} id
 * @property {number} type
 * @property {string} key
 * @property {number} added
 * @property {bigint} version
 * @property {boolean} fav
 * @property {bigint[]} tags
 * @property {{ field: number | string, text?: string, json?: string }[]} values
 * @property {{ list: number, item: number, position: number }[]} items
 * @property {number} [dataSize]
 * @property {number} [createMs]
 * @property {{ which: number, hash: Buffer }[]} hashes
 * @property {number | null} [tagOrder] A tag's manual sort order as recorded; absent when none was.
 * @property {{ book: bigint, key: string, version: bigint }} [link] A character's lorebook link: the book it names,
 * and the key and version of the book that resolves as.
 * @property {number} [entryIndex] An entry's recorded `displayIndex`.
 */

/**
 * The entity's field values and its lists (each item's text in order), with each list's item ids and positions.
 * @param {StoredEntity} entity
 */
export function storedValues(entity) {
    /** @type {Map<number | string, { text?: string, json?: string }>} */
    const values = new Map();
    /** @type {Map<number, string>} */
    const itemTexts = new Map();
    for (const v of entity.values) {
        if (typeof v.field === 'number' && v.field >= 1024) itemTexts.set(v.field, /** @type {string} */ (v.text));
        else values.set(v.field, v.text !== undefined ? { text: v.text } : { json: v.json });
    }
    /** @type {Map<number, string[]>} */
    const lists = new Map();
    /** @type {Map<number, { item: number, position: number }[]>} */
    const places = new Map();
    for (const { list, item, position } of entity.items) {
        if (!lists.has(list)) {
            lists.set(list, []);
            places.set(list, []);
        }
        lists.get(list)?.push(itemTexts.get(itemField(list, item)) ?? '');
        places.get(list)?.push({ item, position });
    }
    return { values, lists, places };
}

/**
 * The records turning a stored entity's values (none for a new one) into `values` and `lists`.
 * @param {bigint} entity
 * @param {StoredEntity | null} stored
 * @param {{ values: Map<number | string, { text?: string, json?: string }>, lists: Map<number, string[]> }} next
 * @returns {object[]}
 */
export function valueRecords(entity, stored, next) {
    const old = stored ? storedValues(stored) : { values: new Map(), lists: new Map(), places: new Map() };
    const records = [];
    for (const field of old.values.keys()) {
        if (!next.values.has(field)) records.push({ kind: 'valueDelete', entity, field });
    }
    for (const [field, after] of next.values) {
        const before = old.values.get(field);
        if (after.text !== undefined) {
            if (before?.text === after.text) continue;
            if (before?.text !== undefined) records.push({ kind: 'textEdit', entity, field, ...textEdit(before.text, after.text) });
            else records.push({ kind: 'textValue', entity, field, text: after.text });
        } else if (before?.json !== after.json) {
            records.push({ kind: 'jsonValue', entity, field, json: after.json });
        }
    }
    const counter = { next: 1 + Math.max(0, ...(stored?.items ?? []).map(i => i.item)) };
    for (const list of new Set([...old.lists.keys(), ...next.lists.keys()])) {
        records.push(...listRecords(entity, list, old.lists.get(list) ?? [], old.places.get(list) ?? [], next.lists.get(list) ?? [], counter));
    }
    return records;
}

/**
 * The records turning a list's items `before` (at `places`) into `after`. Items equal at both ends stay; between
 * them, items are edited in place, then the rest added between their neighbours or deleted. When no position is
 * free between the neighbours, every item of the list is placed again, POSITION_GAP apart, above every position
 * it held, so no place lands on one still taken.
 * @param {bigint} entity
 * @param {number} list
 * @param {string[]} before
 * @param {{ item: number, position: number }[]} places
 * @param {string[]} after
 * @param {{ next: number }} counter The next unused item id.
 * @returns {object[]}
 */
function listRecords(entity, list, before, places, after, counter) {
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    const oldMid = before.length - head - tail;
    const newMid = after.length - head - tail;
    const paired = Math.min(oldMid, newMid);
    const added = newMid - paired;
    const lo = head + paired > 0 ? places[head + paired - 1].position : -1;
    const hi = head + oldMid < places.length ? places[head + oldMid].position : lo + POSITION_GAP * (added + 1);
    const step = Math.floor((hi - lo) / (added + 1));
    const records = [];
    if (added > 0 && step < 1) {
        const top = places.reduce((m, p) => Math.max(m, p.position), 0);
        for (let i = 0; i < after.length; i++) {
            const position = top + POSITION_GAP * (i + 1);
            if (i < places.length) {
                records.push({ kind: 'itemPlace', entity, list, item: places[i].item, position });
                if (before[i] !== after[i]) records.push({ kind: 'textEdit', entity, field: itemField(list, places[i].item), ...textEdit(before[i], after[i]) });
            } else {
                const item = counter.next++;
                records.push({ kind: 'itemPlace', entity, list, item, position });
                records.push({ kind: 'textValue', entity, field: itemField(list, item), text: after[i] });
            }
        }
        for (let i = after.length; i < places.length; i++) records.push({ kind: 'itemDelete', entity, list, item: places[i].item });
        return records;
    }
    for (let i = 0; i < paired; i++) {
        records.push({ kind: 'textEdit', entity, field: itemField(list, places[head + i].item), ...textEdit(before[head + i], after[head + i]) });
    }
    for (let i = paired; i < oldMid; i++) records.push({ kind: 'itemDelete', entity, list, item: places[head + i].item });
    for (let i = 0; i < added; i++) {
        const item = counter.next++;
        records.push({ kind: 'itemPlace', entity, list, item, position: lo + step * (i + 1) });
        records.push({ kind: 'textValue', entity, field: itemField(list, item), text: after[head + paired + i] });
    }
    return records;
}
