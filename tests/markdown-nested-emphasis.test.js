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
let messageFormatting;

beforeAll(async () => {
    ({ renderMarkdown } = await import('../public/scripts/marked-processor.js'));
    ({ messageFormatting } = await import('../public/scripts/message-formatting.js'));
});

const emphasis = [
    ['italics holding bold', '*a **b** a*', '<p><em>a <strong>b</strong> a</em></p>'],
    ['bold followed by punctuation', '*a **b**, a*', '<p><em>a <strong>b</strong>, a</em></p>'],
    ['bold at the end', '*a **b***', '<p><em>a <strong>b</strong></em></p>'],
    ['bold at the start', '***b** a*', '<p><em><strong>b</strong> a</em></p>'],
    ['underscore italics', '_a **b** a_', '<p><em>a <strong>b</strong> a</em></p>'],
    ['underscore bold', '*a __b__ a*', '<p><em>a <strong>b</strong> a</em></p>'],
    ['bold holding italics', '**a *b* a**', '<p><strong>a <em>b</em> a</strong></p>'],
    ['side by side', '*a* **b** *a*', '<p><em>a</em> <strong>b</strong> <em>a</em></p>'],
    ['line break after the bold', '*a **b**\na*', '<p><em>a <strong>b</strong><br>a</em></p>'],
    ['line break before the bold', '*a\n**b** a*', '<p><em>a<br><strong>b</strong> a</em></p>'],
];

const literal = [
    ['spaced asterisks', 'a * b * c', '<p>a * b * c</p>'],
    ['a lone asterisk', '2 * 3', '<p>2 * 3</p>'],
    ['an unclosed asterisk', 'say *unclosed', '<p>say *unclosed</p>'],
];

const quoted = [
    ['quotes around italics', '"*a **b** a*"', '<p><q>&quot;<em>a <strong>b</strong> a</em>&quot;</q></p>'],
    ['italics around quotes', '*"a **b** a"*', '<p><em><q>&quot;a <strong>b</strong> a&quot;</q></em></p>'],
    ['an unclosed quote', 'say "unclosed', '<p>say &quot;unclosed</p>'],
];

describe('renderMarkdown', () => {
    test.each([...emphasis, ...literal])('%s', (_name, input, expected) => {
        expect(String(renderMarkdown(input)).trim()).toBe(expected);
    });
});

describe.each([['a character message', false], ['a user message', true]])('messageFormatting, %s', (_kind, isUser) => {
    test.each([...emphasis, ...literal, ...quoted])('%s', (_name, input, expected) => {
        expect(messageFormatting(input, 'Alice', false, isUser, -1)).toBe(expected);
    });
});
