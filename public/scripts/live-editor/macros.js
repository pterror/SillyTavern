// Macros in the editor: each as a pill holding what is sent in its place (macro-pill.js), its source in its tooltip
// (macro-tooltip.js), and a dropdown of macros while typing one.

import { state as cmState, view as cmView, autocomplete as cmAutocomplete } from '../../live-editor-lib.js';
import { topLevelMacroSpans, withFilledAbout } from '../safe-macros.js';
import { macroColorAttributes, macroPill, macroTooltipAttributes } from '../macro-pill.js';
import { setMacroBesideCursor } from '../macro-tooltip.js';
import { getMacroAutoCompleteAt } from '../autocomplete/MacroAutoCompleteHelper.js';
import { macroCategory } from '../macros/macro-system.js';
import { shouldActivateMacroAutocomplete, MACRO_AUTOCOMPLETE_MODE } from '../autocomplete/MacroAutoComplete.js';
import { t } from '../i18n.js';

const { Facet, Prec, StateField, StateEffect } = cmState;
const { Decoration, ViewPlugin, WidgetType, EditorView, keymap } = cmView;
const { autocompletion } = cmAutocomplete;

/**
 * @typedef {object} MacroValueSource Where the editor's macros' values come from (macro-values.js MacroValues).
 * @property {(source: string) => string | null | undefined} get A macro's value: null when it only runs when sent
 * (side effects or randomness); undefined while it isn't known.
 * @property {(sources: string[]) => Promise<boolean>} wantMacros Asks for those not known; whether one was learned.
 * @property {() => Promise<boolean>} refresh Asks for the known ones again; whether one changed.
 */

/**
 * @typedef {object} MacroOptions
 * @property {MacroValueSource} values The macros' values. One not known yet is shown as written until it is.
 * @property {(macroName: string) => import('../macro-pill.js').MacroPerson | null} [person] Who a mention
 * ({{user}}, {{char}}) names here, for its card.
 */

/** @type {MacroValueSource} */
const NO_VALUES = { get: () => null, wantMacros: async () => false, refresh: async () => false };

const macroOptions = Facet.define({
    combine: values => values[0] ?? { values: NO_VALUES },
});

/** Some macros' values were learned, or changed: the pills are drawn again. */
const valuesLearned = StateEffect.define();

/** How long after the last change the known values are asked for again, for those that change over time. */
const REFRESH_DELAY = 2000;

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
    const value = state.facet(macroOptions).values.get(source) ?? null;
    return { source, name, category: name ? macroCategory(name) : undefined, value };
}

/**
 * Who a mention names here, for its tooltip.
 * @param {import('@codemirror/state').EditorState} state
 * @param {import('../macro-pill.js').MacroShown} shown
 */
function personOf(state, shown) {
    if (!shown.name) return null;
    const { person, values } = state.facet(macroOptions);
    return withFilledAbout(person?.(shown.name) ?? null, shown.name, source => values.get(source));
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
    /**
     * @param {import('../macro-pill.js').MacroShown} macro
     * @param {import('../macro-pill.js').MacroPerson | null} person
     */
    constructor(macro, person) {
        super();
        this.macro = macro;
        this.person = person;
    }

    /** @param {MacroPillWidget} other */
    eq(other) {
        return other.macro.source === this.macro.source && other.macro.value === this.macro.value && other.macro.category === this.macro.category
            && JSON.stringify(other.person) === JSON.stringify(this.person);
    }

    toDOM() {
        return macroPill(this.macro, { t, compact: true, person: this.person });
    }

    // A click on a pill puts the cursor beside it, as on a character.
    ignoreEvent() {
        return false;
    }
}

/**
 * A macro shown as written, in its color: every macro while the source is shown; one whose value isn't known yet; the
 * macro opened for editing, with its tooltip (the source shown says it all otherwise).
 * @param {import('@codemirror/state').EditorState} state
 * @param {string} macroText
 * @param {boolean} opened
 */
