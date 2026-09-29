import { Marked, showdown } from '../lib.js';

// No power-user.js or script.js imports here on purpose: both transitively import
// every consumer of this module (message-formatting.js, chats.js,
// SlashCommandReturnHelper.js), so importing power_user/substituteParams from them
// would create a cycle. Callers that already have the real values inject them instead
// (see reloadMarkedProcessor).
const identitySubstitute = (text) => text;

const EXCLUSION_MARKER = '​';

/**
 * @param {string} [escapeStrings] Comma-separated literal strings (power_user.markdown_escape_strings) to protect from markdown parsing.
 * @param {(text: string) => string} [substituteParamsFn] Macro-substitution function applied to escapeStrings before use (defaults to no substitution).
 * @returns {import('marked').MarkedExtension}
 */
export function markdownExclusionExt(escapeStrings, substituteParamsFn = identitySubstitute) {
    if (!escapeStrings) {
        return {};
    }

    return {
        hooks: {
            preprocess(markdown) {
                const escapedExclusions = substituteParamsFn(escapeStrings)
                    .split(',')
                    .filter((element) => element.length > 0)
                    .map((element) => `(${element.split('').map((char) => `\\${char}`).join('')})`);

                if (escapedExclusions.length === 0) {
                    return markdown;
                }

                const excludeRegex = new RegExp(`^(${escapedExclusions.join('|')})$`, 'gm');
                return markdown.replace(excludeRegex, (match) => `${EXCLUSION_MARKER}${match}`);
            },
            postprocess(html) {
                return html.split(EXCLUSION_MARKER).join('');
            },
        },
    };
}

export let markedProcessor = new Marked();

/** Same configuration as {@link markedProcessor}, except raw HTML tokens are shown as literal text. */
let markedLiteralTagsProcessor = new Marked();

