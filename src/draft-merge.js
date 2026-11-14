import DiffMatchPatch from 'diff-match-patch';

/**
 * Drafts written at once in several places merge three ways: each save carries the changes from the text it was written
 * over (its base) to its text, so what it changed is laid over what the draft has had changed since that base, and what
 * both changed alike is taken once.
 */

/**
 * One replacement, in the positions of the text it applies to, with the text it removes
 * @typedef {{ from: number, to: number, insert: string, deleted: string }} DraftChange
 */

/** @typedef {{ from: number, to: number, insert: string }} Hunk */

const dmp = new DiffMatchPatch();
/** No time limit: a merge never depends on how fast a diff ran */
dmp.Diff_Timeout = 0;

/**
 * @param {unknown} change
 * @returns {change is DraftChange}
 */
function isChange(change) {
    if (!change || typeof change !== 'object') return false;
    const c = /** @type {Record<string, unknown>} */ (change);
    return Number.isSafeInteger(c.from) && Number.isSafeInteger(c.to) && typeof c.insert === 'string' && typeof c.deleted === 'string'
        && /** @type {number} */ (c.from) >= 0 && /** @type {number} */ (c.to) - /** @type {number} */ (c.from) === c.deleted.length;
}

/**
 * The text a save was written over: its changes undone on its text
 * @param {unknown} text the saved text
 * @param {unknown} changes the changes from the base to the text, in the base's positions, in order
 * @returns {string | null} null when the changes don't fit the text
 */
export function baseOf(text, changes) {
    if (typeof text !== 'string' || !Array.isArray(changes)) return null;
    let at = 0;
    let end = 0;
    let base = '';
    for (const change of changes) {
        if (!isChange(change) || change.from < end) return null;
        const kept = change.from - end;
        if (at + kept + change.insert.length > text.length) return null;
        base += text.slice(at, at + kept);
        at += kept;
        if (text.slice(at, at + change.insert.length) !== change.insert) return null;
        at += change.insert.length;
        base += change.deleted;
        end = change.to;
    }
    return base + text.slice(at);
}

/**
 * @param {string} text
 * @param {number} at
 * @returns {boolean} whether `at` falls between the two halves of a surrogate pair
 */
