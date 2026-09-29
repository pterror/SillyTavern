import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { Marked } from 'marked';
import showdown from 'showdown';

// Image sizes: `![alt](url =WxH)` renders an img with width/height, as upstream's showdown `parseImgDimensions` does.
// Each side is a number plus an optional CSS unit (px, %, em, rem, vw, vh, ch, ex, pt, pc, cm, mm, in), or `*` for
// auto. `=W` and `=Wx` are width-only, `=xH` height-only; an `x` is the separator only when it isn't part of a unit.
// Anything else after ` =` leaves the whole thing as text. Reference definitions take a size too.
// Checked on both marked processors and through messageFormatting (the chat render path). messageFormatting's
// DOM-bound and app-wide imports are replaced; DOMPurify needs a window, so sanitize is the identity here.
// Titles are single-quoted: messageFormatting wraps double-quoted text in <q> before markdown runs, as upstream does.

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

let renderMarkdown;
let renderMarkdownLiteralTags;
let messageFormatting;

beforeAll(async () => {
    ({ renderMarkdown, renderMarkdownLiteralTags } = await import('../public/scripts/marked-processor.js'));
    ({ messageFormatting } = await import('../public/scripts/message-formatting.js'));
});

const sizedCases = [
    ['width and height', '![a](u.png =100x80)', '<p><img src="u.png" alt="a" width="100" height="80"></p>'],
    ['`*` height is auto', '![a](u.png =100x*)', '<p><img src="u.png" alt="a" width="100" height="auto"></p>'],
    ['`*` width is auto', '![a](u.png =*x80)', '<p><img src="u.png" alt="a" width="auto" height="80"></p>'],
    ['`=Wx` is width-only', '![a](u.png =100x)', '<p><img src="u.png" alt="a" width="100"></p>'],
    ['`=xH` is height-only', '![a](u.png =x80)', '<p><img src="u.png" alt="a" height="80"></p>'],
    ['`=W` is width-only', '![a](u.png =100)', '<p><img src="u.png" alt="a" width="100"></p>'],
    ['`=Wpx` is width-only', '![a](u.png =100px)', '<p><img src="u.png" alt="a" width="100px"></p>'],
    ['units on both sides', '![a](u.png =100pxx80%)', '<p><img src="u.png" alt="a" width="100px" height="80%"></p>'],
    ['`ex` unit then separator', '![a](u.png =1exx2ex)', '<p><img src="u.png" alt="a" width="1ex" height="2ex"></p>'],
    ['`ex` unit alone', '![a](u.png =1ex)', '<p><img src="u.png" alt="a" width="1ex"></p>'],
    ['longest unit first', '![a](u.png =2remx3em)', '<p><img src="u.png" alt="a" width="2rem" height="3em"></p>'],
    ['every unit', '![a](u.png =1vwx2vh) ![b](u.png =3chx4pt) ![c](u.png =5pcx6cm) ![d](u.png =7mmx8in)',
        '<p><img src="u.png" alt="a" width="1vw" height="2vh"> <img src="u.png" alt="b" width="3ch" height="4pt"> '
        + '<img src="u.png" alt="c" width="5pc" height="6cm"> <img src="u.png" alt="d" width="7mm" height="8in"></p>'],
    ['decimal numbers', '![a](u.png =1.5emx.5em)', '<p><img src="u.png" alt="a" width="1.5em" height=".5em"></p>'],
    ['units in any case', '![a](u.png =100PXx2Em)', '<p><img src="u.png" alt="a" width="100PX" height="2Em"></p>'],
    ['with a title', '![a](u.png =100x80 \'t\')', '<p><img src="u.png" alt="a" title="t" width="100" height="80"></p>'],
    ['with a title and no space', '![a](u.png =100x80\'t\')', '<p><img src="u.png" alt="a" title="t" width="100" height="80"></p>'],
    ['angle-bracket url', '![a](<u v.png> =100x80)', '<p><img src="u%20v.png" alt="a" width="100" height="80"></p>'],
    ['mid-sentence', 'see ![a](u.png =100x80) here', '<p>see <img src="u.png" alt="a" width="100" height="80"> here</p>'],
    ['inside a link', '[![a](u.png =10x20)](https://example.com)',
        '<p><a href="https://example.com"><img src="u.png" alt="a" width="10" height="20"></a></p>'],
    ['alt with markdown', '![*a* b](u.png =10x20)', '<p><img src="u.png" alt="a b" width="10" height="20"></p>'],
    ['reference', '![a][r]\n\n[r]: u.png =100x80 \'t\'', '<p><img src="u.png" alt="a" title="t" width="100" height="80"></p>'],
    ['reference shortcut', '![r] ![r][]\n\n[r]: u.png =100x', '<p><img src="u.png" alt="r" width="100"> <img src="u.png" alt="r" width="100"></p>'],
    ['first reference definition wins', '![a][r]\n\n[r]: u.png =1x2\n[r]: v.png =3x4', '<p><img src="u.png" alt="a" width="1" height="2"></p>'],
    ['first reference definition wins over a sized one', '![a][r]\n\n[r]: u.png\n[r]: v.png =3x4', '<p><img src="u.png" alt="a"></p>'],
];

