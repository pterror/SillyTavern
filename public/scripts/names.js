import { newUi } from './new-ui-page.js';

/**
 * @param {string} holder
 * @param {import('@st/protocol/looks').Looks} looks
 */
export function holdLooks(holder, looks) {
    newUi().names.hold(holder, looks);
}

/**
 * @param {string} holder
 * @param {import('@st/protocol/looks').Looks} looks
 */
export function addLooks(holder, looks) {
    newUi().names.add(holder, looks);
}

/**
 * A thing's name as the one name renderer draws it; text alone for what has no thing to draw by.
 * @param {string | null | undefined} thing
 * @param {string} text
 * @param {{ picture?: string | null, selected?: boolean }} [options]
 * @returns {Node}
 */
export function nameNode(thing, text, options = {}) {
    if (typeof thing !== 'string' || thing === '') return document.createTextNode(text);
    return newUi().names.element({ thing, text, shownAs: 'name' }, options);
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
