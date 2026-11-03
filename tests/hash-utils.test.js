import { describe, test, expect } from '@jest/globals';
import { listCreatorNotes, shallowCharacterData, LIST_CREATOR_NOTES_CHARS, getStringHash, bucketOf, emptyDigest, combineDigest, digestsEqual, contentHashOf, canonicalStringify, DEFAULT_DIGEST_BUCKET_COUNT } from '../public/scripts/hash-utils.js';

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
    'the server and tags.js (client), see this module\'s own header', () => {
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

describe('listCreatorNotes - the prefix of the creator notes a list row carries', () => {
    test('a row carries the default length: no more than LIST_CREATOR_NOTES_CHARS code points', () => {
        const notes = 'x'.repeat(LIST_CREATOR_NOTES_CHARS + 50);
        expect(Array.from(shallowCharacterData({ data: { creator_notes: notes } }).creator_notes).length).toBe(LIST_CREATOR_NOTES_CHARS);
    });

    test('cuts to the given number of code points and keeps shorter notes whole', () => {
        expect(listCreatorNotes('abcdef', 3)).toBe('abc');
        expect(listCreatorNotes('ab', 3)).toBe('ab');
    });

    test('never splits a surrogate pair', () => {
        expect(listCreatorNotes('a\u{1F600}b', 2)).toBe('a\u{1F600}');
        expect(listCreatorNotes('\u{1F600}\u{1F600}', 1)).toBe('\u{1F600}');
    });

    test('anything but a string, and a length of 0, carry nothing', () => {
        for (const notes of [undefined, null, 7, {}, ['a']]) expect(listCreatorNotes(notes, 5)).toBe('');
        expect(listCreatorNotes('abc', 0)).toBe('');
    });
});
