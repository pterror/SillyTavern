import {
    commands as cmCommands,
    grammarLanguage,
    keyHints,
    lookChanged,
    lookDecorations,
    markdownFormat,
    modifierHeld,
    overtype,
    search as cmSearch,
    state as cmState,
    suggestions,
    textEditor,
    toolbar,
    view as cmView,
    formatKey,
    isMac,
    formatSteps,
} from '../../live-editor-lib.js';
import { DOMPurify } from '../../lib.js';
import { EDITOR_KEYS, FORMAT_KEYS, commandIdOfTool } from './format-keys.js';
import { ariaShortcut, shownKeysOf } from './key-names.js';
import { newUi, newUiStarted } from '../new-ui-page.js';
import { boxSize } from './box-size.js';
import { caretInTextColor } from './caret.js';
import { macroCursorTooltip, macroPills, macroValueRequests, openableMacros } from './macros.js';
import { cyclePaste, hasPasteChoice, pastePicker } from './paste.js';
import { savedText } from './saved-text.js';
import { liveSearch, showPresets } from './search.js';
import { macroSuggestions, mentionSuggestions } from './suggest.js';
import { drawnText, grammarOf, lookOf, redrawEditor, TEXT_CLASS } from './surface.js';
import { escapePastPendingSuggestions } from './escape.js';
import { editorTooltips } from './tooltips.js';

const { EditorView, drawSelection, placeholder: placeholderText, keymap } = cmView;
const { history, historyKeymap, defaultKeymap, deleteCharForward } = cmCommands;
const { openSearchPanel, findNext, findPrevious, selectSelectionMatches, selectNextOccurrence, gotoLine } = cmSearch;
const { Compartment } = cmState;

/**
 * @typedef {import('@codemirror/view').EditorView} View
 * @typedef {import('@pterror/interact-editor/tool-buttons').Tool} Tool
 * @typedef {import('./surface.js').TextSetup} TextSetup
 */

/**
 * What editors read from the page
 * @typedef {object} EditorPage
 * @property {() => boolean} hotkeys whether the formatting keys are on (`enable_md_hotkeys`)
 * @property {() => readonly string[]} toolbarChoice the commands a person put on the toolbar, in order; none when they
 *   chose none, and the toolbar holds every formatting command
 * @property {(file: File) => Promise<string>} uploadImage
 * @property {(macroName: string, speaker: string) => import('../macro-pill.js').MacroPerson | null} person
 * @property {import('../macro-pill.js').Translate} t
 */

/** @type {EditorPage} */
let page;

/** @param {EditorPage} dependencies */
export function initChatEditors(dependencies) {
    page = dependencies;
}

/** What a text box has of the browser's, which CodeMirror turns off: spelling checks, correction, capitals */
export const BROWSER_TEXT_AIDS = { spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' };

/** Find and replace, which an editor may not have */
const SEARCH_TOOLS = ['find'];

/** @type {ReturnType<typeof modifierHeld> | undefined} one for every editor, so an editor taken out with its message holds nothing on the window */
let shortcutsShown;

/** Keys the page has for an editor (Mod+Enter accepts an edit), which CodeMirror's own keys would take first */
const PAGE_KEYS = new Set(['Mod-Enter']);

/** @type {import('@codemirror/view').Command} */
export const shiftDelete = view => view.state.selection.ranges.every(range => range.empty) && deleteCharForward(view);

/**
 * Tab writes a tab character, or one at the start of each selected line; Shift+Tab takes one from each
 * @returns {import('@codemirror/state').Extension}
 */
export function tabKeys() {
    /** @param {View} view */
    const lines = (view) => {
        const { from, to } = view.state.selection.main;
        const first = view.state.doc.lineAt(from).number;
        const last = view.state.doc.lineAt(to).number;
        return Array.from({ length: last - first + 1 }, (_, i) => view.state.doc.line(first + i));
    };
    return keymap.of([
        {
            key: 'Tab',
            run(view) {
                const { from, to } = view.state.selection.main;
                if (view.state.doc.lineAt(from).number === view.state.doc.lineAt(to).number) {
                    view.dispatch(view.state.replaceSelection('\t'), { userEvent: 'input' });
                } else {
                    view.dispatch({ changes: lines(view).map(line => ({ from: line.from, insert: '\t' })), userEvent: 'input' });
                }
                return true;
            },
        },
        {
            key: 'Shift-Tab',
            run(view) {
                const changes = lines(view).filter(line => line.text.startsWith('\t')).map(line => ({ from: line.from, to: line.from + 1 }));
                if (changes.length) view.dispatch({ changes, userEvent: 'delete' });
                return true;
            },
        },
    ]);
}

/**
 * An icon for a toolbar button
 * @param {string} name a Font Awesome icon
 * @returns {() => Element}
 */
const icon = name => () => {
    const made = document.createElement('i');
    made.className = `fa-solid ${name}`;
    made.setAttribute('aria-hidden', 'true');
    return made;
};

/**
 * Lets an image be chosen, uploads it, and writes it in where the cursor was, with its size so its space is kept
 * before it loads
 * @param {View} view
 * @returns {boolean}
 */
function insertImage(view) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        const at = view.state.selection.main.head;
        try {
            const [url, size] = await Promise.all([page.uploadImage(file), imageSize(file)]);
            const sized = size ? ` =${size.width}x${size.height}` : '';
            const markdown = `![${file.name}](${url}${sized})`;
            const to = Math.min(at, view.state.doc.length);
            view.dispatch({ changes: { from: to, insert: markdown }, selection: { anchor: to + markdown.length }, userEvent: 'input.format' });
        } catch (error) {
            toastr.error(String(error?.message ?? error), page.t`The image could not be uploaded`);
        }
    });
    input.click();
    return true;
}

