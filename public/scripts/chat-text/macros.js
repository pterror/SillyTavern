import { macroPill, macroPillContent, macroTooltipAttributes } from '../macro-pill.js';

/**
 * @typedef {import('@pterror/interact-editor/look').Piece} Piece
 * @typedef {import('../macro-pill.js').MacroPerson} MacroPerson
 */

/**
 * @typedef {object} MacroValueSource
 * @property {(source: string) => string | null | undefined} get a macro's value: null when only known when sent,
 *   undefined when the text came without it
 */

/**
 * @param {string} source
 * @returns {string | undefined}
 */
function macroNameOf(source) {
    const inner = source.slice(2).trimStart();
    return inner.startsWith('//') ? '//' : /^[^a-zA-Z]{0,3}([a-zA-Z][\w-]*)/.exec(inner)?.[1];
}

/**
 * @param {string} source
 * @returns {string} what the macro is, as a pill names it
 */
function described(source) {
    return source.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').split('::').map(part => part.trim()).filter(Boolean).join(' · ');
}

/**
 * Macros drawn by their value, for reading: a value only known when sent shows what the macro is, a person their
 * name with their card on hover. A text drawn again when its values change draws its pieces again.
 * @param {MacroValueSource} values
 * @param {(macroName: string) => MacroPerson | null} person
 * @param {import('../macro-pill.js').Translate} t
 * @returns {(source: string) => Piece}
 */
export function macroValuePieces(values, person, t) {
    return (source) => {
        const name = macroNameOf(source);
        /** @param {HTMLElement} element */
        const fill = (element) => {
            const value = values.get(source);
            if (value === undefined) {
                element.className = 'macro-value macro-value-unknown';
                element.setAttribute('data-macro-source', source);
                element.textContent = described(source);
                return;
            }
            const macro = { source, name, value };
            const { kind, label } = macroPillContent(macro, t);
            element.className = `macro-value macro-value-${kind}`;
            element.textContent = label;
            const shownPerson = kind === 'mention' && name ? person(name) : null;
            for (const [attribute, attributeValue] of Object.entries(macroTooltipAttributes(macro, { t, person: shownPerson }))) {
                element.setAttribute(attribute, attributeValue);
            }
        };
        return {
            same: other => 'source' in other && other.source === source,
            source,
            draw() {
                const element = document.createElement('span');
                fill(element);
                return element;
            },
        };
    };
}

/**
 * Macros drawn as pills, for editing: one token Backspace deletes whole, showing its value; one whose value didn't come
 * with the text shows what it is, unmarked. Every macro while they are shown as written is drawn as written.
 * @param {MacroValueSource} values
 * @param {(macroName: string) => MacroPerson | null} person
 * @param {import('../macro-pill.js').Translate} t
 * @param {() => boolean} asWritten whether macros are shown as written now
 * @returns {(source: string) => Piece | undefined}
 */
export function macroPills(values, person, t, asWritten) {
    return (source) => {
        const value = values.get(source);
        if (asWritten()) return undefined;
        const name = macroNameOf(source);
        const macro = { source, name, value };
        const shownPerson = macroPillContent(macro, t).kind === 'mention' && name ? person(name) : null;
        return {
            same: other => 'source' in other && other.source === source && 'value' in other && other.value === value,
            source,
            value,
            draw: () => macroPill(macro, { t, compact: true, person: shownPerson }),
        };
    };
}
