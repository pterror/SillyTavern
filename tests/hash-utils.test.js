import { describe, test, expect } from '@jest/globals';
import { getStringHash, bucketOf, treeNodeAt, emptyDigest, combineDigest, foldDigests, digestsEqual, contentHashOf, characterDigestFingerprint, characterDigestContentHash, characterDigestFavHash, characterDigestFieldsHash, characterFavFingerprint, characterContentFieldsFingerprint, canonicalStringify, DEFAULT_DIGEST_BUCKET_COUNT, characterDigestTagIdsHash, characterTagIdsFingerprint } from '../public/scripts/hash-utils.js';

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

describe('treeNodeAt - hierarchical tree-node assignment extending bucketOf()', () => {
    test('level 0 matches bucketOf()', () => {
        const ids = ['Alice.png', 'Bob.png', 'Carol.png', 'test-123.png', ''];
        for (const id of ids) {
            expect(treeNodeAt(id, 0, 256)).toBe(bucketOf(id, 256));
        }
    });

    test('is deterministic', () => {
        expect(treeNodeAt('Alice.png', 1, 256)).toBe(treeNodeAt('Alice.png', 1, 256));
    });

    test('different levels give different (usually) indices', () => {
        // Not guaranteed to differ for every id, but extremely likely for any given id
        const l0 = treeNodeAt('Alice.png', 0, 256);
        const l1 = treeNodeAt('Alice.png', 1, 256);
        const l2 = treeNodeAt('Alice.png', 2, 256);
        // At least two of three levels should differ for a well-distributed hash
        const unique = new Set([l0, l1, l2]);
        expect(unique.size).toBeGreaterThanOrEqual(2);
    });

    test('result is always in range [0, branching)', () => {
        const ids = ['Alice.png', 'Bob.png', '', 'a'.repeat(1000)];
        for (const id of ids) {
            for (let level = 0; level < 4; level++) {
                const result = treeNodeAt(id, level, 256);
                expect(result).toBeGreaterThanOrEqual(0);
                expect(result).toBeLessThan(256);
            }
        }
    });

    test('default branching matches DEFAULT_DIGEST_BUCKET_COUNT', () => {
        expect(treeNodeAt('Alice.png', 0)).toBe(treeNodeAt('Alice.png', 0, DEFAULT_DIGEST_BUCKET_COUNT));
    });
});

describe('combineDigest/foldDigests/digestsEqual - the anti-entropy state-digest primitive shared by ' +
    'character-metadata-db.js (server) and script.js (client), see this module\'s own header', () => {
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

    test('foldDigests combines two bucket digests into the same result as folding all their rows into one accumulator', () => {
        let bucketA = emptyDigest();
        bucketA = combineDigest(bucketA, 'Alice.png', 1);
        bucketA = combineDigest(bucketA, 'Bob.png', 2);

        let bucketB = emptyDigest();
        bucketB = combineDigest(bucketB, 'Carol.png', 3);

        let combinedDirectly = emptyDigest();
        combinedDirectly = combineDigest(combinedDirectly, 'Alice.png', 1);
        combinedDirectly = combineDigest(combinedDirectly, 'Bob.png', 2);
        combinedDirectly = combineDigest(combinedDirectly, 'Carol.png', 3);

        expect(digestsEqual(foldDigests(bucketA, bucketB), combinedDirectly)).toBe(true);
    });
});

describe('contentHashOf/characterDigestFingerprint - the content-derived (not stored-counter-derived) hash ' +
    'input this whole mechanism is built on, see this module\'s own header for why', () => {
    test('contentHashOf is deterministic for the same object', () => {
        expect(contentHashOf({ a: 1, b: 'two' })).toBe(contentHashOf({ a: 1, b: 'two' }));
    });

    test('contentHashOf is insensitive to key order (canonicalStringify)', () => {
        expect(contentHashOf({ a: 1, b: 'two' })).toBe(contentHashOf({ b: 'two', a: 1 }));
    });

    test('contentHashOf changes when actual content changes', () => {
        expect(contentHashOf({ a: 1 })).not.toBe(contentHashOf({ a: 2 }));
    });

    test('characterDigestFingerprint drops chat, chat_size, date_last_chat, date_added, and create_date - ' +
        'fields that are either client-synthesized or server-side live-recomputed from volatile external ' +
        'state, so including them would make the digest disagree with itself for values that were never ' +
        'actually wrong (see characterDigestFingerprint()\'s own doc comment)', () => {
        const base = { name: 'Alice', fav: false, tags: [], data: { name: 'Alice', character_version: '', creator: '', tags: [], creator_notes: '', extensions: { fav: false, world: '' } } };
        const withVolatileFields = { ...base, chat: 'Alice - just now', chat_size: 42, date_last_chat: 123456, date_added: 1, create_date: '2020-01-01' };

        expect(contentHashOf(characterDigestFingerprint(base))).toBe(contentHashOf(characterDigestFingerprint(withVolatileFields)));
    });

    test('characterDigestFingerprint keeps name/fav/tags/data - a real change to any of those changes the fingerprint', () => {
        const base = { name: 'Alice', fav: false, tags: [], data: { name: 'Alice', character_version: '', creator: '', tags: [], creator_notes: '', extensions: { fav: false, world: '' } } };
        const favToggled = { ...base, fav: true };
        const renamed = { ...base, name: 'Alicia' };

        expect(contentHashOf(characterDigestFingerprint(base))).not.toBe(contentHashOf(characterDigestFingerprint(favToggled)));
        expect(contentHashOf(characterDigestFingerprint(base))).not.toBe(contentHashOf(characterDigestFingerprint(renamed)));
    });

    test('characterDigestFingerprint tolerates a missing data object (never throws)', () => {
        expect(() => contentHashOf(characterDigestFingerprint({ name: 'Alice' }))).not.toThrow();
    });
});

