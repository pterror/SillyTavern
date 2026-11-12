/**
 * The text an editor is over, as its save last stored it, and the latest of the editor's edits that save held
 * @typedef {object} SavedText
 * @property {import('@pterror/interact-editor/text-editor').Text} port
 * @property {(text: string, id: string | undefined, sent: number) => void} saved hears a save's answer
 */

/**
 * The text port of an editor whose text is stored by the page's own save. A save's answer is heard with the number it
 * was sent as; an answer to an older save than one already heard is dropped, so the text never goes back.
 * @param {string} initial the text as stored when the editor opens
 * @returns {SavedText}
 */
export function savedText(initial) {
    let held = { text: initial, includes: /** @type {string | undefined} */ (undefined) };
    let newest = 0;
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
        saved(text, id, sent) {
            if (sent <= newest) return;
            newest = sent;
            held = { text, includes: id };
            for (const listener of listeners) listener();
        },
    };
}

