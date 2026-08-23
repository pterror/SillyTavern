import { describe, test, expect, beforeAll } from '@jest/globals';
import { Buffer } from 'node:buffer';
import encode from '../src/png/encode.js';

// A minimal valid 1x1 transparent PNG - same fixture characters-duplicate.test.js uses, just enough of a real
// PNG for png-chunks-extract to parse.
const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('png-chunks-extract').default} */
let extract;
/** @type {typeof import('png-chunk-text')} */
let PNGtext;

beforeAll(async () => {
    cardParser = await import('../src/character-card-parser.js');
    ({ default: extract } = await import('png-chunks-extract'));
    PNGtext = (await import('png-chunk-text')).default ?? await import('png-chunk-text');
});

/**
 * @param {Buffer} buffer
 * @returns {Record<string, string>} tEXt keyword -> decoded text, lowercased keys
 */
function readTextChunks(buffer) {
    const chunks = extract(new Uint8Array(buffer));
    /** @type {Record<string, string>} */
    const result = {};
    for (const chunk of chunks.filter(c => c.name === 'tEXt')) {
        const decoded = PNGtext.decode(chunk.data);
        result[decoded.keyword.toLowerCase()] = decoded.text;
    }
    return result;
}

describe('png/encode.js - CRC32 correctness (2026-08 crc -> crc-32 package swap)', () => {
    // Locks in the thing that actually matters about swapping the CRC implementation package that
    // src/png/encode.js uses to compute each chunk's trailing CRC: the new package still produces the
    // exact PNG-spec CRC-32/IEEE-802.3 value, not some other polynomial (e.g. CRC-32C) that would happen
    // to also be called "crc32" but produce bytes no real PNG reader/writer would accept. Every existing
    // write()/read() round-trip test above already exercises this indirectly - extract() (used by read())
    // independently recomputes and verifies each chunk's CRC, and throws if it doesn't match - so a wrong
    // polynomial would already fail loudly there. This test just makes that guarantee explicit and adds a
    // negative case proving the check isn't vacuous.
    test('a fresh write() output round-trips through an independent PNG extractor without a CRC mismatch', () => {
        const data = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Ghost', data: { name: 'Ghost' } });
        const buffer = cardParser.write(BLANK_PNG, data);
        // extract() throws 'CRC values for X header do not match, PNG file is likely corrupted' on any
        // chunk whose trailing CRC doesn't match a fresh CRC-32/IEEE-802.3 computation over its own bytes.
        expect(() => extract(new Uint8Array(buffer))).not.toThrow();
    });

    test('a single flipped bit in a chunk body IS caught as a CRC mismatch (the check does real work)', () => {
        const data = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Ghost', data: { name: 'Ghost' } });
        const buffer = Buffer.from(cardParser.write(BLANK_PNG, data));

        // Flip one bit inside the IHDR chunk's data (byte 16, well inside the 13-byte IHDR payload that
        // starts at offset 8 + 4(length) + 4('IHDR') = 16) without touching its trailing CRC bytes.
        const corrupted = Buffer.from(buffer);
        corrupted[16] ^= 0x01;

        expect(() => extract(new Uint8Array(corrupted))).toThrow(/CRC values .* do not match/);
    });
});

