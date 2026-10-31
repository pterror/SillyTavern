import { POSITION_GAP, itemField, storedValues } from './entity-values.js';


export const LINKS = 4;

/** @typedef {import('./entity-values.js').StoredEntity} StoredEntity */

/**
 * @param {StoredEntity | null} stored
 * @returns {{ item: number, position: number, book: bigint }[]}
 */
export function storedLinks(stored) {
    if (!stored) return [];
    const { lists, places } = storedValues(stored);
    const texts = lists.get(LINKS) ?? [];
    return (places.get(LINKS) ?? [])
        .map((p, i) => ({ ...p, book: texts[i] === '' ? null : BigInt(texts[i]) }))
        .filter(l => l.book !== null)
        .map(l => ({ item: l.item, position: l.position, book: /** @type {bigint} */ (l.book) }));
}

/**
 * @param {bigint} entity
 * @param {{ item: number, position: number, book: bigint }[]} before
 * @param {bigint[]} after
 * @param {number} [nextItem]
 * @returns {object[]}
 */
export function linkListRecords(entity, before, after, nextItem = 1 + Math.max(0, ...before.map(l => l.item))) {
    const list = LINKS;
    const had = new Map(before.map(l => [l.book, l]));
    const wanted = new Set(after);
    const records = [];
    for (const l of before) if (!wanted.has(l.book)) records.push({ kind: 'itemDelete', entity, list, item: l.item });
    const kept = after.map(b => had.get(b)).filter(l => l !== undefined);
    const best = kept.map(() => 1);
    const from = kept.map(() => -1);
    for (let i = 0; i < kept.length; i++) {
        for (let j = 0; j < i; j++) {
            if (kept[j].position < kept[i].position && best[j] + 1 > best[i]) {
                best[i] = best[j] + 1;
                from[i] = j;
            }
        }
    }
    const anchors = new Set();
    for (let i = best.indexOf(Math.max(0, ...best)); i !== -1 && kept.length > 0; i = from[i]) anchors.add(kept[i].book);
    /** @type {(number | null)[]} */
    const places = after.map(b => (anchors.has(b) ? /** @type {any} */ (had.get(b)).position : null));
    const held = new Map(before.filter(l => wanted.has(l.book) && !anchors.has(l.book)).map(l => [l.position, l.book]));
    let fits = true;
    for (let i = 0; i < after.length;) {
        if (places[i] !== null) {
            i++;
            continue;
        }
        let j = i;
        while (j < after.length && places[j] === null) j++;
        const lo = i > 0 ? /** @type {number} */ (places[i - 1]) : -1;
        const hi = j < after.length ? /** @type {number} */ (places[j]) : lo + POSITION_GAP * (j - i + 1);
        const step = Math.floor((hi - lo) / (j - i + 1));
        for (let k = i; k < j; k++) places[k] = lo + step * (k - i + 1);
        for (let k = i; k < j; k++) {
            const by = held.get(/** @type {number} */ (places[k]));
            if (by !== undefined && by !== after[k]) fits = false;
        }
        if (step < 1) fits = false;
        i = j;
    }
    if (!fits) {
        const top = before.reduce((m, l) => Math.max(m, l.position), 0);
        for (let i = 0; i < after.length; i++) places[i] = top + POSITION_GAP * (i + 1);
    }
    let item = nextItem;
    after.forEach((book, i) => {
        const position = /** @type {number} */ (places[i]);
        const l = had.get(book);
        if (l) {
            if (l.position !== position) records.push({ kind: 'itemPlace', entity, list, item: l.item, position });
            return;
        }
        const added = item++;
        records.push({ kind: 'itemPlace', entity, list, item: added, position });
        records.push({ kind: 'textValue', entity, field: itemField(list, added), text: String(book) });
    });
    return records;
}