const splitsPair = (text, at) => at > 0 && at < text.length && (text.charCodeAt(at - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(at) & 0xfc00) === 0xdc00;

/**
 * The changes from one text to another, each run that differs one hunk, never splitting a character
 * @param {string} from
 * @param {string} to
 * @returns {Hunk[]}
 */
export function hunksBetween(from, to) {
    if (from === to) return [];
    const diffs = dmp.diff_main(from, to);
    dmp.diff_cleanupSemanticLossless(diffs);
    /** @type {Hunk[]} */
    const hunks = [];
    let at = 0;
    for (const [op, run] of diffs) {
        if (op === DiffMatchPatch.DIFF_EQUAL) {
            at += run.length;
            continue;
        }
        const last = hunks.at(-1);
        const hunk = last && last.to === at ? last : { from: at, to: at, insert: '' };
        if (hunk !== last) hunks.push(hunk);
        if (op === DiffMatchPatch.DIFF_DELETE) {
            at += run.length;
            hunk.to = at;
        } else {
            hunk.insert += run;
        }
    }
    /** @type {Hunk[]} */
    const whole = [];
    for (const hunk of hunks) {
        while (splitsPair(from, hunk.from)) {
            hunk.from -= 1;
            hunk.insert = from[hunk.from] + hunk.insert;
        }
        while (splitsPair(from, hunk.to)) {
            hunk.insert += from[hunk.to];
            hunk.to += 1;
        }
        const last = whole.at(-1);
        if (last && hunk.from < last.to) {
            last.insert += hunk.insert.slice(last.to - hunk.from);
            last.to = hunk.to;
        } else {
            whole.push(hunk);
        }
    }
    return whole;
}

/**
 * @param {Hunk} a
 * @param {Hunk} b
 * @returns {boolean} whether two changes touch the same text: their ranges overlap, one inserts inside the other's range,
 *   or both insert at one place
 */
const meet = (a, b) => (a.from < b.to && b.from < a.to) || (a.from === a.to && b.from === b.to && a.from === b.from);

/**
 * @param {string} base
 * @param {number} from
 * @param {number} to
 * @param {Hunk[]} hunks within from..to, in order
 * @returns {string} base's from..to with the hunks applied
 */
function applied(base, from, to, hunks) {
    let out = '';
    let at = from;
    for (const hunk of hunks) {
        out += base.slice(at, hunk.from) + hunk.insert;
        at = hunk.to;
    }
    return out + base.slice(at, to);
}

/**
 * @param {[Hunk[], Hunk[]]} sides the draft's changes and the save's, over one stretch of the base
 * @param {string} kept the stretch as the draft has it
 * @param {string} written the stretch as the save has it
 * @returns {string}
 */
function merged(sides, kept, written) {
    if (sides[1].length === 0) return kept;
    if (sides[0].length === 0) return written;
    if (kept.includes(written)) return kept;
    if (written.includes(kept)) return written;
    return kept + written;
}

/**
 * The base cut into stretches where the draft, the save or both changed it, with the stretch as each has it; stretches
 * where both changed text that touches are one.
 * @param {string} base
 * @param {string} current
 * @param {string} saved
 * @returns {{ from: number, to: number, sides: [Hunk[], Hunk[]], kept: string, written: string }[]}
 */
function stretches(base, current, saved) {
    const tagged = [
        ...hunksBetween(base, current).map(hunk => ({ hunk, side: 0 })),
        ...hunksBetween(base, saved).map(hunk => ({ hunk, side: 1 })),
    ].sort((a, b) => a.hunk.from - b.hunk.from || a.hunk.to - b.hunk.to || a.side - b.side);
    const out = [];
    let i = 0;
    while (i < tagged.length) {
        const span = { from: tagged[i].hunk.from, to: tagged[i].hunk.to, insert: '' };
        /** @type {[Hunk[], Hunk[]]} */
        const sides = [[], []];
        while (i < tagged.length && (sides[0].length + sides[1].length === 0 || meet(span, tagged[i].hunk))) {
            const { hunk, side } = tagged[i];
            sides[side].push(hunk);
            span.to = Math.max(span.to, hunk.to);
            i += 1;
        }
        const [kept, written] = sides.map(hunks => applied(base, span.from, span.to, hunks));
        out.push({ from: span.from, to: span.to, sides, kept, written });
    }
    return out;
}

/**
 * @param {string} base
 * @param {{ from: number, to: number, text: string }[]} pieces in order, within the base
 * @returns {string}
 */
function laid(base, pieces) {
    let out = '';
    let at = 0;
    for (const piece of pieces) {
        out += base.slice(at, piece.from) + piece.text;
        at = piece.to;
    }
    return out + base.slice(at);
}

/**
 * The draft a save makes: what the save changed since its base laid over what the draft has had changed since. Where
 * both changed the same text, a version that holds the other is taken alone, so merging a save that is already in the
 * draft changes nothing; otherwise both are kept, the draft's first.
 * @param {string} base the text the save was written over
 * @param {string} current the draft as it is
 * @param {string} saved the saved text
 * @returns {string}
 */
export function mergeDraft(base, current, saved) {
    if (saved === base || saved === current) return current;
    if (current === base) return saved;
    return laid(base, stretches(base, current, saved).map(({ from, to, sides, kept, written }) => ({ from, to, text: merged(sides, kept, written) })));
}

/**
 * A save laid over what was changed since its base, when the two changed no text in the same place, or changed it
 * alike
 * @param {string} base the text the save was written over
 * @param {string} current the text as it is
 * @param {string} saved the saved text
 * @returns {string | null} null when both changed the same text differently
 */
export function mergeApart(base, current, saved) {
    if (saved === base || saved === current) return current;
    if (current === base) return saved;
    const pieces = [];
    for (const { from, to, sides, kept, written } of stretches(base, current, saved)) {
        if (sides[0].length > 0 && sides[1].length > 0 && kept !== written) return null;
        pieces.push({ from, to, text: sides[1].length > 0 ? written : kept });
    }
    return laid(base, pieces);
}

/**
 * The draft after a send: what the sender had, laid over the draft, then taken out of it, so text written elsewhere
 * since stays
 * @param {string} base the text the sent text was written over
 * @param {string} current the draft as it is
 * @param {string} sent the text sent
 * @returns {string}
 */
export function draftAfterSend(base, current, sent) {
    return mergeDraft(sent, mergeDraft(base, current, sent), '');
}

const WORD = /\s+|[\p{L}\p{N}\p{M}_'’-]+|[^\s\p{L}\p{N}\p{M}_'’-]/gu;

/**
 * The runs of one text against another, word by word: what both have, and what only one has
 * @param {string} from
 * @param {string} to
 * @returns {{ text: string, in: 'both' | 'from' | 'to' }[]}
 */
export function wordRuns(from, to) {
    /** @type {Map<string, string>} */
    const codes = new Map();
    /** @type {string[]} */
    const words = [];
    const encode = (/** @type {string} */ text) => (text.match(WORD) ?? []).map(word => {
        let code = codes.get(word);
        if (code === undefined) {
            code = String.fromCharCode(words.length);
            codes.set(word, code);
            words.push(word);
        }
        return code;
    }).join('');
    const [codedFrom, codedTo] = [encode(from), encode(to)];
    if (words.length > 0xffff) return [{ text: from, in: 'from' }, { text: to, in: 'to' }];
    const diffs = dmp.diff_main(codedFrom, codedTo, false);
    dmp.diff_cleanupSemantic(diffs);
    /** @type {{ text: string, in: 'both' | 'from' | 'to' }[]} */
    const runs = [];
    for (const [op, coded] of diffs) {
        const text = coded.split('').map(code => words[code.charCodeAt(0)]).join('');
        const side = op === DiffMatchPatch.DIFF_EQUAL ? 'both' : op === DiffMatchPatch.DIFF_DELETE ? 'from' : 'to';
        const last = runs.at(-1);
        if (last && last.in === side) last.text += text;
        else if (text !== '') runs.push({ text, in: side });
    }
    return runs;
}
