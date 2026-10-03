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
