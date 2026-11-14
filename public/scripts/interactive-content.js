/**
 * The elements whose click the browser acts on itself: HTML's interactive content, of which a details' summary is only
 * the first, the one that toggles it.
 * https://html.spec.whatwg.org/multipage/dom.html#interactive-content
 */
const INTERACTIVE_CONTENT = 'a[href], audio[controls], video[controls], button, details > summary:first-of-type, embed, iframe, '
    + 'img[usemap], input:not([type="hidden" i]), label, select, textarea';

/**
 * @param {EventTarget | null} target what was clicked
 * @param {Element} within the element whose own handling is asked about
 * @returns {boolean} whether interactive content inside `within`, the target or around it, handles the click
 */
export function handledInside(target, within) {
    const interactive = target instanceof Element ? target.closest(INTERACTIVE_CONTENT) : null;
    return interactive !== null && interactive !== within && within.contains(interactive);
}
