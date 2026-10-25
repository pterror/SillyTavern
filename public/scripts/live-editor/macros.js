// Macros in the editor: each as a pill holding what is sent in its place (macro-pill.js), its source in a tooltip, and
// a dropdown of macros while typing one.

import { state as cmState, view as cmView, autocomplete as cmAutocomplete } from '../../live-editor-lib.js';
import { topLevelMacroSpans } from '../safe-macros.js';
import { macroPill, macroPillContent } from '../macro-pill.js';
import { getMacroAutoCompleteAt } from '../autocomplete/MacroAutoCompleteHelper.js';
import { macroCategory } from '../macros/macro-system.js';
import { shouldActivateMacroAutocomplete, MACRO_AUTOCOMPLETE_MODE } from '../autocomplete/MacroAutoComplete.js';
import { t } from '../i18n.js';

const { Facet, Prec, StateField, StateEffect } = cmState;
const { Decoration, ViewPlugin, WidgetType, EditorView, showTooltip, hoverTooltip, keymap } = cmView;
const { autocompletion } = cmAutocomplete;

/**
 * @typedef {object} MacroOptions
 * @property {(macroText: string) => string | null} evaluate A macro's value, or null when it only runs when sent
 * (side effects or randomness), so it stays as written.
 */

const macroOptions = Facet.define({
    combine: values => values[0] ?? { evaluate: () => null },
});

/**
 * A macro's name, from its text: flags before it (`{{!user}}`, `{{#if …}}`) are skipped; the comment macro is `//`.
 * @param {string} macroText One whole `{{…}}`.
 * @returns {string | undefined}
 */
function macroNameOf(macroText) {
    const inner = macroText.slice(2).trimStart();
    return inner.startsWith('//') ? '//' : /^[^a-zA-Z]{0,3}([a-zA-Z][\w-]*)/.exec(inner)?.[1];
}

/**
 * A macro as its pill shows it.
 * @param {import('@codemirror/state').EditorState} state
 * @param {string} source
 * @returns {import('../macro-pill.js').MacroShown}
 */
function shownMacro(state, source) {
    const name = macroNameOf(source);
    let value = null;
    try {
        value = state.facet(macroOptions).evaluate(source);
    } catch (error) {
        console.warn('Macro could not be filled in', source, error);
    }
    return { source, name, category: name ? macroCategory(name) : undefined, value };
}

/**
 * The macros on the line holding `pos`.
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} pos
 * @returns {{ from: number, to: number }[]}
 */
function macrosOnLine(state, pos) {
    const line = state.doc.lineAt(pos);
    return topLevelMacroSpans(line.text).map(span => ({ from: line.from + span.start, to: line.from + span.end }));
}

/** Opens a macro's source for editing (`{from, to}`), or closes it (null). */
const openSource = StateEffect.define();

/** The macro whose source is open for editing: shown as written until the cursor leaves it. */
const openedMacro = StateField.define({
    /** @returns {{ from: number, to: number } | null} */
    create: () => null,
    update(opened, tr) {
        for (const effect of tr.effects) {
            if (effect.is(openSource)) return effect.value;
        }
        if (!opened) return opened;
        const from = tr.changes.mapPos(opened.from, -1);
        const to = tr.changes.mapPos(opened.to, 1);
        const head = tr.state.selection.main.head;
        return head < from || head > to ? null : { from, to };
    },
});

/** Turns showing every macro as written on or off. */
const toggleSource = StateEffect.define();

/** Every macro shown as written, for working on macros. */
const showingSource = StateField.define({
    create: () => false,
    update: (on, tr) => tr.effects.reduce((value, effect) => (effect.is(toggleSource) ? !value : value), on),
});

/**
 * Shows every macro as written, or as pills again.
 * @param {import('@codemirror/view').EditorView} view
 */
export function toggleMacroSource(view) {
    view.dispatch({ effects: [toggleSource.of(null), openSource.of(null)] });
    return true;
}

/**
 * @param {import('@codemirror/state').EditorState} state
 * @returns {boolean} Whether the editor shows macros (so it has the toggle for them).
 */
export function hasLiveMacros(state) {
    return state.field(showingSource, false) !== undefined;
}

class MacroPillWidget extends WidgetType {
    /** @param {import('../macro-pill.js').MacroShown} macro */
    constructor(macro) {
        super();
        this.macro = macro;
    }

    /** @param {MacroPillWidget} other */
    eq(other) {
        return other.macro.source === this.macro.source && other.macro.value === this.macro.value && other.macro.category === this.macro.category;
    }

