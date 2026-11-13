import { expect, test } from 'vite-plus/test';
import { lookCss, lookPlacementCss, markCss, markShown } from '@st/protocol/looks';
import {
    MAX_USES,
    declarationsOfCss,
    isRefusal,
    resolveLevels,
    resolveMark,
    sanitizeDeclaration,
    storedLook,
    storedMark,
} from './look.ts';
import type { StoredLook } from './look.ts';

const HASH = 'a'.repeat(64);
const FONT = `${HASH}.woff2`;
const ok = (property: string, value: string, fonts: ReadonlySet<string> | 'any' = new Set()) => {
    const d = sanitizeDeclaration(property, value, fonts);
    if (isRefusal(d)) throw new Error(`${property}: ${value} refused: ${d.why}`);
    return d;
};
const refused = (property: string, value: string, fonts: ReadonlySet<string> | 'any' = new Set()) =>
    isRefusal(sanitizeDeclaration(property, value, fonts));

test('colors, gradients and text clipped to a background are kept as written, spaces folded', () => {
    expect(ok('color', 'rgb(200 10 10 / 50%)')).toEqual({ property: 'color', value: 'rgb(200 10 10 / 50%)' });
    expect(ok('Color', '  #c0ffee ')).toEqual({ property: 'color', value: '#c0ffee' });
    expect(ok('color', 'var(--SmartThemeQuoteColor)').value).toBe('var(--SmartThemeQuoteColor)');
    expect(ok('background-image', 'linear-gradient(90deg, gold, oklch(70% 0.1 200))').property).toBe(
        'background-image',
    );
    expect(ok('background-image', 'url("https://example.com/a.png")').value).toBe('url("https://example.com/a.png")');
    expect(refused('background-image', 'url(data:image/png;base64,AAAA)')).toBe(true);
    expect(ok('background-image', 'url("data:image/png;base64,AAAA")')).toBeTruthy();
    expect(ok('background-clip', 'text').value).toBe('text');
    expect(ok('-webkit-text-fill-color', 'transparent').value).toBe('transparent');
    expect(refused('color', '#abcde')).toBe(true);
    expect(refused('background-clip', 'margin-box')).toBe(true);
});

test('glow, outline, shadow, blur and underline keep to what draws on the span itself', () => {
    expect(ok('text-shadow', '0 0 4px gold, 1px 1px 0 rgba(0, 0, 0, 0.5)')).toBeTruthy();
    expect(ok('filter', 'drop-shadow(0 0 2px red) blur(0.5px)')).toBeTruthy();
    expect(ok('filter', 'none')).toBeTruthy();
    expect(refused('filter', 'grayscale(1)')).toBe(true);
    expect(refused('filter', 'url(#f)')).toBe(true);
    expect(ok('-webkit-text-stroke', '1px black')).toBeTruthy();
    expect(ok('paint-order', 'stroke fill')).toBeTruthy();
    expect(ok('text-decoration-line', 'underline')).toBeTruthy();
    for (const style of ['solid', 'double', 'wavy']) expect(ok('text-decoration-style', style)).toBeTruthy();
    expect(refused('text-decoration-style', 'dotted')).toBe(true);
    expect(refused('text-decoration-style', 'dashed')).toBe(true);
    expect(refused('text-decoration', 'underline dotted')).toBe(true);
    expect(ok('text-decoration-thickness', '2px')).toBeTruthy();
});

test('letters: spacing within bounds, weight, italic, small capitals', () => {
    expect(ok('letter-spacing', '0.1em')).toBeTruthy();
    expect(ok('word-spacing', '4px')).toBeTruthy();
    expect(refused('letter-spacing', '3em')).toBe(true);
    expect(refused('letter-spacing', '500px')).toBe(true);
    expect(refused('letter-spacing', '10vw')).toBe(true);
    expect(ok('font-weight', '650')).toBeTruthy();
    expect(ok('font-weight', 'bold')).toBeTruthy();
    expect(refused('font-weight', '2000')).toBe(true);
    expect(ok('font-style', 'italic')).toBeTruthy();
    expect(ok('font-variant-caps', 'small-caps')).toBeTruthy();
    expect(ok('opacity', '0.6')).toBeTruthy();
    expect(refused('opacity', '2')).toBe(true);
});