const unchangedCases = [
    ['plain image', '![a](u.png)', '<p><img src="u.png" alt="a"></p>'],
    ['plain image with title', '![a](u.png \'t\')', '<p><img src="u.png" alt="a" title="t"></p>'],
    ['plain reference', '![a][r]\n\n[r]: u.png', '<p><img src="u.png" alt="a"></p>'],
    ['uppercase separator', '![a](u.png =100X80)', '<p>![a](u.png =100X80)</p>'],
    ['two spaces before `=`', '![a](u.png  =100x80)', '<p>![a](u.png  =100x80)</p>'],
    ['no sides', '![a](u.png =x)', '<p>![a](u.png =x)</p>'],
    ['nothing after `=`', '![a](u.png =)', '<p>![a](u.png =)</p>'],
    ['unknown unit', '![a](u.png =100foo)', '<p>![a](u.png =100foo)</p>'],
    ['unknown unit on height', '![a](u.png =100x80qq)', '<p>![a](u.png =100x80qq)</p>'],
    ['text after a unit', '![a](u.png =1ex2)', '<p>![a](u.png =1ex2)</p>'],
    ['not a number', '![a](u.png =abc)', '<p>![a](u.png =abc)</p>'],
    ['a link, not an image', '[a](u.png =100x80)', '<p>[a](u.png =100x80)</p>'],
    ['code span', '`![a](u.png =100x80)`', '<p><code>![a](u.png =100x80)</code></p>'],
];

describe('renderMarkdown', () => {
    test.each(sizedCases)('%s', (_name, input, expected) => {
        expect(String(renderMarkdown(input)).trim()).toBe(expected);
    });

    test.each(unchangedCases)('%s renders as before', (_name, input, expected) => {
        expect(String(renderMarkdown(input)).trim()).toBe(expected);
    });

    test('a url that can\'t be encoded renders the alt text, as a plain image does', () => {
        expect(String(renderMarkdown('![a](u\uD800.png =10x20)')).trim()).toBe('<p>a</p>');
        expect(String(renderMarkdown('![a](u\uD800.png)')).trim()).toBe('<p>a</p>');
    });
});

describe('renderMarkdownLiteralTags', () => {
    test.each(sizedCases)('%s', (_name, input, expected) => {
        expect(renderMarkdownLiteralTags(input).trim()).toBe(expected);
    });

    test.each(unchangedCases)('%s renders as before', (_name, input, expected) => {
        expect(renderMarkdownLiteralTags(input).trim()).toBe(expected);
    });
});

describe('messageFormatting', () => {
    test.each(sizedCases)('%s', (_name, input, expected) => {
        expect(messageFormatting(input, 'Alice', false, false, -1)).toBe(expected);
    });

    test.each(unchangedCases)('%s renders as before', (_name, input, expected) => {
        expect(messageFormatting(input, 'Alice', false, false, -1)).toBe(expected);
    });
});
