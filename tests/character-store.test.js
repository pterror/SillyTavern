import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

const selectCharacterByAvatar = jest.fn(async () => {});
jest.unstable_mockModule('../public/script.js', () => ({ selectCharacterByAvatar }));

const {
    characters, charactersStore, resolveCharacterRef, resolveCharacterRefPair, CHARACTER_REF_MISMATCH, selectCharacterById,
} = await import('../public/scripts/character-store.js');

const alpha = { avatar: 'alpha.png', name: 'Alpha' };
const digitStem = { avatar: '3.png', name: 'Digit stem' };
const gamma = { avatar: 'gamma.png', name: 'Gamma' };
const delta = { avatar: 'delta.png', name: 'Delta' };

beforeEach(() => {
    for (const character of [...characters]) {
        charactersStore.remove(character.avatar);
    }
    for (const character of [alpha, digitStem, gamma, delta]) {
        charactersStore.create(character);
    }
    selectCharacterByAvatar.mockClear();
});

describe('resolveCharacterRef', () => {
    test('a number is an index', () => {
        expect(resolveCharacterRef(0)).toBe(alpha);
        expect(resolveCharacterRef(2)).toBe(gamma);
    });

    test('a digit string is an index', () => {
        expect(resolveCharacterRef('0')).toBe(alpha);
        expect(resolveCharacterRef('3')).toBe(delta);
    });

    test('any other string is an avatar key', () => {
        expect(resolveCharacterRef('gamma.png')).toBe(gamma);
    });

    test('a digit-stem key is an avatar key, not an index', () => {
        expect(resolveCharacterRef('3.png')).toBe(digitStem);
    });

    test('an object resolves through its avatar', () => {
        expect(resolveCharacterRef({ avatar: 'gamma.png' })).toBe(gamma);
        expect(resolveCharacterRef(gamma)).toBe(gamma);
    });

    test('non-canonical index forms miss, as upstream\'s characters[ref] does', () => {
        expect(resolveCharacterRef(1.5)).toBeUndefined();
        expect(resolveCharacterRef('03')).toBeUndefined();
        expect(resolveCharacterRef(' 3')).toBeUndefined();
        expect(resolveCharacterRef('3.0')).toBeUndefined();
        expect(resolveCharacterRef('1.5')).toBeUndefined();
    });

    test('values upstream\'s characters[ref] hits on resolve to what upstream gets', () => {
        expect(resolveCharacterRef(-0)).toBe(alpha);
        expect(resolveCharacterRef([2])).toBe(gamma);
        expect(resolveCharacterRef(2n)).toBe(gamma);
        expect(resolveCharacterRef('length')).toBe(4);
    });

    test('a miss resolves to undefined', () => {
        expect(resolveCharacterRef(99)).toBeUndefined();
        expect(resolveCharacterRef('99')).toBeUndefined();
        expect(resolveCharacterRef(-1)).toBeUndefined();
        expect(resolveCharacterRef(Number.NaN)).toBeUndefined();
        expect(resolveCharacterRef(['gamma.png'])).toBeUndefined();
        expect(resolveCharacterRef('missing.png')).toBeUndefined();
        expect(resolveCharacterRef('')).toBeUndefined();
        expect(resolveCharacterRef({ avatar: 'missing.png' })).toBeUndefined();
        expect(resolveCharacterRef({ avatar: 1 })).toBeUndefined();
        expect(resolveCharacterRef({})).toBeUndefined();
        expect(resolveCharacterRef(null)).toBeUndefined();
        expect(resolveCharacterRef(undefined)).toBeUndefined();
        expect(resolveCharacterRef(true)).toBeUndefined();
    });
});

describe('resolveCharacterRefPair', () => {
    let warn;
    beforeEach(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        warn.mockRestore();
    });

    test('both forms naming the same character resolve to it without a warning', () => {
        expect(resolveCharacterRefPair(2, 'gamma.png')).toBe(gamma);
        expect(resolveCharacterRefPair('2', 'gamma.png')).toBe(gamma);
        expect(warn).not.toHaveBeenCalled();
    });

    test('forms naming different characters are a mismatch, with one warning naming both', () => {
        expect(resolveCharacterRefPair(0, 'gamma.png')).toBe(CHARACTER_REF_MISMATCH);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]).toEqual(expect.arrayContaining([0, 'gamma.png']));
    });

    test('one form missing while the other resolves is a mismatch, with one warning naming both', () => {
        expect(resolveCharacterRefPair(99, 'gamma.png')).toBe(CHARACTER_REF_MISMATCH);
        expect(resolveCharacterRefPair(2, 'missing.png')).toBe(CHARACTER_REF_MISMATCH);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[0]).toEqual(expect.arrayContaining([99, 'gamma.png']));
        expect(warn.mock.calls[1]).toEqual(expect.arrayContaining([2, 'missing.png']));
    });

    test('both forms missing is a mismatch, with one warning naming both', () => {
        expect(resolveCharacterRefPair(99, 'missing.png')).toBe(CHARACTER_REF_MISMATCH);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]).toEqual(expect.arrayContaining([99, 'missing.png']));
    });

    test('forms resolving to things that are not characters are a mismatch', () => {
        expect(resolveCharacterRefPair('length', 'map')).toBe(CHARACTER_REF_MISMATCH);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    test('the avatar form is never read as an index or an object', () => {
        expect(resolveCharacterRefPair(2, '2')).toBe(CHARACTER_REF_MISMATCH);
        expect(resolveCharacterRefPair(2, 2)).toBe(CHARACTER_REF_MISMATCH);
        expect(resolveCharacterRefPair(2, gamma)).toBe(CHARACTER_REF_MISMATCH);
        expect(resolveCharacterRefPair(2, null)).toBe(CHARACTER_REF_MISMATCH);
        expect(warn).toHaveBeenCalledTimes(4);
    });

    test('the upstream form accepts every resolveCharacterRef form', () => {
        expect(resolveCharacterRefPair('gamma.png', 'gamma.png')).toBe(gamma);
        expect(resolveCharacterRefPair(gamma, 'gamma.png')).toBe(gamma);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('selectCharacterById', () => {
    test('selects by index, digit string, avatar key and object', async () => {
        await selectCharacterById(2);
        await selectCharacterById('2', { switchMenu: false });
        await selectCharacterById('gamma.png');
        await selectCharacterById({ avatar: 'gamma.png' });
        expect(selectCharacterByAvatar.mock.calls).toEqual([
            ['gamma.png', { switchMenu: true }],
            ['gamma.png', { switchMenu: false }],
            ['gamma.png', { switchMenu: true }],
            ['gamma.png', { switchMenu: true }],
        ]);
    });

    test('a miss selects nothing', async () => {
        await selectCharacterById(99);
        await selectCharacterById('03');
        await selectCharacterById('length');
        await selectCharacterById('missing.png');
        expect(selectCharacterByAvatar).not.toHaveBeenCalled();
    });
});
