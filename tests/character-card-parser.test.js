import { describe, test, expect, beforeAll } from '@jest/globals';
import { Buffer } from 'node:buffer';
import encode from '../src/png/encode.js';

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
 * @returns {Record<string, string>}
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
    test('a fresh write() output round-trips through an independent PNG extractor without a CRC mismatch', () => {
        const data = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Ghost', data: { name: 'Ghost' } });
        const buffer = cardParser.write(BLANK_PNG, data);
        expect(() => extract(new Uint8Array(buffer))).not.toThrow();
    });

    test('a single flipped bit in a chunk body IS caught as a CRC mismatch (the check does real work)', () => {
        const data = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Ghost', data: { name: 'Ghost' } });
        const buffer = Buffer.from(cardParser.write(BLANK_PNG, data));

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

    test('a v3-spec source gets only a chara chunk, no ccv3 mirror', () => {
        const data = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', name: 'Ghost', data: { name: 'Ghost' } });
        const buffer = cardParser.write(BLANK_PNG, data);
        const chunks = readTextChunks(buffer);

        expect(chunks.chara).toBeDefined();
        expect(chunks.ccv3).toBeUndefined();
    });

    test('read() still round-trips a v3 card (via chara - write() no longer produces a ccv3 chunk)', () => {
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

describe('computeAvatarIdentityHashFromChunks() - avatar-identity fingerprint', () => {
    test('is stable across a tEXt-chunk-only edit (same pixels, different embedded card data)', () => {
        const withCardA = cardParser.write(BLANK_PNG, JSON.stringify({ name: 'Alice' }));
        const withCardB = cardParser.write(BLANK_PNG, JSON.stringify({ name: 'Bob', spec: 'chara_card_v3', extra: 'field' }));

        const hashA = cardParser.computeAvatarIdentityHashFromChunks(extract(new Uint8Array(withCardA)));
        const hashB = cardParser.computeAvatarIdentityHashFromChunks(extract(new Uint8Array(withCardB)));

        expect(hashA).toBe(hashB);
    });

    test('differs when the actual pixel data (IDAT) differs, even with identical embedded card data', () => {
        const cardData = JSON.stringify({ name: 'Same Text' });

        const chunksA = extract(new Uint8Array(BLANK_PNG));
        const withCardA = cardParser.write(BLANK_PNG, cardData);

        const differentImageChunks = extract(new Uint8Array(BLANK_PNG));
        const idat = differentImageChunks.find(c => c.name === 'IDAT');
        idat.data = new Uint8Array(idat.data);
        idat.data[0] ^= 0xff;
        const differentImage = Buffer.from(encode(differentImageChunks));
        const withCardB = cardParser.write(differentImage, cardData);

        const hashA = cardParser.computeAvatarIdentityHashFromChunks(extract(new Uint8Array(withCardA)));
        const hashB = cardParser.computeAvatarIdentityHashFromChunks(extract(new Uint8Array(withCardB)));

        expect(hashA).not.toBe(hashB);
        expect(chunksA.length).toBeGreaterThan(0);
    });

    test('computeDefaultAvatarIdentityHash() is cached and matches computing it from the same asset directly', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const { DEFAULT_AVATAR_PATH } = await import('../src/constants.js');
        const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
        const buf = fs.readFileSync(path.join(repoRoot, DEFAULT_AVATAR_PATH));
        const expected = cardParser.computeAvatarIdentityHashFromChunks(extract(new Uint8Array(buf)));

        const originalCwd = process.cwd();
        process.chdir(repoRoot);
        try {
            expect(cardParser.computeDefaultAvatarIdentityHash()).toBe(expected);
            expect(cardParser.computeDefaultAvatarIdentityHash()).toBe(expected);
        } finally {
            process.chdir(originalCwd);
        }
    });
});
