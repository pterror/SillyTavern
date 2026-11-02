import { findKeySpans } from './key-matching.js';
import { EMBEDDED_WORLD_NAME as CARD_BOOK } from './candidate-resolution.js';

/**
 * @typedef {{ book: string, entry: string } | { card: string }} EntryRef
 * @typedef {{ node: string, spans: [number, number][] } | { sent: true, spans: [number, number][] } | { field: string } | { inject: string }} RecordSource
 * @typedef {{
 *   ref: EntryRef,
 *   why: import('./activation.js').ActivationWhy,
 *   step: number,
 *   keys: { key: string, in: RecordSource[] }[],
 *   via: number[],
 *   position: number | null,
 *   depth: number | null,
 *   role: number | null,
 * }} RecordEntry
 * @typedef {{ entries: RecordEntry[], cut: { ref: EntryRef, why: 'budget' | 'chance' | 'group' }[] }} ActivationRecord
 */

/**
 * @param {import('./activation.js').WIEntry[]} entries
 * @param {{ entryRefs: (entries: { world: string, uid: string | number }[]) => Promise<({ book: bigint, entry: bigint } | null)[]> }} books
 * @returns {Promise<Map<import('./activation.js').WIEntry, EntryRef>>}
 */
async function refsOf(entries, books) {
    /** @type {Map<import('./activation.js').WIEntry, EntryRef>} */
    const refs = new Map();
    const stored = entries.filter(e => e.world !== CARD_BOOK);
    for (const e of entries) {
        if (e.world === CARD_BOOK) refs.set(e, { card: String(e.uid) });
    }
    const found = stored.length ? await books.entryRefs(stored.map(e => ({ world: e.world, uid: e.uid }))) : [];
    stored.forEach((e, i) => {
        const ref = found[i];
        if (ref) refs.set(e, { book: String(ref.book), entry: String(ref.entry) });
    });
    return refs;
}

/**
 * @param {number | undefined} value
 * @returns {number | null}
 */
const numberOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * @param {import('./activation.js').ActivationTrace} trace
 * @param {object} context
 * @param {{ nodeId: string | null, text: string }[]} context.messages the scanned messages, newest first (depth 0 is the last)
 * @param {string[]} context.injects what each scan inject was, in the order they were added
 * @param {{ entryRefs: (entries: { world: string, uid: string | number }[]) => Promise<({ book: bigint, entry: bigint } | null)[]> }} context.books
 * @returns {Promise<ActivationRecord | null>}
 */
export async function buildActivationRecord(trace, { messages, injects, books }) {
    if (!trace.activated.length && !trace.cut.length) return null;
    const refs = await refsOf([...trace.activated.map(a => a.entry), ...trace.cut.map(c => c.entry)], books);
    const kept = trace.activated.filter(a => refs.has(a.entry));
    const index = new Map(kept.map((a, i) => [a.entry, i]));
    /** @type {RecordEntry[]} */
    const entries = kept.map(a => ({
        ref: /** @type {EntryRef} */ (refs.get(a.entry)),
        why: a.why,
        step: a.step,
        keys: a.keys.map(({ key, sources }) => ({
            key,
            in: sources.flatMap(/** @returns {RecordSource[]} */ source => {
                if ('depth' in source) {
                    const message = messages[source.depth];
                    if (!message || message.nodeId === '') return [];
                    const spans = findKeySpans(message.text, key, a.entry);
                    return [message.nodeId === null ? { sent: true, spans } : { node: message.nodeId, spans }];
                }
                if ('field' in source) return [{ field: source.field }];
                if ('inject' in source) return [{ inject: injects[source.inject] ?? 'other' }];
                return [];
            }),
        })),
        via: a.via.flatMap(v => {
            const i = index.get(v);
            return i === undefined ? [] : [i];
        }),
        position: numberOrNull(/** @type {any} */ (a.entry).position),
        depth: numberOrNull(/** @type {any} */ (a.entry).depth),
        role: numberOrNull(/** @type {any} */ (a.entry).role),
    }));
    const cut = trace.cut.flatMap(c => {
        const ref = refs.get(c.entry);
        return ref ? [{ ref, why: c.why }] : [];
    });
    if (!entries.length && !cut.length) return null;
    return { entries, cut };
}

/**
 * @param {ActivationRecord} record
 * @param {string} nodeId
 * @returns {ActivationRecord}
 */
export function withSentMessage(record, nodeId) {
    return {
        ...record,
        entries: record.entries.map(e => ({
            ...e,
            keys: e.keys.map(k => ({
                ...k,
                in: k.in.map(s => ('sent' in s ? { node: nodeId, spans: s.spans } : s)),
            })),
        })),
    };
}

/**
 * @param {ActivationRecord | null | undefined} before
 * @param {ActivationRecord} after
 * @returns {ActivationRecord}
 */
export function mergeRecords(before, after) {
    if (!before || !Array.isArray(before.entries)) return after;
    const key = (/** @type {EntryRef} */ ref) => JSON.stringify(ref);
    const at = new Map(after.entries.map((e, i) => [key(e.ref), i]));
    const kept = before.entries.filter(e => !at.has(key(e.ref)));
    kept.forEach((e, i) => at.set(key(e.ref), after.entries.length + i));
    const entries = [
        ...after.entries,
        ...kept.map(e => ({
            ...e,
            via: [...new Set(e.via.flatMap(v => {
                const target = before.entries[v];
                const i = target ? at.get(key(target.ref)) : undefined;
                return i === undefined ? [] : [i];
            }))],
        })),
    ];
    const used = new Set(entries.map(e => key(e.ref)));
    const cut = [...after.cut, ...(before.cut ?? []).filter(c => !used.has(key(c.ref)) && !after.cut.some(a => key(a.ref) === key(c.ref)))];
    return { entries, cut };
}
