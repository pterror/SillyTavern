import { lezerMarkdown, lezerHighlight } from '../../live-editor-lib.js';
import { chatMarkdownExtensions as chatSyntax } from '../chat-text/grammar.js';

const { parser: commonmarkParser, Table, TaskList } = lezerMarkdown;
const { styleTags, tags } = lezerHighlight;

/**
 * @typedef {import('../chat-text/grammar.js').GrammarOptions} GrammarOptions
 */

const chatStyles = {
    props: [styleTags({
        'Strikethrough/...': tags.strikethrough,
        StrikethroughMark: tags.processingInstruction,
        ImageSize: tags.attributeValue,
        Emoji: tags.character,
        'DialogueQuote/...': tags.quote,
        DialogueQuoteMark: tags.quote,
        'Macro/...': tags.special(tags.variableName),
        MacroMark: tags.processingInstruction,
    })],
};

/**
 * @param {GrammarOptions} [options]
 * @returns {import('@lezer/markdown').MarkdownConfig[]}
 */
export function chatMarkdownExtensions(options = {}) {
    return [Table, TaskList, ...chatSyntax(options), chatStyles];
}

/**
 * @param {GrammarOptions} [options]
 * @returns {import('@lezer/markdown').MarkdownParser}
 */
export function chatMarkdownParser(options = {}) {
    return commonmarkParser.configure(chatMarkdownExtensions(options));
}
