import { definitionOf, markdownLook } from '../../lib.js';
import { htmlAttributeRegex, parseImageSize } from './grammar.js';

/**
 * @typedef {import('@pterror/interact-editor/look').Look} Look
 * @typedef {import('@pterror/interact-editor/look').Piece} Piece
 * @typedef {import('@pterror/interact-editor/look').Read} Read
 * @typedef {import('@pterror/interact-editor/look').Rule} Rule
 * @typedef {import('@lezer/common').SyntaxNode} SyntaxNode
 * @typedef {import('@pterror/interact-markdown/look').Html} Html
 */

/**
 * @typedef {object} LookOptions
 * @property {Html} html the HTML policy
 * @property {Readonly<Record<string, string>>} emojis what each shortcode draws
 * @property {(source: string) => Piece} macro the piece a macro is drawn as
 * @property {readonly string[]} [reasoningMarkers] the reasoning prefix and suffix, drawn as text where they are
 */

const MARK = { class: 'mark', mark: true };

/**
 * @param {string} text
 * @returns {string} what the text reads as, its character references decoded
 */
function decoded(text) {
    if (!text.includes('&')) return text;
    const holder = document.createElement('textarea');
    holder.innerHTML = text;
    return holder.value;
}

/**
 * @param {import('@pterror/interact-markdown/look').HtmlElement} shown
 * @returns {Piece}
 */
function elementPiece(shown) {
    return {
        draw() {
            const made = document.createElement(shown.name);
            for (const [name, value] of Object.entries(shown.attributes)) made.setAttribute(name, value);
            return made;
        },
        same: () => false,
    };
}

/**
 * @param {string} text
 * @returns {Piece}
 */
function textPiece(text) {
    return {
        draw() {
            const made = document.createElement('span');
            made.textContent = text;
            return made;
        },
        same: () => false,
    };
}

/**
 * @param {SyntaxNode} node
 * @param {string} name
 * @param {Read} read
 * @returns {string | undefined}
 */
function childText(node, name, read) {
    const child = node.getChild(name);
    return child ? read(child.from, child.to) : undefined;
}

/**
 * An HTML block with markdown inside, as its policy draws its open tag's element
 * @param {SyntaxNode} block
 * @param {Read} read
 * @param {Html} html
 * @returns {import('@pterror/interact-markdown/look').HtmlElement | undefined}
 */
function markdownBlockElement(block, read, html) {
    const open = block.getChild('HTMLMarkdownTag');
    if (!open) return undefined;
    const tag = read(open.from, open.to).trim();
    const name = /^<([a-zA-Z][\w-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (!name) return undefined;
    /** @type {Record<string, string>} */
    const attributes = {};
    const inside = tag.replace(/^<[^\s/>]+/, '').replace(/\/?>$/, '');
    for (const [, attribute, doubleQuoted, singleQuoted, unquoted] of inside.matchAll(htmlAttributeRegex)) {
        attributes[attribute.toLowerCase()] = decoded(doubleQuoted ?? singleQuoted ?? unquoted ?? '');
    }
    return html(name, attributes, undefined);
}

/**
 * How chat text is drawn: markdown, by the HTML policy, with SillyTavern's own syntax. HTML blocks keep HTML's
 * whitespace (the `html-block` class), since the text is otherwise drawn with its whitespace as written.
 * @param {LookOptions} options
 * @returns {Look}
 */
export function chatLook({ html, emojis, macro, reasoningMarkers = [] }) {
    const base = markdownLook(html);
    const markers = new Set(reasoningMarkers.map(marker => marker.trim()).filter(Boolean));
    /**
     * @param {SyntaxNode} node an HTML element or one of its tags
     * @param {Read} read
     * @returns {boolean} whether it is, or its element opens with, a reasoning marker
     */
    const isMarker = (node, read) => {
        const element = node.name === 'Element' ? node : node.parent?.name === 'Element' ? node.parent : null;
        const opening = element?.firstChild;
        return markers.has(read(node.from, node.to).trim()) || (opening ? markers.has(read(opening.from, opening.to).trim()) : false);
    };
    /**
     * @param {string} selector
     * @returns {(node: SyntaxNode, read: Read) => Rule | undefined} the base rule, but a reasoning marker is drawn as text
     */
    const unlessMarker = (selector) => {
        const rule = base[selector];
        return (node, read) => (isMarker(node, read) ? undefined : typeof rule === 'function' ? rule(node, read) : rule);
    };
    /** @type {Rule} */
    const image = {
        class: 'mark',
        source: 'beside',
        piece: (node, read) => {
            const target = node.getChild('URL') ? node : definitionOf(node, read);
            const src = target ? childText(target, 'URL', read) : undefined;
            const alt = node.getChild('LinkMark');
            const altEnd = alt?.nextSibling;
            const altText = alt && altEnd ? read(alt.to, altEnd.from) : '';
            const title = target ? childText(target, 'LinkTitle', read) : undefined;
            const size = parseImageSize((target ? childText(target, 'ImageSize', read) ?? '' : '').slice(1)) ?? {};
            const shown = html('img', {
                alt: decoded(altText),
                src: src ?? '',
                ...(title === undefined ? {} : { title: decoded(title.slice(1, -1)) }),
                ...size,
            }, undefined);
            if (src === undefined || shown === undefined) return undefined;
            const sized = 'width' in shown.attributes || 'height' in shown.attributes || 'hidden' in shown.attributes;
            return elementPiece({ ...shown, attributes: { ...shown.attributes, ...(sized ? {} : { 'data-unsized': '' }) } });
        },
    };
    return {
        ...base,
        CloseTag: unlessMarker('CloseTag'),
        Element: unlessMarker('Element'),
        MismatchedCloseTag: unlessMarker('MismatchedCloseTag'),
        OpenTag: unlessMarker('OpenTag'),
        SelfClosingTag: unlessMarker('SelfClosingTag'),
        CodeText: { element: 'code', class: 'hljs' },
        DialogueQuote: { element: 'q' },
        Emoji: {
            class: 'emoji-source',
            source: 'beside',
            piece: (node, read) => {
                const emoji = emojis[read(node.from + 1, node.to - 1)];
                return emoji === undefined ? undefined : textPiece(emoji);
            },
        },
        CommentBlock: { block: true, element: 'div', class: 'html-block' },
        HTMLBlock: { block: true, element: 'div', class: 'html-block' },
        HTMLMarkdownBlock: (node, read) => {
            const shown = markdownBlockElement(node, read, html);
            return shown && { block: true, element: shown.name, attributes: () => shown.attributes };
        },
        HTMLMarkdownTag: (node, read) => (node.parent && markdownBlockElement(node.parent, read, html) ? MARK : undefined),
        Image: image,
        ImageSize: MARK,
        Macro: {
            source: 'replaced',
            piece: (node, read, surface) => (surface === 'reader' ? macro(read(node.from, node.to)) : undefined),
        },
        MacroMark: MARK,
        ReasoningMarkerLine: { block: true, element: 'p' },
    };
}
