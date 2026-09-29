import { Marked } from '../lib.js';

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

    markedLiteralTagsProcessor = new Marked({
        gfm: true,
        breaks: true,
    });
    markedLiteralTagsProcessor.use(markdownExclusionExt(escapeStrings, substituteParamsFn));
    markedLiteralTagsProcessor.use(urlTrailingUnderscoreExt);
    markedLiteralTagsProcessor.use(htmlBlockExt);
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
