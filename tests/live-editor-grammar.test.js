import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { Marked } from 'marked';
import showdown from 'showdown';
import * as lezerMarkdown from '@lezer/markdown';
import * as lezerHighlight from '@lezer/highlight';

// The editor's grammar has to find the same constructs, at the same places, as chat's marked setup. This compares
// the two on a corpus covering each of our extensions and their edge cases.

jest.unstable_mockModule('../public/lib.js', () => ({ Marked, showdown }));
jest.unstable_mockModule('../public/live-editor-lib.js', () => ({ lezerMarkdown, lezerHighlight }));

/** @type {typeof import('../public/scripts/live-editor/grammar.js')} */
let grammar;
/** @type {typeof import('../public/scripts/marked-processor.js')} */
let markedSetup;

beforeAll(async () => {
    grammar = await import('../public/scripts/live-editor/grammar.js');
    markedSetup = await import('../public/scripts/marked-processor.js');
});

const BLOCK_NAMES = {
    ATXHeading1: 'heading', ATXHeading2: 'heading', ATXHeading3: 'heading', ATXHeading4: 'heading',
    ATXHeading5: 'heading', ATXHeading6: 'heading', SetextHeading1: 'heading', SetextHeading2: 'heading',
    FencedCode: 'code', CodeBlock: 'code', Blockquote: 'blockquote', BulletList: 'list', OrderedList: 'list',
    Table: 'table', HorizontalRule: 'hr', HTMLBlock: 'html', Paragraph: 'paragraph',
};
const INLINE_NAMES = {
    Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 'del', InlineCode: 'codespan', Link: 'link',
    Image: 'image', URL: 'link', Emoji: 'emoji', HTMLTag: 'html',
};

/**
 * Constructs the grammar finds: top-level blocks, and inline constructs in top-level paragraphs and headings.
 * @param {string} text
 * @param {object} [options]
 * @returns {string[]}
 */
function lezerConstructs(text, options) {
    const tree = grammar.chatMarkdownParser({ emojis: showdown.helper.emojis, ...options }).parse(text);
    /** @type {string[]} */
    const found = [];
    const top = tree.topNode.firstChild;
    for (let block = tree.topNode.firstChild; block; block = block.nextSibling) {
        const name = BLOCK_NAMES[block.name];
        if (!name) continue;
        found.push(`${name} ${block.from}-${block.to}`);
        if (name !== 'paragraph' && name !== 'heading') continue;
        const cursor = block.cursor();
        while (cursor.next() && cursor.from < block.to) {
            const inline = INLINE_NAMES[cursor.name];
            // An image's URL is part of the image, as in marked.
            if (inline && !(cursor.name === 'URL' && cursor.node.parent?.name !== block.name && cursor.node.parent?.name !== 'Emphasis' && cursor.node.parent?.name !== 'StrongEmphasis' && cursor.node.parent?.name !== 'Strikethrough')) {
                found.push(`${inline} ${cursor.from}-${cursor.to}`);
            }
        }
    }
    void top;
    return found.sort();
}

const MARKED_BLOCKS = { heading: 'heading', code: 'code', blockquote: 'blockquote', list: 'list', table: 'table', hr: 'hr', html: 'html', paragraph: 'paragraph' };
const MARKED_INLINE = { em: 'em', strong: 'strong', del: 'del', codespan: 'codespan', link: 'link', image: 'image', emoji: 'emoji', html: 'html' };

/**
 * The same constructs from marked's tokens, positioned by their `raw` text.
 * @param {string} text
 * @returns {string[]}
 */
function markedConstructs(text) {
    const tokens = markedSetup.markedProcessor.lexer(text);
    /** @type {string[]} */
    const found = [];
    /**
     * @param {any[]} list
     * @param {number} offset
     */
    const inline = (list, offset) => {
        let at = offset;
        for (const token of list) {
            const name = MARKED_INLINE[token.type];
            if (name) found.push(`${name} ${at}-${at + token.raw.length}`);
            if (token.tokens?.length && token.type !== 'image') {
                const inner = token.tokens.map(t => t.raw).join('');
                const start = token.raw.indexOf(inner);
                inline(token.tokens, at + Math.max(0, start));
            }
            at += token.raw.length;
        }
    };
    /**
     * @param {any[]} list
     * @param {number} start
     */
    const blocks = (list, start) => {
        let at = start;
        for (const token of list) {
            // A markdown="1" block: its opening and closing tags and the blocks between, as the grammar has them.
            if (token.type === 'htmlBlockMarkdown') blocks(token.tokens, at);
            else block(token, at);
            at += token.raw.length;
        }
    };
    /**
     * @param {any} token
     * @param {number} at
     */
    const block = (token, at) => {
        const name = MARKED_BLOCKS[token.type];
        if (name) {
            const raw = token.raw.replace(/\n+$/, '');
            const lead = raw.length - raw.trimStart().length;
            found.push(`${name} ${at + (name === 'html' || name === 'paragraph' ? 0 : lead)}-${at + raw.length}`);
            if ((token.type === 'paragraph' || token.type === 'heading') && token.tokens) {
                const textStart = token.raw.indexOf(token.text);
                inline(token.tokens, at + Math.max(0, textStart));
            }
        }
    };
    blocks(tokens, 0);
    return found.sort();
}

/**
 * Constructs where the two are known to differ, and why.
 * @type {Record<string, { lezerOnly?: string[], markedOnly?: string[], why: string }>}
 */
