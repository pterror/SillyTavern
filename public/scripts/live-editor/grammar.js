// The editor's markdown grammar: @lezer/markdown configured to read text the way chat's `marked` setup does
// (marked-processor.js: gfm and breaks, plus its extensions) and messageFormatting's dialogue quotes, with a node for
// each macro. The parity test (tests/live-editor-grammar.test.js) holds the two together.

import { lezerMarkdown, lezerHighlight } from '../../live-editor-lib.js';

const { parser: commonmarkParser, Table, TaskList } = lezerMarkdown;
const { tags } = lezerHighlight;

/**
 * @typedef {object} GrammarOptions
 * @property {Record<string, string>} [emojis] The `:name:` shortcodes chat shows as emoji (showdown's set).
 * @property {boolean} [dialogueQuotes] Mark quoted dialogue, as messageFormatting wraps it in `<q>`.
 * @property {boolean} [encodeTags] HTML is shown as text, not parsed (messageFormatting with `encode_tags`).
 * @property {string[]} [escapeLines] Lines kept as plain text (`markdown_escape_strings`, already substituted).
 */

// ---- Autolinks, as marked's `url` rule with marked-processor.js's trailing-`_` change. ----

const urlStartRegex = /(?:(?:ftp|https?):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/y;
const emailRegex = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/y;
const urlBackpedal = /(?:[^?!.,:;*'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*'"~)]+(?!$))+/;

/** @type {import('@lezer/markdown').MarkdownConfig} */
const MarkedAutolink = {
    parseInline: [{
        name: 'Autolink',
        parse(cx, next, absPos) {
            // Only where a URL or an address can start: a letter, digit or one of the address characters.
            if (!/[A-Za-z0-9._+-]/.test(String.fromCharCode(next))) return -1;
            const pos = absPos - cx.offset;
            urlStartRegex.lastIndex = pos;
            const url = urlStartRegex.exec(cx.text);
            if (url) {
                let text = url[0];
                let previous;
                do {
                    previous = text;
                    text = urlBackpedal.exec(text)?.[0] ?? '';
                } while (previous !== text);
                if (!text) return -1;
                return cx.addElement(cx.elt('URL', absPos, absPos + text.length));
            }
            if (pos > 0 && /[A-Za-z0-9._+-]/.test(cx.text[pos - 1])) return -1;
            emailRegex.lastIndex = pos;
            const email = emailRegex.exec(cx.text);
            if (!email) return -1;
            return cx.addElement(cx.elt('URL', absPos, absPos + email[0].length));
        },
        before: 'Link',
    }],
};

// ---- Strikethrough, as marked's `del`: `~text~` and `~~text~~`. ----

const StrikeOne = { resolve: 'Strikethrough', mark: 'StrikethroughMark' };
const StrikeTwo = { resolve: 'Strikethrough', mark: 'StrikethroughMark' };

/** @type {import('@lezer/markdown').MarkdownConfig} */
const MarkedStrikethrough = {
    defineNodes: [
        { name: 'Strikethrough', style: { 'Strikethrough/...': tags.strikethrough } },
        { name: 'StrikethroughMark', style: tags.processingInstruction },
    ],
    parseInline: [{
        name: 'Strikethrough',
        parse(cx, next, pos) {
            if (next !== 126) return -1;
            let end = pos;
            while (cx.char(end) === 126) end++;
            const length = end - pos;
            if (length > 2) return -1;
            const before = cx.slice(pos - 1, pos);
            const after = cx.slice(end, end + 1);
            const canOpen = after !== '' && !/\s|~/.test(after);
            const canClose = before !== '' && !/\s|~/.test(before);
            return cx.addDelimiter(length === 1 ? StrikeOne : StrikeTwo, pos, end, canOpen, canClose);
        },
        after: 'Emphasis',
    }],
};

// ---- HTML blocks kept whole, as marked-processor.js's `htmlBlockExt`. ----

const HTML_BLOCK_TAGS = [
    'pre', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'dl', 'ol', 'ul', 'script', 'noscript',
    'form', 'fieldset', 'iframe', 'math', 'style', 'section', 'header', 'footer', 'nav', 'article', 'aside', 'address',
    'audio', 'canvas', 'figure', 'hgroup', 'output', 'video', 'p',
];
const HTML_BLOCK_TAG_NAMES = `(?:${HTML_BLOCK_TAGS.join('|')})(?=[\\s/>])`;
const htmlBlockOpenRegex = new RegExp(`^ {0,3}<(${HTML_BLOCK_TAG_NAMES})[^>]*>`, 'i');
const htmlAttributeRegex = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * @param {string} src Text from the start of a line.
 * @returns {{ length: number, openLength: number, closeFrom: number } | null} The block's length (its last line's
 * newline not included), its opening tag's length and where its closing tag starts.
 */
function matchHtmlBlock(src) {
    const open = htmlBlockOpenRegex.exec(src);
    if (!open) return null;
    const tagRegex = new RegExp(`<(/?)${open[1]}(?=[\\s/>])[^>]*>`, 'gi');
    tagRegex.lastIndex = open[0].length;
    let depth = 1;
    let tag;
    while ((tag = tagRegex.exec(src))) {
        depth += tag[1] ? -1 : 1;
        if (depth === 0) {
            const lineEnd = /^[ \t]*/.exec(src.slice(tagRegex.lastIndex))?.[0] ?? '';
            return { length: tagRegex.lastIndex + lineEnd.length, openLength: open[0].length, closeFrom: tag.index };
        }
    }
    return null;
}

/** @param {string} openTag @returns {boolean} */
function hasMarkdownAttribute(openTag) {
    const attributes = openTag.trimStart().replace(/^<[^\s/>]+/, '').replace(/\/?>$/, '');
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of attributes.matchAll(htmlAttributeRegex)) {
        if (name.toLowerCase() === 'markdown') return (doubleQuoted ?? singleQuoted ?? unquoted) !== '0';
    }
    return false;
}

/**
 * The rest of the document from the current line's content.
 * @param {import('@lezer/markdown').BlockContext} cx
 * @param {import('@lezer/markdown').Line} line
 */
function restFromLine(cx, line) {
    // @ts-ignore input is a BlockContext field the published types leave out.
    return cx.input.read(cx.lineStart + line.pos, cx.input.length);
}

/** @type {WeakMap<object, Set<number>>} Per parse, where the closing tag of a `markdown="1"` block starts. */
const pendingCloses = new WeakMap();

/** @type {import('@lezer/markdown').MarkdownConfig} */
const KeptHtmlBlocks = {
    parseBlock: [{
        name: 'KeptHTMLBlock',
        parse(cx, line) {
            const from = cx.lineStart + line.pos;
            // @ts-ignore
            const closes = pendingCloses.get(cx.input);
            if (closes?.has(from)) {
                closes.delete(from);
                cx.addElement(cx.elt('HTMLBlock', from, cx.lineStart + line.text.length));
                cx.nextLine();
                return true;
            }
            if (line.next !== 60) return false;
            const src = restFromLine(cx, line);
            const block = matchHtmlBlock(src);
            if (!block) return false;
            const openTag = src.slice(0, block.openLength);
            const openLineLength = line.text.length - line.pos;
            const closeOnOwnLine = /\n[ \t]*$/.test(src.slice(0, block.closeFrom)) || block.closeFrom === 0;
            if (hasMarkdownAttribute(openTag) && block.openLength === openLineLength && closeOnOwnLine) {
                // The inside is markdown: the opening and closing lines are HTML, what's between parses as usual.
                // @ts-ignore
                const set = pendingCloses.get(cx.input) ?? new Set();
                set.add(from + block.closeFrom);
                // @ts-ignore
                pendingCloses.set(cx.input, set);
                cx.addElement(cx.elt('HTMLBlock', from, from + openLineLength));
                cx.nextLine();
                return true;
            }
            const end = from + block.length;
            while (cx.lineStart + line.text.length < end && cx.nextLine()) { /* consume the block's lines */ }
            cx.addElement(cx.elt('HTMLBlock', from, Math.min(end, cx.lineStart + line.text.length)));
            cx.nextLine();
            return true;
        },
        // marked starts one wherever a line opens it, even in the middle of a paragraph.
        endLeaf(cx, line) {
            return line.next === 60 && matchHtmlBlock(restFromLine(cx, line)) !== null;
        },
        before: 'HTMLBlock',
    }],
};

// ---- Image sizes, as marked-processor.js's `imageSizeExt`: `![alt](url =WxH)` and `[id]: url =WxH`. ----

const IMAGE_SIZE_UNITS = ['px', '%', 'em', 'rem', 'vw', 'vh', 'ch', 'ex', 'pt', 'pc', 'cm', 'mm', 'in'];
const imageSizeSideRegex = new RegExp(
    `^(?:\\*|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:${[...IMAGE_SIZE_UNITS].sort((a, b) => b.length - a.length).join('|')})?)`,
    'i',
);

/** @param {string} size The text after `=`. @returns {boolean} */
function isImageSize(size) {
    const width = imageSizeSideRegex.exec(size)?.[0] ?? '';
    let rest = size.slice(width.length);
    let height = '';
    if (rest.startsWith('x')) {
        height = imageSizeSideRegex.exec(rest.slice(1))?.[0] ?? '';
        rest = rest.slice(1 + height.length);
    }
    return rest === '' && Boolean(width || height);
}

const TITLE = String.raw`(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^()\\])*\))`;
const DESTINATION = String.raw`(?:<(?:\\.|[^\n<>\\])*>|(?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+?)`;
const sizedImageRegex = new RegExp(String.raw`!\[((?:\\[\s\S]|[^\[\]\\])*)\]\([ \t]*(${DESTINATION})( =[^\s"'()]*)(?:\s+(${TITLE}))?\s*\)`, 'dy');
const sizedDefinitionRegex = new RegExp(String.raw`^ {0,3}\[((?:\\[\s\S]|[^\[\]\\])+)\]:[ \t]*(${DESTINATION})( =[^\s"'()]*)(?:[ \t]+(${TITLE}))?[ \t]*$`, 'd');

/** @type {import('@lezer/markdown').MarkdownConfig} */
const ImageSizes = {
    defineNodes: [{ name: 'ImageSize', style: tags.attributeValue }],
    parseInline: [{
        name: 'SizedImage',
        parse(cx, next, absPos) {
            if (next !== 33 || cx.char(absPos + 1) !== 91) return -1;
            sizedImageRegex.lastIndex = absPos - cx.offset;
            const match = sizedImageRegex.exec(cx.text);
            if (!match || !isImageSize(match[3].slice(2))) return -1;
            const at = (/** @type {number} */ group) => match.indices[group].map(i => i + cx.offset);
            const [altFrom, altTo] = at(1);
            const [urlFrom, urlTo] = at(2);
            const [sizeFrom, sizeTo] = at(3);
            const end = absPos + match[0].length;
            const children = [
                cx.elt('LinkMark', absPos, absPos + 2),
                cx.elt('LinkMark', altTo, altTo + 1),
                cx.elt('LinkMark', altTo + 1, altTo + 2),
                cx.elt('URL', urlFrom, urlTo),
                cx.elt('ImageSize', sizeFrom + 1, sizeTo),
                ...(match[4] ? [cx.elt('LinkTitle', ...at(4))] : []),
                cx.elt('LinkMark', end - 1, end),
            ];
            void altFrom;
            return cx.addElement(cx.elt('Image', absPos, end, children));
        },
        before: 'Link',
    }],
    parseBlock: [{
        name: 'SizedLinkReference',
        parse(cx, line) {
            if (line.next !== 91 && !/^ {1,3}\[/.test(line.text)) return false;
            const match = sizedDefinitionRegex.exec(line.text);
            if (!match || !isImageSize(match[3].slice(2))) return false;
            const at = (/** @type {number} */ group) => match.indices[group].map(i => i + cx.lineStart);
            const [labelFrom, labelTo] = at(1);
            const children = [
                cx.elt('LinkLabel', labelFrom - 1, labelTo + 1),
                cx.elt('LinkMark', labelTo + 1, labelTo + 2),
                cx.elt('URL', ...at(2)),
                cx.elt('ImageSize', at(3)[0] + 1, at(3)[1]),
                ...(match[4] ? [cx.elt('LinkTitle', ...at(4))] : []),
            ];
            cx.addElement(cx.elt('LinkReference', cx.lineStart + line.pos, cx.lineStart + line.text.length, children));
            cx.nextLine();
            return true;
        },
        before: 'LinkReference',
    }],
};

// ---- Emoji shortcodes, as marked-processor.js's `emojiExt`. ----

/**
 * @param {Record<string, string>} emojis
 * @returns {import('@lezer/markdown').MarkdownConfig}
 */
function emojiShortcodes(emojis) {
    const shortcodeRegex = /:([^\s:]+):/y;
    return {
        defineNodes: [{ name: 'Emoji', style: tags.character }],
        parseInline: [{
            name: 'Emoji',
            parse(cx, next, absPos) {
                if (next !== 58) return -1;
                shortcodeRegex.lastIndex = absPos - cx.offset;
                const match = shortcodeRegex.exec(cx.text);
                if (!match || !Object.hasOwn(emojis, match[1])) return -1;
                return cx.addElement(cx.elt('Emoji', absPos, absPos + match[0].length));
            },
        }],
    };
}

// ---- Dialogue quotes, as messageFormatting's `quoteRegex`: each style closes on the same line, shortest first. ----

const QUOTE_PAIRS = { '"': '"', '“': '”', '«': '»', '「': '」', '『': '』', '＂': '＂' };
const QuoteDelim = { resolve: 'DialogueQuote', mark: 'DialogueQuoteMark' };

/** @type {WeakMap<object, Set<number>>} Per inline section, where a quote that has opened closes. */
const quoteCloses = new WeakMap();

/** @type {import('@lezer/markdown').MarkdownConfig} */
const DialogueQuotes = {
    defineNodes: [
        { name: 'DialogueQuote', style: { 'DialogueQuote/...': tags.quote } },
        { name: 'DialogueQuoteMark', style: tags.quote },
    ],
    parseInline: [{
        name: 'DialogueQuote',
        parse(cx, next, absPos) {
            const char = String.fromCharCode(next);
            let closes = quoteCloses.get(cx);
            if (closes?.has(absPos)) {
                closes.delete(absPos);
                return cx.addDelimiter(QuoteDelim, absPos, absPos + 1, false, true);
            }
            const close = QUOTE_PAIRS[char];
            if (!close) return -1;
            const pos = absPos - cx.offset;
            const lineEnd = cx.text.indexOf('\n', pos + 1);
            const closeAt = cx.text.slice(pos + 1, lineEnd === -1 ? undefined : lineEnd).indexOf(close);
            if (closeAt === -1) return -1;
            if (!closes) {
                closes = new Set();
                quoteCloses.set(cx, closes);
            }
            closes.add(absPos + 1 + closeAt);
            return cx.addDelimiter(QuoteDelim, absPos, absPos + 1, true, false);
        },
        before: 'Emphasis',
    }],
};

// ---- Macros: `{{…}}`, nested macros included, as one node, so the editor knows each macro's range. ----

/** @type {import('@lezer/markdown').MarkdownConfig} */
const Macros = {
    defineNodes: [
        { name: 'Macro', style: { 'Macro/...': tags.special(tags.variableName) } },
        { name: 'MacroMark', style: tags.processingInstruction },
    ],
    parseInline: [{
        name: 'Macro',
        parse(cx, next, absPos) {
            if (next !== 123 || cx.char(absPos + 1) !== 123) return -1;
            let depth = 0;
            for (let pos = absPos; pos < cx.end - 1; pos++) {
                const a = cx.char(pos);
                const b = cx.char(pos + 1);
                if (a === 123 && b === 123) {
                    depth++;
                    pos++;
                } else if (a === 125 && b === 125) {
                    depth--;
                    pos++;
                    if (depth === 0) {
                        const end = pos + 1;
                        return cx.addElement(cx.elt('Macro', absPos, end, [
                            cx.elt('MacroMark', absPos, absPos + 2),
                            cx.elt('MacroMark', end - 2, end),
                        ]));
                    }
                } else if (a === 10 && depth > 0 && cx.char(pos + 1) === 10) {
                    return -1;
                }
            }
            return -1;
        },
        before: 'Escape',
    }],
};

// ---- Lines kept as plain text (`markdown_escape_strings`). ----

/**
 * @param {string[]} lines
 * @returns {import('@lezer/markdown').MarkdownConfig}
 */
function escapedLines(lines) {
    const set = new Set(lines.filter(Boolean));
    return {
        parseBlock: [{
            name: 'EscapedLine',
            parse(cx, line) {
                if (line.pos !== 0 || !set.has(line.text)) return false;
                cx.addElement(cx.elt('Paragraph', cx.lineStart, cx.lineStart + line.text.length));
                cx.nextLine();
                return true;
            },
            before: 'Blockquote',
        }],
    };
}

/**
 * The extensions for @lezer/markdown that make it read text as chat's markdown does.
 * @param {GrammarOptions} [options]
 * @returns {import('@lezer/markdown').MarkdownConfig[]}
 */
export function chatMarkdownExtensions(options = {}) {
    return [
        Table,
        TaskList,
        MarkedStrikethrough,
        MarkedAutolink,
        ...(options.encodeTags ? [] : [KeptHtmlBlocks]),
        ImageSizes,
        Macros,
        ...(options.emojis ? [emojiShortcodes(options.emojis)] : []),
        ...(options.dialogueQuotes ? [DialogueQuotes] : []),
        ...(options.escapeLines?.length ? [escapedLines(options.escapeLines)] : []),
        ...(options.encodeTags ? [{ remove: ['HTMLBlock', 'HTMLTag'] }] : []),
    ];
}

/**
 * @param {GrammarOptions} [options]
 * @returns {import('@lezer/markdown').MarkdownParser}
 */
export function chatMarkdownParser(options = {}) {
    return commonmarkParser.configure(chatMarkdownExtensions(options));
}
