// Importable without loading CodeMirror: where in a text a click on its rendered HTML lands.

/**
 * How many characters of the element's shown text come before the point clicked.
 * @param {HTMLElement} dom
 * @param {MouseEvent} event
 * @returns {number}
 */
export function renderedOffset(dom, event) {
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
    if (!caret || !dom.contains(caret.node)) return 0;
    const range = document.createRange();
    range.setStart(dom, 0);
    range.setEnd(caret.node, caret.offset);
    return range.toString().length;
}

/**
 * The source position matching a point in the rendered text: the rendered characters are matched in order against
 * the source, skipping markup.
 * @param {string} source
 * @param {number} renderedChars
 * @returns {number}
 */
export function sourcePosition(source, renderedChars) {
    let rendered = 0;
    let pos = 0;
    while (pos < source.length && rendered < renderedChars) {
        if (/[*_~`#>[\]()!\\|<]/.test(source[pos])) {
            pos++;
            continue;
        }
        rendered++;
        pos++;
    }
    return Math.min(pos, source.length);
}
