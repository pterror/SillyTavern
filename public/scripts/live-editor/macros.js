// Macros in the editor: filled in where the cursor isn't, and a dropdown of macros while typing one.

import { state as cmState, view as cmView, language as cmLanguage, autocomplete as cmAutocomplete } from '../../live-editor-lib.js';
import { renderField } from './render.js';
import { getMacroAutoCompleteAt } from '../autocomplete/MacroAutoCompleteHelper.js';
import { shouldActivateMacroAutocomplete, MACRO_AUTOCOMPLETE_MODE } from '../autocomplete/MacroAutoComplete.js';
import { t } from '../i18n.js';

const { Facet } = cmState;
const { Decoration, WidgetType, ViewPlugin } = cmView;
const { syntaxTree } = cmLanguage;
const { autocompletion } = cmAutocomplete;

/**
 * @typedef {object} MacroOptions
 * @property {(macroText: string) => string | null} evaluate A macro's value, or null when it only runs when sent
 * (side effects or randomness), so it stays as written.
 */

const macroOptions = Facet.define({
    combine: values => values[0] ?? { evaluate: () => null },
});

class MacroWidget extends WidgetType {
    /**
     * @param {string} text
     * @param {boolean} filled Whether `text` is the macro's value; otherwise the macro as written.
     */
    constructor(text, filled) {
        super();
        this.text = text;
        this.filled = filled;
    }

    /** @param {MacroWidget} other */
    eq(other) {
        return other.text === this.text && other.filled === this.filled;
    }

    toDOM() {
        const span = document.createElement('span');
        span.className = this.filled ? 'macro-substituted' : 'macro-raw';
        span.textContent = this.text;
        return span;
    }
}

/**
 * In the blocks being edited, each macro the selection isn't in shows its value (or, if it only runs when sent, stays
 * as written in its own style); the one being typed in shows as written.
 */
const macroValues = ViewPlugin.fromClass(class {
    /** @param {import('@codemirror/view').EditorView} view */
    constructor(view) {
        this.decorations = this.build(view);
    }

    /** @param {import('@codemirror/view').ViewUpdate} update */
    update(update) {
        if (update.docChanged || update.selectionSet || update.state.field(renderField) !== update.startState.field(renderField)) {
            this.decorations = this.build(update.view);
        }
    }

    /** @param {import('@codemirror/view').EditorView} view */
    build(view) {
        const state = view.state;
        const { editing } = state.field(renderField);
        const { evaluate } = state.facet(macroOptions);
        /** @type {import('@codemirror/state').Range<import('@codemirror/view').Decoration>[]} */
        const ranges = [];
        const tree = syntaxTree(state);
        for (const unit of editing) {
            tree.iterate({
                from: unit.from,
                to: unit.to,
                enter: (node) => {
                    if (node.name !== 'Macro') return true;
                    const inSelection = state.selection.ranges.some(r => r.from <= node.to && r.to >= node.from);
                    if (inSelection) return false;
                    const text = state.doc.sliceString(node.from, node.to);
                    let value = null;
                    try {
                        value = evaluate(text);
                    } catch (error) {
                        console.warn('Macro could not be filled in', text, error);
                    }
                    ranges.push(Decoration.replace({ widget: new MacroWidget(value ?? text, value !== null) }).range(node.from, node.to));
                    return false;
                },
            });
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
        macroValues,
        // No delay before Enter takes a suggestion, as with the app's own suggestion lists.
        autocompletion({ override: [macroCompletions], icons: false, closeOnBlur: true, interactionDelay: 0 }),
    ];
}
