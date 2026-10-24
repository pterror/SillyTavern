// Importable without loading CodeMirror: where in a text a click on its rendered HTML lands.

/**
 * The element's shown text, and how many of its characters come before the point clicked.
 * @param {HTMLElement} dom
 * @param {MouseEvent} event
 * @returns {{ text: string, offset: number }}
 */
export function renderedOffset(dom, event) {
    const whole = document.createRange();
    whole.selectNodeContents(dom);
    const text = whole.toString();
    /** @type {{ node: Node, offset: number } | null} */
    let caret = null;
    // @ts-ignore Firefox
    if (document.caretPositionFromPoint) {
        // @ts-ignore
        const position = document.caretPositionFromPoint(event.clientX, event.clientY);
        if (position) caret = { node: position.offsetNode, offset: position.offset };
    } else if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
        if (range) caret = { node: range.startContainer, offset: range.startOffset };
    }
    if (!caret || !dom.contains(caret.node)) return { text, offset: 0 };
    const range = document.createRange();
    range.setStart(dom, 0);
    range.setEnd(caret.node, caret.offset);
    return { text, offset: range.toString().length };
}

const WORD = /[\p{L}\p{N}_]+/gu;

/**
 * The source position matching a point in the rendered text. Rendering takes markup away and changes spacing,
 * numbering and entities, but keeps the words and their order: the point is in (or after) the n-th time a word shows,
 * so it goes to the same place in the n-th time that word is in the source. A word the source doesn't have (a macro's
 * value) goes to the nearest word before it that it does.
 * @param {string} source
 * @param {{ text: string, offset: number }} rendered
 * @returns {number}
 */
export function sourcePosition(source, { text, offset }) {
    const shown = [...text.matchAll(WORD)];
    const written = [...source.matchAll(WORD)];
    let at = shown.findLastIndex(m => /** @type {number} */ (m.index) <= offset);
    let within = at >= 0 ? Math.min(offset - /** @type {number} */ (shown[at].index), shown[at][0].length) : 0;
    for (; at >= 0; at--, within = Infinity) {
        const word = shown[at][0];
        const nth = shown.slice(0, at).filter(m => m[0] === word).length;
        const same = written.filter(m => m[0] === word);
        if (same.length === 0) continue;
        const match = same[Math.min(nth, same.length - 1)];
        return /** @type {number} */ (match.index) + Math.min(within, word.length);
    }
    return 0;
}
