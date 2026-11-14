/**
 * SillyTavern's syntax over markdown, as `@lezer/markdown` extensions: macros, emoji shortcodes, dialogue quotes, image
 * sizes, lines kept out of markdown, reasoning markers drawn as text, HTML blocks (whole, or with markdown inside when
 * they carry a `markdown` attribute), and bare URLs and `~` strikethrough as chat text writes them. The extensions use
 * only the parse context they are handed, so the live editor's own copy of `@lezer/markdown` takes them too.
 */

/**
 * @typedef {import('@lezer/markdown').MarkdownConfig} MarkdownConfig
 * @typedef {import('@lezer/markdown').BlockContext} BlockContext
 * @typedef {import('@lezer/markdown').Line} Line
 */

/**
 * @typedef {object} GrammarOptions
 * @property {Readonly<Record<string, string>>} [emojis] the shortcodes drawn as emoji
 * @property {boolean} [dialogueQuotes] whether quoted speech is a node
 * @property {boolean} [encodeTags] HTML is shown as text: no HTML nodes
 * @property {readonly string[]} [escapeLines] lines that, written exactly, are a paragraph of plain text
 * @property {readonly string[]} [reasoningMarkers] the reasoning prefix and suffix, drawn as text where a body has them
 */

const urlStartRegex = /(?:(?:ftp|https?):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/y;
const emailRegex = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/y;
const urlBackpedal = /(?:[^?!.,:;*'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*'"~)]+(?!$))+/;

/** @type {MarkdownConfig} */
const BareUrls = {
    parseInline: [{
        name: 'Autolink',
        parse(cx, next, absPos) {
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

const STRIKE_PUNCTUATION = /(?!~)[\p{P}\p{S}]/u;
const StrikeOne = { resolve: 'Strikethrough', mark: 'StrikethroughMark' };
const StrikeTwo = { resolve: 'Strikethrough', mark: 'StrikethroughMark' };

/** @type {MarkdownConfig} */
const Strikethrough = {
    defineNodes: ['Strikethrough', 'StrikethroughMark'],
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
            const spaceBefore = before === '' || /\s/u.test(before);
            const spaceAfter = after === '' || /\s/u.test(after);
            const punctBefore = STRIKE_PUNCTUATION.test(before);
            const punctAfter = STRIKE_PUNCTUATION.test(after);
            const canOpen = !spaceAfter && after !== '~' && (!punctAfter || spaceBefore || punctBefore);
            const canClose = !spaceBefore && before !== '~' && (!punctBefore || spaceAfter || punctAfter);
            return cx.addDelimiter(length === 1 ? StrikeOne : StrikeTwo, pos, end, canOpen, canClose);
        },
        after: 'Emphasis',
    }],
};

const HTML_BLOCK_TAGS = [
    'pre', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'dl', 'ol', 'ul', 'script', 'noscript',
    'form', 'fieldset', 'iframe', 'math', 'style', 'section', 'header', 'footer', 'nav', 'article', 'aside', 'address',
    'audio', 'canvas', 'figure', 'hgroup', 'output', 'video', 'p',
];
const HTML_BLOCK_TAG_NAMES = `(?:${HTML_BLOCK_TAGS.join('|')})(?=[\\s/>])`;
const htmlBlockOpenRegex = new RegExp(`^ {0,3}<(${HTML_BLOCK_TAG_NAMES})[^>]*>`, 'i');
export const htmlAttributeRegex = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * An HTML block from its open tag to the close tag that balances it, blank lines and all, and the blocks that follow
 * on the close tag's line
 * @param {string} src the text from the open tag on
 * @returns {{ length: number, openLength: number, closeFrom: number } | null}
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
            const end = tagRegex.lastIndex;
            const lineRest = /^[^\n]*/.exec(src.slice(end))[0];
            const indent = lineRest.length - lineRest.trimStart().length;
            const next = lineRest.trim() ? matchHtmlBlock(src.slice(end + indent)) : null;
            const length = next ? end + indent + Math.max(next.length, lineRest.length - indent) : end + lineRest.length;
            return { length, openLength: open[0].length, closeFrom: tag.index };
        }
    }
    return null;
}

/**
 * @param {string} openTag
 * @returns {boolean} whether the tag asks for markdown inside its element
 */
function hasMarkdownAttribute(openTag) {
    const attributes = openTag.trimStart().replace(/^<[^\s/>]+/, '').replace(/\/?>$/, '');
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of attributes.matchAll(htmlAttributeRegex)) {
        if (name.toLowerCase() === 'markdown') return (doubleQuoted ?? singleQuoted ?? unquoted) !== '0';
    }
    return false;
}

/**
 * @param {BlockContext} cx
 * @param {Line} line
 * @returns {string} the text from the line's position to the end of the input
 */
function restFromLine(cx, line) {
    // @ts-ignore input is a BlockContext field the published types leave out.
    return cx.input.read(cx.lineStart + line.pos, cx.input.length);
}

/** @type {WeakMap<object, Set<number>>} where an HTML block with markdown inside has its close tag, by parse input */
const markdownBlockCloses = new WeakMap();

