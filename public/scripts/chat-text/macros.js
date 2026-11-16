import { lookChanged, state as cmState, syntaxTree, view as cmView } from '../../live-editor-lib.js';
import { macroPersonCard, macroPill, macroPillContent, macroTooltipAttributes } from '../macro-pill.js';
import { withFilledAbout } from '../safe-macros.js';

const { StateEffect, StateField } = cmState;
const { EditorView, ViewPlugin, showTooltip } = cmView;

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
        return {
            same: other => 'source' in other && other.source === source,
            source,
            draw() {
                const macro = { source, name, value: values.get(source) };
                const shownPerson = macroPillContent(macro, t).kind === 'mention' && name ? person(name) : null;
                const pill = macroPill(macro, { t, person: shownPerson });
                pill.classList.add('macro-value');
                return pill;
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
 * @param {(from: number) => boolean} [opened] whether the macro starting at a position is open for editing as written
 * @returns {(source: string, from: number) => Piece | undefined}
 */
export function macroPills(values, person, t, asWritten, opened = () => false) {
    return (source, from) => {
        const value = values.get(source);
        if (asWritten() || opened(from)) return undefined;
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
 * @param {import('@codemirror/state').EditorState} state
 * @returns {{ from: number, to: number } | null} the macro the cursor is in or beside
 */
function macroAtCursor(state) {
    const { empty, head } = state.selection.main;
    return empty ? macroAt(state, head) : null;
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

/**
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} pos
 * @returns {{ from: number, to: number } | null} the macro the position is in or beside
 */
function macroAt(state, pos) {
    const tree = syntaxTree(state);
    for (const side of /** @type {const} */ ([-1, 1])) {
        for (let node = tree.resolveInner(pos, side); node.parent; node = node.parent) {
            if (node.name === 'Macro' || node.name === 'MacroBlockTag') return { from: node.from, to: node.to };
        }
    }
    return null;
}

const openSource = StateEffect.define();

/** The macro open for editing as written: until the cursor leaves it */
const openedMacro = StateField.define({
    /** @returns {{ from: number, to: number } | null} */
    create: () => null,
    update(opened, tr) {
        for (const effect of tr.effects) {
            if (effect.is(openSource)) return effect.value;
        }
        if (!opened) return null;
        const from = tr.changes.mapPos(opened.from, -1);
        const to = tr.changes.mapPos(opened.to, 1);
        const head = tr.newSelection.main.head;
        return head < from || head > to ? null : { from, to };
    },
});

/**
 * A double-click on a macro's pill opens it as written, to edit its source, until the cursor leaves it
 * @param {() => import('@codemirror/view').EditorView} viewOf the editor the extension is in
 * @param {() => void} redraw draws the text's macros again
 * @returns {{ extension: import('@codemirror/state').Extension, isOpen: (from: number) => boolean }}
 */
export function openableMacros(viewOf, redraw) {
    const redrawn = ViewPlugin.fromClass(class {
        /** @param {import('@codemirror/view').ViewUpdate} update */
        update(update) {
            if (update.startState.field(openedMacro) !== update.state.field(openedMacro) && update.state.field(openedMacro) === null) {
                queueMicrotask(redraw);
            }
        }
    });
    const open = EditorView.domEventHandlers({
        dblclick(event, view) {
            const pill = event.target instanceof Element ? event.target.closest('.macro-pill') : null;
            if (!pill) return false;
            const macro = macroAt(view.state, view.posAtDOM(pill));
            if (!macro) return false;
            view.dispatch({ effects: [openSource.of(macro), lookChanged.of(undefined)], selection: { anchor: macro.to - 2 } });
            event.preventDefault();
            return true;
        },
    });
    return {
        extension: [openedMacro, redrawn, open],
        isOpen(from) {
            const opened = viewOf()?.state.field(openedMacro, false);
            return opened?.from === from;
        },
    };
}

/**
 * @typedef {object} WantedValues
 * @property {(sources: string[]) => Promise<boolean>} wantMacros asks for the values of macros, answering whether
 *   that changed what is shown
 * @property {(sources: string[]) => Promise<boolean>} [refresh] asks for the values of macros known again, answering
 *   whether any changed
 */

/**
 * Asks for the value of each macro the text comes to have without one: those it has when the editor starts, and those
 * typed or pasted, once the text has been still for a moment, in one request for all of them. A moment after an edit
 * it asks for the values of its macros again, since they may depend on it.
 * @param {object} options
 * @param {MacroValueSource} options.values the values the text has
 * @param {WantedValues} options.wanted where the others are asked
 * @param {() => void} options.redraw draws the text's macros again
 * @returns {import('@codemirror/state').Extension}
 */
export function macroValueRequests({ values, wanted, redraw }) {
    return ViewPlugin.fromClass(class {
        /** @param {import('@codemirror/view').EditorView} view */
        constructor(view) {
            this.view = view;
            /** @type {Set<string>} */
            this.sources = new Set();
            /** @type {Set<string>} */
            this.asked = new Set();
            this.stopped = false;
            this.asking = setTimeout(() => this.ask(), 0);
            this.refreshing = 0;
            this.collect(0, view.state.doc.length);
        }

        /** @param {import('@codemirror/view').ViewUpdate} update */
        update(update) {
            if (!update.docChanged) return;
            update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => this.collect(fromB, toB));
            clearTimeout(this.asking);
            this.asking = setTimeout(() => this.ask(), ASK_DELAY);
            if (wanted.refresh) {
                clearTimeout(this.refreshing);
                this.refreshing = setTimeout(() => void wanted.refresh?.(this.written()).then(changed => changed && !this.stopped && redraw()), REFRESH_DELAY);
            }
        }

        /**
         * @param {number} from
         * @param {number} to
         */
        collect(from, to) {
            const { state } = this.view;
            syntaxTree(state).iterate({
                from,
                to,
                enter: (node) => {
                    if (node.name !== 'Macro') return;
                    this.sources.add(state.sliceDoc(node.from, node.to));
                    return false;
                },
            });
        }

        /** @returns {string[]} the macros in the text */
        written() {
            const { state } = this.view;
            /** @type {Set<string>} */
            const written = new Set();
            syntaxTree(state).iterate({
                enter: (node) => {
                    if (node.name !== 'Macro') return;
                    written.add(state.sliceDoc(node.from, node.to));
                    return false;
                },
            });
            return [...written];
        }

        ask() {
            const missing = [...this.sources].filter(source => values.get(source) === undefined && !this.asked.has(source));
            this.sources.clear();
            if (missing.length === 0) return;
            for (const source of missing) this.asked.add(source);
            void wanted.wantMacros(missing).then(learned => learned && !this.stopped && redraw());
        }

        destroy() {
            this.stopped = true;
            clearTimeout(this.asking);
            clearTimeout(this.refreshing);
        }
    });
}

const ASK_DELAY = 300;
const REFRESH_DELAY = 2000;
