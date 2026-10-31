export { SERVER_OWNED } from '/ui/entry.js';

/** @type {import('/ui/entry.js').NewUi | null} */
let started = null;

/**
 * @param {import('/ui/entry.js').NewUi} page
 */
export function setNewUi(page) {
    started = page;
}

export const newUiStarted = () => started !== null;

export function newUi() {
    if (!started) throw new Error('The new page is not started yet');
    return started;
}
