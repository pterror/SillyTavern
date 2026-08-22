import { describe, test, expect } from '@jest/globals';
import { getStringHash } from '../public/scripts/hash-utils.js';

describe('getStringHash', () => {
    test('is deterministic for the same string and seed', () => {
        expect(getStringHash('character.abc', 42)).toBe(getStringHash('character.abc', 42));
    });

    test('a different seed produces a different hash (with overwhelming probability)', () => {
        expect(getStringHash('character.abc', 1)).not.toBe(getStringHash('character.abc', 2));
    });

    test('a different string produces a different hash under the same seed (with overwhelming probability)', () => {
        expect(getStringHash('character.abc', 7)).not.toBe(getStringHash('character.def', 7));
    });

    test('always returns a finite number, even for a non-string input', () => {
        // @ts-expect-error deliberate non-string input
        expect(getStringHash(null)).toBe(0);
        // @ts-expect-error deliberate non-string input
        expect(getStringHash(undefined)).toBe(0);
        expect(Number.isFinite(getStringHash(''))).toBe(true);
    });

    test('defaults the seed to 0', () => {
        expect(getStringHash('character.abc')).toBe(getStringHash('character.abc', 0));
    });
});
