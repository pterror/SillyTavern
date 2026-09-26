import { describe, test, expect } from '@jest/globals';
// Namespace import: a missing export (normalizeFav on a build without it) fails its own tests, not the whole file.
import * as hashUtils from '../public/scripts/hash-utils.js';

const MISSING = Symbol('missing');

// fav is true iff the value is `true`, `'true'` or `1`; everything else is false.
const FAV_CASES = [
    ['true', true, true],
    ['false', false, false],
    ['"true"', 'true', true],
    ['"false"', 'false', false],
    ['1', 1, true],
    ['0', 0, false],
    ['null', null, false],
    ['missing', MISSING, false],
    ['"yes"', 'yes', false],
];

/** @param {unknown} value @returns {object} */
function characterWith(value) {
    const character = { name: 'A', data: { name: 'A', extensions: { world: '' } } };
    if (value !== MISSING) {
        character.fav = value;
        character.data.extensions.fav = value;
    }
    return character;
}

/** @param {unknown} value @returns {object} */
function groupWith(value) {
    const group = { id: 'g1', name: 'G', members: [] };
    if (value !== MISSING) group.fav = value;
    return group;
}

describe('normalizeFav', () => {
    test.each(FAV_CASES)('%s', (_label, value, expected) => {
        expect(typeof hashUtils.normalizeFav).toBe('function');
        expect(hashUtils.normalizeFav(value === MISSING ? undefined : value)).toBe(expected);
    });

    test('called with no argument (missing) -> false', () => {
        expect(hashUtils.normalizeFav()).toBe(false);
    });
});

describe('client character fav fingerprint/hash normalize inside the functions', () => {
    test.each(FAV_CASES)('characterFavFingerprint: %s', (_label, value, expected) => {
        expect(hashUtils.characterFavFingerprint(characterWith(value))).toEqual({
            fav: expected,
            data: { extensions: { fav: expected } },
        });
    });

    test.each(FAV_CASES)('characterDigestFingerprint fav fields: %s', (_label, value, expected) => {
        const fingerprint = hashUtils.characterDigestFingerprint(characterWith(value));
        expect(fingerprint.fav).toBe(expected);
        expect(fingerprint.data.extensions.fav).toBe(expected);
    });

    test.each(FAV_CASES)('characterDigestFavHash equals the hash of the normalized boolean: %s', (_label, value, expected) => {
        expect(hashUtils.characterDigestFavHash(characterWith(value)))
            .toBe(hashUtils.characterDigestFavHash({ fav: expected, data: { extensions: { fav: expected } } }));
    });

    test.each(FAV_CASES)('characterDigestFavHash fast path matches contentHashOf(characterFavFingerprint): %s', (_label, value) => {
        const character = characterWith(value);
        expect(hashUtils.characterDigestFavHash(character) % 4294967296)
            .toBe(hashUtils.contentHashOf(hashUtils.characterFavFingerprint(character)) % 4294967296);
    });

    test('the two fav fields are normalized independently', () => {
        expect(hashUtils.characterFavFingerprint({ fav: 'true', data: { extensions: { fav: 'false' } } }))
            .toEqual({ fav: true, data: { extensions: { fav: false } } });
    });
});

describe('client group fav fingerprint/hash normalize inside the functions', () => {
    test.each(FAV_CASES)('groupFavFingerprint: %s', (_label, value, expected) => {
        expect(hashUtils.groupFavFingerprint(groupWith(value))).toEqual({ fav: expected });
    });

    test('a missing fav fingerprints as {"fav":false}', () => {
        expect(hashUtils.canonicalStringify(hashUtils.groupFavFingerprint({ id: 'g1' }))).toBe('{"fav":false}');
        expect(hashUtils.canonicalStringify(hashUtils.groupFavFingerprint(undefined))).toBe('{"fav":false}');
    });

    test.each(FAV_CASES)('groupDigestFavHash equals the hash of the normalized boolean: %s', (_label, value, expected) => {
        expect(hashUtils.groupDigestFavHash(groupWith(value))).toBe(hashUtils.groupDigestFavHash({ fav: expected }));
        expect(hashUtils.groupDigestFavHash(groupWith(value))).toBe(hashUtils.contentHashOf({ fav: expected }) % 4294967296);
    });
});