/**
 * @param {File} file
 * @returns {Promise<{ width: number, height: number } | null>}
 */
async function imageSize(file) {
    try {
        const bitmap = await createImageBitmap(file);
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
    } catch {
        return null;
    }
}

/** @param {string} id @returns {string} the name of a tool the page has a key for */
const labelOf = id => FORMAT_KEYS.find(key => key.id === id)?.label(page.t) ?? id;

/**
 * The markdown formatting commands, and an image upload, as tools
 * @returns {Tool[]}
 */
export function formatTools() {
    const { toggleStyle, hasStyle } = markdownFormat;
    return [
        { id: 'bold', label: labelOf('bold'), icon: icon('fa-bold'), run: toggleStyle('bold'), on: state => hasStyle(state, 'bold') },
        { id: 'italic', label: labelOf('italic'), icon: icon('fa-italic'), run: toggleStyle('italic'), on: state => hasStyle(state, 'italic') },
        { id: 'underline', label: labelOf('underline'), icon: icon('fa-underline'), run: toggleStyle('underline'), on: state => hasStyle(state, 'underline') },
        { id: 'strike', label: labelOf('strike'), icon: icon('fa-strikethrough'), run: toggleStyle('strike'), on: state => hasStyle(state, 'strike') },
        { id: 'code', label: labelOf('code'), icon: icon('fa-code'), run: toggleStyle('code'), on: state => hasStyle(state, 'code') },
        { id: 'heading', label: page.t`Heading`, icon: icon('fa-heading'), run: markdownFormat.heading, on: markdownFormat.inHeading },
        { id: 'link', label: page.t`Link`, icon: icon('fa-link'), run: markdownFormat.link, on: markdownFormat.inLink },
        { id: 'quote', label: page.t`Quote`, icon: icon('fa-quote-left'), run: markdownFormat.quote, on: markdownFormat.inQuote },
        { id: 'list', label: page.t`List`, icon: icon('fa-list-ul'), run: markdownFormat.list, on: markdownFormat.inList },
        { id: 'codeBlock', label: page.t`Code block`, icon: icon('fa-terminal'), run: markdownFormat.codeBlock, on: markdownFormat.inCodeBlock },
        { id: 'image', label: page.t`Image`, icon: icon('fa-image'), run: insertImage },
    ];
}

/**
 * The tool that draws macros as written instead of their values
 * @param {import('@codemirror/view').Command} toggle
 * @param {() => boolean} on whether they are drawn as written
 * @returns {Tool}
 */
export function macroTool(toggle, on) {
    return { id: 'macros', label: labelOf('macros'), icon: icon('fa-file-code'), run: toggle, on };
}

/** @returns {Tool} the tool that opens find and replace */
export function findTool() {
    return { id: 'find', label: labelOfEditorKey('find'), icon: icon('fa-magnifying-glass'), run: openSearchPanel };
}

/** @param {string} id @returns {string} the name of an editor action the page has a key for */
const labelOfEditorKey = id => EDITOR_KEYS.find(key => key.id === id)?.label(page.t) ?? id;

/**
 * The editor's other actions (searching, selecting, how a paste is kept), as tools
 * @returns {Tool[]}
 */
export function editTools() {
    /** @type {(id: string, name: string, run: import('@codemirror/view').Command, applies?: (state: import('@codemirror/state').EditorState) => boolean) => Tool} */
    const tool = (id, name, run, applies) => ({ id, label: labelOfEditorKey(id), icon: icon(name), run, ...(applies ? { applies } : {}) });
    return [
        tool('findNext', 'fa-angle-down', findNext),
        tool('findPrevious', 'fa-angle-up', findPrevious),
        tool('selectMatches', 'fa-highlighter', selectSelectionMatches),
        tool('selectNextOccurrence', 'fa-i-cursor', selectNextOccurrence),
        tool('gotoLine', 'fa-hashtag', gotoLine),
        tool('pasteMode', 'fa-paste', cyclePaste, hasPasteChoice),
    ];
}

