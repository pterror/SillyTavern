import { sourcePositionAt } from '../chat-text/surface.js';

/**
 * @param {MouseEvent} event
 * @returns {{ node: Node, offset: number } | null} the place in the page under the pointer
 */
function caretAt(event) {
    // @ts-ignore Firefox
    if (document.caretPositionFromPoint) {
        // @ts-ignore
        const position = document.caretPositionFromPoint(event.clientX, event.clientY);
        return position ? { node: position.offsetNode, offset: position.offset } : null;
    }
    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
        return range ? { node: range.startContainer, offset: range.startOffset } : null;
    }
    return null;
}

/**
 * Where in its source a click or double-click on read text starts an edit: the source position the reader drew there.
 * A click on a link or an image, or a click when click to edit is off or text is selected, starts none.
 * @param {MouseEvent} event
 * @param {HTMLElement} rendered the element the text is read in
 * @param {boolean} clickToEdit
 * @returns {number | null}
 */
export function editPosition(event, rendered, clickToEdit) {
    if (event.type === 'click' && (!clickToEdit || window.getSelection()?.toString())) return null;
    const target = event.target;
    if (target instanceof Element) {
        const link = target.closest('a[href]');
        if (link && rendered.contains(link)) return null;
    }
    if (target instanceof HTMLImageElement) return null;
    const caret = caretAt(event);
    if (!caret || !rendered.contains(caret.node)) return 0;
    return sourcePositionAt(caret.node, caret.offset) ?? 0;
}
