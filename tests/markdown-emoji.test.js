import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { Marked } from 'marked';
import { EMOJIS } from '../public/scripts/emojis.js';

jest.unstable_mockModule('../public/lib.js', () => ({
    Marked,
    DOMPurify: { sanitize: (html) => html },
}));
jest.unstable_mockModule('../public/script.js', () => ({
    systemUserName: 'SillyTavern System',
    substituteParams: (text) => text,
}));
jest.unstable_mockModule('../public/scripts/slash-commands.js', () => ({ COMMENT_NAME_DEFAULT: 'Note' }));
jest.unstable_mockModule('../public/scripts/chats.js', () => ({
    encodeStyleTags: (text) => text,
    decodeStyleTags: (text) => text,
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: {
        user_prompt_bias: '',
        show_user_prompt_bias: true,
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


const renderedCases = [
    ['alone', ':smile:', '<p>😄</p>'],
    ['mid-sentence', 'hi :smile: there', '<p>hi 😄 there</p>'],
    ['name with `+`', ':+1:', '<p>👍</p>'],
    ['name with `_` is not emphasis', 'a :heart_eyes: b :heart_eyes: c', '<p>a 😍 b 😍 c</p>'],
    ['two in a row', ':smile::+1:', '<p>😄👍</p>'],
    ['next to a word', 'ok:smile:', '<p>ok😄</p>'],
    ['inside emphasis', '**:smile:**', '<p><strong>😄</strong></p>'],
    ['inside link text', '[:smile:](https://example.com)', '<p><a href="https://example.com">😄</a></p>'],
    ['in a heading', '# :smile:', '<h1>😄</h1>'],
    ['in a list item', '- :smile:', '<ul>\n<li>😄</li>\n</ul>'],
];

const literalCases = [
    ['unknown name', ':notanemoji:', '<p>:notanemoji:</p>'],
    ['whitespace inside', ':smile :', '<p>:smile :</p>'],
    ['time of day', '10:30:45', '<p>10:30:45</p>'],
    ['escaped colon', '\\:smile:', '<p>:smile:</p>'],
    ['code span', '`:smile:`', '<p><code>:smile:</code></p>'],
    ['fenced code block', '```\n:smile:\n```', '<pre><code>:smile:\n</code></pre>'],
    ['bare URL', 'https://example.com/:smile:/x', '<p><a href="https://example.com/:smile:/x">https://example.com/:smile:/x</a></p>'],
    ['bare URL mid-sentence', 'see https://example.com/:smile:/x here', '<p>see <a href="https://example.com/:smile:/x">https://example.com/:smile:/x</a> here</p>'],
    ['link href', '[a](https://example.com/:smile:)', '<p><a href="https://example.com/:smile:">a</a></p>'],
];

describe('renderMarkdown', () => {
    test.each(renderedCases)('%s', (_name, input, expected) => {
        expect(String(renderMarkdown(input)).trim()).toBe(expected);
    });

    test.each(literalCases)('%s stays as written', (_name, input, expected) => {
        expect(String(renderMarkdown(input)).trim()).toBe(expected);
    });

    test('every name in the emoji set renders as its emoji', () => {
        const names = Object.keys(EMOJIS);
        expect(names.length).toBeGreaterThan(1000);
        const wrong = names.filter((name) => String(renderMarkdown(`:${name}:`)).trim() !== `<p>${EMOJIS[name]}</p>`);
        expect(wrong).toEqual([]);
    });

    test('inside an HTML tag\'s attribute stays as written', () => {
        expect(String(renderMarkdown('<span title=":smile:">:smile:</span>')).trim())
            .toBe('<p><span title=":smile:">😄</span></p>');
    });

    test('inside a kept-whole HTML block stays as written', () => {
        const input = '<div>\n\n:smile:\n</div>';
        expect(String(renderMarkdown(input)).trim()).toBe(input);
    });

    test('inside a markdown="1" HTML block renders', () => {
        expect(String(renderMarkdown('<div markdown="1">\n:smile:\n</div>')).trim())
            .toBe('<div markdown="1"><p>😄</p>\n</div>');
    });
});

describe('renderMarkdownLiteralTags', () => {
    test.each(renderedCases)('%s', (_name, input, expected) => {
        expect(renderMarkdownLiteralTags(input).trim()).toBe(expected);
    });

    test.each(literalCases)('%s stays as written', (_name, input, expected) => {
        expect(renderMarkdownLiteralTags(input).trim()).toBe(expected);
    });

    test('between literal tags renders', () => {
        expect(renderMarkdownLiteralTags('<b>:smile:</b>').trim()).toBe('<p>&lt;b&gt;😄&lt;/b&gt;</p>');
    });
});

describe('messageFormatting', () => {
    test.each(renderedCases)('%s', (_name, input, expected) => {
        expect(messageFormatting(input, 'Alice', false, false, -1)).toBe(expected);
    });

    test.each(literalCases)('%s stays as written', (_name, input, expected) => {
        expect(messageFormatting(input, 'Alice', false, false, -1)).toBe(expected);
    });
});
