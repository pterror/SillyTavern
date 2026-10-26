// The started new page, for old modules to read. Kept apart from new-ui.js, which starts it and imports what that
// needs (the slash commands, the tab session): a module that only reads it pulls none of that in.

/** The settings paths the server owns: the new page shows them, and the old page neither writes nor saves them. */
export { SERVER_OWNED } from '/ui/entry.js';

/** @type {import('/ui/entry.js').NewUi | null} */
let started = null;

/**
 * new-ui.js's start: the page old code reaches from now on.
 * @param {import('/ui/entry.js').NewUi} page
 */
export function setNewUi(page) {
    started = page;
}

/** Whether script.js's init started the new page yet. */
export const newUiStarted = () => started !== null;

/** The started new page; old code calls in only after script.js's init started it. */
export function newUi() {
    if (!started) throw new Error('The new page is not started yet');
    return started;
}