describe('characterDigestContentHash - the fixed-shape fast path for contentHashOf(characterDigestFingerprint(x)), ' +
    'see this function\'s own doc comment for why it must stay byte-identical to the generic pipeline it replaces ' +
    'at the two full-library call sites (getStateDigest()/getBucketMembers() server-side, ' +
    'verifyCharacterCacheDigest() client-side)', () => {
    /** @type {object[]} */
    const fixtures = [
        // Fully populated.
        { name: 'Alice', fav: false, tags: ['a', 'b'], data: { name: 'Alice', character_version: '1.0', creator: 'bob', tags: ['a', 'b'], creator_notes: 'hi', extensions: { fav: false, world: 'Wonderland' } } },
        // fav: true, different tag order/content, unicode + characters needing JSON escaping.
        { name: 'Bo\'b "the builder"', fav: true, tags: ['NSFW', 'tag\nwith\nnewlines'], data: { name: 'Bo\'b', character_version: '', creator: '', tags: [], creator_notes: '"quoted"', extensions: { fav: true, world: '' } } },
        // Missing `data` entirely.
        { name: 'NoData', fav: false, tags: [] },
        // `data` present but missing several of its own fields.
        { name: 'PartialData', fav: false, tags: ['x'], data: { name: 'PartialData' } },
        // `data.extensions` entirely missing.
        { name: 'NoExtensions', fav: true, tags: null, data: { name: 'NoExtensions', character_version: '2.0', creator: 'carol', tags: ['y'], creator_notes: '' } },
        // Empty object - every field undefined.
        {},
        // Volatile fields present too (must be ignored by both paths identically).
        { name: 'WithVolatile', fav: false, tags: [], chat: 'just now', chat_size: 1, date_added: 1, create_date: 'x', date_last_chat: 2, data: { name: 'WithVolatile', character_version: '', creator: '', tags: [], creator_notes: '', extensions: { fav: false, world: '' } } },
    ];

    test('matches contentHashOf(characterDigestFingerprint(x)) exactly, for every fixture', () => {
        for (const fixture of fixtures) {
            const generic = contentHashOf(characterDigestFingerprint(fixture));
            const fast = characterDigestContentHash(fixture);
            expect(fast).toBe(generic);
        }
    });

    test('tolerates a null/undefined character (never throws, still matches the generic path)', () => {
        expect(characterDigestContentHash(undefined)).toBe(contentHashOf(characterDigestFingerprint(undefined)));
        expect(characterDigestContentHash(null)).toBe(contentHashOf(characterDigestFingerprint(null)));
    });

    test('a real change to any kept field changes the fast-path hash the same way it changes the generic one', () => {
        const base = fixtures[0];
        const favToggled = { ...base, fav: true };
        expect(characterDigestContentHash(base)).not.toBe(characterDigestContentHash(favToggled));
        expect(characterDigestContentHash(base) === characterDigestContentHash(favToggled))
            .toBe(contentHashOf(characterDigestFingerprint(base)) === contentHashOf(characterDigestFingerprint(favToggled)));
    });
});

