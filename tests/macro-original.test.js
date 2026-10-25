import { describe, test, expect } from '@jest/globals';
import { substituteParams } from '../src/macro-substitution.js';

// The {{original}} macro (public/scripts/macros/definitions/env-macros.js), through the macro engine the page and the
// server both run.

describe('{{original}} macro', () => {
    test('resolves to the provided original text when one is supplied', () => {
        expect(substituteParams('{{original}}', { original: 'hello from the original message' })).toBe('hello from the original message');
    });

    test('resolves to an empty string, instead of throwing, when no original text is in context', () => {
        // The RA_CountCharTokens path (RossAscends-mods.js) substitutes with no `original`: {{original}} used to call
        // `undefined()`, throw, and stay in the text as written.
        expect(substituteParams('{{original}}')).toBe('');
    });
});
