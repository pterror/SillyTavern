/**
 * The row of tags whose names match the character search, shown above the results (`/query`'s `tagMatches`).
 * Picking one adds it to the tag filter and takes the words that matched its name out of the search text; the
 * other words stay ("dragon knight" with the tag "dragon" becomes the filter "dragon" and the search "knight").
 */

// Same tokens as the search string's (character-view.js, src/search-clauses.js): whitespace, a quote kept whole.
const TOKEN_PATTERN = /[^\s"]*"[^"]*"|[^\s"]*"[^"]*$|\S+/g;

/**
 * A text's words as the search folds them: runs of letters and digits, accents dropped, lower case.
 * @param {string} text
 * @returns {string[]}
 */
export function foldedWords(text) {
    return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * The search text with the words that match a tag's name taken out: a word whose every folded word is one of the
 * name's, the text's last word also when its last folded word begins one of the name's (two characters or more), as
 * the search reads a last word.
 * @param {string} text
 * @param {string} name
 * @returns {string}
 */
export function withoutMatchedWords(text, name) {
    const nameWords = foldedWords(name);
    const tokens = String(text ?? '').trim().match(TOKEN_PATTERN) ?? [];
    const kept = tokens.filter((token, i) => {
        const closed = token.startsWith('"') && token.length >= 2 && token.endsWith('"');
        const words = foldedWords(token);
        if (words.length === 0) return true;
        const prefixLast = i === tokens.length - 1 && !closed;
        const matched = words.every((w, k) => nameWords.includes(w)
            || (prefixLast && k === words.length - 1 && w.length >= 2 && nameWords.some(n => n.startsWith(w))));
        return !matched;
    });
    return kept.join(' ');
}

/**
 * The view a picked chip leads to: the tag added to the tag filter, its matched words out of the text.
 * @param {import('./character-view.js').CharacterView} view
 * @param {{ id: string, name: string }} chip
 * @returns {import('./character-view.js').CharacterView}
 */
export function viewForTagChip(view, chip) {
    const include = view.tags.include.includes(chip.id) ? view.tags.include : [...view.tags.include, chip.id];
    return {
        ...view,
        text: withoutMatchedWords(view.text, chip.name),
        tags: { ...view.tags, include, exclude: view.tags.exclude.filter(id => id !== chip.id) },
    };
}

/**
 * Draws the chips in `container` (emptied, and hidden when there are none).
 * @param {HTMLElement} container
 * @param {{ id: string, name: string, carriers: number }[]} chips
 * @param {(chip: { id: string, name: string }) => void} onPick
 * @param {(name: string) => string} title A chip's tooltip, given the tag's name.
 */
export function renderTagMatchChips(container, chips, onPick, title) {
    container.replaceChildren();
    container.hidden = chips.length === 0;
    for (const chip of chips) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tag_match_chip menu_button';
        button.title = title(chip.name);
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-tag';
        const label = document.createElement('span');
        label.textContent = chip.name;
        const count = document.createElement('small');
        count.textContent = String(chip.carriers);
        button.append(icon, label, count);
        button.addEventListener('click', () => onPick(chip));
        container.append(button);
    }
}
