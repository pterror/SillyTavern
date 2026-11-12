import { markdownGrammar, reader } from '../../lib.js';
import { EMOJIS } from '../emojis.js';
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

const TEXT_CLASS = 'chat-text';

/** @type {Map<string, import('@lezer/markdown').MarkdownParser>} */
const grammars = new Map();

/**
 * @param {Omit<GrammarOptions, 'emojis'>} options
 * @returns {import('@lezer/markdown').MarkdownParser}
 */
function grammarOf(options) {
    const key = JSON.stringify([options.dialogueQuotes, options.encodeTags, options.escapeLines, options.reasoningMarkers]);
    let grammar = grammars.get(key);
    if (!grammar) {
        grammar = markdownGrammar(chatMarkdownExtensions({ ...options, emojis: EMOJIS }));
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
        look: chatLook({ html: setup.html, emojis: EMOJIS, macro: setup.macro }),
        overlays: [codeHighlighting, ...overlays],
        textClass: TEXT_CLASS,
    });
    readers.set(made.element, made);
    return made;
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
