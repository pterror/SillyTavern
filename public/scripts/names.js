import { newUi, onceStarted } from './new-ui-page.js';

const NOTHING_TO_UNDO = () => {};

/**
 * Held once the page has started, when an answer comes before it.
 * @param {string} holder
 * @param {import('@st/protocol/looks').Looks} looks
 */
export function holdLooks(holder, looks) {
    onceStarted(page => {
        page.names.hold(holder, looks);
        return NOTHING_TO_UNDO;
    });
}

/**
 * Added once the page has started, when an answer comes before it.
 * @param {string} holder
 * @param {import('@st/protocol/looks').Looks} looks
 */
export function addLooks(holder, looks) {
    onceStarted(page => {
        page.names.add(holder, looks);
        return NOTHING_TO_UNDO;
    });
}

/**
 * A thing's name as the one name renderer draws it; text alone for what has no thing to draw by.
 * @param {string | null | undefined} thing
 * @param {string} text
 * @param {{ picture?: string | null, selected?: boolean }} [options]
 * @returns {HTMLElement | Text}
 */
export function nameNode(thing, text, options = {}) {
    if (typeof thing !== 'string' || thing === '') return document.createTextNode(text);
    return newUi().names.element({ thing, text, shownAs: 'name' }, options);
}

/**
 * Draws an element the place draws itself, such as a tag's chip, as a thing's name: its look's layers style the element
 * itself, so a look's background is the whole element, and the element's own CSS keeps its size. No box goes around it,
 * so the look's picture and note aren't drawn there.
 * @param {Element} element
 * @param {string | null | undefined} thing nothing to draw by: the element is left as it is
 */
export function nameOn(element, thing) {
    if (typeof thing !== 'string' || thing === '') return;
    const [, name] = newUi().names.inline(thing, null);
    element.classList.add(...name.class.split(' '));
    for (const [attribute, value] of Object.entries(name.attributes)) element.setAttribute(attribute, value);
}

/**
 * @param {JQuery<HTMLElement> | Element} place
 * @param {string | null | undefined} thing
 * @param {string} text
 * @param {{ picture?: string | null, selected?: boolean }} [options]
 */
export function drawName(place, thing, text, options = {}) {
    const element = place instanceof Element ? place : place.get(0);
    element?.replaceChildren(nameNode(thing, text, options));
}
