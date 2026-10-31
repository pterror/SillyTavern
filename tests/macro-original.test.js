import { describe, test, expect } from '@jest/globals';
import { substituteParams } from '../src/macro-substitution.js';

describe('{{original}} macro', () => {
    test('resolves to the provided original text when one is supplied', () => {
        expect(substituteParams('{{original}}', { original: 'hello from the original message' })).toBe('hello from the original message');
    });

    test('resolves to an empty string, instead of throwing, when no original text is in context', () => {
        expect(substituteParams('{{original}}')).toBe('');
    });
});