test("a typeface is one of the app's fonts or one of the thing's world's", () => {
    expect(ok('font-family', 'noto-sans, serif')).toEqual({ property: 'font-family', value: 'noto-sans, serif' });
    expect(ok('font-family', `"${FONT}", sans-serif`, new Set([FONT]))).toBeTruthy();
    expect(refused('font-family', `"${FONT}"`)).toBe(true);
    expect(ok('font-family', `"${FONT}"`, 'any')).toBeTruthy();
    expect(refused('font-family', 'Comic Sans MS')).toBe(true);
    expect(refused('font-family', 'noto-sans, noto-sans-mono')).toBe(true);
    expect(refused('font-family', `${FONT}`, 'any')).toBe(true);
});

test("motion only by the app's animations", () => {
    expect(ok('animation-name', 'shimmer')).toBeTruthy();
    expect(ok('animation-duration', '2s')).toBeTruthy();
    expect(ok('animation-timing-function', 'cubic-bezier(0.2, 0, 0.2, 1)')).toBeTruthy();
    expect(ok('animation-iteration-count', 'infinite')).toBeTruthy();
    expect(refused('animation-name', 'spin')).toBe(true);
    expect(refused('animation', 'shimmer 2s')).toBe(true);
});

test('nothing that moves or sizes the span, or reaches past it, is stored', () => {
    for (const [property, value] of [
        ['position', 'absolute'],
        ['margin', '0'],
        ['padding', '4px'],
        ['display', 'block'],
        ['width', '10px'],
        ['height', '10px'],
        ['font-size', '40px'],
        ['line-height', '3'],
        ['transform', 'scale(2)'],
        ['content', '"x"'],
        ['--x', 'red'],
        ['background', 'red'],
        ['top', '0'],
        ['z-index', '9'],
    ])
        expect(refused(property as string, value as string), property).toBe(true);
});

test('hostile values are refused: comments, escapes, injections, scripts, at-rules', () => {
    expect(refused('color', 'red /* */')).toBe(true);
    expect(refused('color', 'red; position: fixed')).toBe(true);
    expect(refused('color', 'red} body { display: none')).toBe(true);
    expect(refused('color', 'red !important')).toBe(true);
    expect(refused('color', '\\72 ed')).toBe(true);
    expect(refused('color', 'expression(alert(1))')).toBe(true);
    expect(refused('color', 'red‮')).toBe(true);
    expect(refused('color', '@import url(x)')).toBe(true);
    expect(refused('color', 'attr(title)')).toBe(true);
    expect(refused('background-image', 'url(javascript:alert(1))')).toBe(true);
    expect(refused('background-image', 'url("javascript:alert(1)")')).toBe(true);
    expect(refused('background-image', 'url(a) b) ;')).toBe(true);
    expect(refused('background-image', 'url("a" ) )')).toBe(true);
    expect(refused('background-image', 'url(a b)')).toBe(true);
    expect(refused('background-image', 'url("x\\"); }")')).toBe(true);
    expect(refused('background-image', "url('x'\")")).toBe(true);
    expect(refused('background-image', 'image-set("a.png" 1x)')).toBe(true);
    expect(refused('background-image', 'url(data:text/html,x)')).toBe(true);
    expect(refused('col\\6fr', 'red')).toBe(true);
    expect(refused('cоlor', 'red')).toBe(true);
    expect(refused('color', 'rgb(1, 2, 3')).toBe(true);
    expect(refused('color', 'red)')).toBe(true);
    expect(refused('color', '"red"')).toBe(true);
    expect(refused('color', '')).toBe(true);
});

test('CSS text is read as declarations only', () => {
    expect(declarationsOfCss('color: red; /* glow */ text-shadow: 0 0 2px gold')).toEqual([
        { property: 'color', value: 'red' },
        { property: 'text-shadow', value: '0 0 2px gold' },
    ]);
    expect(declarationsOfCss('color: red } body { color: blue')).toHaveProperty('refused');
    expect(declarationsOfCss('@import url(x); color: red')).toHaveProperty('refused');
    expect(declarationsOfCss('@media print { color: red }')).toHaveProperty('refused');
    expect(declarationsOfCss('')).toEqual([]);
});

