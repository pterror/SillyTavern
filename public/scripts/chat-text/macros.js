import { state as cmState, syntaxTree, view as cmView } from '../../live-editor-lib.js';
import { macroPersonCard, macroPill, macroPillContent, macroTooltipAttributes } from '../macro-pill.js';
import { withFilledAbout } from '../safe-macros.js';

const { StateEffect, StateField } = cmState;
const { EditorView, showTooltip } = cmView;

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

/**
 * Fills the tooltip beside the cursor with what a macro is and its value: a person their card, any other macro its
 * source with what the pill's tooltip notes and, for a value, the value
 * @param {HTMLElement} dom
 * @param {string} source
 * @param {MacroValueSource} values
 * @param {(macroName: string) => MacroPerson | null} person
 * @param {import('../macro-pill.js').Translate} t
 */
function fillMacroDetails(dom, source, values, person, t) {
    const name = macroNameOf(source);
    const macro = { source, name, value: values.get(source) };
    const { kind, label, note } = macroPillContent(macro, t, true);
    const colors = macroTooltipAttributes(macro, { t, compact: true });
    for (const attribute of ['data-macro-name', 'data-macro-category']) {
        if (attribute in colors) dom.setAttribute(attribute, colors[attribute]);
        else dom.removeAttribute(attribute);
    }
    const shownPerson = kind === 'mention' && name ? withFilledAbout(person(name), name, other => values.get(other)) : null;
    if (shownPerson) {
        dom.replaceChildren(macroPersonCard(shownPerson, source));
        return;
    }
    const code = document.createElement('code');
    code.textContent = source;
    dom.replaceChildren(code);
    const line = kind === 'value' ? note || label : note;
    if (line) {
        const text = document.createElement('div');
        text.textContent = line;
        dom.append(text);
    }
}

/** Whether the editor has focus, for the tooltip, which only the focused editor shows */
const focused = StateEffect.define();

/**
 * The macro the cursor is in or beside: the range of its `Macro` node
 * @param {import('@codemirror/state').EditorState} state
 * @returns {{ from: number, to: number } | null}
 */
function macroAtCursor(state) {
    const { empty, head } = state.selection.main;
    if (!empty) return null;
    const tree = syntaxTree(state);
    for (const side of /** @type {const} */ ([-1, 1])) {
        for (let node = tree.resolveInner(head, side); node.parent; node = node.parent) {
            if (node.name === 'Macro') return { from: node.from, to: node.to };
        }
    }
    return null;
}

/**
 * A tooltip beside the cursor while it is in or beside a macro, saying what the macro is and its value. It is drawn
 * above the cursor, where suggestions are not, and floats over the text without moving it.
 * @param {MacroValueSource} values
 * @param {(macroName: string) => MacroPerson | null} person
 * @param {import('../macro-pill.js').Translate} t
 * @returns {import('@codemirror/state').Extension}
 */
export function macroCursorTooltip(values, person, t) {
    const hasFocus = StateField.define({
        create: () => false,
        update: (value, tr) => tr.effects.reduce((now, effect) => (effect.is(focused) ? effect.value : now), value),
    });
    /** @param {import('@codemirror/view').EditorView} view */
    const create = (view) => {
        const dom = document.createElement('div');
        dom.className = 'macro-tooltip macro-cursor-tooltip';
        let drawn = '';
        /** @param {import('@codemirror/state').EditorState} state */
        const draw = (state) => {
            const macro = macroAtCursor(state);
            if (!macro) return;
            const source = state.sliceDoc(macro.from, macro.to);
            const key = JSON.stringify([source, values.get(source)]);
            if (key === drawn) return;
            drawn = key;
            fillMacroDetails(dom, source, values, person, t);
        };
        draw(view.state);
        return { dom, update: update => draw(update.state) };
    };
    return [
        hasFocus,
        EditorView.focusChangeEffect.of((_state, focusing) => focused.of(focusing)),
        showTooltip.compute([hasFocus, 'selection', 'doc'], (state) => {
            const macro = state.field(hasFocus) ? macroAtCursor(state) : null;
            return macro && { pos: state.selection.main.head, above: true, strictSide: false, arrow: false, create };
        }),
    ];
}
