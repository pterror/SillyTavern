import { state as cmState, view as cmView, commands as cmCommands } from '../../live-editor-lib.js';
import { EDITOR_ESCAPE_TAKERS, isEditorEvent, markEditorEvent, registerMountedEditor, unregisterMountedEditor } from './registry.js';
import { chatMarkdownLanguage, liveRendering } from './render.js';
import { liveMacros } from './macros.js';
import { liveFormatting } from './formatting.js';
import { livePaste } from './paste.js';
import { liveSearch } from './search.js';
import { OVERLAYS_CHANGED_EVENT } from '../drawer-stack.js';
import { unclippedSpace } from '../util/unclipped-space.js';

const { EditorState, Compartment, Annotation, Prec } = cmState;
const { EditorView, placeholder: placeholderExtension, keymap, drawSelection, tooltips } = cmView;
const { history, historyKeymap, defaultKeymap, deleteCharForward } = cmCommands;

/** @type {import('@codemirror/view').Command} */
const shiftDelete = view => view.state.selection.ranges.every(range => range.empty) && deleteCharForward(view);

/**
 * @typedef {object} LiveEditorOptions
 * @property {Element} [mountAfter]
 * @property {import('./grammar.js').GrammarOptions} [grammar]
 * @property {(text: string) => string} [render]
 * @property {import('./macros.js').MacroOptions} [macros]
 * @property {import('./formatting.js').FormattingOptions | false} [formatting]
 * @property {import('./search.js').SearchOptions | false} [search]
 * @property {string} [contentClass]
 * @property {string} [editorClass]
 */

/**
 * @typedef {object} LiveEditor
 * @property {import('@codemirror/view').EditorView} view
 * @property {Record<'grammar'|'render'|'macros'|'toolbar'|'paste'|'search'|'sync', import('@codemirror/state').Compartment>} compartments
 * @property {() => void} destroy
 * @property {() => void} takeFocus
 */

const fromTextarea = Annotation.define();

const FORWARDED = ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'copy', 'cut', 'paste'];

