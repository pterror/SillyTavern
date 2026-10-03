import { describe, test, expect } from '@jest/globals';
import { getStringHash, bucketOf, emptyDigest, combineDigest, digestsEqual, contentHashOf, characterDigestFieldsHash, characterContentFieldsFingerprint, canonicalStringify, DEFAULT_DIGEST_BUCKET_COUNT } from '../public/scripts/hash-utils.js';

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

describe('bucketOf', () => {
    test('is deterministic and stable for the same id and bucket count', () => {
        expect(bucketOf('Alice.png', 256)).toBe(bucketOf('Alice.png', 256));
    });

    test('always lands within [0, bucketCount)', () => {
        for (const id of ['Alice.png', 'Bob.png', 'Carol.png', '', 'a very long avatar filename indeed.png']) {
            const bucket = bucketOf(id, 8);
            expect(bucket).toBeGreaterThanOrEqual(0);
            expect(bucket).toBeLessThan(8);
        }
    });

    test('defaults bucketCount to DEFAULT_DIGEST_BUCKET_COUNT', () => {
        expect(bucketOf('Alice.png')).toBe(bucketOf('Alice.png', DEFAULT_DIGEST_BUCKET_COUNT));
    });
});

describe('combineDigest/digestsEqual - the anti-entropy state-digest primitive shared by ' +
    'character-metadata-db.js (server) and tags.js (client), see this module\'s own header', () => {
    test('an empty digest equals another independently-created empty digest', () => {
        expect(digestsEqual(emptyDigest(), emptyDigest())).toBe(true);
    });

    test('folding the same {id, contentHash} set in a different order produces the same digest - the entire ' +
        'point of using XOR: a client and server never guarantee iterating the same id set in the same order', () => {
        const pairs = [['Alice.png', 3], ['Bob.png', 7], ['Carol.png', 1], ['Dave.png', 42]];

        let forward = emptyDigest();
        for (const [id, contentHash] of pairs) forward = combineDigest(forward, id, contentHash);

        let reversed = emptyDigest();
        for (const [id, contentHash] of [...pairs].reverse()) reversed = combineDigest(reversed, id, contentHash);

        let shuffled = emptyDigest();
        for (const [id, contentHash] of [pairs[2], pairs[0], pairs[3], pairs[1]]) shuffled = combineDigest(shuffled, id, contentHash);

        expect(digestsEqual(reversed, forward)).toBe(true);
        expect(digestsEqual(shuffled, forward)).toBe(true);
    });

    test('a different content hash for the same id changes the digest - content staleness must be detectable, ' +
        'not just set-membership', () => {
        const withHash1 = combineDigest(emptyDigest(), 'Alice.png', 1);
        const withHash2 = combineDigest(emptyDigest(), 'Alice.png', 2);
        expect(digestsEqual(withHash1, withHash2)).toBe(false);
    });

    test('a missing or extra id changes the digest', () => {
        let withTwo = emptyDigest();
        withTwo = combineDigest(withTwo, 'Alice.png', 1);
        withTwo = combineDigest(withTwo, 'Bob.png', 1);

        let withOne = emptyDigest();
        withOne = combineDigest(withOne, 'Alice.png', 1);

        expect(digestsEqual(withOne, withTwo)).toBe(false);
    });

    test('folding a bucket digest back out (XOR is self-inverting) restores the previous digest', () => {
        const before = combineDigest(emptyDigest(), 'Alice.png', 1);
        const after = combineDigest(before, 'Bob.png', 2);
        const restored = combineDigest(after, 'Bob.png', 2);
        expect(digestsEqual(restored, before)).toBe(true);
    });
});

describe('contentHashOf - the content-derived hash', () => {
    test('contentHashOf is deterministic for the same object', () => {
        expect(contentHashOf({ a: 1, b: 'two' })).toBe(contentHashOf({ a: 1, b: 'two' }));
    });

    test('contentHashOf is insensitive to key order (canonicalStringify)', () => {
        expect(contentHashOf({ a: 1, b: 'two' })).toBe(contentHashOf({ b: 'two', a: 1 }));
    });

    test('contentHashOf changes when actual content changes', () => {
        expect(contentHashOf({ a: 1 })).not.toBe(contentHashOf({ a: 2 }));
    });
});

describe('characterDigestFieldsHash - the edit route\'s conflict hash of the list fields', () => {
    const fixtures = [
        { name: 'Alice', fav: false, tags: ['a', 'b'], data: { name: 'Alice', character_version: '1.0', creator: 'bob', tags: ['a', 'b'], creator_notes: 'hi', extensions: { fav: false, world: 'Wonderland' } } },
        { name: 'Bo\'b "the builder"', fav: true, tags: ['NSFW'], data: { name: 'Bo\'b', character_version: '', creator: '', tags: [], creator_notes: '"quoted"', extensions: { fav: true, world: '' } } },
        { name: 'NoData', fav: false, tags: [] },
        { name: 'PartialData', fav: false, tags: ['x'], data: { name: 'PartialData' } },
        { name: 'NoExtensions', fav: true, tags: null, data: { name: 'NoExtensions', character_version: '2.0', creator: 'carol', tags: ['y'], creator_notes: '' } },
        {},
        { name: 'WithVolatile', fav: false, tags: [], chat: 'just now', chat_size: 1, date_added: 1, create_date: 'x', date_last_chat: 2, data: { name: 'WithVolatile', character_version: '', creator: '', tags: [], creator_notes: '', extensions: { fav: false, world: '' } } },
    ];

    test('fast path matches generic pipeline for fieldsHash', () => {
        for (const fixture of fixtures) {
            expect(characterDigestFieldsHash(fixture)).toBe(contentHashOf(characterContentFieldsFingerprint(fixture)));
        }
    });

    test('null/undefined tolerance', () => {
        for (const val of [null, undefined]) {
            expect(characterDigestFieldsHash(val)).toBe(contentHashOf(characterContentFieldsFingerprint(val)));
        }
    });

    test('a fav change leaves fieldsHash alone', () => {
        const base = fixtures[0];
        const favToggled = { ...base, fav: !base.fav, data: { ...base.data, extensions: { ...base.data.extensions, fav: !base.data.extensions.fav } } };
        expect(characterDigestFieldsHash(base)).toBe(characterDigestFieldsHash(favToggled));
    });

    test('a content change changes fieldsHash', () => {
        const base = fixtures[0];
        const renamed = { ...base, name: 'Alicia', data: { ...base.data, name: 'Alicia' } };
        expect(characterDigestFieldsHash(base)).not.toBe(characterDigestFieldsHash(renamed));
    });
});

describe('canonicalStringify', () => {
    test('sorts object keys at every level', () => {
        expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalStringify({ a: { c: 3, d: 2 }, b: 1 }));
    });

    test('omits undefined-valued keys, matching JSON.stringify semantics', () => {
        expect(canonicalStringify({ a: 1, b: undefined })).toBe(canonicalStringify({ a: 1 }));
    });

    test('preserves array order (arrays are not sorted)', () => {
        expect(canonicalStringify([1, 2, 3])).not.toBe(canonicalStringify([3, 2, 1]));
    });
});