test('a stored look keeps what passes, says what was refused, and is no look in another shape', () => {
    const { look, refused: out } = storedLook(
        {
            rest: [
                { property: 'color', value: 'red' },
                { property: 'position', value: 'fixed' },
                { property: 'color', value: 'blue' },
            ],
            selected: [{ property: 'font-weight', value: 'bold' }],
            picture: { before: true, sideways: 3 },
            note: 'the heir',
            uses: ['00000000-0000-4000-8000-000000000001', 'not an id', '00000000-0000-4000-8000-000000000001'],
        },
        new Set(),
    );
    expect(look).toEqual({
        rest: [{ property: 'color', value: 'blue' }],
        selected: [{ property: 'font-weight', value: 'bold' }],
        picture: { before: true },
        note: 'the heir',
        uses: ['00000000-0000-4000-8000-000000000001'],
    });
    expect(out).toEqual([{ property: 'position', value: 'fixed', why: 'a look may not set this property' }]);
    expect(storedLook('red', new Set()).look).toBeNull();
    expect(storedLook({ rest: 'color: red' }, new Set()).look).toBeNull();
    const many = Array.from({ length: MAX_USES + 2 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    expect(storedLook({ uses: many }, new Set()).look?.uses).toHaveLength(MAX_USES);
});

test('levels resolve theme first and the thing last, per layer and per property', () => {
    const theme: StoredLook = { rest: [{ property: 'color', value: 'gray' }], picture: { before: true } };
    const world: StoredLook = {
        rest: [
            { property: 'color', value: 'teal' },
            { property: 'font-style', value: 'italic' },
        ],
    };
    const shared: StoredLook = {
        wordPointed: [{ property: 'text-shadow', value: '0 0 4px gold' }],
        note: 'house',
    };
    const thing: StoredLook = {
        rest: [{ property: 'font-family', value: `"${FONT}"` }],
        picture: { before: false, after: true },
        note: '',
    };
    const resolved = resolveLevels([theme, world, shared, thing]);
    expect(resolved.layers).toEqual({
        rest: [
            { property: 'color', value: 'teal' },
            { property: 'font-style', value: 'italic' },
            { property: 'font-family', value: `"look-font-${HASH.slice(0, 16)}"` },
        ],
        wordPointed: [{ property: 'text-shadow', value: '0 0 4px gold' }],
    });
    expect(resolved.picture).toEqual({ before: false, after: true, crop: null, image: null });
    expect(resolved.note).toBeNull();
    expect(resolved.fonts).toEqual([
        { family: `look-font-${HASH.slice(0, 16)}`, url: `/fonts/${FONT}`, format: 'woff2' },
    ]);
    expect(resolveLevels([world, theme]).layers.rest?.[0]).toEqual({ property: 'font-style', value: 'italic' });
    expect(resolveLevels([{ rest: [{ property: 'font-family', value: 'noto-sans' }] }]).layers.rest).toEqual([
        { property: 'font-family', value: '"Noto Sans"' },
    ]);
    expect(resolveLevels([{ rest: [{ property: 'animation-name', value: 'shimmer' }] }]).layers.rest).toEqual([
        { property: 'animation-name', value: 'look-shimmer' },
    ]);
});

test('the rules put each state above rest in order, at the specificity of one class', () => {
    const css = lookCss('42', {
        layers: {
            rest: [{ property: 'color', value: 'teal' }],
            messagePointed: [{ property: 'color', value: 'gold' }],
            wordPointed: [{ property: 'text-shadow', value: '0 0 2px gold' }],
            selected: [{ property: 'color', value: 'white' }],
        },
        picture: { before: false, after: false, crop: null, image: null },
        note: null,
        fonts: [],
    });
    expect(css.split('\n')).toEqual([
        '.look-42 { color: teal; }',
        ':where(.look-scope:hover, .look-scope:focus-within, .look-shows-message-pointed) .look-42 { color: gold; }',
        '.look-42:where(:hover, :focus-visible, .look-shows-word-pointed *) { text-shadow: 0 0 2px gold; }',
        '.look-42:where([data-selected]) { color: white; }',
    ]);
});

test("a small picture shows a crop of the thing's own picture, or another image, kept only when well formed", () => {
    const image = `${'ab'.repeat(32)}.png`;
    const kept = storedLook(
        { picture: { before: true, crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.4 }, image: '../secret.png' } },
        'any',
    );
    expect(kept.look?.picture).toEqual({ before: true, crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.4 } });
    for (const crop of [
        { x: 0.8, y: 0, width: 0.5, height: 0.5 },
        { x: 0, y: 0, width: 0.01, height: 0.5 },
        { x: -0.1, y: 0, width: 0.5, height: 0.5 },
        { x: 0, y: 0, width: '1', height: 1 },
    ])
        expect(storedLook({ picture: { crop } }, 'any').look).toEqual({});
    const resolved = resolveLevels([
        { picture: { before: true, crop: { x: 0, y: 0, width: 1, height: 1 } } },
        { picture: { image, crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } } },
    ]);
    expect(resolved.picture).toEqual({
        before: true,
        after: false,
        crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
        image: `/look-images/${image}`,
    });
    expect(lookPlacementCss('7', resolved).split('\n')).toEqual([
        '.look-box-7 > .name-picture-before { display: inline-block; }',
        '.look-box-7.name-inline::before { display: inline-block; }',
        `.look-box-7 > .name-picture, .look-box-7.name-inline::before, .look-box-7.name-inline > .named::after { background-image: url("/look-images/${image}"); background-size: 200% 200%; background-position: 100% 100%; }`,
    ]);
});

