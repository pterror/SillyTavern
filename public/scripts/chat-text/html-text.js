import { htmlParser, NodeType, Parser, parseMixed, Tree } from '../../lib.js';
import { macroSpans } from './grammar.js';

/**
 * @typedef {import('@lezer/markdown').MarkdownConfig} MarkdownConfig
 * @typedef {import('@lezer/common').SyntaxNode} SyntaxNode
 */

const [TOP, MACRO, BLOCK_TAG, MARK] = ['HTMLText', 'Macro', 'MacroBlockTag', 'MacroMark'].map((name, id) => NodeType.define({ id, name, top: id === 0 }));

/** The text of an HTML element: each `{{…}}` in it a `Macro` or `MacroBlockTag` with its two `MacroMark`s */
class MacroTextParser extends Parser {
    /**
     * @param {import('@lezer/common').Input} input
     * @param {readonly import('@lezer/common').TreeFragment[]} _fragments
     * @param {readonly { from: number, to: number }[]} ranges
     * @returns {import('@lezer/common').PartialParse}
     */
    createParse(input, _fragments, ranges) {
        const from = ranges[0].from;
        const to = ranges[ranges.length - 1].to;
        let parsed = from;
        return {
            get parsedPos() {
                return parsed;
            },
            stoppedAt: null,
            stopAt() {},
            advance() {
                parsed = to;
                /** @type {Tree[]} */
                const children = [];
                /** @type {number[]} */
                const positions = [];
                for (const span of macroSpans(input.read(from, to))) {
                    const length = span.to - span.from;
                    const marks = [new Tree(MARK, [], [], 2), new Tree(MARK, [], [], 2)];
                    children.push(new Tree(span.blockTag ? BLOCK_TAG : MACRO, marks, [0, length - 2], length));
                    positions.push(span.from);
                }
                return new Tree(TOP, children, positions, to - from);
            },
        };
    }
}

const macroText = new MacroTextParser();

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
 * mounted as one overlay, an HTML block is an overlay over itself (as interact-markdown's `htmlInMarkdown`, whose HTML
 * parser can't be given one that parses macros)
 * @type {MarkdownConfig}
 */
export const htmlInChatText = {
    wrap: parseMixed((node) => {
        if (node.name === 'HTMLBlock' || node.name === 'CommentBlock') return { overlay: [{ from: node.from, to: node.to }], parser: html };
        const tags = node.type.is('LeafBlock') && !NOT_HOSTS.has(node.name) ? tagsUnder(node.node) : [];
        return tags.length === 0 ? null : { overlay: tags, parser: html };
    }),
};
