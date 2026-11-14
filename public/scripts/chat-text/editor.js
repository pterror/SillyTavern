import {
    commands as cmCommands,
    grammarLanguage,
    keyHints,
    keybinds,
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
    formatSteps,
} from '../../live-editor-lib.js';
import { DOMPurify } from '../../lib.js';
import { boxSize } from './box-size.js';
import { caretInTextColor } from './caret.js';
import { macroCursorTooltip, macroPills } from './macros.js';
import { pastePicker } from './paste.js';
import { savedText } from './saved-text.js';
import { liveSearch, showPresets } from './search.js';
import { macroSuggestions, mentionSuggestions } from './suggest.js';
import { drawnText, grammarOf, lookOf, redrawEditor, TEXT_CLASS } from './surface.js';
import { escapePastPendingSuggestions } from './escape.js';
import { editorTooltips } from './tooltips.js';

const { EditorView, drawSelection, placeholder: placeholderText, keymap } = cmView;
const { history, historyKeymap, defaultKeymap, deleteCharForward } = cmCommands;
const { openSearchPanel } = cmSearch;
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

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? 'meta' : 'ctrl';

/** @type {readonly Readonly<{ id: string, keys: string, when?: 'hotkeys' }>[]} each command's key */
const KEYS = [
    { id: 'bold', keys: `${MOD}+b`, when: 'hotkeys' },
    { id: 'italic', keys: `${MOD}+i`, when: 'hotkeys' },
    { id: 'underline', keys: `${MOD}+u`, when: 'hotkeys' },
    { id: 'code', keys: `${MOD}+k`, when: 'hotkeys' },
    { id: 'strike', keys: `${MOD}+shift+backquote`, when: 'hotkeys' },
    { id: 'macros', keys: `${MOD}+shift+m` },
];

/** Find and replace, which an editor may not have */
const SEARCH_TOOLS = ['find'];

/** @type {ReturnType<typeof modifierHeld> | undefined} one for every editor, so an editor taken out with its message holds nothing on the window */
let shortcutsShown;

/** Keys the page has for an editor (Ctrl+Enter accepts an edit), which CodeMirror's own keys would take first */
const PAGE_KEYS = new Set(['Mod-Enter']);

/** @type {import('@codemirror/view').Command} */
const shiftDelete = view => view.state.selection.ranges.every(range => range.empty) && deleteCharForward(view);

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

/**
 * The markdown formatting commands, and an image upload, as tools
 * @returns {Tool[]}
 */
export function formatTools() {
    const { toggleStyle, hasStyle } = markdownFormat;
    return [
        { id: 'bold', label: page.t`Bold`, icon: icon('fa-bold'), run: toggleStyle('bold'), on: state => hasStyle(state, 'bold') },
        { id: 'italic', label: page.t`Italic`, icon: icon('fa-italic'), run: toggleStyle('italic'), on: state => hasStyle(state, 'italic') },
        { id: 'underline', label: page.t`Underline`, icon: icon('fa-underline'), run: toggleStyle('underline'), on: state => hasStyle(state, 'underline') },
        { id: 'strike', label: page.t`Strikethrough`, icon: icon('fa-strikethrough'), run: toggleStyle('strike'), on: state => hasStyle(state, 'strike') },
        { id: 'code', label: page.t`Code`, icon: icon('fa-code'), run: toggleStyle('code'), on: state => hasStyle(state, 'code') },
        { id: 'heading', label: page.t`Heading`, icon: icon('fa-heading'), run: markdownFormat.heading, on: markdownFormat.inHeading },
        { id: 'link', label: page.t`Link`, icon: icon('fa-link'), run: markdownFormat.link, on: markdownFormat.inLink },
        { id: 'quote', label: page.t`Quote`, icon: icon('fa-quote-left'), run: markdownFormat.quote, on: markdownFormat.inQuote },
        { id: 'list', label: page.t`List`, icon: icon('fa-list-ul'), run: markdownFormat.list, on: markdownFormat.inList },
        { id: 'codeBlock', label: page.t`Code block`, icon: icon('fa-terminal'), run: markdownFormat.codeBlock, on: markdownFormat.inCodeBlock },
        { id: 'image', label: page.t`Image`, icon: icon('fa-image'), run: insertImage },
    ];
}

/**
 * Binds each command's key on an editor, running it there
 * @param {View} view
 * @param {ReadonlyMap<string, Tool>} byId the editor's tools by id
 * @returns {() => void} unbinds them
 */
export function commandKeys(view, byId) {
    return keybinds(KEYS.map(key => ({
        keys: [key.keys],
        typing: true,
        ...(key.when === 'hotkeys' ? { when: () => page.hotkeys() } : {}),
        run: () => byId.get(key.id)?.run(view) ?? false,
    })), { target: view.dom, capture: true });
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
        const binding = KEYS.find(key => key.id === id);
        return binding ? formatSteps(binding.keys, step => formatKey(step)) : undefined;
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
 * @param {(source: string) => import('@pterror/interact-editor/look').Piece | undefined} pill
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
    });
}

/** @returns {EditorPage} what editors read from the page */
export const editorPage = () => page;

/**
 * @typedef {object} ChatEditorOptions
 * @property {Element} parent where the editor and its toolbar go
 * @property {TextSetup} setup how the text is drawn
 * @property {(source: string) => string | null | undefined} macroValue a macro's value, as the text came with it
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
export function chatEditor({ parent, setup, macroValue, speaker, person = name => page.person(name, speaker), initial, edited, save, className, label, placeholder, presetContext }) {
    let current = initial;
    /** @type {string | undefined} */
    let latest;
    let sent = 0;
    let asWritten = false;
    const stored = savedText(initial);
    const pill = macroPills({ get: macroValue }, person, page.t, () => asWritten);
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
        { id: 'macros', label: page.t`Show macros as written`, icon: icon('fa-file-code'), run: toggleMacros, on: () => asWritten },
        { id: 'find', label: page.t`Find and replace`, icon: icon('fa-magnifying-glass'), run: openSearchPanel },
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
            escapePastPendingSuggestions(),
            drawSelection(),
            caretInTextColor(),
            liveSearch({ context: presetContext ?? (() => ({ characterName: speaker })) }),
            overtype(),
            pasteFor(setup),
            suggestions([macroSuggestions(macroValue, page.t), mentionSuggestions(person)]),
            EditorView.contentAttributes.of({ 'aria-multiline': 'true', ...(label ? { 'aria-label': label } : {}) }),
            ...(placeholder ? [placeholderText(placeholder)] : []),
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
