/**
 * The chat box's text: the editor's edits are its edits; from outside it is replaced whole (`replace`, the editor's
 * edits so far dropped), or the server's draft is heard (`heard`), which the editor shows with the edits the draft
 * doesn't include laid over it
 * @typedef {object} BoxText
 * @property {import('@pterror/interact-editor/text-editor').Text} port
 * @property {import('@pterror/interact-editor/text-editor').Edit} edited hears each of the editor's edits
 * @property {() => string} text the text as the editor shows it, or as last set while no editor is bound or one is still
 *   to show a replaced text
 * @property {() => string | undefined} latest the id of the editor's latest edit
 * @property {(text: string) => void} replace
 * @property {(text: string, includes: string | undefined) => void} heard the draft as the server has it, and the latest
 *   of the editor's edits it includes
 * @property {(read: () => string) => void} bind reads the text from the editor that shows it
 */

/**
 * @param {string} [initial]
 * @param {() => void} [changed] hears each of the editor's edits, after the text has it
 * @returns {BoxText}
 */
export function boxText(initial = '', changed = () => {}) {
    let current = initial;
    /** @type {string | undefined} */
    let latest;
    let held = { text: initial, includes: latest };
    /** @type {(() => string) | null} */
    let read = null;
    let replaced = false;
    /** @type {Set<() => void>} */
    const listeners = new Set();
    const tell = () => {
        for (const listener of listeners) listener();
    };
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
            replaced = false;
            changed();
        },
        text: () => (read && !replaced ? read() : current),
        latest: () => latest,
        replace(text) {
            current = text;
            held = { text, includes: latest };
            tell();
            if (read) {
                replaced = true;
                queueMicrotask(() => {
                    replaced = false;
                });
            }
        },
        heard(text, includes) {
            held = { text, includes };
            if (!read) current = text;
            tell();
        },
        bind(reader) {
            read = reader;
        },
    };
}