function sourceMark(state, macroText, opened) {
    if (!opened) {
        const name = macroNameOf(macroText);
        return Decoration.mark({ class: 'macro-source', attributes: macroColorAttributes(name, name ? macroCategory(name) : undefined) });
    }
    const shown = shownMacro(state, macroText);
    return Decoration.mark({ class: 'macro-source', attributes: macroTooltipAttributes(shown, { t, compact: true, person: personOf(state, shown) }) });
}

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
        this.view = view;
        /** @type {ReturnType<typeof setTimeout> | null} */
        this.refreshTimer = null;
        this.build(view);
    }

    /** @param {import('@codemirror/view').ViewUpdate} update */
    update(update) {
        const learned = update.transactions.some(tr => tr.effects.some(effect => effect.is(valuesLearned)));
        // While an IME composes, the pills only move with the text; they're worked out again when it ends.
        if (update.view.composing) {
            this.pills = this.pills.map(update.changes);
            this.marks = this.marks.map(update.changes);
            this.decorations = this.decorations.map(update.changes);
        } else if (learned || update.docChanged || update.viewportChanged
            || update.startState.field(openedMacro) !== update.state.field(openedMacro)
            || update.startState.field(showingSource) !== update.state.field(showingSource)) {
            this.build(update.view);
        }
        if (update.docChanged) this.refreshLater();
    }

    /** Asks for the known values again once the typing stops ({{time}} moves on, a variable is set elsewhere). */
    refreshLater() {
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            void this.view.state.facet(macroOptions).values.refresh().then(changed => this.redraw(changed));
        }, REFRESH_DELAY);
    }

    /** @param {boolean} changed Whether a value was learned or changed. */
    redraw(changed) {
        if (changed && this.view.dom.isConnected) this.view.dispatch({ effects: valuesLearned.of(null) });
    }

    destroy() {
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
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
        const { values } = state.facet(macroOptions);
        /** @type {string[]} Macros whose values aren't known yet: shown as written until they are. */
        const unknown = [];
        // Whole lines, so a macro is never cut by the edge of what's shown.
        for (const visible of view.visibleRanges) {
            const unit = { from: state.doc.lineAt(visible.from).from, to: state.doc.lineAt(visible.to).to };
            // Found in the text, not the syntax tree: macros are filled in before the text is read as markdown, so
            // one in code, in HTML or after a backslash is filled in too, as the preview shows it.
            for (const span of topLevelMacroSpans(state.doc.sliceString(unit.from, unit.to))) {
                const from = unit.from + span.start;
                const to = unit.from + span.end;
                const text = state.doc.sliceString(from, to);
                const isOpened = Boolean(opened && opened.from <= from && to <= opened.to);
                if ((isOpened || !asWritten) && values.get(text) === undefined) unknown.push(text);
                if (asWritten || isOpened || values.get(text) === undefined) {
                    marks.push(sourceMark(state, text, isOpened && !asWritten).range(from, to));
                } else {
                    const shown = shownMacro(state, text);
                    pills.push(Decoration.replace({ widget: new MacroPillWidget(shown, personOf(state, shown)) }).range(from, to));
                    const line = state.doc.lineAt(from);
                    marks.push(pillGlue.range(Math.max(line.from, from - 1), Math.min(line.to, to + 1)));
                }
            }
        }
        this.pills = Decoration.set(pills, true);
        this.marks = Decoration.set(marks, true);
        this.decorations = Decoration.set([...pills, ...marks], true);
        if (unknown.length > 0) void values.wantMacros(unknown).then(learned => this.redraw(learned));
    }
}, {
    decorations: plugin => plugin.decorations,
    provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.pills ?? Decoration.none),
});

/**
 * The macro the cursor is beside (a pill), or inside (a macro opened for editing), after the user put it there (a
 * click, the arrow keys, typing). Not where an edit starts: its tooltip would cover what is above the field.
 */
const cursorMacro = StateField.define({
    /** @returns {{ from: number, to: number } | null} */
    create: () => null,
    update(macro, tr) {
        if (!tr.docChanged && !tr.selection && !tr.effects.length) return macro;
        if (!tr.isUserEvent('select') && !tr.isUserEvent('input') && !tr.isUserEvent('delete')) return null;
        const state = tr.state;
        const selection = state.selection.main;
        if (!selection.empty || state.field(showingSource)) return null;
        const head = selection.head;
        return macrosOnLine(state, head).find(m => m.from <= head && head <= m.to) ?? null;
    },
});

