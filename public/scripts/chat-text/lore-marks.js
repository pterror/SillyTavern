import { getStringHash } from '../hash-utils.js';
import { TRIGGER_MARK_CLASS } from '/ui/entry.js';

/**
 * @typedef {import('@pterror/interact-editor/reader').Range} Range
 */

/**
 * The parts of a message's text that the reply's lore keys matched in, as activation reported them: ranges of the text
 * it read, kept only while the text is still the one it read. Each part has every entry matched over it.
 * @param {Record<string, any> | null} reply the reply whose activations are marked
 * @param {string} nodeId the message
 * @param {string} text the message's text
 * @returns {Range[]} disjoint, in order
 */
export function loreMarkRanges(reply, nodeId, text) {
    const entries = reply?.extra?.activations?.entries;
    if (!Array.isArray(entries)) return [];
    /** @type {{ from: number, to: number, entry: number }[]} */
    const spans = [];
    /** @type {number | null} */
    let hash = null;
    entries.forEach((entry, index) => {
        for (const key of Array.isArray(entry?.keys) ? entry.keys : []) {
            for (const source of Array.isArray(key?.in) ? key.in : []) {
                if (source?.node !== nodeId || !Array.isArray(source.spans)) continue;
                hash ??= getStringHash(text);
                if (source.of !== hash) continue;
                for (const [from, to] of source.spans) {
                    if (Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= text.length && from < to) {
                        spans.push({ from, to, entry: index });
                    }
                }
            }
        }
    });
    const points = [...new Set(spans.flatMap(span => [span.from, span.to]))].sort((a, b) => a - b);
    /** @type {Range[]} */
    const ranges = [];
    for (let i = 0; i + 1 < points.length; i++) {
        const from = points[i];
        const to = points[i + 1];
        const here = [...new Set(spans.filter(span => span.from <= from && to <= span.to).map(span => span.entry))].sort((a, b) => a - b);
        if (here.length) {
            ranges.push({
                from,
                to,
                class: `lore-mark ${TRIGGER_MARK_CLASS}`,
                attributes: { 'data-lore': here.join(' '), 'data-lore-reply': String(reply?.node_id), tabindex: '0' },
            });
        }
    }
    return ranges;
}
