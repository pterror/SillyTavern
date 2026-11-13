import {
    commands as cmCommands,
    grammarLanguage,
    lookDecorations,
    markdownPaste,
    overtype,
    state as cmState,
    suggestions,
    textEditor,
    view as cmView,
} from '../../live-editor-lib.js';
import { boxSize } from './box-size.js';
import { commandKeys, editorPage, formatTools, toolbarFor } from './editor.js';
import { macroPills } from './macros.js';
import { macroSuggestions, mentionSuggestions, slashSuggestions } from './suggest.js';
import { drawnText, grammarOf, lookOf, TEXT_CLASS } from './surface.js';

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
 * @property {() => void} stop
 */

/**
 * The chat box: an editor over the box's text, drawn as messages are, with suggestions for slash commands, macros and
 * mentions, formatting on keys, overtype and pasted HTML as markdown, sized to its text, with a toolbar holding no
 * tools in the space it reserves
 * @param {ChatBoxEditorOptions} options
 * @returns {ChatBoxEditor}
 */
export function chatBoxEditor({ parent, text, setup, label, keys, slashParser, slashWanted, maxHeight }) {
    const page = editorPage();
    const filledWhenSent = () => null;
    const pill = macroPills({ get: filledWhenSent }, name => page.person(name, ''), page.t, () => false);
    const placeholders = new Compartment();
    const editorHolder = document.createElement('div');
    editorHolder.className = 'chat-box-editor';
    parent.append(editorHolder);
    const made = textEditor({
        parent: editorHolder,
        text: text.port,
        edit: text.edited,
        extensions: [
            grammarLanguage(grammarOf(setup.grammar)),
            lookDecorations(lookOf(setup, pill)),
            EditorView.contentAttributes.of({ class: TEXT_CLASS, 'aria-multiline': 'true', 'aria-label': label }),
            history(),
            keymap.of([...keys, ...defaultKeymap.filter(binding => !PAGE_KEYS.has(binding.key ?? '')), ...historyKeymap]),
            EditorView.lineWrapping,
            drawSelection(),
            overtype(),
            markdownPaste({ shows: markdown => drawnText(markdown, setup).textContent ?? '' }),
            suggestions([slashSuggestions(slashParser, slashWanted), macroSuggestions(filledWhenSent, page.t), mentionSuggestions(name => page.person(name, ''))]),
            boxSize(maxHeight),
            placeholders.of([]),
        ],
    });
    const { view } = made;
    const byId = new Map(formatTools().map(tool => [tool.id, tool]));
    const stopKeys = commandKeys(view, byId);
    const bar = toolbarFor(view, { get: () => [], watch: () => () => {} });
    parent.prepend(bar.element);
    return {
        view,
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
