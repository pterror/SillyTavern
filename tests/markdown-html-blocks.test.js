import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { Marked } from 'marked';

// An HTML block that starts with one of showdown's hashHTMLBlocks tags runs to its matching closing tag
// (nesting-aware), blank lines and indentation included, and its inside isn't parsed as markdown.
// With a `markdown` attribute on the opening tag (PHP Markdown Extra's opt-in), the inside is parsed as markdown,
// unless its value is "0".
// Checked on both marked processors and through messageFormatting (the chat render path). messageFormatting's
// DOM-bound and app-wide imports are replaced; DOMPurify needs a window, so sanitize is the identity here.

jest.unstable_mockModule('../public/lib.js', () => ({
    Marked,
    DOMPurify: { sanitize: (html) => html },
}));
jest.unstable_mockModule('../public/script.js', () => ({
    systemUserName: 'SillyTavern System',
    substituteParams: (text) => text,
    setMesForShowdownParse: () => {},
}));
jest.unstable_mockModule('../public/scripts/slash-commands.js', () => ({ COMMENT_NAME_DEFAULT: 'Note' }));
jest.unstable_mockModule('../public/scripts/extensions/regex/engine.js', () => ({
    getRegexedString: (text) => text,
    regex_placement: { MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 },
}));
jest.unstable_mockModule('../public/scripts/chats.js', () => ({
    encodeStyleTags: (text) => text,
    decodeStyleTags: (text) => text,
}));
jest.unstable_mockModule('../public/scripts/message-formatter.js', () => ({
    MessageFormatter: { stage: {}, runStage: (_stage, text) => text },
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    fixMarkdown: (text) => text,
    power_user: {
        user_prompt_bias: '',
        show_user_prompt_bias: true,
        auto_fix_generated_markdown: false,
        encode_tags: false,
        reasoning: { prefix: '', suffix: '' },
        allow_name2_display: false,
    },
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    escapeRegex: (string) => string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&'),
    escapeHtml: (str) => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    canUseNegativeLookbehind: () => true,
}));

let renderMarkdown;
let renderMarkdownLiteralTags;
let messageFormatting;

beforeAll(async () => {
    ({ renderMarkdown, renderMarkdownLiteralTags } = await import('../public/scripts/marked-processor.js'));
    ({ messageFormatting } = await import('../public/scripts/message-formatting.js'));
});

const escape = (text) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const BLOCK_TAGS = [
    'pre', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'dl', 'ol', 'ul', 'script', 'noscript',
    'form', 'fieldset', 'iframe', 'math', 'style', 'section', 'header', 'footer', 'nav', 'article', 'aside', 'address',
    'audio', 'canvas', 'figure', 'hgroup', 'output', 'video', 'p',
];

// Creator's-notes shape: nested, indented inner HTML with a blank line inside.
const NESTED = [
    '<div class="card">',
    '    <div class="inner">',
    '        <span>one</span>',
    '',
    '        <span>two</span>',
    '    </div>',
    '</div>',
].join('\n');

// Kept whole: the output is the input, unchanged.
const wholeCases = [
    ['nested, indented inner HTML with a blank line', NESTED],
    ['markdown inside is not parsed', '<div>\n\n**bold** _em_ # heading\n\n- item\n</div>'],
    ['same tag nested, blank line after the inner close', '<div>\n<div>a</div>\n\n    b\n</div>'],
    ['indented up to three spaces', '   <section>\n\n    x\n   </section>'],
    ['case-insensitive tag names', '<DIV>\n\n    x\n</Div>'],
];