/**
 * What shows the macro at `macro` in the editor: its pill, or its source opened for editing.
 * @param {import('@codemirror/view').EditorView} view
 * @param {{ from: number, to: number } | null} macro
 * @returns {Element | null}
 */
function macroElement(view, macro) {
    if (!macro) return null;
    const pill = [...view.contentDOM.querySelectorAll('.macro-pill')].find(el => view.posAtDOM(el) === macro.from);
    if (pill) return pill;
    return [...view.contentDOM.querySelectorAll('.macro-source[data-macro-source]')].find((el) => {
        const pos = view.posAtDOM(el);
        return macro.from <= pos && pos <= macro.to;
    }) ?? null;
}

/** While the cursor is beside a macro, its tooltip. */
const cursorTooltip = ViewPlugin.fromClass(class {
    /** @param {import('@codemirror/view').EditorView} view */
    constructor(view) {
        this.view = view;
    }

    /** @param {import('@codemirror/view').ViewUpdate} update */
    update(update) {
        const macro = update.state.field(cursorMacro);
        if (!macro && !update.startState.field(cursorMacro)) return;
        // Once the editor has drawn: a pill is drawn anew when the text around it changes.
        update.view.requestMeasure({
            read: view => macroElement(view, view.state.field(cursorMacro)),
            write: el => setMacroBesideCursor(this, el),
        });
    }

    destroy() {
        setMacroBesideCursor(this, null);
    }
});

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

/** The macros "@" offers: one person's name each. */
const MENTIONABLE = ['user', 'char'];

/**
 * "@" at the start of a word offers who can be mentioned ({{user}}, {{char}}) by their names here; picking one puts
 * its macro in place of the "@" and what was typed after it.
 * @param {import('@codemirror/autocomplete').CompletionContext} context
 */
function mentionCompletions(context) {
    const typed = context.matchBefore(/(?:^|[\s(["'*_])@[^\s@]*$/u);
    if (!typed) return null;
    const at = context.state.sliceDoc(typed.from, typed.to).lastIndexOf('@') + typed.from;
    const { person } = context.state.facet(macroOptions);
    const options = MENTIONABLE.map((macro, index) => {
        const who = person?.(macro);
        return {
            label: who?.name || macro,
            detail: `{{${macro}}}`,
            avatarUrl: who?.avatarUrl,
            boost: -index,
            apply: (/** @type {import('@codemirror/view').EditorView} */ view, /** @type {any} */ _completion, /** @type {number} */ _from, /** @type {number} */ to) => {
                const insert = `{{${macro}}}`;
                view.dispatch({ changes: { from: at, to, insert }, selection: { anchor: at + insert.length }, userEvent: 'input.complete' });
            },
        };
    });
    return { from: at + 1, options, filter: true };
}

/** A mention's avatar in the "@" list, before its name; nothing for other suggestions. */
const mentionAvatar = {
    position: 20,
    render: (/** @type {{ avatarUrl?: string }} */ completion) => {
        if (!completion.avatarUrl) return null;
        const img = document.createElement('img');
        img.className = 'live-mention-avatar';
        img.src = completion.avatarUrl;
        img.alt = '';
        return img;
    },
};

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
    const { values } = context.state.facet(macroOptions);
    const name = result.name ?? '';
    const from = result.start;
    const to = Math.max(pos, from + name.length);
    const options = result.optionList.filter(option => option.isSelectable !== false).map((option, index) => {
        const replacer = option.valueProvider ? option.valueProvider(name) : option.value;
        return {
            label: option.name,
            detail: option.type || undefined,
            boost: -index,
            info: async () => {
                const source = `{{${option.name}}}`;
                await values.wantMacros([source]);
                const value = values.get(source) ?? null;
                const box = document.createElement('div');
                box.className = 'live-macro-info';
                const details = option.renderDetails?.();
                if (details) box.append(details);
                const valueLine = document.createElement('div');
                valueLine.className = 'live-macro-value';
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
        cursorMacro,
        cursorTooltip,
        openOnDoubleClick,
        keymap.of([{ key: 'Mod-Shift-m', run: toggleMacroSource }]),
        // No delay before Enter takes a suggestion, as with the app's own suggestion lists.
        autocompletion({ override: [macroCompletions, mentionCompletions], icons: false, closeOnBlur: true, interactionDelay: 0, addToOptions: [mentionAvatar] }),
    ];
}
