import { htmlParser, markdownParser, parseMixed } from '../../lib.js';
import { Macros } from './grammar.js';

/**
 * @typedef {import('@lezer/markdown').MarkdownConfig} MarkdownConfig
 * @typedef {import('@lezer/common').SyntaxNode} SyntaxNode
 */

/**
 * HTML text uses the Markdown grammar's macro rule. Other Markdown syntax stays literal unless the enclosing
 * element asks for Markdown. HTMLText has no paragraph wrapper, preserving the element's HTML structure.
 * @type {MarkdownConfig}
 */
const htmlText = {
    defineNodes: ['HTMLText'],
    remove: ['Escape', 'Entity', 'InlineCode', 'HTMLTag', 'Emphasis', 'HardBreak', 'Link', 'Image', 'Autolink'],
    parseBlock: [{
        name: 'HTMLText',
        parse(cx, line) {
            const from = cx.lineStart;
            let to = from + line.text.length;
            while (cx.nextLine()) to = cx.lineStart + line.text.length;
            // @ts-ignore input is a BlockContext field the published types leave out.
            cx.addElement(cx.elt('HTMLText', from, to, cx.parser.parseInline(cx.input.read(from, to), from)));
            return true;
        },
        before: 'LinkReference',
    }],
};

const macroText = markdownParser.configure([Macros, htmlText]);

const html = htmlParser.configure({
    wrap: parseMixed(node => (node.name === 'Text' && node.from < node.to ? { parser: macroText } : null)),
});

const NOT_HOSTS = new Set(['CodeBlock', 'FencedCode', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock']);

/**
 * @param {SyntaxNode} node
 * @returns {{ from: number, to: number }[]} the ranges of the HTML tags under the node, in order
 */
function tagsUnder(node) {
    /** @type {{ from: number, to: number }[]} */
    const tags = [];
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
        if (child.name === 'HTMLTag') tags.push({ from: child.from, to: child.to });
        else tags.push(...tagsUnder(child));
    }
    return tags;
}

/**
 * HTML inside chat text, parsed by `@lezer/html` with the macros in its text: the HTML tags of one leaf block are
 * mounted as one overlay, an HTML block is an overlay over itself
 * @type {MarkdownConfig}
 */
export const htmlInChatText = {
    wrap: parseMixed((node) => {
        if (node.name === 'HTMLBlock' || node.name === 'CommentBlock') return { overlay: [{ from: node.from, to: node.to }], parser: html };
        const tags = node.type.is('LeafBlock') && !NOT_HOSTS.has(node.name) ? tagsUnder(node.node) : [];
        return tags.length === 0 ? null : { overlay: tags, parser: html };
    }),
};
