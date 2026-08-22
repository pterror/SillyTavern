import { describe, test, expect, jest, beforeEach, beforeAll } from '@jest/globals';

// character-existence-check.js's only dependency is character-repository.js's `characterRepository` singleton -
// mocked at the module boundary (same pattern tests/character-repository.test.js uses for script.js) so this
// stays a pure unit test of the abort-on-failure contract, with no jQuery/DOM/script.js involved.
const existsMock = jest.fn();
jest.unstable_mockModule('../public/scripts/character-repository.js', () => ({
    characterRepository: { exists: existsMock },
}));

/** @type {typeof import('../public/scripts/character-existence-check.js').checkCharactersExistOrNull} */
let checkCharactersExistOrNull;

beforeAll(async () => {
    ({ checkCharactersExistOrNull } = await import('../public/scripts/character-existence-check.js'));
});

beforeEach(() => {
    existsMock.mockReset();
});

describe('checkCharactersExistOrNull()', () => {
    test('returns an empty object without calling exists() for an empty id list', async () => {
        const result = await checkCharactersExistOrNull([]);
        expect(result).toEqual({});
        expect(existsMock).not.toHaveBeenCalled();
    });

    test('passes ids straight through to characterRepository.exists() and returns its result on success', async () => {
        existsMock.mockResolvedValue({ a: true, b: false, c: true });
        const result = await checkCharactersExistOrNull(['a', 'b', 'c']);
        expect(existsMock).toHaveBeenCalledWith(['a', 'b', 'c']);
        expect(result).toEqual({ a: true, b: false, c: true });
    });

    test('returns null (never an all-false map) when the underlying exists() call rejects', async () => {
        existsMock.mockRejectedValue(new Error('network down'));
        const result = await checkCharactersExistOrNull(['a', 'b']);
        expect(result).toBeNull();
    });

    test('does not swallow the failure into a false-for-every-id answer', async () => {
        existsMock.mockRejectedValue(new Error('boom'));
        const result = await checkCharactersExistOrNull(['only-id']);
        expect(result).not.toEqual({ 'only-id': false });
        expect(result).toBeNull();
    });
});