describe('characterDigestFavHash / characterDigestFieldsHash - per-field-group split of characterDigestContentHash, ' +
    'see these functions\' own doc comments for why fav is its own stream', () => {
    const fixtures = [
        { name: 'Alice', fav: false, tags: ['a', 'b'], data: { name: 'Alice', character_version: '1.0', creator: 'bob', tags: ['a', 'b'], creator_notes: 'hi', extensions: { fav: false, world: 'Wonderland' } } },
        { name: 'Bo\'b "the builder"', fav: true, tags: ['NSFW'], data: { name: 'Bo\'b', character_version: '', creator: '', tags: [], creator_notes: '"quoted"', extensions: { fav: true, world: '' } } },
        { name: 'NoData', fav: false, tags: [] },
        { name: 'PartialData', fav: false, tags: ['x'], data: { name: 'PartialData' } },
        { name: 'NoExtensions', fav: true, tags: null, data: { name: 'NoExtensions', character_version: '2.0', creator: 'carol', tags: ['y'], creator_notes: '' } },
        {},
        { name: 'WithVolatile', fav: false, tags: [], chat: 'just now', chat_size: 1, date_added: 1, create_date: 'x', date_last_chat: 2, data: { name: 'WithVolatile', character_version: '', creator: '', tags: [], creator_notes: '', extensions: { fav: false, world: '' } } },
    ];

    test('fast path matches generic pipeline for favHash', () => {
        for (const fixture of fixtures) {
            expect(characterDigestFavHash(fixture)).toBe(contentHashOf(characterFavFingerprint(fixture)));
        }
    });

    test('fast path matches generic pipeline for fieldsHash', () => {
        for (const fixture of fixtures) {
            expect(characterDigestFieldsHash(fixture)).toBe(contentHashOf(characterContentFieldsFingerprint(fixture)));
        }
    });

    test('null/undefined tolerance', () => {
        for (const val of [null, undefined]) {
            expect(characterDigestFavHash(val)).toBe(contentHashOf(characterFavFingerprint(val)));
            expect(characterDigestFieldsHash(val)).toBe(contentHashOf(characterContentFieldsFingerprint(val)));
        }
    });

    test('fav change only affects favHash, not fieldsHash', () => {
        const base = fixtures[0];
        const favToggled = { ...base, fav: !base.fav, data: { ...base.data, extensions: { ...base.data.extensions, fav: !base.data.extensions.fav } } };
        expect(characterDigestFavHash(base)).not.toBe(characterDigestFavHash(favToggled));
        expect(characterDigestFieldsHash(base)).toBe(characterDigestFieldsHash(favToggled));
    });

    test('content change only affects fieldsHash, not favHash', () => {
        const base = fixtures[0];
        const renamed = { ...base, name: 'Alicia', data: { ...base.data, name: 'Alicia' } };
        expect(characterDigestFieldsHash(base)).not.toBe(characterDigestFieldsHash(renamed));
        expect(characterDigestFavHash(base)).toBe(characterDigestFavHash(renamed));
    });
});

describe('characterDigestTagIdsHash - per-field hash for tag_ids, must match ' +
    'contentHashOf(characterTagIdsFingerprint(x)) % 4294967296 (32-bit truncation)', () => {
    const fixtures = [
        // No tag_ids at all
        {},
        // Empty tag_ids
        { tag_ids: [] },
        // Single tag
        { tag_ids: ['abc-123'] },
        // Multiple tags (should be sorted before hashing for determinism)
        { tag_ids: ['z-tag', 'a-tag', 'm-tag'] },
        // Same tags in different order (must produce same hash due to sorting)
        { tag_ids: ['a-tag', 'm-tag', 'z-tag'] },
        // With other character fields present (must be ignored)
        { name: 'Alice', fav: true, tag_ids: ['tag1', 'tag2'], tags: ['card-tag'], data: { name: 'Alice' } },
        // null/undefined tag_ids
        { tag_ids: null },
        { tag_ids: undefined },
        // Large tag set
        { tag_ids: Array.from({ length: 50 }, (_, i) => `tag-${String(i).padStart(3, '0')}`) },
    ];

    test('fast path matches generic pipeline (truncated to 32 bits) for every fixture', () => {
        for (const fixture of fixtures) {
            const generic = contentHashOf(characterTagIdsFingerprint(fixture)) % 4294967296;
            const fast = characterDigestTagIdsHash(fixture);
            expect(fast).toBe(generic);
        }
    });

    test('null/undefined character tolerance', () => {
        for (const val of [null, undefined]) {
            expect(characterDigestTagIdsHash(val)).toBe(
                contentHashOf(characterTagIdsFingerprint(val)) % 4294967296,
            );
        }
    });

    test('different order of same tag_ids produces the same hash (sorting invariant)', () => {
        const a = { tag_ids: ['z', 'a', 'm'] };
        const b = { tag_ids: ['a', 'm', 'z'] };
        expect(characterDigestTagIdsHash(a)).toBe(characterDigestTagIdsHash(b));
    });

    test('tag_ids change only affects tagIdsHash, not favHash or fieldsHash', () => {
        const base = { name: 'Alice', fav: false, tag_ids: ['tag1'], tags: ['a'], data: { name: 'Alice', extensions: { fav: false, world: '' } } };
        const changed = { ...base, tag_ids: ['tag1', 'tag2'] };
        expect(characterDigestTagIdsHash(base)).not.toBe(characterDigestTagIdsHash(changed));
        expect(characterDigestFavHash(base)).toBe(characterDigestFavHash(changed));
        expect(characterDigestFieldsHash(base)).toBe(characterDigestFieldsHash(changed));
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
