export { SERVER_OWNED } from '/ui/entry.js';

/** @typedef {Parameters<import('/ui/entry.js').NewUi['commands']['attachActions']>[1]} FocusActions */

/** @type {import('/ui/entry.js').NewUi | null} */
let started = null;

/** @typedef {Parameters<import('/ui/entry.js').NewUi['commands']['register']>} Registration */

/** @type {{ attach: (page: import('/ui/entry.js').NewUi) => () => void, detach?: () => void, detached: boolean }[]} */
let waiting = [];

/**
 * Runs `attach` now if the page has started, else once it has
 * @param {(page: import('/ui/entry.js').NewUi) => () => void} attach
 * @returns {() => void} undoes it, or keeps it from being done
 */
function onceStarted(attach) {
    if (started) return attach(started);
    const entry = { attach, detached: false };
    waiting.push(entry);
    return () => {
        entry.detached = true;
        entry.detach?.();
    };
}

/**
 * @param {import('/ui/entry.js').NewUi} page
 */
export function setNewUi(page) {
    started = page;
    for (const each of waiting) {
        if (!each.detached) each.detach = each.attach(page);
    }
    waiting = [];
}

export const newUiStarted = () => started !== null;

export function newUi() {
    if (!started) throw new Error('The new page is not started yet');
    return started;
}

/**
 * Gives an element its own focus actions (Confirm, Cancel, Next, Previous, Activate), as the page's
 * `commands.attachActions` does; ones attached before the page starts apply once it has
 * @param {Element} element
 * @param {FocusActions} actions
 * @returns {() => void} takes them off
 */
export function attachActions(element, actions) {
    return onceStarted(page => page.commands.attachActions(element, actions));
}

/**
 * Registers commands, as the page's `commands.register` does, made once the page has started (their labels translated)
 * @param {() => Registration[0]} make
 * @param {Registration[1]} [placement]
 * @returns {() => void} takes them out
 */
export function registerCommands(make, placement) {
    return onceStarted(page => page.commands.register(make(), placement));
}
