/**
 * The chat box's text, the box's own: the editor's edits are its edits, and from outside it is only ever replaced
 * whole, which the editor shows in place of what it had, nothing of the old text kept
 * @typedef {object} BoxText
 * @property {import('@pterror/interact-editor/text-editor').Text} port
 * @property {import('@pterror/interact-editor/text-editor').Edit} edited hears each of the editor's edits
 * @property {() => string} text
 * @property {(text: string) => void} replace
 */

/**
 * @param {string} [initial]
 * @returns {BoxText}
 */
export function boxText(initial = '') {
    let current = initial;
    /** @type {string | undefined} */
    let latest;
    let held = { text: initial, includes: latest };
    /** @type {Set<() => void>} */
    const listeners = new Set();
    return {
        port: {
            get: () => held,
            watch(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        },
        edited(changes, id) {
            for (const change of [...changes].reverse()) current = current.slice(0, change.from) + change.insert + current.slice(change.to);
            latest = id;
        },
        text: () => current,
        replace(text) {
            current = text;
            held = { text, includes: latest };
            for (const listener of listeners) listener();
        },
    };
}