    toDOM() {
        return macroPill(this.macro, { t, compact: true });
    }

    // A click on a pill puts the cursor beside it, as on a character.
    ignoreEvent() {
        return false;
    }
}

/** A macro shown as written: the source opened, or every macro while the source is shown. */
const sourceMark = Decoration.mark({ class: 'macro-source' });

/**
 * Holds a pill to the characters either side of it, so a line never wraps right before or after it. CodeMirror reads
 * where a cursor beside a widget is from the zero-width spacer it puts next to the widget; a wrap between the two left
 * the cursor drawn at the end of the line above, and a click before a pill starting a line landed there.
 */
const pillGlue = Decoration.mark({ class: 'macro-pill-glue' });

/**
 * Each macro is a pill holding what is sent in its place: the text reads as it is sent, and `{{…}}` is never on
 * screen as if it were sent. A pill is one step for the cursor and one Backspace. Its source shows in a tooltip above
 * it while the cursor is beside it, and on hover; a double click opens it for editing.
 */
const macroPills = ViewPlugin.fromClass(class {
    /** @param {import('@codemirror/view').EditorView} view */
    constructor(view) {
        this.build(view);
    }

    /** @param {import('@codemirror/view').ViewUpdate} update */
    update(update) {
        // While an IME composes, the pills only move with the text; they're worked out again when it ends.
        if (update.view.composing) {
            this.pills = this.pills.map(update.changes);
            this.marks = this.marks.map(update.changes);
            this.decorations = this.decorations.map(update.changes);
        } else if (update.docChanged || update.viewportChanged
            || update.startState.field(openedMacro) !== update.state.field(openedMacro)
            || update.startState.field(showingSource) !== update.state.field(showingSource)) {
            this.build(update.view);
        }
    }

    /** @param {import('@codemirror/view').EditorView} view */
    build(view) {
        const state = view.state;
        const opened = state.field(openedMacro);
        const asWritten = state.field(showingSource);
        /** @type {import('@codemirror/state').Range<import('@codemirror/view').Decoration>[]} */
        const pills = [];
        /** @type {import('@codemirror/state').Range<import('@codemirror/view').Decoration>[]} */
        const marks = [];
        // Whole lines, so a macro is never cut by the edge of what's shown.
        for (const visible of view.visibleRanges) {
            const unit = { from: state.doc.lineAt(visible.from).from, to: state.doc.lineAt(visible.to).to };
            // Found in the text, not the syntax tree: macros are filled in before the text is read as markdown, so
            // one in code, in HTML or after a backslash is filled in too, as the preview shows it.
            for (const span of topLevelMacroSpans(state.doc.sliceString(unit.from, unit.to))) {
                const from = unit.from + span.start;
                const to = unit.from + span.end;
                if (asWritten || (opened && opened.from <= from && to <= opened.to)) {
                    marks.push(sourceMark.range(from, to));
                } else {
                    pills.push(Decoration.replace({ widget: new MacroPillWidget(shownMacro(state, state.doc.sliceString(from, to))) }).range(from, to));
                    const line = state.doc.lineAt(from);
                    marks.push(pillGlue.range(Math.max(line.from, from - 1), Math.min(line.to, to + 1)));
                }
            }
        }
        this.pills = Decoration.set(pills, true);
        this.marks = Decoration.set(marks, true);
        this.decorations = Decoration.set([...pills, ...marks], true);
    }
}, {
    decorations: plugin => plugin.decorations,
    provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.pills ?? Decoration.none),
});

/**
 * The tooltip saying what a macro is and what is sent in its place.
 * @param {import('@codemirror/state').EditorState} state
 * @param {{ from: number, to: number }} macro
 * @returns {import('@codemirror/view').Tooltip}
 */
function macroTooltip(state, macro) {
    const source = state.doc.sliceString(macro.from, macro.to);
    return {
        pos: macro.from,
        end: macro.to,
        above: true,
        create: () => {
            const dom = document.createElement('div');
            dom.className = 'live-macro-tooltip';
            const code = document.createElement('code');
            code.textContent = source;
            const text = document.createElement('div');
            text.textContent = macroPillContent(shownMacro(state, source), t).tooltip;
            dom.append(code, text);
            return { dom };
        },
    };
}

/**
 * While the cursor is beside a pill, or inside a macro opened for editing, after the user put it there (a click, the
 * arrow keys, typing): its tooltip, above it. Not where an edit starts: it would cover what is above the field.
 */
