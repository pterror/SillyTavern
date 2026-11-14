import { getStringHash } from '../hash-utils.js';
import { TRIGGER_MARK_CLASS, TRIGGER_MARK_EARLIER_CLASS } from '/ui/entry.js';

/**
 * @typedef {import('@pterror/interact-editor/reader').Range} Range
 */

/**
 * @typedef {object} LoreMarks where replies' lore keys matched, by the message they matched in
 * @property {Record<string, any>[]} replies in chat order
 * @property {string | null} latest the chat's latest reply; the marks of every other reply carry the earlier class
 * @property {Map<string, { reply: number, entry: number, of: unknown, spans: unknown[] }[]>} sources each message's
 *   matched places: the reply and its entry, the hash of the text the spans are into, and the spans
 */

/**
 * @param {Record<string, any>[]} replies the replies whose activations are marked, in chat order
 * @param {string | null} latest the chat's latest reply
 * @returns {LoreMarks}
 */
export function loreMarksOf(replies, latest) {
    /** @type {LoreMarks['sources']} */
    const sources = new Map();
    replies.forEach((reply, at) => {
        const entries = reply?.extra?.activations?.entries;
        if (!Array.isArray(entries)) return;
        entries.forEach((entry, index) => {
            for (const key of Array.isArray(entry?.keys) ? entry.keys : []) {
                for (const source of Array.isArray(key?.in) ? key.in : []) {
                    if (typeof source?.node !== 'string' || !Array.isArray(source.spans)) continue;
                    const into = sources.get(source.node) ?? [];
                    into.push({ reply: at, entry: index, of: source.of, spans: source.spans });
                    sources.set(source.node, into);
                }
            }
        });
    });
    return { replies, latest, sources };
}

/**
 * The parts of a message's text that the replies' lore keys matched in: ranges of the text each reply read, kept only
 * while the text is still the one it read. A part matched for several replies is the latest of those replies', with
 * every entry of it matched over the part.
 * @param {LoreMarks} marks
 * @param {string} nodeId the message
 * @param {string} text the message's text
 * @returns {Range[]} disjoint, in order
 */
export function loreMarkRanges(marks, nodeId, text) {
    const sources = marks.sources.get(nodeId);
    if (!sources) return [];
    const hash = getStringHash(text);
    /** @type {{ from: number, to: number, reply: number, entry: number }[]} */
    const spans = [];
    for (const source of sources) {
        if (source.of !== hash) continue;
        for (const span of source.spans) {
            if (!Array.isArray(span)) continue;
            const [from, to] = span;
            if (Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= text.length && from < to) {
                spans.push({ from, to, reply: source.reply, entry: source.entry });
            }
        }
    }
    const points = [...new Set(spans.flatMap(span => [span.from, span.to]))].sort((a, b) => a - b);
    /** @type {Range[]} */
    const ranges = [];
    for (let i = 0; i + 1 < points.length; i++) {
        const from = points[i];
        const to = points[i + 1];
        const over = spans.filter(span => span.from <= from && to <= span.to);
        if (!over.length) continue;
        const at = Math.max(...over.map(span => span.reply));
        const here = [...new Set(over.filter(span => span.reply === at).map(span => span.entry))].sort((a, b) => a - b);
        const reply = String(marks.replies[at]?.node_id);
        ranges.push({
            from,
            to,
            class: `lore-mark ${TRIGGER_MARK_CLASS}${reply === marks.latest ? '' : ` ${TRIGGER_MARK_EARLIER_CLASS}`}`,
            attributes: { 'data-lore': here.join(' '), 'data-lore-reply': reply, tabindex: '0' },
        });
    }
    return ranges;
}