/** @param {KeyboardEvent} event */
const isPasteCycleKey = (event) => (event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && event.code === 'KeyV';

const LIST_KEYS = new Set(['Escape', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown']);

const STOPPED = [...FORWARDED, 'input', 'beforeinput', 'focusin', 'focusout', 'compositionstart', 'compositionupdate', 'compositionend'];

const COPIED_STYLE = [
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'word-spacing',
    'word-break', 'overflow-wrap', 'color', 'caret-color', 'background-color', 'background-image', 'transition', 'border-top',
    'border-right', 'border-bottom', 'border-left', 'border-radius', 'max-height', 'text-align',
];
const COPIED_CONTENT_STYLE = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];

const textareaValue = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'));

/**
 * @param {Event} event
 * @returns {Event}
 */
function copyEvent(event) {
    const base = { bubbles: true, cancelable: true, composed: true };
    if (event instanceof KeyboardEvent) {
        return new KeyboardEvent(event.type, {
            ...base, key: event.key, code: event.code, location: event.location, repeat: event.repeat,
            isComposing: event.isComposing, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey,
            metaKey: event.metaKey,
        });
    }
    if (event instanceof MouseEvent) {
        return new MouseEvent(event.type, {
            ...base, detail: event.detail, screenX: event.screenX, screenY: event.screenY, clientX: event.clientX,
            clientY: event.clientY, button: event.button, buttons: event.buttons, ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, view: event.view,
        });
    }
    if (event instanceof ClipboardEvent) {
        return new ClipboardEvent(event.type, { ...base, clipboardData: event.clipboardData });
    }
    return new Event(event.type, base);
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {{ from: number, to: number, insert: string } | null}
 */
function diffText(from, to) {
    if (from === to) return null;
    let start = 0;
    const max = Math.min(from.length, to.length);
    while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
    let endFrom = from.length;
    let endTo = to.length;
    while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
        endFrom--;
        endTo--;
    }
    return { from: start, to: endFrom, insert: to.slice(start, endTo) };
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {LiveEditorOptions} [options]
 * @returns {LiveEditor}
 */
export function mountLiveEditor(textarea, options = {}) {
    const compartments = {
        grammar: new Compartment(),
        render: new Compartment(),
        macros: new Compartment(),
        toolbar: new Compartment(),
        paste: new Compartment(),
        search: new Compartment(),
        sync: new Compartment(),
    };

    const look = readLook(textarea);

    const forwardHandlers = Object.fromEntries(FORWARDED.map(type => [type, (/** @type {Event} */ event, /** @type {EditorView} */ editorView) => {
        if (event.defaultPrevented) return false;
        if (event instanceof KeyboardEvent && LIST_KEYS.has(event.key) && editorView.dom.querySelector('.cm-tooltip-autocomplete')) return false;
        if (event instanceof KeyboardEvent && event.key === 'Escape' && editorView.dom.querySelector(EDITOR_ESCAPE_TAKERS)) return false;
        if (event instanceof KeyboardEvent && isPasteCycleKey(event) && editorView.dom.querySelector('.live-paste-picker')) return false;
        const copy = copyEvent(event);
        markEditorEvent(copy);
        textarea.dispatchEvent(copy);
        if (copy.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            return true;
        }
        return false;
    }]));

    let chatScrollBefore = null;
    const keepChatScroll = [
        EditorState.transactionExtender.of(() => {
            chatScrollBefore = textarea.closest('#chat')?.scrollTop ?? null;
            return null;
        }),
        EditorView.updateListener.of((update) => {
            const chat = update.view.dom.closest('#chat');
            if (update.heightChanged && chat && chatScrollBefore !== null) chat.scrollTop = chatScrollBefore;
        }),
    ];

    const sync = EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some(tr => tr.annotation(fromTextarea))) {
            textareaValue.set.call(textarea, update.state.doc.toString());
            const input = new InputEvent('input', { bubbles: true, cancelable: false });
            markEditorEvent(input);
            textarea.dispatchEvent(input);
        }
    });

    const placeholderSlot = new Compartment();

    const view = new EditorView({
        state: EditorState.create({
            doc: textareaValue.get.call(textarea),
            selection: initialSelection(textarea),
            extensions: [
                compartments.grammar.of(chatMarkdownLanguage(options.grammar)),
                compartments.render.of(options.render ? liveRendering({ render: options.render, emojis: options.grammar?.emojis }) : []),
                compartments.macros.of(options.macros ? liveMacros(options.macros) : []),
                compartments.toolbar.of(options.formatting === false ? [] : liveFormatting(options.formatting || {})),
                compartments.paste.of(livePaste()),
                compartments.search.of(options.search === false ? [] : liveSearch(options.search || {})),
                compartments.sync.of([]),
                history(),
                keymap.of([{ key: 'Shift-Delete', run: shiftDelete }, ...defaultKeymap, ...historyKeymap]),
                EditorView.lineWrapping,
                tooltips({ tooltipSpace: view => unclippedSpace(view.dom) }),
                drawSelection(),
                EditorView.editorAttributes.of({ class: options.editorClass ? `live-editor ${options.editorClass}` : 'live-editor' }),
                Prec.highest(EditorView.domEventHandlers(forwardHandlers)),
                sync,
                keepChatScroll,
                placeholderSlot.of(textarea.placeholder ? placeholderExtension(textarea.placeholder) : []),
                EditorState.readOnly.of(textarea.readOnly),
                EditorView.editable.of(!textarea.disabled),
                EditorView.contentAttributes.of({
                    'aria-multiline': 'true',
                    ...(options.contentClass ? { class: options.contentClass } : {}),
                    ...(textarea.getAttribute('aria-label') ? { 'aria-label': textarea.getAttribute('aria-label') } : {}),
                    ...(textarea.labels?.[0]?.id ? { 'aria-labelledby': textarea.labels[0].id } : {}),
                }),
            ],
        }),
    });

    applyLook(view, look);
    (options.mountAfter ?? textarea).after(view.dom);
    registerMountedEditor(view.dom, textarea, {
        caretRect: () => {
            const coords = view.coordsAtPos(view.state.selection.main.head);
            return coords ? new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top) : null;
        },
        macroSuggestions: Boolean(options.macros),
    });

    let movingFocusIn = false;

    const onContentFocus = (/** @type {FocusEvent} */ event) => {
        if (movingFocusIn) return;
        const pair = event.type === 'focus' ? [['focus', false], ['focusin', true]] : [['blur', false], ['focusout', true]];
        for (const [type, bubbles] of pair) {
            const copy = new FocusEvent(String(type), { bubbles: Boolean(bubbles), relatedTarget: event.relatedTarget });
            markEditorEvent(copy);
            textarea.dispatchEvent(copy);
        }
    };
    view.contentDOM.addEventListener('focus', onContentFocus);
    view.contentDOM.addEventListener('blur', onContentFocus);

    const stopAtEditor = (/** @type {Event} */ event) => event.stopPropagation();
    for (const type of STOPPED) view.dom.addEventListener(type, stopAtEditor);

    textarea.classList.add('live-editor-textarea');
    const restoreTextarea = proxyTextarea(textarea, view);

    const onOutsideInput = (/** @type {Event} */ event) => {
        if (isEditorEvent(event)) return;
        const change = diffText(view.state.doc.toString(), textareaValue.get.call(textarea));
        if (change) view.dispatch({ changes: change, annotations: fromTextarea.of(true) });
    };
    textarea.addEventListener('input', onOutsideInput, true);

    const observer = new MutationObserver((mutations) => {
        applyLook(view, readLook(textarea));
        if (mutations.some(m => m.attributeName === 'placeholder')) {
            view.dispatch({ effects: placeholderSlot.reconfigure(textarea.placeholder ? placeholderExtension(textarea.placeholder) : []) });
        }
    });
    observer.observe(textarea, { attributes: true, attributeFilter: ['style', 'class', 'placeholder'] });

    const tooltipWatcher = new MutationObserver(() => {
        watchTooltips();
        view.dom.dispatchEvent(new Event(OVERLAYS_CHANGED_EVENT, { bubbles: true }));
    });
    const watchTooltips = () => {
        tooltipWatcher.disconnect();
        tooltipWatcher.observe(view.dom, { childList: true });
        for (const tooltip of view.dom.querySelectorAll(':scope > .cm-tooltip')) tooltipWatcher.observe(tooltip, { childList: true });
    };
    watchTooltips();

    let destroyed = false;
    return {
        view,
        compartments,
        takeFocus() {
            if (document.activeElement !== textarea) {
                view.focus();
                return;
            }
            const swallow = (/** @type {Event} */ event) => {
                if (event.target === textarea) event.stopImmediatePropagation();
            };
            window.addEventListener('blur', swallow, true);
            window.addEventListener('focusout', swallow, true);
            movingFocusIn = true;
            try {
                view.focus();
            } finally {
                movingFocusIn = false;
                window.removeEventListener('blur', swallow, true);
                window.removeEventListener('focusout', swallow, true);
            }
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            observer.disconnect();
            tooltipWatcher.disconnect();
            textarea.removeEventListener('input', onOutsideInput, true);
            for (const type of STOPPED) view.dom.removeEventListener(type, stopAtEditor);
            view.contentDOM.removeEventListener('focus', onContentFocus);
            view.contentDOM.removeEventListener('blur', onContentFocus);
            restoreTextarea();
            textarea.classList.remove('live-editor-textarea');
            unregisterMountedEditor(view.dom);
            view.destroy();
            view.dom.remove();
        },
    };
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @returns {{ anchor: number, head: number }}
 */