const KNOWN_DIFFERENCES = {
    'macros': {
        markedOnly: ['emoji 33-36'],
        why: 'Chat substitutes macros before markdown, so marked never sees `:1:` inside {{random::1::2}}; the grammar keeps the macro whole.',
    },
    'not a size': {
        lezerOnly: ['image 0-4'],
        why: '@lezer/markdown has no table of reference definitions, so `![a]` with no `[a]:` definition is an image to it; marked leaves it as text.',
    },
    'bracket without a definition': {
        lezerOnly: ['link 2-5'],
        why: 'Same: @lezer/markdown reads any `[x]` as a shortcut reference link.',
    },
};

const CORPUS = {
    'emphasis and strong': 'a *b* and **c** and ***d*** and _e_ __f__',
    'nested emphasis keeps spaces': '*a **b** a*',
    'unclosed star': 'a * b and *c',
    'strikethrough both lengths': 'a ~one~ b ~~two~~ c ~~~three~~~',
    'code spans': 'use `x *y*` and ``a`b``',
    'links': 'a [link](http://x.com "t") and ![img](a.png) and [ref][r]\n\n[r]: http://r.com',
    'autolinks': 'see https://example.com/a_b_ and www.site.com. and mail a@b.co',
    'url keeps trailing underscore': 'go https://x.com/path_',
    'url drops trailing full stop': 'go to https://x.com/a.',
    'headings': '# One\n\nTwo\n===\n\n### three ###',
    'lists': '- a\n- b\n\n1. c\n2. d',
    'blockquote': '> quoted *text*\n> more',
    'fenced and indented code': '```js\nx = *1*\n```\n\n    indented',
    'hr': 'a\n\n---\n\nb',
    'table': '| a | b |\n|---|---|\n| *c* | d |',
    'task list': '- [ ] todo\n- [x] done',
    'html block kept whole': '<div>\n\n*not md*\n\n</div>\n\nafter',
    'html block with markdown attribute': '<div markdown="1">\n\n*md*\n\n</div>',
    'html block interrupting a paragraph': 'text\n<div>x</div>\nmore',
    'nested html blocks of one tag': '<div>\n<div>\n\ninner\n\n</div>\n</div>\n\nout',
    'markdown="0" keeps it whole': '<section markdown="0">\n\n*x*\n\n</section>',
    'url with parentheses and a query': 'see https://en.wikipedia.org/wiki/A_(b)?x=1&y=2, ok',
    'strong around emphasis around code': '**a *b `c`* d**',
    'list items with emphasis': '- *a*\n- **b**',
    'inline html':'a <span>b</span> c',
    'emoji': 'hi :smile: and :notanemoji: and `:smile:`',
    'sized image': '![a](b.png =100x200) and ![c](d.png =50%x* "title")',
    'sized definition': '![a][r]\n\n[r]: x.png =10x10',
    'not a size': '![a](b.png =1qx)',
    'bracket without a definition': 'a [b] c',
    'hard breaks': 'a\nb  \nc',
    'escapes and entities': '\\*not em\\* &amp; &copy;',
    'macros': 'hi {{char}}, *{{user}}* {{setvar::a::{{random::1::2}}}}',
};

describe('the editor grammar reads markdown as chat does', () => {
    test.each(Object.entries(CORPUS))('%s', (name, text) => {
        const known = KNOWN_DIFFERENCES[name];
        const lezer = lezerConstructs(text).filter(x => !known?.lezerOnly?.includes(x));
        const marked = markedConstructs(text).filter(x => !known?.markedOnly?.includes(x));
        expect(lezer).toEqual(marked);
    });
});

describe('nodes only the editor needs', () => {
    /** @param {string} text @param {string} node @param {object} [options] */
    const spans = (text, node, options) => {
        const tree = grammar.chatMarkdownParser(options).parse(text);
        /** @type {string[]} */
        const found = [];
        tree.iterate({ enter: (n) => { if (n.name === node) found.push(text.slice(n.from, n.to)); } });
        return found;
    };

    test('macros, nested ones inside their outer macro', () => {
        expect(spans('a {{char}} {{setvar::x::{{random::1::2}}}} `{{code}}`', 'Macro')).toEqual(['{{char}}', '{{setvar::x::{{random::1::2}}}}']);
    });

    test('dialogue quotes close on the same line, each style with its own closing mark', () => {
        expect(spans('"hi" she said, “there” «a» 「b」 『c』 ＂d＂ "open\nline"', 'DialogueQuote', { dialogueQuotes: true }))
            .toEqual(['"hi"', '“there”', '«a»', '「b」', '『c』', '＂d＂']);
        expect(spans('"hi"', 'DialogueQuote')).toEqual([]);
    });

    test('emphasis inside a quote is still emphasis', () => {
        expect(spans('"a *b* c"', 'Emphasis', { dialogueQuotes: true })).toEqual(['*b*']);
    });

    test('with encodeTags, HTML is text', () => {
        expect(spans('<div>x</div>\n\na <b>c</b>', 'HTMLBlock', { encodeTags: true })).toEqual([]);
        expect(spans('<div>x</div>\n\na <b>c</b>', 'HTMLTag', { encodeTags: true })).toEqual([]);
    });

    test('escaped lines are plain paragraphs', () => {
        expect(spans('***', 'HorizontalRule', { escapeLines: ['***'] })).toEqual([]);
        expect(spans('***', 'HorizontalRule')).toEqual(['***']);
    });
});
