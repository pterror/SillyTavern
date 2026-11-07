import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { Marked } from 'marked';

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

const URL = 'https://example.com/foo_';
const LINK = `<a href="${URL}">${URL}</a>`;

const underscoreCases = [
    ['bare URL alone', `${URL}`, `<p>${LINK}</p>`],
    ['bare URL mid-sentence', `see ${URL} here`, `<p>see ${LINK} here</p>`],
    ['autolinked URL alone', `<${URL}>`, `<p>${LINK}</p>`],
    ['autolinked URL mid-sentence', `see <${URL}> here`, `<p>see ${LINK} here</p>`],
    ['bare URL with `_` then a full stop', `see ${URL}.`, `<p>see ${LINK}.</p>`],
    ['bare www URL', 'see www.example.com/foo_ here', '<p>see <a href="http://www.example.com/foo_">www.example.com/foo_</a> here</p>'],
];

const punctuationCases = ['.', ',', '!', '?', ':', ';', '*', '~', '\'', '"'].map((mark) => [
    mark,
    `see https://example.com/foo${mark} here`,
    'https://example.com/foo',
]);

describe('renderMarkdown', () => {
    test.each(underscoreCases)('%s', (_name, input, expected) => {
        expect(String(renderMarkdown(input)).trim()).toBe(expected);
    });

    test.each(punctuationCases)('trailing %s stays out of the link', (_mark, input, href) => {
        expect(String(renderMarkdown(input))).toContain(`<a href="${href}">${href}</a>`);
    });
});

describe('renderMarkdownLiteralTags', () => {
    test.each(underscoreCases)('%s', (_name, input, expected) => {
        expect(renderMarkdownLiteralTags(input).trim()).toBe(expected);
    });
});

describe('messageFormatting', () => {
    test.each(underscoreCases)('%s', (_name, input, expected) => {
        expect(messageFormatting(input, 'Alice', false, false, -1)).toBe(expected);
    });
});
