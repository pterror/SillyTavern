/**
 * The character list's bulk selection, held as rules over the list rather than as a list of every selected
 * character: "everything the list shows" (`all`), position ranges of it, and the characters picked or left out one by
 * one. Positions count the list's rows from 0 in the list's own order, groups included, folder tiles not. The server
 * turns a selection into characters (`POST /api/characters/bulk/prepare`).
 *
 * `include` holds only characters that `all` and `ranges` don't already select (or that `excludeRanges` left out),
 * and `exclude` only ones they do, so the server can apply them in order without checking.
 */

/**
 * @typedef {object} BulkSelection
 * @property {boolean} all Every character the list shows.
 * @property {[number, number][]} ranges Positions selected, both ends included, sorted, not overlapping.
 * @property {[number, number][]} excludeRanges Positions left out of `all`, same shape.
 * @property {Map<string, number>} include Characters picked one by one, with their position when picked.
 * @property {Map<string, number>} exclude Characters left out one by one, with their position when left out.
 */

/** @returns {BulkSelection} */
export function emptySelection() {
    return { all: false, ranges: [], excludeRanges: [], include: new Map(), exclude: new Map() };
}

/**
 * @param {[number, number][]} ranges
 * @param {number} position
 */
function inRanges(ranges, position) {
    return Number.isInteger(position) && ranges.some(([a, b]) => position >= a && position <= b);
}

/**
 * @param {[number, number][]} ranges
 * @param {number} a
 * @param {number} b
 * @returns {[number, number][]} `ranges` with a..b added, merged.
 */
function addRange(ranges, a, b) {
    const all = [...ranges, [a, b]].sort((x, y) => x[0] - y[0]);
    /** @type {[number, number][]} */
    const merged = [];
    for (const [start, end] of all) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
    }
    return merged;
}

/**
 * @param {[number, number][]} ranges
 * @param {number} a
 * @param {number} b
 * @returns {[number, number][]} `ranges` less a..b.
 */
function subtractRange(ranges, a, b) {
    /** @type {[number, number][]} */
    const left = [];
    for (const [start, end] of ranges) {
        if (end < a || start > b) {
            left.push([start, end]);
            continue;
        }
        if (start < a) left.push([start, a - 1]);
        if (end > b) left.push([b + 1, end]);
    }
    return left;
}

/**
 * Whether a character is selected.
 * @param {BulkSelection} selection
 * @param {string} avatar
 * @param {number} position Its position in the list.
 */
export function isSelected(selection, avatar, position) {
    if (selection.exclude.has(avatar)) return false;
    if (selection.include.has(avatar)) return true;
    if (selection.all) return !inRanges(selection.excludeRanges, position);
    return inRanges(selection.ranges, position);
}

/**
 * Selects or unselects one character.
 * @param {BulkSelection} selection Changed in place.
 * @param {string} avatar
 * @param {number} position
 * @param {boolean} select
 */
export function setOne(selection, avatar, position, select) {
    if (isSelected(selection, avatar, position) === select) return;
    if (select) {
        // Selected before by a rule and left out by hand: taking it off the left-out list is enough.
        if (selection.exclude.has(avatar)) selection.exclude.delete(avatar);
        else selection.include.set(avatar, position);
    } else if (selection.include.has(avatar)) {
        selection.include.delete(avatar);
    } else {
        selection.exclude.set(avatar, position);
    }
}

/**
 * Selects or unselects every character from position `a` to `b`, both included.
 * @param {BulkSelection} selection Changed in place.
 * @param {number} a
 * @param {number} b
 * @param {boolean} select
 */
export function setRange(selection, a, b, select) {
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (select) {
        selection.excludeRanges = subtractRange(selection.excludeRanges, start, end);
        if (!selection.all) selection.ranges = addRange(selection.ranges, start, end);
    } else {
        selection.ranges = subtractRange(selection.ranges, start, end);
        if (selection.all) selection.excludeRanges = addRange(selection.excludeRanges, start, end);
    }
    // The range now decides these, one way or the other.
    for (const map of [selection.include, selection.exclude]) {
        for (const [avatar, position] of map) {
            if (position >= start && position <= end) map.delete(avatar);
        }
    }
}

/**
 * Selects every character the list shows, or nothing.
 * @param {BulkSelection} selection Changed in place.
 * @param {boolean} select
 */
export function setAll(selection, select) {
    selection.all = select;
    selection.ranges = [];
    selection.excludeRanges = [];
    selection.include.clear();
    selection.exclude.clear();
}

/**
 * Whether the selection is "everything the list shows", with nothing left out.
 * @param {BulkSelection} selection
 */
export function isEverything(selection) {
    return selection.all && selection.excludeRanges.length === 0 && selection.exclude.size === 0;
}

/**
 * Whether the selection selects anything.
 * @param {BulkSelection} selection
 */
export function isEmpty(selection) {
    return !selection.all && selection.ranges.length === 0 && selection.include.size === 0;
}

/**
 * How many characters the selection holds, as far as the page can tell. Exact for characters picked one by one; an
 * estimate (`approx`) when a rule is involved, since rules count list rows and groups are rows too. The server
 * gives the exact count when the selection is prepared.
 * @param {BulkSelection} selection
 * @param {number} total How many rows the list has.
 * @returns {{ count: number, approx: boolean }}
 */
export function countSelection(selection, total) {
    const width = (/** @type {[number, number][]} */ ranges) => ranges
        .reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, total - 1) - a + 1), 0);
    if (selection.all) {
        const count = total - width(selection.excludeRanges) - selection.exclude.size + selection.include.size;
        return { count: Math.max(0, count), approx: true };
    }
    if (selection.ranges.length === 0) {
        return { count: selection.include.size, approx: false };
    }
    const count = width(selection.ranges) - selection.exclude.size + selection.include.size;
    return { count: Math.max(0, count), approx: true };
}

/**
 * The selection as `/api/characters/bulk/prepare` takes it.
 * @param {BulkSelection} selection
 * @param {{ filter: object, sort: object|undefined } | null} query The list the selection is over.
 */
export function selectionToWire(selection, query) {
    return {
        query: selection.all || selection.ranges.length > 0 || selection.excludeRanges.length > 0 ? query : undefined,
        all: selection.all,
        ranges: selection.ranges,
        excludeRanges: selection.excludeRanges,
        include: [...selection.include.keys()],
        exclude: [...selection.exclude.keys()],
    };
}
