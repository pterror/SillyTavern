import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { Marked } from 'marked';
import showdown from 'showdown';

// messageFormatting wraps quoted dialogue in <q> before markdown runs. A double-quoted title in link, image or
// reference-definition syntax is markdown, not dialogue, so it's left for marked to read as the title.
// messageFormatting's DOM-bound and app-wide imports are replaced; DOMPurify needs a window, so sanitize is the
// identity here.


jest.unstable_mockModule('../public/lib.js', () => ({
    Marked,
    showdown,
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

let messageFormatting;

beforeAll(async () => {
    ({ messageFormatting } = await import('../public/scripts/message-formatting.js'));
});

const titleCases = [
    ['link', '[a](https://example.com "t")', '<p><a href="https://example.com" title="t">a</a></p>'],
    ['image', '![a](u.png "t")', '<p><img src="u.png" alt="a" title="t"></p>'],
    ['sized image', '![a](u.png =100x80 "t")', '<p><img src="u.png" alt="a" title="t" width="100" height="80"></p>'],
    ['sized image, no space before the title', '![a](u.png =100x80"t")',
        '<p><img src="u.png" alt="a" title="t" width="100" height="80"></p>'],
    ['angle-bracket url', '![a](<u v.png> "t")', '<p><img src="u%20v.png" alt="a" title="t"></p>'],
    ['url with parentheses', '[a](u(1) "t")', '<p><a href="u(1)" title="t">a</a></p>'],
    ['escaped quotes in the title', '[a](u "say \\"hi\\"")', '<p><a href="u" title="say &quot;hi&quot;">a</a></p>'],
    ['title on the next line', '[a](u\n"t")', '<p><a href="u" title="t">a</a></p>'],
    ['two in a row', '[a](u "t") [b](v "s")', '<p><a href="u" title="t">a</a> <a href="v" title="s">b</a></p>'],
    ['reference definition', '[a][r] ![b][r]\n\n[r]: u.png "t"',
        '<p><a href="u.png" title="t">a</a> <img src="u.png" alt="b" title="t"></p>'],
    ['sized reference definition', '![a][r]\n\n[r]: u.png =100x80 "t"',
        '<p><img src="u.png" alt="a" title="t" width="100" height="80"></p>'],
    ['reference definition, title on the next line', '[a][r]\n\n[r]: u\n  "t"', '<p><a href="u" title="t">a</a></p>'],
];

const dialogueCases = [
    ['dialogue', 'He said "hi".', '<p>He said <q>&quot;hi&quot;</q>.</p>'],
    ['dialogue after a link', '[a](u) "hi"', '<p><a href="u">a</a> <q>&quot;hi&quot;</q></p>'],
    ['dialogue after a link, then a parenthesis', '[a](u) "hi")', '<p><a href="u">a</a> <q>&quot;hi&quot;</q>)</p>'],
    ['dialogue before a titled link', '"hi" [a](u "t")', '<p><q>&quot;hi&quot;</q> <a href="u" title="t">a</a></p>'],
    ['dialogue in link text', '[say "hi"](u "t")', '<p><a href="u" title="t">say <q>&quot;hi&quot;</q></a></p>'],
];

describe('messageFormatting', () => {
    test.each(titleCases)('%s keeps its title', (_name, input, expected) => {
        expect(messageFormatting(input, 'Alice', false, false, -1)).toBe(expected);
    });

    test.each(dialogueCases)('%s is still quoted', (_name, input, expected) => {
        expect(messageFormatting(input, 'Alice', false, false, -1)).toBe(expected);
    });
});
