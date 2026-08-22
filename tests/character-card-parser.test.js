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