/** @param {string} text @returns {string} */
function escapeHtmlText(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** @type {import('marked').MarkedExtension} */
const literalTagsExt = {
    renderer: {
        html({ text }) {
            return escapeHtmlText(text);
        },
    },
};

/**
 * marked's GFM `_backpedal` without `_`: trailing punctuation is dropped from a bare URL so a sentence's full stop
 * isn't swallowed, but `_` isn't sentence punctuation, so a URL ending in `_` keeps it.
 */
const urlBackpedal = /(?:[^?!.,:;*'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*'"~)]+(?!$))+/;

/** @type {import('marked').MarkedExtension} */
const urlTrailingUnderscoreExt = {
    tokenizer: {
        url(src) {
            const cap = this.rules.inline.url.exec(src);
            if (!cap || cap[2] === '@') {
                return false;
            }
            let text = cap[0];
            let prev;
            do {
                prev = text;
                text = urlBackpedal.exec(text)?.[0] ?? '';
            } while (prev !== text);
            const href = cap[1] === 'www.' ? `http://${text}` : text;
            return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
        },
    },
};

/** The tags showdown's `hashHTMLBlocks` keeps whole. */
const HTML_BLOCK_TAGS = [
    'pre', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'dl', 'ol', 'ul', 'script', 'noscript',
    'form', 'fieldset', 'iframe', 'math', 'style', 'section', 'header', 'footer', 'nav', 'article', 'aside', 'address',
    'audio', 'canvas', 'figure', 'hgroup', 'output', 'video', 'p',
];
const HTML_BLOCK_TAG_NAMES = `(?:${HTML_BLOCK_TAGS.join('|')})(?=[\\s/>])`;
const htmlBlockOpenRegex = new RegExp(`^ {0,3}<(${HTML_BLOCK_TAG_NAMES})[^>]*>`, 'i');
const htmlBlockCandidateRegex = new RegExp(`\\n {0,3}<${HTML_BLOCK_TAG_NAMES}`, 'gi');
const htmlAttributeRegex = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Matches an HTML block at the start of `src`: an opening tag from {@link HTML_BLOCK_TAGS} up to its matching closing
 * tag, counting nested tags of the same name.
 * @param {string} src
 * @returns {{ raw: string, open: string, inner: string, close: string } | null} null when there's no matching closing tag.
 */
function matchHtmlBlock(src) {
    const openMatch = htmlBlockOpenRegex.exec(src);
    if (!openMatch) {
        return null;
    }
    const tagRegex = new RegExp(`<(/?)${openMatch[1]}(?=[\\s/>])[^>]*>`, 'gi');
    tagRegex.lastIndex = openMatch[0].length;
    let depth = 1;
    let tag;
    while ((tag = tagRegex.exec(src))) {
        depth += tag[1] ? -1 : 1;
        if (depth === 0) {
            const lineEnd = /^[ \t]*(?:\n|$)/.exec(src.slice(tagRegex.lastIndex))?.[0] ?? '';
            return {
                raw: src.slice(0, tagRegex.lastIndex) + lineEnd,
                open: openMatch[0],
                inner: src.slice(openMatch[0].length, tag.index),
                close: tag[0] + lineEnd,
            };
        }
    }
    return null;
}

/**
 * PHP Markdown Extra's opt-in: an opening tag with a `markdown` attribute has its inside parsed as markdown, unless the
 * value is `0`. As in HTML, the first of repeated attributes counts.
 * @param {string} openTag
 * @returns {boolean}
 */
function hasMarkdownAttribute(openTag) {
    const attributes = openTag.trimStart().replace(/^<[^\s/>]+/, '').replace(/\/?>$/, '');
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of attributes.matchAll(htmlAttributeRegex)) {
        if (name.toLowerCase() === 'markdown') {
            return (doubleQuoted ?? singleQuoted ?? unquoted) !== '0';
        }
    }
    return false;
}

/**
 * @param {string} text
 * @param {string} tagName
 * @returns {import('marked').Tokens.HTML}
 */
function htmlBlockToken(text, tagName) {
    return { type: 'html', block: true, pre: ['pre', 'script', 'style'].includes(tagName), raw: text, text };
}

/**
 * Keeps an HTML block whole: it runs to its matching closing tag, blank lines and indentation included,
 * and its inside isn't parsed as markdown unless the opening tag has a `markdown` attribute. The tags go through the
 * `html` renderer, so the literal-tags processor shows them as text.
 * @type {import('marked').MarkedExtension}
 */
const htmlBlockExt = {
    extensions: [{
        name: 'htmlBlockMarkdown',
        level: 'block',
        start(src) {
            htmlBlockCandidateRegex.lastIndex = 0;
            let candidate;
            while ((candidate = htmlBlockCandidateRegex.exec(src))) {
                if (matchHtmlBlock(src.slice(candidate.index + 1))) {
                    return candidate.index + 1;
                }
            }
            return undefined;
        },
        tokenizer(src) {
            const block = matchHtmlBlock(src);
            if (!block) {
                return undefined;
            }
            const tagName = htmlBlockOpenRegex.exec(block.open)[1].toLowerCase();
            if (!hasMarkdownAttribute(block.open)) {
                return htmlBlockToken(block.raw, tagName);
            }
            return {
                type: 'htmlBlockMarkdown',
                raw: block.raw,
                tokens: [
                    htmlBlockToken(block.open, tagName),
                    ...this.lexer.blockTokens(block.inner, []),
                    htmlBlockToken(block.close, tagName),
                ],
            };
        },
        renderer(token) {
            return this.parser.parse(token.tokens);
        },
    }],
};

/** Upstream's emoji set: the one showdown's `emoji` option uses. */
const EMOJIS = showdown.helper.emojis;
const emojiShortcodeRegex = /^:([^\s:]+):/;
const emojiCandidateRegex = /:([^\s:]+):/g;

/**
 * `:name:` shortcodes render as emoji, for the names in showdown's emoji set; any other name stays as written.
 * An inline token, so code, URLs, HTML tags and kept-whole HTML blocks are left alone.
 * @type {import('marked').MarkedExtension}
 */
const emojiExt = {
    extensions: [{
        name: 'emoji',
        level: 'inline',
        start(src) {
            emojiCandidateRegex.lastIndex = 0;
            let candidate;
            while ((candidate = emojiCandidateRegex.exec(src))) {
                if (Object.hasOwn(EMOJIS, candidate[1])) {
                    return candidate.index;
                }
                emojiCandidateRegex.lastIndex = candidate.index + 1;
            }
            return undefined;
        },
        tokenizer(src) {
            const match = emojiShortcodeRegex.exec(src);
            if (!match || !Object.hasOwn(EMOJIS, match[1])) {
                return undefined;
            }
            return { type: 'emoji', raw: match[0], name: match[1] };
        },
        renderer(token) {
            return EMOJIS[token.name];
        },
    }],
};

const IMAGE_SIZE_UNITS = ['px', '%', 'em', 'rem', 'vw', 'vh', 'ch', 'ex', 'pt', 'pc', 'cm', 'mm', 'in'];
const imageSizeSideRegex = new RegExp(
    `^(?:\\*|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:${[...IMAGE_SIZE_UNITS].sort((a, b) => b.length - a.length).join('|')})?)`,
    'i',
);
/** The ` =WxH` after a url; its characters are checked by {@link parseImageSize}. */
const IMAGE_SIZE_GROUP = '( =[^\\s"\'()]*)';

/**
 * Parses showdown's image size, `WxH`, with `*` as auto on either side, plus the shorthands `W`, `Wx` (width-only)
 * and `xH` (height-only). Each side is a CSS number with an optional unit from {@link IMAGE_SIZE_UNITS}, longest unit
 * first, so an `x` is the separator only when it isn't part of a unit (`1exx2`).
 * @param {string} size The text after `=`.
 * @returns {{ width?: string, height?: string } | null} null when it isn't a size.
 */
function parseImageSize(size) {
    const width = imageSizeSideRegex.exec(size)?.[0] ?? '';
    let rest = size.slice(width.length);
    let height = '';
    if (rest.startsWith('x')) {
        height = imageSizeSideRegex.exec(rest.slice(1))?.[0] ?? '';
        rest = rest.slice(1 + height.length);
    }
    if (rest !== '' || (!width && !height)) {
        return null;
    }
    const auto = (side) => side === '*' ? 'auto' : side;
    return { ...(width && { width: auto(width) }), ...(height && { height: auto(height) }) };
}

/** @type {Map<string, RegExp>} */
const sizedRegexCache = new Map();
/**
 * marked's own link or definition rule with {@link IMAGE_SIZE_GROUP} inserted right after the url group, so the
 * label, url and title follow marked exactly.
 * @param {RegExp} rule
 * @param {string} urlGroupEnd The text that ends the url group in the rule's source.
 * @returns {RegExp | null} null when marked's rule no longer has that shape.
 */
function sizedRegex(rule, urlGroupEnd) {
    let regex = sizedRegexCache.get(rule.source);
    if (regex === undefined) {
        const at = rule.source.indexOf(urlGroupEnd);
        regex = at === -1 ? null : new RegExp(rule.source.slice(0, at + urlGroupEnd.length) + IMAGE_SIZE_GROUP, 'd');
        if (!regex) {
            console.warn('Image sizes are off: marked\'s link or definition rule changed shape', rule);
        }
        sizedRegexCache.set(rule.source, regex);
    }
    return regex;
}

/**
 * Runs one of marked's own tokenizers on `src` with the size cut out, and gives the token the size.
 * @param {(src: string) => any} tokenize
 * @param {RegExp | null} regex From {@link sizedRegex}.
 * @param {string} src
 * @returns {any} undefined when `src` doesn't start with a sized form.
 */
function tokenizeSized(tokenize, regex, src) {
    const match = regex?.exec(src);
    if (!match) {
        return undefined;
    }
    const size = parseImageSize(match[match.length - 1].slice(2));
    if (!size) {
        return undefined;
    }
    const [start, end] = match.indices[match.length - 1];
    // A space in place of the size keeps a title that followed it with no space (`=1x2"t"`) separate from the url.
    const token = tokenize(src.slice(0, start) + ' ' + src.slice(end));
    if (!token || token.raw.length <= start) {
        return undefined;
    }
    token.raw = src.slice(0, token.raw.length - 1 + end - start);
    return Object.assign(token, size);
}

/**
 * Image sizes, as upstream's showdown `parseImgDimensions`: `![alt](url =WxH)`, and a size on a reference
 * definition (`[id]: url =WxH`) for the images that use it. See {@link parseImageSize} for the forms.
 * @type {import('marked').MarkedExtension}
 */
const imageSizeExt = {
    extensions: [{
        name: 'sizedImageDef',
        level: 'block',
        tokenizer(src, tokens) {
            const previous = tokens.at(-1);
            if (previous?.type === 'paragraph' || previous?.type === 'text') {
                return undefined;
            }
            const tokenizer = this.lexer.tokenizer;
            const def = tokenizeSized(
                (text) => Object.getPrototypeOf(tokenizer).def.call(tokenizer, text),
                sizedRegex(tokenizer.rules.block.def, '|<.*?>)'),
                src,
            );
            if (!def) {
                return undefined;
            }
            const links = this.lexer.tokens.links;
            if (!links[def.tag]) {
                links[def.tag] = { href: def.href, title: def.title, width: def.width, height: def.height };
            }
            return { type: 'sizedImageDef', raw: def.raw };
        },
        renderer() {
            return '';
        },
    }],
    tokenizer: {
        link(src) {
            if (!src.startsWith('![')) {
                return false;
            }
            return tokenizeSized(
                (text) => Object.getPrototypeOf(this).link.call(this, text),
                sizedRegex(this.rules.inline.link, '|(?=\\)))'),
                src,
            ) ?? false;
        },
        reflink(src, links) {
            let entry;
            const watchedLinks = new Proxy(links, {
                get(target, key) {
                    entry = target[key];
                    return entry;
                },
            });
            const token = Object.getPrototypeOf(this).reflink.call(this, src, watchedLinks);
            if (token?.type === 'image' && entry) {
                Object.assign(token, entry.width && { width: entry.width }, entry.height && { height: entry.height });
            }
            return token;
        },
    },
    renderer: {
        image(token) {
            if (!token.width && !token.height) {
                return false;
            }
            const html = Object.getPrototypeOf(this).image.call(this, token);
            if (!html.startsWith('<img ')) {
                return html;
            }
            const size = (token.width ? ` width="${token.width}"` : '') + (token.height ? ` height="${token.height}"` : '');
            return html.slice(0, -1) + size + '>';
        },
    },
};

/**
 * @param {string} [escapeStrings] power_user.markdown_escape_strings; pass the real value when calling this from a module that already imports power_user (e.g. on power_user.markdown_escape_strings change), same as the old reloadMarkdownProcessor() was called.
 * @param {(text: string) => string} [substituteParamsFn] The real `substituteParams` from script.js, from a module that already imports it.
 */
export function reloadMarkedProcessor(escapeStrings, substituteParamsFn = identitySubstitute) {
    markedProcessor = new Marked({
        gfm: true,
        breaks: true,
    });
    markedProcessor.use(markdownExclusionExt(escapeStrings, substituteParamsFn));
    markedProcessor.use(urlTrailingUnderscoreExt);
    markedProcessor.use(htmlBlockExt);
    markedProcessor.use(emojiExt);
    markedProcessor.use(imageSizeExt);

    markedLiteralTagsProcessor = new Marked({
        gfm: true,
        breaks: true,
    });
    markedLiteralTagsProcessor.use(markdownExclusionExt(escapeStrings, substituteParamsFn));
    markedLiteralTagsProcessor.use(urlTrailingUnderscoreExt);
    markedLiteralTagsProcessor.use(htmlBlockExt);
    markedLiteralTagsProcessor.use(emojiExt);
    markedLiteralTagsProcessor.use(imageSizeExt);
    markedLiteralTagsProcessor.use(literalTagsExt);
    return markedProcessor;
}

export function renderMarkdown(text) {
    return markedProcessor.parse(text);
}

/**
 * Renders markdown with raw HTML (block and inline tags) shown as literal text; code spans, code blocks
 * and blockquotes render as usual.
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdownLiteralTags(text) {
    return String(markedLiteralTagsProcessor.parse(text));
}

reloadMarkedProcessor();
