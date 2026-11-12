import { macroPillContent, macroTooltipAttributes } from '../macro-pill.js';

/**
 * @typedef {import('@pterror/interact-editor/look').Piece} Piece
 * @typedef {import('../macro-pill.js').MacroPerson} MacroPerson
 */

/**
 * @typedef {object} MacroValueSource
 * @property {(source: string) => string | null | undefined} get a macro's value: null when only known when sent,
 *   undefined while not yet known
 * @property {(sources: string[]) => Promise<unknown>} wantMacros asks for the values of macros not yet known
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
 * name with their card on hover. A value not yet known is asked for, and the piece's element takes it when it comes.
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
            for (const attribute of [...element.attributes]) {
                if (attribute.name !== 'class') element.removeAttribute(attribute.name);
            }
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
                if (values.get(source) === undefined) {
                    void values.wantMacros([source]).then(() => fill(element));
                }
                return element;
            },
        };
    };
}