describe('character-card-parser write() - spec-fidelity (no forced v2->v3 upgrade)', () => {
    test('a v2-spec source gets only a chara chunk, no synthesized ccv3', () => {
        const data = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Ghost', data: { name: 'Ghost' } });
        const buffer = cardParser.write(BLANK_PNG, data);
        const chunks = readTextChunks(buffer);

        expect(chunks.chara).toBeDefined();
        expect(chunks.ccv3).toBeUndefined();

        const decodedChara = JSON.parse(Buffer.from(chunks.chara, 'base64').toString('utf8'));
        expect(decodedChara.spec).toBe('chara_card_v2');
        expect(decodedChara.spec_version).toBe('2.0');
    });

    test('a spec-less (V1) source gets only a chara chunk, no synthesized ccv3', () => {
        const data = JSON.stringify({ name: 'Ghost' });
        const buffer = cardParser.write(BLANK_PNG, data);
        const chunks = readTextChunks(buffer);

        expect(chunks.chara).toBeDefined();
        expect(chunks.ccv3).toBeUndefined();
    });

    test('a v3-spec source gets a ccv3 chunk holding the SAME bytes as chara - not a re-derived copy', () => {
        const data = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', name: 'Ghost', data: { name: 'Ghost' } });
        const buffer = cardParser.write(BLANK_PNG, data);
        const chunks = readTextChunks(buffer);

        expect(chunks.chara).toBeDefined();
        expect(chunks.ccv3).toBeDefined();
        expect(chunks.ccv3).toBe(chunks.chara);
    });

    test('read() still round-trips a v3 card back through the ccv3 chunk (unaffected by the write-side fix)', () => {
        const data = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', name: 'Ghost', data: { name: 'Ghost' } });
        const buffer = cardParser.write(BLANK_PNG, data);
        expect(JSON.parse(cardParser.read(buffer))).toEqual(JSON.parse(data));
    });

    test('preserves an unrelated tEXt chunk across a re-write (only chara/ccv3 keywords are ever touched)', () => {
        const encoded = PNGtext.encode('comment', 'not a character card field');
        const chunks = extract(new Uint8Array(BLANK_PNG));
        chunks.splice(-1, 0, encoded);
        const withComment = Buffer.from(encode(chunks));

        const buffer = cardParser.write(withComment, JSON.stringify({ name: 'Ghost' }));
        const textChunks = readTextChunks(buffer);
        expect(textChunks.comment).toBe('not a character card field');
        expect(textChunks.chara).toBeDefined();
    });
});

/**
 * Byte-simulates the OLD (pre-293f4294b) write() - a 'chara' chunk holding `pristineData` verbatim, PLUS a
 * separately-written 'ccv3' chunk holding a LOCAL COPY with spec/spec_version force-bumped to v3 - the exact
 * shape a real poisoned library row's PNG has. Built directly with png-chunk-text/png-chunks-extract rather than
 * via cardParser.write() (which no longer produces this shape after the fix), matching this file's own
 * "preserves an unrelated tEXt chunk" test's technique above.
 * @param {object} pristineData
 * @returns {Buffer}
 */
function buildOldStylePng(pristineData) {
    const pristineBase64 = Buffer.from(JSON.stringify(pristineData), 'utf8').toString('base64');
    const bumped = { ...pristineData, spec: 'chara_card_v3', spec_version: '3.0' };
    const bumpedBase64 = Buffer.from(JSON.stringify(bumped), 'utf8').toString('base64');

    const chunks = extract(new Uint8Array(BLANK_PNG));
    chunks.splice(-1, 0, PNGtext.encode('chara', pristineBase64));
    chunks.splice(-1, 0, PNGtext.encode('ccv3', bumpedBase64));
    return Buffer.from(encode(chunks));
}

describe('readCharaChunkPristine() - recovering a poisoned row\'s pre-mutation content', () => {
    test('recovers the pristine (pre-v3-bump) chara content, ignoring a present ccv3 chunk entirely', () => {
        const pristineData = { spec: 'chara_card_v2', spec_version: '2.0', name: 'Ghost', data: { name: 'Ghost' } };
        const buffer = buildOldStylePng(pristineData);

        // Sanity: the standard, ccv3-preferring read() returns the MUTATED (v3-bumped) copy on this fixture -
        // confirms the fixture actually reproduces the old-write()-poisoned shape this function exists for.
        expect(JSON.parse(cardParser.read(buffer)).spec).toBe('chara_card_v3');

        const pristine = JSON.parse(cardParser.readCharaChunkPristine(buffer));
        expect(pristine).toEqual(pristineData);
        expect(pristine.spec).toBe('chara_card_v2');
    });

    test('falls back to ccv3 (rather than throwing) for a PNG with no chara chunk at all', () => {
        const data = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', name: 'Ghost' });
        const chunks = extract(new Uint8Array(BLANK_PNG));
        chunks.splice(-1, 0, PNGtext.encode('ccv3', Buffer.from(data, 'utf8').toString('base64')));
        const buffer = Buffer.from(encode(chunks));

        expect(cardParser.readCharaChunkPristine(buffer)).toBe(data);
    });

    test('throws on a PNG with no character-data tEXt chunks at all, same as read()', () => {
        expect(() => cardParser.readCharaChunkPristine(BLANK_PNG)).toThrow();
    });
});
