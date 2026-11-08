import { FIELD } from './library-codes.js';
import { POSITION_GAP, itemField, storedValues } from './entity-values.js';
import { textEdit } from './text-edit.js';

export const GREETING_LIST = 0;
export const DEFAULT_POSITION_VALUE = 'ext:greeting_default_position';

/** @typedef {{ id: number, text: string }} Greeting */
/** @typedef {{ greetings: Greeting[], defaultId: number | null, nextId: number }} GreetingModel */

/**
 * @param {string | undefined} json
 * @returns {number | null}
 */
function wholeNumber(json) {
    if (json === undefined) return null;
    const value = JSON.parse(json);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * @param {Greeting[]} others
 * @param {Greeting | null} first
 * @param {number | null} at
 * @returns {Greeting[]}
 */
function inOrder(others, first, at) {
    if (!first) return others;
    const position = at !== null && at <= others.length ? at : 0;
    return [...others.slice(0, position), first, ...others.slice(position)];
}

/**
 * @param {import('./entity-values.js').StoredEntity | null} entity
 * @returns {GreetingModel}
 */
export function greetingModelOf(entity) {
    if (!entity) return { greetings: [], defaultId: null, nextId: 0 };
    const { values } = storedValues(entity);
    const texts = new Map(entity.values.filter(v => typeof v.field === 'number' && v.field >= 1024).map(v => [v.field, v.text ?? '']));
    const others = entity.items
        .filter(i => i.list === GREETING_LIST)
        .sort((a, b) => a.position - b.position)
        .map(i => ({ id: i.item, text: texts.get(itemField(GREETING_LIST, i.item)) ?? '' }));
    const firstText = values.get(FIELD.first_mes)?.text ?? '';
    const first = firstText === '' ? null : { id: wholeNumber(values.get(FIELD.first_mes_item)?.json) ?? 0, text: firstText };
    const greetings = inOrder(others, first, wholeNumber(values.get(DEFAULT_POSITION_VALUE)?.json));
    const highest = Math.max(-1, ...greetings.map(g => g.id));
    return { greetings, defaultId: first?.id ?? null, nextId: Math.max(highest + 1, wholeNumber(values.get(FIELD.greeting_next_item)?.json) ?? 0) };
}

/**
 * @param {import('./character-card-storage.js').CardParts} parts
 * @returns {{ texts: string[], defaultIndex: number | null }}
 */
export function greetingTextsOf(parts) {
    const others = parts.greetings.filter(g => g.list === 'alternate_greetings').sort((a, b) => a.position - b.position).map(g => g.text);
    const firstText = typeof parts.card.first_mes === 'string' ? parts.card.first_mes : '';
    if (firstText === '') return { texts: others, defaultIndex: null };
    const recorded = parts.extensions.find(e => e.key === 'greeting_default_position');
    const at = recorded ? wholeNumber(recorded.value) : null;
    const position = at !== null && at <= others.length ? at : 0;
    return { texts: [...others.slice(0, position), firstText, ...others.slice(position)], defaultIndex: position };
}

/**
 * @param {GreetingModel} stored
 * @param {{ texts: string[], defaultIndex: number | null }} written
 * @returns {GreetingModel}
 */
export function matchedGreetings(stored, written) {
    const unused = [...stored.greetings];
    let nextId = stored.nextId;
    const greetings = written.texts.map(text => {
        const at = unused.findIndex(g => g.text === text);
        if (at >= 0) return { id: unused.splice(at, 1)[0].id, text };
        return { id: nextId++, text };
    });
    return { greetings, defaultId: written.defaultIndex === null ? null : greetings[written.defaultIndex].id, nextId };
}

/**
 * @param {number[]} positions
 * @returns {Set<number>} the indexes of a longest increasing run of the defined positions
 */
function keptInOrder(positions) {
    /** @type {number[]} */
    const tails = [];
    /** @type {number[]} */
    const before = new Array(positions.length).fill(-1);
    positions.forEach((position, i) => {
        if (position < 0) return;
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (positions[tails[mid]] < position) lo = mid + 1;
            else hi = mid;
        }
        before[i] = lo > 0 ? tails[lo - 1] : -1;
        tails[lo] = i;
    });
    const kept = new Set();
    for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = before[i]) kept.add(i);
    return kept;
}

/**
 * @param {bigint} entity
 * @param {import('./entity-values.js').StoredEntity | null} stored
 * @param {GreetingModel} model
 * @returns {{ records: object[], values: Map<number | string, { json: string }> }}
 */
export function greetingRecords(entity, stored, model) {
    const records = [];
    const texts = new Map((stored?.values ?? []).filter(v => typeof v.field === 'number' && v.field >= 1024).map(v => [v.field, v.text ?? '']));
    const placed = new Map((stored?.items ?? []).filter(i => i.list === GREETING_LIST).map(i => [i.item, i.position]));
    const others = model.greetings.filter(g => g.id !== model.defaultId);
    const wanted = new Set(others.map(g => g.id));
    for (const item of placed.keys()) {
        if (!wanted.has(item)) records.push({ kind: 'itemDelete', entity, list: GREETING_LIST, item });
    }
    const positions = others.map(g => placed.get(g.id) ?? -1);
    const kept = keptInOrder(positions);
    const held = new Set([...placed.entries()].filter(([item]) => wanted.has(item)).map(([, position]) => position));
    /** @type {number[]} */
    const next = positions.map((p, i) => (kept.has(i) ? p : -1));
    let fits = true;
    for (let i = 0; i < next.length && fits;) {
        if (next[i] >= 0) {
            i++;
            continue;
        }
        let j = i;
        while (j < next.length && next[j] < 0) j++;
        let at = i > 0 ? next[i - 1] : -1;
        const hi = j < next.length ? next[j] : at + POSITION_GAP * (j - i + 1);
        const step = Math.max(1, Math.floor((hi - at) / (j - i + 1)));
        for (let k = i; k < j && fits; k++) {
            at += step;
            while (held.has(at) && at < hi) at++;
            if (at >= hi) fits = false;
            next[k] = at;
        }
        i = j;
    }
    const top = Math.max(-1, ...placed.values());
    others.forEach((g, i) => {
        const position = fits ? next[i] : top + POSITION_GAP * (i + 1);
        if (placed.get(g.id) !== position) records.push({ kind: 'itemPlace', entity, list: GREETING_LIST, item: g.id, position });
        const field = itemField(GREETING_LIST, g.id);
        if (!placed.has(g.id)) records.push({ kind: 'textValue', entity, field, text: g.text });
        else if (texts.get(field) !== g.text) records.push({ kind: 'textEdit', entity, field, ...textEdit(texts.get(field) ?? '', g.text) });
    });
    /** @type {Map<number | string, { json: string }>} */
    const values = new Map();
    if (model.defaultId !== null && model.defaultId !== 0) values.set(FIELD.first_mes_item, { json: JSON.stringify(model.defaultId) });
    const highest = Math.max(-1, ...model.greetings.map(g => g.id));
    if (model.nextId > highest + 1) values.set(FIELD.greeting_next_item, { json: JSON.stringify(model.nextId) });
    return { records, values };
}
