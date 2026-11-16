/**
 * @typedef {object} GreetingSelection
 * @property {string|null} owner a character's avatar, or null for the create form
 * @property {number} index where the pager was
 * @property {number|undefined} id the greeting shown, undefined for one not saved yet
 */

/**
 * @param {GreetingSelection} selected
 * @param {string|null} owner
 * @param {(number|undefined)[]} ids the pager's greetings' ids
 * @param {number} length
 * @returns {number} the selected greeting's place, while the card has it; else the place the pager was, in range
 */
export function selectedGreetingIndex(selected, owner, ids, length) {
    if (selected.owner !== owner) return 0;
    const { index, id } = selected;
    if (Number.isInteger(id)) {
        const at = ids.indexOf(id);
        if (at >= 0) return at;
    }
    return Math.max(0, Math.min(index, length - 1));
}

/**
 * @param {GreetingSelection} current what the pager shows now
 * @param {string|null} owner the card the pager is filled with
 * @param {{ id: number } | undefined} kept the greeting the tab keeps shown for that card
 * @returns {GreetingSelection}
 */
export function pagerSelection(current, owner, kept) {
    return current.owner !== owner && kept ? { owner, index: 0, id: kept.id } : current;
}