test('the trigger mark is dotted in the text color at rest, and each state is its own settings over those below', () => {
    expect(resolveMark({})).toEqual({
        rest: { style: 'dotted', color: 'currentColor', opacity: 1 },
        messagePointed: { style: 'dotted', color: 'currentColor', opacity: 1 },
        wordPointed: { style: 'dotted', color: 'currentColor', opacity: 1 },
    });
    const pointing = resolveMark({ rest: { style: 'none' }, messagePointed: { style: 'dotted', opacity: 0.5 } });
    expect(pointing.rest).toEqual({ style: 'none', color: 'currentColor', opacity: 1 });
    expect(pointing.messagePointed).toEqual({ style: 'dotted', color: 'currentColor', opacity: 0.5 });
    expect(pointing.wordPointed).toEqual(pointing.messagePointed);
    const word = resolveMark({ rest: { style: 'dashed', color: '#ff0000' }, wordPointed: { style: 'large-dots' } });
    expect(word.messagePointed).toEqual({ style: 'dashed', color: '#ff0000', opacity: 1 });
    expect(word.wordPointed).toEqual({ style: 'large-dots', color: '#ff0000', opacity: 1 });
});

test("a stored mark keeps only a mark's settings: its styles, a color the sanitizer lets in, an opacity from 0 to 1", () => {
    expect(
        storedMark({
            rest: { style: 'dashed', color: ' #00ff00 ', opacity: 0.4, width: 9 },
            messagePointed: { style: 'wavy', color: 'red; position: fixed', opacity: 2 },
            selected: { style: 'none' },
        }),
    ).toEqual({ rest: { style: 'dashed', color: '#00ff00', opacity: 0.4 } });
    expect(storedMark('dotted')).toEqual({});
});

test("the mark's rules are the mark class's, at no specificity, the states in order; none draws no line", () => {
    const css = markCss(resolveMark({ rest: { style: 'none' }, messagePointed: { style: 'dashed', opacity: 0.5 } }));
    const [rest, message, word] = css.split('\n');
    expect(rest).toBe(':where(.trigger-mark) { text-decoration-line: none; }');
    expect(message).toMatch(
        /^:where\(\.look-scope:hover, \.look-scope:focus-within, \.look-shows-message-pointed\) :where\(\.trigger-mark\) \{/,
    );
    expect(message).toContain('text-decoration-style: dashed;');
    expect(message).toContain('text-decoration-color: color-mix(in srgb, currentColor 50%, transparent);');
    expect(word).toMatch(
        /^:where\(\.trigger-mark:hover, \.trigger-mark:focus-visible, \.look-shows-word-pointed \.trigger-mark\)/,
    );
    const large = markCss(resolveMark({ rest: { style: 'large-dots' } }));
    expect(large).toContain(
        'text-decoration-style: dotted; text-decoration-color: currentColor; text-decoration-thickness: 0.2em;',
    );
});

test('a mark no state draws is not drawn', () => {
    expect(markShown(resolveMark({}))).toBe(true);
    expect(markShown(resolveMark({ rest: { style: 'none' }, messagePointed: { style: 'dotted' } }))).toBe(true);
    expect(markShown(resolveMark({ rest: { style: 'none' } }))).toBe(false);
});
