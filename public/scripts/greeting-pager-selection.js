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
