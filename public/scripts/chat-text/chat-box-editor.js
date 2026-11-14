import {
    commands as cmCommands,
    lookChanged,
    markdownPaste,
    overtype,
    state as cmState,
    suggestions,
    textEditor,
    view as cmView,
} from '../../live-editor-lib.js';
import { boxSize } from './box-size.js';
import { caretInTextColor } from './caret.js';
import { commandKeys, drawnWith, editorPage, formatTools, shownTools, toolbarFor } from './editor.js';
import { macroPills } from './macros.js';
import { macroSuggestions, mentionSuggestions, slashSuggestions } from './suggest.js';
import { drawnText, redrawEditor, TEXT_CLASS } from './surface.js';

const { EditorView, drawSelection, placeholder: placeholderText, keymap } = cmView;
const { history, historyKeymap, defaultKeymap } = cmCommands;
const { Compartment } = cmState;

/** Keys the page has for the box (Ctrl+Enter sends or regenerates), which CodeMirror's own keys would take first */
const PAGE_KEYS = new Set(['Mod-Enter']);

/**
 * @typedef {import('@codemirror/view').EditorView} View
 * @typedef {import('@codemirror/view').KeyBinding} KeyBinding
 */

/**
 * @typedef {object} ChatBoxEditorOptions
 * @property {Element} parent
 * @property {import('../chat-box-text.js').BoxText} text
 * @property {import('./surface.js').TextSetup} setup
 * @property {(source: string) => string | null | undefined} macroValue a macro's value, as the server sent it with the
 *   box's text: null when only known when sent, undefined when it sent none
 * @property {string} label what the field is, for assistive technology
 * @property {readonly KeyBinding[]} keys the box's own commands on keys (Enter sends), taken before the editor's
 * @property {Parameters<typeof slashSuggestions>[0]} slashParser
 * @property {(text: string) => boolean} slashWanted whether slash command suggestions show for the text as typed
 * @property {string} maxHeight how tall the box grows, a CSS length
 */

/**
 * @typedef {object} ChatBoxEditor
 * @property {View} view
 * @property {(text: string) => void} placeholder
 * @property {() => { text: string, changes: import('../chat-box-text.js').BoxChange[] }} unsaved the edits the text
 *   heard last doesn't include, as replacements in that text's positions with what each removes, and that text
 * @property {(base: string) => void} rebase keeps what the box shows, as edits over `base` in place of the text heard
 * @property {() => void} redraw draws the text again, as when its macros' values changed
 * @property {() => void} stop
 */

/**
 * The chat box: an editor over the box's text, drawn as messages are, with suggestions for slash commands, macros and
 * mentions, formatting on keys and its toolbar, overtype and pasted HTML as markdown, sized to its text
 * @param {ChatBoxEditorOptions} options
 * @returns {ChatBoxEditor}
 */
export function chatBoxEditor({ parent, text, setup, macroValue, label, keys, slashParser, slashWanted, maxHeight }) {
    const page = editorPage();
    const pill = macroPills({ get: macroValue }, name => page.person(name, ''), page.t, () => false);
    const placeholders = new Compartment();
    const drawing = new Compartment();
    const editorHolder = document.createElement('div');
    editorHolder.className = 'chat-box-editor';
    parent.append(editorHolder);
    const made = textEditor({
        parent: editorHolder,
        text: text.port,
        edit: text.edited,
        extensions: [
            drawing.of(drawnWith(setup, pill)),
            EditorView.contentAttributes.of({ class: TEXT_CLASS, 'aria-multiline': 'true', 'aria-label': label }),
            history(),
            keymap.of([...keys, ...defaultKeymap.filter(binding => !PAGE_KEYS.has(binding.key ?? '')), ...historyKeymap]),
            EditorView.lineWrapping,
            drawSelection(),
            caretInTextColor(),
            overtype(),
            markdownPaste({ shows: markdown => drawnText(markdown, setup).textContent ?? '' }),
            suggestions([slashSuggestions(slashParser, slashWanted), macroSuggestions(macroValue, page.t), mentionSuggestions(name => page.person(name, ''))]),
            boxSize(maxHeight),
            placeholders.of([]),
        ],
    });
    const { view } = made;
    redrawEditor(view.contentDOM, setup, next => view.dispatch({ effects: drawing.reconfigure(drawnWith(next, pill)) }));
    const byId = new Map(formatTools().map(tool => [tool.id, tool]));
    const stopKeys = commandKeys(view, byId);
    const bar = toolbarFor(view, shownTools(byId));
    parent.prepend(bar.element);
    return {
        view,
        unsaved() {
            const composed = made.unincluded();
            /** @type {import('../chat-box-text.js').BoxChange[]} */
            const changes = [];
            const { text: base } = composed;
            composed.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
                changes.push({ from, to, insert: inserted.toString(), deleted: base.slice(from, to) });
            });
            return { text: base, changes };
        },
        rebase(base) {
            text.rebased(base, made.rebase(base));
        },
        redraw() {
            view.dispatch({ effects: lookChanged.of(undefined) });
        },
        placeholder(shown) {
            view.dispatch({ effects: placeholders.reconfigure(shown ? placeholderText(shown) : []) });
        },
        stop() {
            stopKeys();
            bar.stop();
            made.stop();
            editorHolder.remove();
        },
    };
}
