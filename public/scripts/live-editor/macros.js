// Macros in the editor: each as written, with what is sent in its place beside it, and a dropdown of macros while typing one.

import { state as cmState, view as cmView, autocomplete as cmAutocomplete } from '../../live-editor-lib.js';
import { topLevelMacroSpans } from '../safe-macros.js';
import { getMacroAutoCompleteAt } from '../autocomplete/MacroAutoCompleteHelper.js';
import { macros as macroSystem } from '../macros/macro-system.js';
import { shouldActivateMacroAutocomplete, MACRO_AUTOCOMPLETE_MODE } from '../autocomplete/MacroAutoComplete.js';
import { t } from '../i18n.js';

const { Facet, Prec } = cmState;
const { Decoration, ViewPlugin } = cmView;
const { autocompletion } = cmAutocomplete;

/**
 * @typedef {object} MacroOptions
 * @property {(macroText: string) => string | null} evaluate A macro's value, or null when it only runs when sent
 * (side effects or randomness), so it stays as written.
 */

const macroOptions = Facet.define({
    combine: values => values[0] ?? { evaluate: () => null },
});

// The most of a value the badge shows; the title has all of it.
const SHOWN_VALUE_LENGTH = 24;

/**
 * A macro's category in the registry, from its text: the color it is drawn in goes by it.
 * @param {string} macroText One whole `{{…}}`.
 * @returns {string | undefined}
 */
function macroCategory(macroText) {
    const inner = macroText.slice(2).trimStart();
    // Flags before the name (`{{!user}}`, `{{#if …}}`); the comment macro is named `//`.
    const name = inner.startsWith('//') ? '//' : /^[^a-zA-Z]{0,3}([a-zA-Z][\w-]*)/.exec(inner)?.[1];
    return name ? macroSystem.registry.getPrimaryMacro(name)?.category : undefined;
}

/**
 * The mark a macro is drawn with. What is sent in its place is drawn by the mark's own span (CSS generated content
 * from these attributes), not by a widget: it is no position in the text, and it never breaks across lines or away
 * from the macro, so a click on it lands on the macro, on the line it is drawn on.
 * @param {string | null} value The macro's value, or null when it only runs when sent.
 * @param {string | undefined} category Its category, for its color.
 */
function macroMark(value, category) {
    const categoryAttribute = category ? { 'data-macro-category': category } : {};
    if (value === null) {
        return Decoration.mark({
            class: 'macro-source macro-later',
            attributes: { ...categoryAttribute, 'data-sent-label': t`filled in when sent`, title: t`This macro is filled in when the message is sent.` },
        });
    }
    const flat = value.replace(/\s+/g, ' ');
    const shown = flat.length > SHOWN_VALUE_LENGTH ? `${flat.slice(0, SHOWN_VALUE_LENGTH - 1)}…` : flat;
    return Decoration.mark({
        class: 'macro-source',
        attributes: { ...categoryAttribute, 'data-sent-label': t`sent as`, 'data-sent-value': shown, title: t`Sent as: ${value}` },
    });
}

/**
 * Each macro shows as written, styled as a macro, followed by what is sent in its place (or, if it only runs when
 * sent, a note saying so). Neither depends on the selection: the text is never swapped for its value, so selecting
 * across a macro moves nothing.
 */
const macroValues = ViewPlugin.fromClass(class {
    /** @param {import('@codemirror/view').EditorView} view */
    constructor(view) {
        this.decorations = this.build(view);
    }

    /** @param {import('@codemirror/view').ViewUpdate} update */
    update(update) {
        // While an IME composes, the values only move with the text; they're worked out again when it ends.
        if (update.view.composing) {
            this.decorations = this.decorations.map(update.changes);
        } else if (update.docChanged || update.viewportChanged) {
            this.decorations = this.build(update.view);
        }
    }

    /** @param {import('@codemirror/view').EditorView} view */
    build(view) {
        const state = view.state;
        const { evaluate } = state.facet(macroOptions);
        /** @type {import('@codemirror/state').Range<import('@codemirror/view').Decoration>[]} */
        const ranges = [];
        // Whole lines, so a macro is never cut by the edge of what's shown.
        for (const visible of view.visibleRanges) {
            const unit = { from: state.doc.lineAt(visible.from).from, to: state.doc.lineAt(visible.to).to };
            // Found in the text, not the syntax tree: macros are filled in before the text is read as markdown, so
            // one in code, in HTML or after a backslash is filled in too, as the preview shows it.
            for (const span of topLevelMacroSpans(state.doc.sliceString(unit.from, unit.to))) {
                const from = unit.from + span.start;
                const to = unit.from + span.end;
                const text = state.doc.sliceString(from, to);
                let value = null;
                try {
                    value = evaluate(text);
                } catch (error) {
                    console.warn('Macro could not be filled in', text, error);
                }
                ranges.push(macroMark(value, macroCategory(text)).range(from, to));
            }
        }
        return Decoration.set(ranges, true);
    }
}, { decorations: plugin => plugin.decorations });

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
        // Highest, so a macro's span wraps the styling inside it rather than being cut into pieces by it: its value is
        // drawn once, after the whole macro.
        Prec.highest(macroValues),
        // No delay before Enter takes a suggestion, as with the app's own suggestion lists.
        autocompletion({ override: [macroCompletions], icons: false, closeOnBlur: true, interactionDelay: 0 }),
    ];
}
