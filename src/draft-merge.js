import { ChangeSet, Text } from '@codemirror/state';
import DiffMatchPatch from 'diff-match-patch';

/**
 * Drafts written at once in several places merge, as an editor rebases edits made elsewhere (`ChangeSet.map`): what one
 * writer changed since the text both started from is laid over what the others changed since.
 */

const dmp = new DiffMatchPatch();
/** No time limit: a diff never depends on how fast it ran */
dmp.Diff_Timeout = 0;

/**
 * @param {string} from
 * @param {string} to
 * @returns {ChangeSet} the changes from one text to the other, each run that differs its own change
 */
export function changesBetween(from, to) {
    const diffs = dmp.diff_main(from, to);
    dmp.diff_cleanupSemantic(diffs);
    /** @type {{ from: number, to?: number, insert?: string }[]} */
    const specs = [];
    let at = 0;
    for (const [op, run] of diffs) {
        if (op === DiffMatchPatch.DIFF_EQUAL) {
            at += run.length;
        } else if (op === DiffMatchPatch.DIFF_DELETE) {
            specs.push({ from: at, to: at + run.length });
            at += run.length;
        } else {
            specs.push({ from: at, insert: run });
        }
    }
    return ChangeSet.of(specs, from.length);
}

/** @param {string} text */
const doc = text => Text.of(text.split('\n'));

/** A lone UTF-16 surrogate, which a diff of a character outside the BMP can leave in a merge */
const BROKEN = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Both texts whole: what they share at the start and the end once, and between it each one's own part, the kept text's
 * first. Nothing of either is lost.
 * @param {string} kept the draft as it is
 * @param {string} saved the text written over an earlier draft whose text is not known any more
 * @returns {string}
 */
export function unionOf(kept, saved) {
    const max = Math.min(kept.length, saved.length);
    let start = 0;
    while (start < max && kept.charCodeAt(start) === saved.charCodeAt(start)) start++;
    if (start > 0 && (kept.charCodeAt(start - 1) & 0xfc00) === 0xd800) start--;
    let end = 0;
    while (end < max - start && kept.charCodeAt(kept.length - 1 - end) === saved.charCodeAt(saved.length - 1 - end)) end++;
    if (end > 0 && (kept.charCodeAt(kept.length - end) & 0xfc00) === 0xdc00) end--;
    return kept.slice(0, kept.length - end) + saved.slice(start, saved.length - end) + kept.slice(kept.length - end);
}

/**
 * A text written over `base` laid over the draft as it became since, which also started from `base`
 * @param {string} base the draft both started from
 * @param {string} kept the draft as it is now
 * @param {string} saved the text written over `base`
 * @returns {string}
 */
export function mergeDraft(base, kept, saved) {
    if (saved === base || saved === kept) return kept;
    if (kept === base) return saved;
    const theirs = changesBetween(base, kept);
    const mine = changesBetween(base, saved);
    const merged = mine.map(theirs).apply(doc(kept)).toString();
    return BROKEN.test(merged) && !BROKEN.test(kept) && !BROKEN.test(saved) ? unionOf(kept, saved) : merged;
}
