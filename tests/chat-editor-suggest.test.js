import { describe, expect, jest, test, beforeAll } from '@jest/globals';

jest.unstable_mockModule('../public/scripts/autocomplete/MacroAutoCompleteHelper.js', () => ({ getMacroAutoCompleteAt: async () => null }));
jest.unstable_mockModule('../public/scripts/autocomplete/MacroAutoComplete.js', () => ({ MACRO_AUTOCOMPLETE_MODE: { ALWAYS: 'always' }, shouldActivateMacroAutocomplete: () => false }));

/** @type {typeof import('../public/scripts/chat-text/suggest.js')} */
let suggest;

beforeAll(async () => {
    suggest = await import('../public/scripts/chat-text/suggest.js');
});

/**
 * @param {string} text
 * @returns {(from: number, to: number) => string}
 */
const reader = text => (from, to) => text.slice(from, to);

describe('mention suggestions', () => {
    test('offer each person after @, named, written as their macro', async () => {
        const mentions = suggest.mentionSuggestions(name => (name === 'char' ? { name: 'Seraphina', avatarUrl: '', about: '' } : null));
        const answer = await mentions(reader('hi @se'), 6, false);
        expect(answer?.from).toBe(4);
        expect(answer?.options.map(option => [option.label, option.detail])).toEqual([['user', '{{user}}'], ['Seraphina', '{{char}}']]);
    });

    test('offer nothing without an @ starting a word', async () => {
        const mentions = suggest.mentionSuggestions(() => null);
        expect(await mentions(reader('mail@x'), 6, false)).toBeUndefined();
        expect(await mentions(reader('plain'), 5, false)).toBeUndefined();
    });

    test('replace the @ and what was typed with the macro', async () => {
        const mentions = suggest.mentionSuggestions(() => null);
        const answer = await mentions(reader('hi @us'), 6, false);
        /** @type {any[]} */
        const dispatched = [];
        const view = /** @type {any} */ ({ dispatch: (/** @type {any} */ spec) => dispatched.push(spec) });
        answer?.options[0].apply(view, 4, 6);
        expect(dispatched[0].changes).toEqual({ from: 3, to: 6, insert: '{{user}}' });
    });
});

describe('macro suggestions', () => {
    test('offer nothing where the macro list wouldn\'t open', async () => {
        const macros = suggest.macroSuggestions(() => undefined, (strings, ...values) => String.raw({ raw: strings }, ...values));
        expect(await macros(reader('no braces'), 9, false)).toBeUndefined();
    });
});