/** @type {WeakMap<View, ReadonlyMap<string, Tool>>} each editor's tools, for the page's commands to run on it */
const toolsOf = new WeakMap();

/**
 * Lets the page's formatting commands run on an editor while it has focus
 * @param {View} view
 * @param {ReadonlyMap<string, Tool>} byId the editor's tools by id
 * @returns {() => void} takes the editor out again
 */
export function commandKeys(view, byId) {
    toolsOf.set(view, byId);
    return () => toolsOf.delete(view);
}

/** @returns {View | null} the editor that has focus */
function focusedEditor() {
    const at = document.activeElement?.closest('.cm-editor');
    return at instanceof HTMLElement ? EditorView.findFromDOM(at) : null;
}

/**
 * The tool of the editor that has focus, for the page's formatting command
 * @param {string} id the tool's id
 * @returns {Readonly<{ view: View, tool: Tool }> | null}
 */
export function focusedTool(id) {
    const view = focusedEditor();
    const tool = view ? toolsOf.get(view)?.get(id) : undefined;
    return view && tool ? { view, tool } : null;
}

/**
 * The tools an editor's toolbar shows: those the person chose, in their order, of the editor's own; when they chose
 * none, every formatting command and, where the editor has it, find and replace
 * @param {ReadonlyMap<string, Tool>} byId the editor's tools by id
 * @returns {import('@pterror/interact-editor/toolbar').Watched<readonly Tool[]>}
 */
export function shownTools(byId) {
    return {
        get() {
            const chosen = page.toolbarChoice();
            const ids = chosen.length ? chosen : [...formatTools().map(tool => tool.id), ...SEARCH_TOOLS];
            return ids.map(id => byId.get(id)).filter(tool => tool !== undefined);
        },
        watch: () => () => {},
    };
}

/**
 * The toolbar of an editor, in the space it reserves, its buttons naming their keys
 * @param {View} view
 * @param {import('@pterror/interact-editor/toolbar').Watched<readonly Tool[]>} tools
 * @returns {{ element: HTMLElement, stop: () => void }}
 */
export function toolbarFor(view, tools) {
    shortcutsShown ??= modifierHeld({ modifier: isMac ? 'Meta' : 'Control' });
    /** @param {string} id */
    const keyOf = id => {
        if (!newUiStarted()) return undefined;
        const binding = newUi().commands.all().find(command => command.id === commandIdOfTool(id))?.keys?.[0];
        return binding ? formatSteps(binding, step => formatKey(step)) : undefined;
    };
    const bar = toolbar({ view, tools });
    const stopHints = keyHints({ buttons: bar.buttons, keyOf, held: shortcutsShown });
    bar.element.classList.add('chat-editor-toolbar');
    bar.element.setAttribute('aria-label', page.t`Formatting`);
    return {
        element: bar.element,
        stop() {
            stopHints();
            bar.stop();
        },
    };
}

/**
 * How an editor draws its text: its grammar, and its look with macros as the given pieces
 * @param {TextSetup} setup
 * @param {(source: string, from: number) => import('@pterror/interact-editor/look').Piece | undefined} pill
 * @returns {import('@codemirror/state').Extension}
 */
export function drawnWith(setup, pill) {
    return [grammarLanguage(grammarOf(setup.grammar)), lookDecorations(lookOf(setup, pill))];
}

/**
 * How an editor takes a paste: HTML as markdown, with the picker for the other ways
 * @param {TextSetup} setup
 * @returns {import('@codemirror/state').Extension}
 */
export function pasteFor(setup) {
    return pastePicker({
        shows: markdown => drawnText(markdown, setup).textContent ?? '',
        clean: html => DOMPurify.sanitize(html, { WHOLE_DOCUMENT: false }),
        t: page.t,
        shortcut: () => ariaShortcut('editor.pasteMode'),
    });
}

/** @returns {EditorPage} what editors read from the page */
export const editorPage = () => page;

/**
 * @typedef {object} ChatEditorOptions
 * @property {Element} parent where the editor and its toolbar go
 * @property {TextSetup} setup how the text is drawn
 * @property {(source: string) => string | null | undefined} macroValue a macro's value, as the text came with it
 * @property {import('./macros.js').WantedValues} [macroValues] where the value of a macro the text has none for is
 *   asked, when it is typed or pasted; none leaves those macros without one
 * @property {string} speaker whose text it is, for mentions
 * @property {(macroName: string) => import('../macro-pill.js').MacroPerson | null} [person] who a mention names; by
 *   default the page's person for the speaker
 * @property {string} initial the text
 * @property {(text: string) => void} edited hears the text after each edit
 * @property {(text: string) => Promise<unknown>} save stores the text, answering when it is stored
 * @property {string} [className] classes of the element holding the editor and its toolbar
 * @property {string} [label] what the field is, for assistive technology
 * @property {string} [placeholder]
 * @property {() => import('./search.js').PresetContext} [presetContext]
 * @property {import('@codemirror/state').Extension} [extensions] more of the editor
 */