describe('renderMarkdown', () => {
    test.each(wholeCases)('%s', (_name, input) => {
        expect(String(renderMarkdown(input)).trim()).toBe(input.trim());
    });

    test.each(BLOCK_TAGS)('<%s> with a blank line and an indented line is kept whole', (tag) => {
        const input = `<${tag}>\n\n    **x**\n</${tag}>`;
        expect(String(renderMarkdown(input)).trim()).toBe(input);
    });

    test('markdown after the block is still parsed', () => {
        const input = '<div>\n\n    a\n</div>\n\n**b**';
        expect(String(renderMarkdown(input)).trim()).toBe('<div>\n\n    a\n</div>\n<p><strong>b</strong></p>');
    });

    test('a block starting right after a paragraph line ends the paragraph', () => {
        const input = 'text\n<video>\n\n    x\n</video>';
        expect(String(renderMarkdown(input)).trim()).toBe('<p>text</p>\n<video>\n\n    x\n</video>');
    });

    test('two blocks in a row are each kept whole', () => {
        const input = '<div>\n\n    a\n</div>\n<div>\n\n    b\n</div>';
        expect(String(renderMarkdown(input)).trim()).toBe(input);
    });

    test('a block inside a blockquote is kept whole', () => {
        const input = '> <div>\n>\n>     x\n> </div>';
        expect(String(renderMarkdown(input)).trim()).toBe('<blockquote>\n<div>\n\n    x\n</div></blockquote>');
    });

    test('an unclosed tag falls back to the spec: blank line ends it', () => {
        const input = '<div>\n\n    code';
        expect(String(renderMarkdown(input))).toContain('<pre><code>code');
    });

    test('a tag name that only starts with a block tag is not a block tag', () => {
        const input = '<divider>\n\n    code\n</divider>';
        expect(String(renderMarkdown(input))).toContain('<pre><code>code');
    });

    test('a block inside a fenced code block stays code', () => {
        const input = '```\n<div>\n\n    x\n</div>\n```';
        expect(String(renderMarkdown(input))).toContain('<pre><code>&lt;div&gt;');
    });

    test('markdown="1": the inside is parsed as markdown, nested plain blocks kept whole', () => {
        const input = '<div markdown="1">\n**x**\n\n<div>\n\n    **y**\n</div>\n</div>';
        expect(String(renderMarkdown(input)).trim())
            .toBe('<div markdown="1"><p><strong>x</strong></p>\n<div>\n\n    **y**\n</div>\n</div>');
    });

    test('markdown attribute of any value, or bare, opts in', () => {
        expect(String(renderMarkdown('<div markdown>**x**</div>')).trim()).toBe('<div markdown><p><strong>x</strong></p>\n</div>');
        expect(String(renderMarkdown('<div class="a" markdown="block">**x**</div>')).trim())
            .toBe('<div class="a" markdown="block"><p><strong>x</strong></p>\n</div>');
    });

    test.each([
        ['double-quoted', '<div markdown="0">\n\n**x**\n</div>'],
        ['single-quoted', '<div markdown=\'0\'>\n\n**x**\n</div>'],
        ['unquoted', '<div markdown=0>\n\n**x**\n</div>'],
        ['upper-case name, other attributes', '<div class="a" MARKDOWN="0">\n\n**x**\n</div>'],
    ])('markdown="0" (%s) does not opt in: kept whole', (_name, input) => {
        expect(String(renderMarkdown(input)).trim()).toBe(input);
    });

    test('"markdown" as a value of another attribute does not opt in', () => {
        const input = '<div class="markdown">\n\n**x**\n</div>';
        expect(String(renderMarkdown(input)).trim()).toBe(input);
    });

    test('markdown="1" nested same tag: the inner close does not end the outer block', () => {
        const input = '<div markdown="1">\n<div>\n\n    a\n</div>\n\n**b**\n</div>';
        expect(String(renderMarkdown(input)).trim())
            .toBe('<div markdown="1"><div>\n\n    a\n</div>\n<p><strong>b</strong></p>\n</div>');
    });
});

describe('renderMarkdownLiteralTags', () => {
    test.each(wholeCases)('%s: shown as literal text, kept whole', (_name, input) => {
        expect(renderMarkdownLiteralTags(input).trim()).toBe(escape(input).trim());
    });

    test('markdown="1": the tags are literal text, the inside is parsed as markdown', () => {
        const input = '<div markdown="1">\n**x**\n</div>';
        expect(renderMarkdownLiteralTags(input).trim())
            .toBe(`${escape('<div markdown="1">')}<p><strong>x</strong></p>\n${escape('</div>')}`);
    });

    test('markdown="0": shown as literal text, kept whole', () => {
        const input = '<div markdown="0">\n\n**x**\n</div>';
        expect(renderMarkdownLiteralTags(input).trim()).toBe(escape(input));
    });
});

describe('messageFormatting', () => {
    test.each(wholeCases)('%s', (_name, input) => {
        expect(messageFormatting(input, 'Alice', false, false, -1)).toBe(input.trim());
    });

    test('markdown="1": the inside is parsed as markdown', () => {
        const input = '<div markdown="1">\n**x**\n</div>';
        expect(messageFormatting(input, 'Alice', false, false, -1))
            .toBe('<div markdown="1"><p><strong>x</strong></p>\n</div>');
    });

    test('markdown="0": kept whole', () => {
        const input = '<div markdown="0">\n\n**x**\n</div>';
        expect(messageFormatting(input, 'Alice', false, false, -1)).toBe(input);
    });
});
