import { Marked, showdown } from '../lib.js';

const identitySubstitute = (text) => text;

const EXCLUSION_MARKER = '​';

/**
 * @param {string} [escapeStrings]
 * @param {(text: string) => string} [substituteParamsFn]
 * @returns {import('marked').MarkedExtension}
 */
function markdownExclusionExt(escapeStrings, substituteParamsFn = identitySubstitute) {
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

let markedLiteralTagsProcessor = new Marked();

/**
 * @param {string} text
 * @returns {string}
 */
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
    tokenizer: {
        html() {
            return undefined;
        },
    },
    renderer: {
        html({ text }) {
            return escapeHtmlText(text);
        },
    },
};

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
 * @param {string} src
 * @returns {{ raw: string, open: string, inner: string, close: string } | null}
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

/** @type {import('marked').MarkedExtension} */
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

const EMOJIS = showdown.helper.emojis;
const emojiShortcodeRegex = /^:([^\s:]+):/;
const emojiCandidateRegex = /:([^\s:]+):/g;

/** @type {import('marked').MarkedExtension} */
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
const IMAGE_SIZE_GROUP = '( =[^\\s"\'()]*)';

/**
 * @param {string} size
 * @returns {{ width?: string, height?: string } | null}
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
 * @param {RegExp} rule
 * @param {string} urlGroupEnd
 * @returns {RegExp | null}
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
 * @param {(src: string) => any} tokenize
 * @param {RegExp | null} regex
 * @param {string} src
 * @returns {any}
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
    const token = tokenize(src.slice(0, start) + ' ' + src.slice(end));
    if (!token || token.raw.length <= start) {
        return undefined;
    }
    token.raw = src.slice(0, token.raw.length - 1 + end - start);
    return Object.assign(token, size);
}

/** @type {import('marked').MarkedExtension} */
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
 * @param {string} [escapeStrings]
 * @param {(text: string) => string} [substituteParamsFn]
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
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdownLiteralTags(text) {
    return String(markedLiteralTagsProcessor.parse(text));
}

reloadMarkedProcessor();
