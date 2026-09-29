import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { Marked } from 'marked';

// A URL ending in `_` keeps the `_` in its link, for bare URLs and `<...>` autolinks, alone and mid-sentence.
// Other trailing punctuation stays out of a bare URL's link, as GFM's extended-autolink rule says.
// Checked on both marked processors and through messageFormatting (the chat render path). messageFormatting's
// DOM-bound and app-wide imports are replaced; DOMPurify needs a window, so sanitize is the identity here.
// fixMarkdown is the identity: it only acts on paired `*`/`_` and odd `*`/`"`, which none of these inputs have.

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
        auto_fix_generated_markdown: true,
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
