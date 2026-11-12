import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:8000/' });
globalThis.window = /** @type {any} */ (window);
globalThis.document = /** @type {any} */ (window.document);
globalThis.location = /** @type {any} */ (window.location);

jest.unstable_mockModule('../public/lib.js', async () => {
    const { default: createDOMPurify } = await import('dompurify');
    const { default: css } = await import('@adobe/css-tools');
    const { default: hljs } = await import('highlight.js');
    const { reader } = await import('@pterror/interact-editor/reader');
    const { markdownGrammar } = await import('@pterror/interact-markdown/grammar');
    const { markdownLook } = await import('@pterror/interact-markdown/look');
    return { DOMPurify: createDOMPurify(/** @type {any} */ (window)), css, hljs, reader, markdownGrammar, markdownLook };
});
/** @type {import('../public/scripts/macro-pill.js').Translate} */
const translate = (strings, ...values) => String.raw({ raw: strings }, ...values);

/** @type {typeof import('../public/scripts/chat-text/surface.js')} */
let surface;
/** @type {typeof import('../public/scripts/chat-text/policy.js')} */
let policy;
/** @type {typeof import('../public/scripts/chat-text/macros.js')} */
let macros;
/** @type {typeof import('../public/scripts/chat-text/fade-in.js')} */
let fade;
/** @type {typeof import('../public/scripts/chat-text/lore-marks.js')} */
let lore;
/** @type {typeof import('../public/scripts/hash-utils.js')} */
let hashes;

beforeAll(async () => {
    surface = await import('../public/scripts/chat-text/surface.js');
    policy = await import('../public/scripts/chat-text/policy.js');
    macros = await import('../public/scripts/chat-text/macros.js');
    fade = await import('../public/scripts/chat-text/fade-in.js');
    lore = await import('../public/scripts/chat-text/lore-marks.js');
    hashes = await import('../public/scripts/hash-utils.js');
});

/**
 * @param {readonly import('@pterror/interact-editor/reader').Range[]} ranges
 * @returns {import('@pterror/interact-editor/reader').Overlay}
 */
const overlayOf = ranges => ({ ranges: () => ranges, watch: () => () => undefined });

/**
 * @param {{ mediaAllowed?: boolean, autoplay?: boolean, values?: Record<string, string | null>, grammar?: object }} [options]
 * @returns {import('../public/scripts/chat-text/surface.js').TextSetup}
 */
function setup({ mediaAllowed = true, autoplay = false, values = {}, grammar = {} } = {}) {
    return {
        key: JSON.stringify([mediaAllowed, autoplay, values, grammar]),
        grammar: { dialogueQuotes: true, ...grammar },
        html: policy.chatHtmlPolicy({ mediaAllowed: () => mediaAllowed, autoplay: () => autoplay, styleScope: '.mes_text ' }),
        macro: macros.macroValuePieces({ get: source => values[source], wantMacros: async () => undefined }, () => null, translate),
    };
}

/**
 * @param {string} text
 * @param {Parameters<typeof setup>[0]} [options]
 * @returns {string} what the reader draws for the text
 */
function drawn(text, options) {
    return surface.drawnText(text, setup(options)).innerHTML;
}

