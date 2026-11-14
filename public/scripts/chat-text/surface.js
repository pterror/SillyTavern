import { GFM, htmlInMarkdown, markdownParser, reader } from '../../lib.js';
import { EMOJIS } from '../emojis.js';
import { handledInside } from '../interactive-content.js';
import { fadeIn } from './fade-in.js';
import { chatMarkdownExtensions } from './grammar.js';
import { codeHighlighting } from './highlight.js';
import { chatLook } from './look.js';

/**
 * @typedef {import('@pterror/interact-editor/reader').Overlay} Overlay
 * @typedef {import('@pterror/interact-editor/reader').Reader} Reader
 * @typedef {import('@pterror/interact-editor/look').Piece} Piece
 * @typedef {import('@pterror/interact-markdown/look').Html} Html
 * @typedef {import('./grammar.js').GrammarOptions} GrammarOptions
 */

/**
 * How a kind of text is drawn
 * @typedef {object} TextSetup
 * @property {string} key what tells this setup from another; a container's reader is made again when it changes
 * @property {Omit<GrammarOptions, 'emojis'>} grammar
 * @property {Html} html
 * @property {(source: string) => Piece} macro
 * @property {() => Overlay[]} [overlays] the overlays of a reader made for a container
 */

export const TEXT_CLASS = 'chat-text';

/** @type {Map<string, import('@lezer/markdown').MarkdownParser>} */
const grammars = new Map();

/**
 * @param {Omit<GrammarOptions, 'emojis'>} options
 * @returns {import('@lezer/markdown').MarkdownParser}
 */
export function grammarOf(options) {
    const key = JSON.stringify([options.dialogueQuotes, options.encodeTags, options.escapeLines, options.reasoningMarkers]);
    let grammar = grammars.get(key);
    if (!grammar) {
        grammar = markdownParser.configure([
            GFM,
            ...(options.encodeTags ? [] : [htmlInMarkdown]),
            ...chatMarkdownExtensions({ ...options, emojis: EMOJIS }),
        ]);
        grammars.set(key, grammar);
    }
    return grammar;
}

/**
 * @param {TextSetup} setup
 * @param {Overlay[]} overlays
 * @returns {Reader}
 */
function readerOf(setup, overlays) {
    const made = reader({
        grammar: grammarOf(setup.grammar),
        look: lookOf(setup),
        overlays: [codeHighlighting, ...overlays],
        textClass: TEXT_CLASS,
    });
    readers.set(made.element, made);
    return made;
}

/**
 * How a kind of text is drawn, for reading and, with the pieces macros are drawn as there, for editing
 * @param {TextSetup} setup
 * @param {(source: string) => Piece | undefined} [pill] the piece a macro is drawn as in an editor
 * @returns {import('@pterror/interact-editor/look').Look}
 */
export function lookOf(setup, pill) {
    return chatLook({ html: setup.html, emojis: EMOJIS, macro: setup.macro, pill, reasoningMarkers: setup.grammar.reasoningMarkers });
}

/** @type {WeakMap<Node, Reader>} each reader, by the element it draws into */
const readers = new WeakMap();

/**
 * The source position of a place in text a reader drew
 * @param {Node} node
 * @param {number} offset an offset in the node, as a DOM selection gives
 * @returns {number | undefined} the position in the text, or none outside any reader's text
 */
export function sourcePositionAt(node, offset) {
    for (let at = /** @type {Node | null} */ (node); at; at = at.parentNode) {
        const drawnBy = readers.get(at);
        if (drawnBy) return drawnBy.positionAt(node, offset);
    }
    return undefined;
}

/**
 * @param {MouseEvent} event
 * @returns {{ node: Node, offset: number } | null} the place in the page under the pointer
 */
function caretAt(event) {
    // @ts-ignore Firefox
    if (document.caretPositionFromPoint) {
        // @ts-ignore
        const position = document.caretPositionFromPoint(event.clientX, event.clientY);
        return position ? { node: position.offsetNode, offset: position.offset } : null;
    }
    if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
        return range ? { node: range.startContainer, offset: range.startOffset } : null;
    }
    return null;
}