/**
 * HTML blocks: a block element's open tag to the close tag that balances it is one `HTMLBlock`. With a `markdown`
 * attribute, and its tags on their own lines, it is an `HTMLMarkdownBlock` holding its two `HTMLMarkdownTag` lines
 * and the markdown between them.
 * @type {MarkdownConfig}
 */
const HtmlBlocks = {
    defineNodes: [
        {
            name: 'HTMLMarkdownBlock',
            block: true,
            composite: (cx, _line, closeFrom) => cx.lineStart <= closeFrom,
        },
        'HTMLMarkdownTag',
    ],
    parseBlock: [{
        name: 'KeptHTMLBlock',
        parse(cx, line) {
            const from = cx.lineStart + line.pos;
            // @ts-ignore
            const closes = markdownBlockCloses.get(cx.input);
            if (closes?.has(from)) {
                closes.delete(from);
                cx.addElement(cx.elt('HTMLMarkdownTag', from, cx.lineStart + line.text.length));
                cx.nextLine();
                return true;
            }
            if (line.next !== 60) return false;
            const src = restFromLine(cx, line);
            const block = matchHtmlBlock(src);
            if (!block) return false;
            const openTag = src.slice(0, block.openLength);
            const openLineLength = line.text.length - line.pos;
            const closeOnOwnLine = /\n[ \t]*$/.test(src.slice(0, block.closeFrom));
            if (hasMarkdownAttribute(openTag) && block.openLength === openLineLength && closeOnOwnLine) {
                // @ts-ignore
                const set = markdownBlockCloses.get(cx.input) ?? new Set();
                set.add(from + block.closeFrom);
                // @ts-ignore
                markdownBlockCloses.set(cx.input, set);
                cx.startComposite('HTMLMarkdownBlock', line.pos, from + block.closeFrom);
                cx.addElement(cx.elt('HTMLMarkdownTag', from, from + openLineLength));
                line.moveBase(line.text.length);
                return null;
            }
            const end = from + block.length;
            while (cx.lineStart + line.text.length < end && cx.nextLine()) { /* consume the block's lines */ }
            cx.addElement(cx.elt('HTMLBlock', from, Math.min(end, cx.lineStart + line.text.length)));
            cx.nextLine();
            return true;
        },
        endLeaf(cx, line) {
            return line.next === 60 && matchHtmlBlock(restFromLine(cx, line)) !== null;
        },
        before: 'HTMLBlock',
    }],
};

const IMAGE_SIZE_UNITS = ['px', '%', 'em', 'rem', 'vw', 'vh', 'ch', 'ex', 'pt', 'pc', 'cm', 'mm', 'in'];
const imageSizeSideRegex = new RegExp(
    `^(?:\\*|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:${[...IMAGE_SIZE_UNITS].sort((a, b) => b.length - a.length).join('|')})?)`,
    'i',
);

/**
 * An image size as written after `=`: `W`, `WxH` or `xH`, each side a number with an optional unit, or `*` for auto
 * @param {string} size
 * @returns {{ width?: string, height?: string } | null} the sides, or none when it isn't a size
 */
export function parseImageSize(size) {
    const width = imageSizeSideRegex.exec(size)?.[0] ?? '';
    let rest = size.slice(width.length);
    let height = '';
    if (rest.startsWith('x')) {
        height = imageSizeSideRegex.exec(rest.slice(1))?.[0] ?? '';
        rest = rest.slice(1 + height.length);
    }
    if (rest !== '' || (!width && !height)) return null;
    const auto = (/** @type {string} */ side) => (side === '*' ? 'auto' : side);
    return { ...(width && { width: auto(width) }), ...(height && { height: auto(height) }) };
}

const TITLE = String.raw`(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^()\\])*\))`;
const DESTINATION = String.raw`(?:<(?:\\.|[^\n<>\\])*>|(?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+?)`;
const sizedImageRegex = new RegExp(String.raw`!\[((?:\\[\s\S]|[^\[\]\\])*)\]\([ \t]*(${DESTINATION})( =[^\s"'()]*)(?:\s+(${TITLE}))?\s*\)`, 'dy');
const sizedDefinitionRegex = new RegExp(String.raw`^ {0,3}\[((?:\\[\s\S]|[^\[\]\\])+)\]:[ \t]*(${DESTINATION})( =[^\s"'()]*)(?:[ \t]+(${TITLE}))?[ \t]*$`, 'd');

/**
 * `![alt](url =WxH)`: an image with an `ImageSize` after its URL; and the same size on a link reference definition
 * @type {MarkdownConfig}
 */