/**
 * @typedef {object} ChatEditor
 * @property {View} view
 * @property {() => string} text the text as edited
 * @property {() => Promise<void>} save stores the text as edited now
 * @property {() => void} redraw draws the text again, as when its macros' values changed
 * @property {() => void} stop
 */

/**
 * An editor over chat text: the reader's grammar and look with macros as pills, markdown formatting from the keys and
 * the toolbar, find and replace with its presets, suggestions for macros and mentions, and pasted
 * HTML as markdown. Each edit is handed on; `save` stores the text through the page's own save.
 * @param {ChatEditorOptions} options
 * @returns {ChatEditor}
 */
export function chatEditor({ parent, setup, macroValue, macroValues, speaker, person = name => page.person(name, speaker), initial, edited, save, className, label, placeholder, presetContext, extensions = [] }) {
    let current = initial;
    /** @type {string | undefined} */
    let latest;
    let sent = 0;
    let asWritten = false;
    const stored = savedText(initial);
    const opened = openableMacros(() => view, () => redraw());
    const pill = macroPills({ get: macroValue }, person, page.t, () => asWritten, opened.isOpen);
    const drawing = new Compartment();
    const holder = document.createElement('div');
    holder.className = className ? `chat-editor ${className}` : 'chat-editor';
    const editorHolder = document.createElement('div');
    holder.append(editorHolder);
    parent.append(holder);

    /** @type {View} */
    let view;
    const redraw = () => view.dispatch({ effects: lookChanged.of(undefined) });
    const toggleMacros = () => {
        asWritten = !asWritten;
        redraw();
        return true;
    };
    /** @type {readonly Tool[]} */
    const tools = [
        ...formatTools(),
        macroTool(toggleMacros, () => asWritten),
        findTool(),
        ...editTools(),
        { id: 'presets', label: page.t`Find and replace presets`, icon: icon('fa-wand-magic-sparkles'), run: v => (showPresets(v), true) },
    ];
    const byId = new Map(tools.map(tool => [tool.id, tool]));

    const made = textEditor({
        parent: editorHolder,
        text: stored.port,
        edit(changes, id) {
            for (const change of [...changes].reverse()) current = current.slice(0, change.from) + change.insert + current.slice(change.to);
            latest = id;
            edited(current);
        },
        extensions: [
            drawing.of(drawnWith(setup, pill)),
            EditorView.contentAttributes.of({ class: TEXT_CLASS }),
            history(),
            keymap.of([{ key: 'Shift-Delete', run: shiftDelete }, ...defaultKeymap.filter(binding => !PAGE_KEYS.has(binding.key ?? '')), ...historyKeymap]),
            EditorView.lineWrapping,
            boxSize('75dvh'),
            editorTooltips(),
            macroCursorTooltip({ get: macroValue }, person, page.t),
            opened.extension,
            ...(macroValues ? [macroValueRequests({ values: { get: macroValue }, wanted: macroValues, redraw: () => redraw() })] : []),
            escapePastPendingSuggestions(),
            drawSelection(),
            caretInTextColor(),
            liveSearch({ context: presetContext ?? (() => ({ characterName: speaker })), keysOf: shownKeysOf }),
            overtype(),
            pasteFor(setup),
            suggestions([macroSuggestions(macroValue, page.t), mentionSuggestions(person)]),
            EditorView.contentAttributes.of({ ...BROWSER_TEXT_AIDS, 'aria-multiline': 'true', ...(label ? { 'aria-label': label } : {}) }),
            ...(placeholder ? [placeholderText(placeholder)] : []),
            extensions,
        ],
    });
    view = made.view;
    redrawEditor(view.contentDOM, setup, next => view.dispatch({ effects: drawing.reconfigure(drawnWith(next, pill)) }));

    const bar = toolbarFor(view, shownTools(byId));
    holder.prepend(bar.element);
    const stopKeys = commandKeys(view, byId);

    return {
        view,
        text: () => current,
        async save() {
            const text = current;
            const id = latest;
            sent += 1;
            const order = sent;
            await save(text);
            stored.saved(text, id, order);
        },
        redraw,
        stop() {
            stopKeys();
            bar.stop();
            made.stop();
            holder.remove();
        },
    };
}
