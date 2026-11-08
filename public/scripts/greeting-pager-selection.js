/**
 * @typedef {object} GreetingSelection
 * @property {string|null} owner a character's avatar, or null for the create form
 * @property {number} index
 * @property {number|undefined} hash undefined for a greeting not saved yet
 */

/**
 * @param {GreetingSelection} selected
 * @param {string|null} owner
 * @param {number[]} hashes
 * @param {number} length
 * @returns {number}
 */
export function selectedGreetingIndex(selected, owner, hashes, length) {
    if (selected.owner !== owner) return 0;
    const { index, hash } = selected;
    if (Number.isFinite(hash)) {
        if (hashes[index] === hash) return index;
        const matches = hashes.flatMap((h, i) => (h === hash ? [i] : []));
        if (matches.length === 1) return matches[0];
    }
    return Math.max(0, Math.min(index, length - 1));
}

/**
 * @param {GreetingSelection} current what the pager shows now
 * @param {string|null} owner the card the pager is filled with
 * @param {{ index: number, hash: number } | undefined} kept the greeting the tab keeps shown for that card
 * @returns {GreetingSelection}
 */
export function pagerSelection(current, owner, kept) {
    return current.owner !== owner && kept ? { owner, ...kept } : current;
}