const ImageSizes = {
    defineNodes: ['ImageSize'],
    parseInline: [{
        name: 'SizedImage',
        parse(cx, next, absPos) {
            if (next !== 33 || cx.char(absPos + 1) !== 91) return -1;
            sizedImageRegex.lastIndex = absPos - cx.offset;
            const match = sizedImageRegex.exec(cx.text);
            if (!match || !parseImageSize(match[3].slice(2))) return -1;
            const at = (/** @type {number} */ group) => match.indices[group].map(i => i + cx.offset);
            const [, altTo] = at(1);
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
            return cx.addElement(cx.elt('Image', absPos, end, children));
        },
        before: 'Link',
    }],
    parseBlock: [{
        name: 'SizedLinkReference',
        parse(cx, line) {
            if (line.next !== 91 && !/^ {1,3}\[/.test(line.text)) return false;
            const match = sizedDefinitionRegex.exec(line.text);
            if (!match || !parseImageSize(match[3].slice(2))) return false;
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

/**
 * @param {Readonly<Record<string, string>>} emojis
 * @returns {MarkdownConfig} `:name:` for each name the table has, as an `Emoji`
 */
function emojiShortcodes(emojis) {
    const shortcodeRegex = /:([^\s:]+):/y;
    return {
        defineNodes: ['Emoji'],
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

const QUOTE_PAIRS = { '"': '"', '“': '”', '«': '»', '「': '」', '『': '』', '＂': '＂' };
const QuoteDelim = { resolve: 'DialogueQuote', mark: 'DialogueQuoteMark' };

/** @type {WeakMap<object, Set<number>>} where an open quote of a line closes, by inline context */
const quoteCloses = new WeakMap();

/**
 * Quoted speech on one line, `"…"` and the other quote pairs, as a `DialogueQuote` with its quote marks
 * @type {MarkdownConfig}
 */
const DialogueQuotes = {
    defineNodes: ['DialogueQuote', 'DialogueQuoteMark'],
    parseInline: [{
        name: 'DialogueQuote',
        parse(cx, next, absPos) {
            const char = String.fromCharCode(next);
            let closes = quoteCloses.get(cx);
            if (closes?.has(absPos)) {
                closes.delete(absPos);
                return cx.addDelimiter(QuoteDelim, absPos, absPos + 1, false, true);
            }
            const close = QUOTE_PAIRS[/** @type {keyof typeof QUOTE_PAIRS} */ (char)];
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

/** What opens, continues or closes a Handlebars block: `{{#if x}}`, `{{else}}`, `{{/if}}` */
const BLOCK_TAG = /^\s*(?:#|\/(?!\/)|else(?![\w-]))/u;

/**
 * `{{…}}`, nested ones included, as one `Macro` with its two `MacroMark`s; a Handlebars block's opening, `else` and
 * closing tags as `MacroBlockTag`s, which hold no value
 * @type {MarkdownConfig}
 */
const Macros = {
    defineNodes: ['Macro', 'MacroBlockTag', 'MacroMark'],
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
                        const name = BLOCK_TAG.test(cx.slice(absPos + 2, end - 2)) ? 'MacroBlockTag' : 'Macro';
                        return cx.addElement(cx.elt(name, absPos, end, [
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

/**
 * @param {readonly string[]} lines
 * @returns {MarkdownConfig} each of the lines, written exactly, as a paragraph of plain text
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
 * @param {readonly string[]} markers
 * @returns {MarkdownConfig} each marker as a `ReasoningMarker` in a line, or a `ReasoningMarkerLine` alone on one, so it
 * is never taken for an HTML tag
 */
function reasoningMarkers(markers) {
    const found = (/** @type {string} */ text) => markers.find(marker => text.trimEnd() === marker);
    return {
        defineNodes: ['ReasoningMarker', { name: 'ReasoningMarkerLine', block: true }],
        parseInline: [{
            name: 'ReasoningMarker',
            parse(cx, _next, pos) {
                const marker = markers.find(each => cx.slice(pos, pos + each.length) === each);
                return marker ? cx.addElement(cx.elt('ReasoningMarker', pos, pos + marker.length)) : -1;
            },
            before: 'HTMLTag',
        }],
        parseBlock: [{
            name: 'ReasoningMarkerLine',
            parse(cx, line) {
                const marker = found(line.text.slice(line.pos));
                if (!marker) return false;
                const from = cx.lineStart + line.pos;
                cx.addElement(cx.elt('ReasoningMarkerLine', from, from + marker.length));
                cx.nextLine();
                return true;
            },
            endLeaf: (_cx, line) => found(line.text.slice(line.pos)) !== undefined,
            before: 'HTMLBlock',
        }],
    };
}

/**
 * @param {GrammarOptions} [options]
 * @returns {MarkdownConfig[]} the extensions, for a markdown parser with tables and task lists
 */
export function chatMarkdownExtensions(options = {}) {
    const markers = (options.reasoningMarkers ?? []).map(marker => marker.trim()).filter(Boolean);
    return [
        Strikethrough,
        BareUrls,
        ...(markers.length ? [reasoningMarkers(markers)] : []),
        ...(options.encodeTags ? [] : [HtmlBlocks]),
        ImageSizes,
        Macros,
        ...(options.emojis ? [emojiShortcodes(options.emojis)] : []),
        ...(options.dialogueQuotes ? [DialogueQuotes] : []),
        ...(options.escapeLines?.length ? [escapedLines(options.escapeLines)] : []),
        ...(options.encodeTags ? [{ remove: ['HTMLBlock', 'HTMLTag'] }] : []),
    ];
}
