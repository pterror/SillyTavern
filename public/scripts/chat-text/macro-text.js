import { markdownParser, parseMixed } from '../../lib.js';
import { Macros } from './grammar.js';

/** @typedef {import('@lezer/markdown').MarkdownConfig} MarkdownConfig */

/**
 * Literal text uses the Markdown grammar's macro rule without interpreting other Markdown syntax or adding
 * paragraph wrappers. This is shared by HTML text and code.
 * @type {MarkdownConfig}
 */
const literalText = {
    defineNodes: ['LiteralText'],
    remove: ['Escape', 'Entity', 'InlineCode', 'HTMLTag', 'Emphasis', 'HardBreak', 'Link', 'Image', 'Autolink'],
    parseBlock: [{
        name: 'LiteralText',
        parse(cx, line) {
            const from = cx.lineStart;
            let to = from + line.text.length;
            while (cx.nextLine()) to = cx.lineStart + line.text.length;
            // @ts-ignore input is a BlockContext field the published types leave out.
            cx.addElement(cx.elt('LiteralText', from, to, cx.parser.parseInline(cx.input.read(from, to), from)));
            return true;
        },
        before: 'LinkReference',
    }],
};

export const macroText = markdownParser.configure([Macros, literalText]);

/** @type {MarkdownConfig} macros inside code use the same grammar as other text */
export const macrosInCode = {
    wrap: parseMixed(node => {
        if (node.name === 'CodeText') return { parser: macroText, overlay: [{ from: node.from, to: node.to }] };
        if (node.name !== 'InlineCode') return null;
        const open = node.node.firstChild;
        const close = node.node.lastChild;
        return open && close && open.to < close.from
            ? { parser: macroText, overlay: [{ from: open.to, to: close.from }] }
            : null;
    }),
};