/**
 * Where in its source a click or double-click on read text starts an edit: the source position the reader drew there.
 * A click that something else handles starts none: one a handler marked with `preventDefault`, which it does before
 * this runs, or one on interactive content inside the text. Nor does a click when click to edit is off or text is
 * selected.
 * @param {MouseEvent} event
 * @param {HTMLElement} rendered the element the text is read in
 * @param {boolean} clickToEdit
 * @returns {number | null}
 */
export function editPosition(event, rendered, clickToEdit) {
    if (event.defaultPrevented) return null;
    if (event.type === 'click' && (!clickToEdit || window.getSelection()?.toString())) return null;
    if (handledInside(event.target, rendered)) return null;
    const caret = caretAt(event);
    if (!caret || !rendered.contains(caret.node)) return 0;
    return sourcePositionAt(caret.node, caret.offset) ?? 0;
}

/**
 * Where the reader's selection in a text is, as source positions: what an edit opened from it starts selected
 * @param {Element} rendered the element the text is read in
 * @returns {{ from: number, to: number } | undefined} the range, none when nothing in the text is selected
 */
export function readerSelection(rendered) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) return undefined;
    if (!rendered.contains(selection.anchorNode) || !rendered.contains(selection.focusNode)) return undefined;
    const anchor = sourcePositionAt(selection.anchorNode, selection.anchorOffset);
    const focus = sourcePositionAt(selection.focusNode, selection.focusOffset);
    if (anchor === undefined || focus === undefined) return undefined;
    return { from: Math.min(anchor, focus), to: Math.max(anchor, focus) };
}

/** @type {WeakMap<Element, { key: string, reader: Reader, fade: ReturnType<typeof fadeIn>, text: string }>} */
const shown = new WeakMap();

/**
 * Shows a text in a container through the reader it keeps there, drawing only what changed since it last showed one.
 * @param {Element} container
 * @param {string} text
 * @param {TextSetup} setup
 * @param {{ fade?: boolean }} [options] fade: the text is a streamed reply, and what it adds fades in
 * @returns {Reader}
 */
export function showText(container, text, setup, { fade = false } = {}) {
    let held = shown.get(container);
    if (!held || held.key !== setup.key) {
        held?.reader.stop();
        const fader = fadeIn();
        held = { key: setup.key, reader: readerOf(setup, [fader, ...(setup.overlays?.() ?? [])]), fade: fader, text: '' };
        shown.set(container, held);
    }
    if (fade) {
        let start = 0;
        while (start < held.text.length && start < text.length && held.text[start] === text[start]) start++;
        held.fade.added(start, text.length);
    }
    held.text = text;
    held.reader.show(text);
    if (container.firstChild !== held.reader.element || container.childNodes.length !== 1) {
        container.replaceChildren(held.reader.element);
    }
    return held.reader;
}

/**
 * Takes a container's reader out, as when the container shows something else
 * @param {Element} container
 */
export function stopText(container) {
    shown.get(container)?.reader.stop();
    shown.delete(container);
}

/**
 * @param {string} source
 * @returns {Piece} a macro drawn as written
 */
function writtenMacro(source) {
    return {
        draw() {
            const made = document.createElement('span');
            made.textContent = source;
            return made;
        },
        same: () => false,
    };
}

/** @type {TextSetup} plain text with markdown: no HTML, macros as written */
export const PLAIN_TEXT = { key: 'plain', grammar: { encodeTags: true }, html: () => undefined, macro: writtenMacro };

/**
 * A reader of its own for a kind of text, for a place that keeps it
 * @param {TextSetup} setup
 * @returns {Reader}
 */
export function textReader(setup) {
    return readerOf(setup, setup.overlays?.() ?? []);
}

/**
 * A text drawn once, for a place that shows it and never updates it
 * @param {string} text
 * @param {TextSetup} setup
 * @returns {HTMLElement}
 */
export function drawnText(text, setup) {
    const drawn = readerOf(setup, setup.overlays?.() ?? []);
    drawn.show(text);
    return drawn.element;
}