const cursorTooltip = StateField.define({
    /** @returns {import('@codemirror/view').Tooltip | null} */
    create: () => null,
    update(shown, tr) {
        if (!tr.docChanged && !tr.selection && !tr.effects.length) return shown;
        if (!tr.isUserEvent('select') && !tr.isUserEvent('input') && !tr.isUserEvent('delete')) return null;
        const state = tr.state;
        const selection = state.selection.main;
        if (!selection.empty || state.field(showingSource)) return null;
        const head = selection.head;
        const macro = macrosOnLine(state, head).find(m => m.from <= head && head <= m.to);
        return macro ? macroTooltip(state, macro) : null;
    },
    provide: field => showTooltip.from(field),
});

/** On hover over a pill: its tooltip. */
const hoverMacro = hoverTooltip((view, pos) => {
    if (view.state.field(showingSource)) return null;
    const macro = macrosOnLine(view.state, pos).find(m => m.from <= pos && pos <= m.to);
    return macro ? macroTooltip(view.state, macro) : null;
}, { hoverTime: 300 });

/** A double click on a pill opens its source for editing, the cursor before its closing braces. */
const openOnDoubleClick = EditorView.domEventHandlers({
    dblclick(event, view) {
        const pill = event.target instanceof Element ? event.target.closest('.macro-pill') : null;
        if (!pill) return false;
        const pos = view.posAtDOM(pill);
        const macro = macrosOnLine(view.state, pos).find(m => m.from === pos);
        if (!macro) return false;
        view.dispatch({ effects: openSource.of(macro), selection: { anchor: macro.to - 2 } });
        event.preventDefault();
        return true;
    },
});

/**
 * The app's macro suggestions as a CodeMirror completion source: the same options, details and argument hints as
 * the macro autocomplete elsewhere, always on in the editor (Ctrl+Space shows them anywhere), and the highlighted
 * macro's current value.
 * @param {import('@codemirror/autocomplete').CompletionContext} context
 */
async function macroCompletions(context) {
    const text = context.state.doc.toString();
    const pos = context.pos;
    if (!shouldActivateMacroAutocomplete(text, pos, { isForced: context.explicit, autocompleteMode: MACRO_AUTOCOMPLETE_MODE.ALWAYS })) {
        return null;
    }
    const result = await getMacroAutoCompleteAt(text, pos, { isForced: context.explicit });
    if (!result || context.aborted) return null;
    const { evaluate } = context.state.facet(macroOptions);
    const name = result.name ?? '';
    const from = result.start;
    const to = Math.max(pos, from + name.length);
    const options = result.optionList.filter(option => option.isSelectable !== false).map((option, index) => {
        const replacer = option.valueProvider ? option.valueProvider(name) : option.value;
        return {
            label: option.name,
            detail: option.type || undefined,
            boost: -index,
            info: () => {
                const box = document.createElement('div');
                box.className = 'live-macro-info';
                const details = option.renderDetails?.();
                if (details) box.append(details);
                const valueLine = document.createElement('div');
                valueLine.className = 'live-macro-value';
                let value = null;
                try {
                    value = evaluate(`{{${option.name}}}`);
                } catch {
                    value = null;
                }
                valueLine.textContent = value === null ? t`Runs when sent` : t`Now: ${value}`;
                box.append(valueLine);
                return box;
            },
            apply: (/** @type {import('@codemirror/view').EditorView} */ view) => {
                const start = from + (option.replacementStartOffset ?? 0);
                const insert = String(replacer ?? option.name);
                view.dispatch({ changes: { from: start, to, insert }, selection: { anchor: start + insert.length } });
            },
        };
    });
    if (options.length === 0) return null;
    return { from, to, options, filter: true };
}

/**
 * @param {MacroOptions} options
 * @returns {import('@codemirror/state').Extension}
 */
export function liveMacros(options) {
    return [
        macroOptions.of(options),
        openedMacro,
        showingSource,
        // Highest, so a macro opened as written is one span over the styling inside it, in the macro's color.
        Prec.highest(macroPills),
        cursorTooltip,
        hoverMacro,
        openOnDoubleClick,
        keymap.of([{ key: 'Mod-Shift-m', run: toggleMacroSource }]),
        // No delay before Enter takes a suggestion, as with the app's own suggestion lists.
        autocompletion({ override: [macroCompletions], icons: false, closeOnBlur: true, interactionDelay: 0 }),
    ];
}