describe('chat text, read', () => {
    test('draws the text as written: a single line break stays one, nothing is trimmed', () => {
        expect(drawn('one\ntwo')).toBe('<p>one\ntwo</p>');
        expect(drawn('a\n\nb')).toBe('<p>a</p><p>b</p>');
    });

    test('draws dialogue quotes with their quote marks', () => {
        expect(drawn('He said "hi" and «salut».')).toBe('<p>He said <q>"hi"</q> and <q>«salut»</q>.</p>');
        expect(drawn('"open\nclose"')).toBe('<p>"open\nclose"</p>');
    });

    test('draws `~` and `~~` strikethrough and bare URLs as links opening a new tab', () => {
        expect(drawn('a ~b~ ~~c~~')).toBe('<p>a <del>b</del> <del>c</del></p>');
        expect(drawn('see https://x.y/z_.')).toBe('<p>see <a href="https://x.y/z_" target="_blank" rel="noopener">https://x.y/z_</a>.</p>');
    });

    test('draws emoji shortcodes, and leaves unknown ones as written', () => {
        expect(drawn('ok :+1: :nope:')).toBe('<p>ok <span>👍</span> :nope:</p>');
    });

    test('draws a macro as its value, one known only when sent as what it is, and none as written', () => {
        const values = { '{{user}}': 'Ann', '{{random::a::b}}': null, '{{// note}}': '' };
        expect(drawn('{{user}} {{random::a::b}} {{// note}}', { values })).toBe(
            '<p><span class="macro-value macro-value-mention" data-macro-name="user" data-macro-source="{{user}}">Ann</span> '
            + '<span class="macro-value macro-value-later" data-macro-name="random" data-macro-source="{{random::a::b}}" data-macro-note="Filled in when sent">random · a · b</span> '
            + '<span class="macro-value macro-value-empty" data-macro-name="//" data-macro-source="{{// note}}" data-macro-note="Sends nothing">// note</span></p>',
        );
    });

    test('draws images at their written size, and an unsized one in the fixed box', () => {
        expect(drawn('![a](i.png =100x50)')).toBe('<p><img alt="a" src="i.png" width="100" height="50"></p>');
        expect(drawn('![a](i.png)')).toBe('<p><img alt="a" src="i.png" data-unsized=""></p>');
    });

    test('hides media from other sites unless it is allowed', () => {
        expect(drawn('![a](https://e.x/i.png)', { mediaAllowed: false })).toBe('<p><img hidden=""></p>');
        expect(drawn('<video src="https://e.x/v.mp4"></video>', { mediaAllowed: false })).toBe('<div class="html-block"><video hidden=""></video></div>');
        expect(drawn('<video src="https://e.x/v.mp4" autoplay></video>')).toBe('<div class="html-block"><video src="https://e.x/v.mp4"></video></div>');
        expect(drawn('<video src="v.mp4" autoplay></video>', { autoplay: true })).toBe('<div class="html-block"><video src="v.mp4" autoplay=""></video></div>');
    });

    test('prefixes classes, keeps icon classes, and draws refused elements and attributes as written', () => {
        expect(drawn('a <span class="big fa-solid">b</span>')).toBe('<p>a <span class="custom-big fa-solid">b</span></p>');
        expect(drawn('<b onclick="x()">b</b>')).toBe('<p><b>b</b></p>');
        expect(drawn('x <script>alert(1)</script>')).toBe('<p>x &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    });

    test('limits a style element to message text, without imports', () => {
        expect(drawn('<style>@import url(x.css);\n.box { color: red }</style>')).toBe(
            '<div class="html-block"><style>.mes_text .custom-box {\n  color: red;\n}</style></div>',
        );
    });

    test('draws an HTML block with HTML whitespace, and one with a markdown attribute with markdown inside', () => {
        expect(drawn('<div class="k">\n\n  <i>x</i>\n\n</div>')).toBe('<div class="html-block"><div class="custom-k">\n  <i>x</i>\n</div></div>');
        expect(drawn('<div markdown="1">\n*hi*\n</div>')).toBe('<div><p><em>hi</em></p></div>');
    });

    test('draws the HTML after a comment on its line', () => {
        expect(drawn('<!-- note --><div>third</div>')).toBe('<div class="html-block"><div>third</div></div>');
    });

    test('with tags shown as text, draws HTML as written', () => {
        expect(drawn('a <b>b</b>', { grammar: { encodeTags: true } })).toBe('<p>a &lt;b&gt;b&lt;/b&gt;</p>');
    });

    test('draws reasoning markers in a body as text', () => {
        const grammar = { reasoningMarkers: ['<think>', '</think>'] };
        expect(drawn('<think>\n*plan*\n</think>\nreply', { grammar })).toBe('<p>&lt;think&gt;</p><p><em>plan</em></p><p>&lt;/think&gt;</p><p>reply</p>');
        expect(drawn('a <think> b', { grammar })).toBe('<p>a &lt;think&gt; b</p>');
    });

    test('keeps the escaped lines out of markdown', () => {
        expect(drawn('***\n---', { grammar: { escapeLines: ['***'] } })).toBe('<p>***</p><hr>');
    });

    test('draws code blocks highlighted', () => {
        expect(drawn('```js\nlet x = 1\n```')).toBe(
            '<pre data-language="js"><code class="hljs"><span class="hljs-keyword">let</span> x = <span class="hljs-number">1</span></code></pre>',
        );
    });
});

describe('chat text, with ranges drawn over it', () => {
    test('lore marks land on the words activation matched, each part with every entry matched over it', () => {
        const text = 'She lit the *old lantern* by the harbour.';
        const at = (/** @type {string} */ word) => [text.indexOf(word), text.indexOf(word) + word.length];
        const of = hashes.getStringHash(text);
        const reply = {
            node_id: 'r',
            extra: {
                activations: {
                    entries: [
                        { keys: [{ in: [{ node: 'm', of, spans: [at('old lantern')] }] }] },
                        { keys: [{ in: [{ node: 'm', of, spans: [at('lantern'), at('harbour')] }] }] },
                    ],
                },
            },
        };
        const ranges = lore.loreMarkRanges(reply, 'm', text);
        const shown = surface.drawnText(text, { ...setup(), overlays: () => [overlayOf(ranges)] });
        expect([...shown.querySelectorAll('.lore-mark')].map(mark => [mark.textContent, mark.getAttribute('data-lore')])).toEqual([
            ['old ', '0'],
            ['lantern', '0 1'],
            ['harbour', '1'],
        ]);
        expect(shown.querySelector('em')?.textContent).toBe('old lantern');
        expect(lore.loreMarkRanges(reply, 'm', `${text} more`)).toEqual([]);
    });

    test('search matches are drawn over the parts matched, across the elements they cross', () => {
        const shown = surface.drawnText('a **bold** word', { ...setup(), overlays: () => [overlayOf([{ from: 4, to: 13, class: 'match' }])] });
        expect(shown.innerHTML).toBe('<p>a <strong><span class="match">bold</span></strong><span class="match"> wo</span>rd</p>');
    });

    test('a link title is not dialogue', () => {
        expect(drawn('[a](u "quoted title")')).toBe('<p><a href="u" title="quoted title" target="_blank" rel="noopener">a</a></p>');
    });
});

describe('chat text, a place in it', () => {
    test('is the source position the reader drew there, past the markup and the macros before it', () => {
        const source = 'Some *em* and {{user}} **strong** target.';
        const shown = surface.drawnText(source, setup({ values: { '{{user}}': 'Ann' } }));
        const walker = document.createTreeWalker(shown, 4);
        /** @type {Node | null} */
        let node = walker.nextNode();
        while (node && !node.textContent?.includes('target')) node = walker.nextNode();
        expect(node && surface.sourcePositionAt(node, ' target'.indexOf('get'))).toBe(source.indexOf('get'));
        const value = shown.querySelector('.macro-value')?.firstChild;
        expect(value && surface.sourcePositionAt(value, 1)).toBe(source.indexOf('{{user}}'));
        expect(surface.sourcePositionAt(document.createTextNode('elsewhere'), 0)).toBeUndefined();
    });
});

describe('chat text, shown in a container', () => {
    test('a streamed reply redraws what it added, which fades in', () => {
        const container = document.createElement('div');
        const at = setup();
        surface.showText(container, 'first\n\nsec', at, { fade: true });
        const first = container.querySelector('p');
        surface.showText(container, 'first\n\nsecond', at, { fade: true });
        const [kept, last] = container.querySelectorAll('p');
        expect(kept).toBe(first);
        expect([...(last?.querySelectorAll('.text-fade-in') ?? [])].map(span => span.textContent)).toEqual(['sec', 'ond']);
    });

    test('nothing is appended to unclosed marks while streaming', () => {
        const container = document.createElement('div');
        surface.showText(container, 'a *b', setup());
        expect(container.innerHTML).toBe('<div class="chat-text"><p>a *b</p></div>');
    });

    test('a fade only covers what was added since', () => {
        const overlay = fade.fadeIn();
        overlay.added(0, 5);
        overlay.added(3, 8);
        expect(/** @type {any[]} */ (overlay.ranges(0, 8, /** @type {any} */ ({}))).map(r => [r.from, r.to])).toEqual([[3, 8]]);
    });
});
