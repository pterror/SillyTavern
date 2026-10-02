import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import * as lezerMarkdown from '@lezer/markdown';
import * as lezerHighlight from '@lezer/highlight';

jest.unstable_mockModule('../public/live-editor-lib.js', () => ({ lezerMarkdown, lezerHighlight }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (strings, ...values) => String.raw({ raw: strings }, ...values) }));

/** @type {typeof import('../public/scripts/live-editor/presets.js')} */
let presets;

beforeAll(async () => {
    presets = await import('../public/scripts/live-editor/presets.js');
});

describe('remove italics', () => {
    test.each([
        ['*a*', 'a'],
        ['_a_', 'a'],
        ['**a**', '**a**'],
        ['***a***', '***a***'],
        ['*__a__*', '*__a__*'],
        ['___a___', '___a___'],
        ['***a** b*', '**a** b'],
        ['*a **b***', 'a **b**'],
        ['x *y* `*code*` z', 'x y `*code*` z'],
        ['see https://x.com/*a*_b_ ok', 'see https://x.com/*a*_b_ ok'],
        ['a * b * c', 'a * b * c'],
    ])('%s', (input, expected) => {
        expect(presets.removeItalics(input)).toBe(expected);
    });
});

describe('typography to plain characters', () => {
    test('quotes, dashes and ellipses, but not in code or URLs', () => {
        expect(presets.typographyToAscii('“Hi” ‘there’ — «a» 「b」 『c』 ＂d＂ wait… `“code”` https://x.com/a—b'))
            .toBe('"Hi" \'there\' - "a" "b" "c" "d" wait... `“code”` https://x.com/a—b');
    });
});

describe('desloppify processors', () => {
    const run = (/** @type {string} */ name, /** @type {string} */ text, context = {}) => {
        const preset = presets.builtinPresets().find(p => p.name === name);
        return preset.run(text, context);
    };

    test('smart quotes are all replaced (desloppify\'s regex only caught ’g)', () => {
        expect(run('Replace Smart Quotes', 'it’s “x” ‘y’ «z»')).toBe('it\'s "x" \'y\' "z"');
    });

    test('W++ becomes a plain field', () => {
        expect(run('Remove W++', '[Personality("kind" + "brave")]')).toBe('Personality: kind, brave');
    });

    test('the character\'s name becomes {{char}}', () => {
        expect(run('Replace Name With {{char}}', 'Anna likes Annabel and anna.', { characterName: 'Anna' })).toBe('{{char}} likes Annabel and {{char}}.');
    });

    test('line processors that drop lines drop them', () => {
        expect(run('Strip Empty Lines', 'a\n\nb')).toBe('a\nb');
        expect(run('Remove Horizontal Rules', 'a\n---\nb')).toBe('a\nb');
    });

    test('the defaults run as desloppify runs them', () => {
        const text = '  [Character("Anna")]\n{{char}}\'s_hair_color: red;\n\n\n\nspecies: human\nShe says “hi” — often.  ';
        expect(run('Clean up character definitions (all of the below, in order)', text, { characterName: 'Anna' }))
            .toBe('Name: {{char}}\nHair color: Red\n\nShe says "hi" - often.');
    });

    test('every built-in has a unique id', () => {
        const ids = presets.builtinPresets().map(p => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every(id => id.startsWith('builtin:'))).toBe(true);
    });
});