function initialSelection(textarea) {
    const length = textareaValue.get.call(textarea).length;
    const clamp = (/** @type {number} */ n) => Math.max(0, Math.min(length, Number(n) || 0));
    const start = clamp(textarea.selectionStart);
    const end = clamp(textarea.selectionEnd);
    return textarea.selectionDirection === 'backward' ? { anchor: end, head: start } : { anchor: start, head: end };
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @returns {{ editor: Record<string, string>, content: Record<string, string> }}
 */
function readLook(textarea) {
    const style = getComputedStyle(textarea);
    const read = (/** @type {string[]} */ props) => Object.fromEntries(props.map(p => [p, style.getPropertyValue(p)]));
    const caret = style.getPropertyValue('caret-color');
    const editor = { ...read(COPIED_STYLE), '--live-caret-color': !caret || caret === 'auto' ? style.getPropertyValue('color') : caret };
    return { editor, content: read(COPIED_CONTENT_STYLE) };
}

/**
 * @param {EditorView} view
 * @param {{ editor: Record<string, string>, content: Record<string, string> }} look
 */
function applyLook(view, look) {
    for (const [prop, value] of Object.entries(look.editor)) view.dom.style.setProperty(prop, value);
    for (const [prop, value] of Object.entries(look.content)) view.contentDOM.style.setProperty(prop, value);
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {EditorView} view
 * @returns {() => void}
 */
function proxyTextarea(textarea, view) {
    /** @param {string} text */
    const writeFromCode = (text) => {
        textareaValue.set.call(textarea, text);
        const change = diffText(view.state.doc.toString(), textareaValue.get.call(textarea));
        if (change) view.dispatch({ changes: change, annotations: fromTextarea.of(true) });
    };
    const clamp = (/** @type {number} */ n) => Math.max(0, Math.min(view.state.doc.length, Number(n) || 0));
    /**
     * @param {number} start
     * @param {number} end
     * @param {string} [direction]
     */
    const select = (start, end, direction) => {
        const from = clamp(start);
        const to = Math.max(from, clamp(end));
        view.dispatch({ selection: direction === 'backward' ? { anchor: to, head: from } : { anchor: from, head: to } });
    };

    /** @type {PropertyDescriptorMap} */
    const own = {
        value: {
            configurable: true,
            get: () => textareaValue.get.call(textarea),
            set: (value) => writeFromCode(String(value ?? '')),
        },
        selectionStart: {
            configurable: true,
            get: () => view.state.selection.main.from,
            set: (n) => select(n, Math.max(Number(n), view.state.selection.main.to)),
        },
        selectionEnd: {
            configurable: true,
            get: () => view.state.selection.main.to,
            set: (n) => select(Math.min(Number(n), view.state.selection.main.from), n),
        },
        selectionDirection: {
            configurable: true,
            get: () => (view.state.selection.main.head < view.state.selection.main.anchor ? 'backward' : 'forward'),
            set: (direction) => select(view.state.selection.main.from, view.state.selection.main.to, direction),
        },
        setSelectionRange: {
            configurable: true,
            value: (/** @type {number} */ start, /** @type {number} */ end, /** @type {string} */ direction) => select(start, end, direction),
        },
        select: {
            configurable: true,
            value: () => select(0, view.state.doc.length),
        },
        setRangeText: {
            configurable: true,
            value: (/** @type {string} */ replacement, /** @type {number} */ start, /** @type {number} */ end, /** @type {string} */ selectMode = 'preserve') => {
                const main = view.state.selection.main;
                const from = clamp(start ?? main.from);
                const to = Math.max(from, clamp(end ?? main.to));
                const text = String(replacement);
                view.dispatch({ changes: { from, to, insert: text }, annotations: fromTextarea.of(true) });
                textareaValue.set.call(textarea, view.state.doc.toString());
                if (selectMode === 'select') select(from, from + text.length);
                else if (selectMode === 'start') select(from, from);
                else if (selectMode === 'end') select(from + text.length, from + text.length);
            },
        },
        focus: {
            configurable: true,
            value: () => view.focus(),
        },
        blur: {
            configurable: true,
            value: () => view.contentDOM.blur(),
        },
    };
    Object.defineProperties(textarea, own);

    return () => {
        for (const key of Object.keys(own)) {
            delete textarea[/** @type {keyof HTMLTextAreaElement} */ (key)];
        }
    };
}
