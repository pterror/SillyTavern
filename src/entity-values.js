import { textEdit } from './text-edit.js';

/**
 * An entity's values as the engine stores them, and the records turning stored values into new ones: the library's
 * and world info's entities alike.
 */

/**
 * Appends `items` to `list` one by one (a spread argument list overflows the stack for a large book's records).
 * @template T
 * @param {T[]} list
 * @param {Iterable<T>} items
 */
export function pushAll(list, items) {
    for (const x of items) list.push(x);
}

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
 * @typedef {object} Writes How the records changing an entity's values are written.
 * @property {(entity: bigint, field: number | string, text: string) => object} text A field's text.
 * @property {(entity: bigint, field: number | string, edit: { offset: number, removed: number, text: string }) => object} edit
 * An edit of its text.
 * @property {(entity: bigint, field: number | string, json: string, before: string | undefined) => object[]} json Its
 * JSON (`before`: the JSON stored, if any).
 * @property {(entity: bigint, field: number | string) => object[]} delete Its value goes.
 * @property {(entity: bigint, list: number, item: number, position: number) => object} place A list item's place.
 * @property {(entity: bigint, list: number, item: number) => object[]} unplace The item and its text go.
 */

/** @type {Writes} The records written over: each value's current record only. */
const OVERWRITE = Object.freeze({
    text: (entity, field, text) => ({ kind: 'textValue', entity, field, text }),
    edit: (entity, field, edit) => ({ kind: 'textEdit', entity, field, ...edit }),
    json: (entity, field, json) => [{ kind: 'jsonValue', entity, field, json }],
    delete: (entity, field) => [{ kind: 'valueDelete', entity, field }],
    place: (entity, list, item, position) => ({ kind: 'itemPlace', entity, list, item, position }),
    unplace: (entity, list, item) => [{ kind: 'itemDelete', entity, list, item }],
});

/**
 * @typedef {object} Stamp Who made a change and when, as a history record holds it.
 * @property {bigint} id
 * @property {number} time
 * @property {bigint} [session]
 * @property {bigint} [user]
 */

/**
 * The records writing changes with their history (`store::history`): each a change stamped by `stamp()`, a JSON
 * value's change an edit of its JSON as a text value's is.
 * @param {() => Stamp} stamp
 * @returns {Writes}
 */
export function historyWrites(stamp) {
    return {
        text: (entity, field, text) => ({ kind: 'histSet', entity, field, value: text, json: false, ...stamp() }),
        edit: (entity, field, edit) => ({ kind: 'histEdit', entity, field, ...edit, json: false, ...stamp() }),
        json: (entity, field, json, before) => [before === undefined
            ? { kind: 'histSet', entity, field, value: json, json: true, ...stamp() }
            : { kind: 'histEdit', entity, field, ...textEdit(before, json), json: true, ...stamp() }],
        delete: (entity, field) => [{ kind: 'histDelete', entity, field, ...stamp() }],
        place: (entity, list, item, position) => ({ kind: 'histPlace', entity, list, item, position, ...stamp() }),
        unplace: (entity, list, item) => [
            { kind: 'histPlace', entity, list, item, ...stamp() },
            { kind: 'histDelete', entity, field: itemField(list, item), ...stamp() },
        ],
    };
}

/**
 * The records turning a stored entity's values (none for a new one) into `values` and `lists`.
 * @param {bigint} entity
 * @param {StoredEntity | null} stored
 * @param {{ values: Map<number | string, { text?: string, json?: string }>, lists: Map<number, string[]> }} next
 * @param {Writes} [writes]
 * @returns {object[]}
 */
export function valueRecords(entity, stored, next, writes = OVERWRITE) {
    const old = stored ? storedValues(stored) : { values: new Map(), lists: new Map(), places: new Map() };
    const records = [];
    for (const field of old.values.keys()) {
        if (!next.values.has(field)) pushAll(records, writes.delete(entity, field));
    }
    for (const [field, after] of next.values) {
        const before = old.values.get(field);
        if (after.text !== undefined) {
            if (before?.text === after.text) continue;
            if (before?.text !== undefined) records.push(writes.edit(entity, field, textEdit(before.text, after.text)));
            else records.push(writes.text(entity, field, after.text));
        } else if (before?.json !== after.json) {
            pushAll(records, writes.json(entity, field, /** @type {string} */ (after.json), before?.json));
        }
    }
    const counter = { next: 1 + Math.max(0, ...(stored?.items ?? []).map(i => i.item)) };
    for (const list of new Set([...old.lists.keys(), ...next.lists.keys()])) {
        pushAll(records, listRecords(entity, list, old.lists.get(list) ?? [], old.places.get(list) ?? [], next.lists.get(list) ?? [], counter, writes));
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
 * @param {Writes} writes
 * @returns {object[]}
 */
function listRecords(entity, list, before, places, after, counter, writes) {
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
    const edit = (/** @type {number} */ item, /** @type {string} */ from, /** @type {string} */ to) => writes.edit(entity, itemField(list, item), textEdit(from, to));
    if (added > 0 && step < 1) {
        const top = places.reduce((m, p) => Math.max(m, p.position), 0);
        for (let i = 0; i < after.length; i++) {
            const position = top + POSITION_GAP * (i + 1);
            if (i < places.length) {
                records.push(writes.place(entity, list, places[i].item, position));
                if (before[i] !== after[i]) records.push(edit(places[i].item, before[i], after[i]));
            } else {
                const item = counter.next++;
                records.push(writes.place(entity, list, item, position));
                records.push(writes.text(entity, itemField(list, item), after[i]));
            }
        }
        for (let i = after.length; i < places.length; i++) pushAll(records, writes.unplace(entity, list, places[i].item));
        return records;
    }
    for (let i = 0; i < paired; i++) {
        if (before[head + i] !== after[head + i]) records.push(edit(places[head + i].item, before[head + i], after[head + i]));
    }
    for (let i = paired; i < oldMid; i++) pushAll(records, writes.unplace(entity, list, places[head + i].item));
    for (let i = 0; i < added; i++) {
        const item = counter.next++;
        records.push(writes.place(entity, list, item, lo + step * (i + 1)));
        records.push(writes.text(entity, itemField(list, item), after[head + paired + i]));
    }
    return records;
}
