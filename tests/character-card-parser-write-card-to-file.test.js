import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

// A minimal valid 1x1 transparent PNG - same fixture character-card-parser.test.js uses.
const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

const reflinkFileMock = jest.fn();

// Same reasoning as local-import-copy.test.js: @reflink/reflink is a real native binding, not something a
// unit test should depend on this platform/filesystem actually supporting - mocked here so the fast-path
// vs fallback behavior is deterministic regardless of what /tmp happens to be mounted on in CI.
jest.unstable_mockModule('@reflink/reflink', () => ({
    reflinkFile: reflinkFileMock,
}));

/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('png-chunks-extract').default} */
let extract;
/** @type {typeof import('png-chunk-text')} */
let PNGtext;
/** @type {typeof import('../src/png/encode.js').default} */
let encode;

beforeAll(async () => {
    cardParser = await import('../src/character-card-parser.js');
    ({ default: extract } = await import('png-chunks-extract'));
    PNGtext = (await import('png-chunk-text')).default ?? await import('png-chunk-text');
    ({ default: encode } = await import('../src/png/encode.js'));
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

/**
 * Builds a source PNG that already carries a 'chara' tEXt chunk - matching the real-world shape of a
 * previously-exported character card (write() always removes an existing chara/ccv3 chunk before adding
 * the new one, so a realistic fixture needs one present to exercise that removal).
 * @param {object} charaData
 * @param {'before-idat' | 'before-iend'} [position] Where to place the chara chunk - 'before-iend' (the
 * default) matches every real sample checked against the live install; 'before-idat' simulates a foreign
 * tool's layout this optimization must safely decline to fast-path.
 * @returns {Buffer}
 */
function buildSourcePng(charaData, position = 'before-iend') {
    const base64 = Buffer.from(JSON.stringify(charaData), 'utf8').toString('base64');
    const chunks = extract(new Uint8Array(BLANK_PNG));
    const insertAt = position === 'before-idat' ? chunks.findIndex(c => c.name === 'IDAT') : -1;
    chunks.splice(insertAt, 0, PNGtext.encode('chara', base64));
    return Buffer.from(encode(chunks));
}

describe('writeCardToFile', () => {
    let tempDir;
    let sourcePath;
    let destPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-write-card-to-file-'));
        sourcePath = path.join(tempDir, 'source.png');
        destPath = path.join(tempDir, 'dest.png');

        reflinkFileMock.mockReset();
        // Default: simulate a working reflink by doing a real copy - most tests exercise the fast path.
        reflinkFileMock.mockImplementation(async (src, dst) => {
            fs.copyFileSync(src, dst);
            return 0;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('takes the reflink-preserving fast path for a realistic source (chara chunk immediately before IEND)', async () => {
        fs.writeFileSync(sourcePath, buildSourcePng({ name: 'Old Name', spec: 'chara_card_v2' }));
        const newData = JSON.stringify({ name: 'New Name', spec: 'chara_card_v2' });

        const result = await cardParser.writeCardToFile(sourcePath, destPath, newData);

        expect(result).toEqual({ reflinked: true });
        expect(reflinkFileMock).toHaveBeenCalledTimes(1);
        expect(reflinkFileMock.mock.calls[0][0]).toBe(sourcePath);

        const written = fs.readFileSync(destPath);
        const expected = cardParser.write(fs.readFileSync(sourcePath), newData);
        expect(Buffer.compare(written, expected)).toBe(0);
        expect(JSON.parse(Buffer.from(readTextChunks(written).chara, 'base64').toString('utf8'))).toEqual({ name: 'New Name', spec: 'chara_card_v2' });
    });

    test('never leaves a leftover .tmp file after a successful reflink write', async () => {
        fs.writeFileSync(sourcePath, buildSourcePng({ name: 'Ghost' }));
        await cardParser.writeCardToFile(sourcePath, destPath, JSON.stringify({ name: 'Ghost 2' }));

        const leftovers = fs.readdirSync(tempDir).filter(f => f.endsWith('.tmp'));
        expect(leftovers).toEqual([]);
    });

    test('falls back to a full write, without attempting reflink, when the chara chunk sits before IDAT', async () => {
        fs.writeFileSync(sourcePath, buildSourcePng({ name: 'Ghost' }, 'before-idat'));
        const newData = JSON.stringify({ name: 'Ghost 2' });

        const result = await cardParser.writeCardToFile(sourcePath, destPath, newData);

        expect(result).toEqual({ reflinked: false });
        expect(reflinkFileMock).not.toHaveBeenCalled();

        const written = fs.readFileSync(destPath);
        expect(JSON.parse(Buffer.from(readTextChunks(written).chara, 'base64').toString('utf8'))).toEqual({ name: 'Ghost 2' });
    });

    test('falls back to a full write when the reflink call itself fails (e.g. cross-filesystem)', async () => {
        fs.writeFileSync(sourcePath, buildSourcePng({ name: 'Ghost' }));
        reflinkFileMock.mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
        const newData = JSON.stringify({ name: 'Ghost 2' });

        const result = await cardParser.writeCardToFile(sourcePath, destPath, newData);

        expect(result).toEqual({ reflinked: false });
        const written = fs.readFileSync(destPath);
        expect(JSON.parse(Buffer.from(readTextChunks(written).chara, 'base64').toString('utf8'))).toEqual({ name: 'Ghost 2' });
        // No abandoned temp file from the failed attempt.
        expect(fs.readdirSync(tempDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    });

    test('a source with no existing chara/ccv3 chunk at all still takes the fast path (nothing to remove, insert before IEND)', async () => {
        fs.writeFileSync(sourcePath, BLANK_PNG);
        const newData = JSON.stringify({ name: 'Fresh' });

        const result = await cardParser.writeCardToFile(sourcePath, destPath, newData);

        expect(result).toEqual({ reflinked: true });
        const written = fs.readFileSync(destPath);
        expect(JSON.parse(Buffer.from(readTextChunks(written).chara, 'base64').toString('utf8'))).toEqual({ name: 'Fresh' });
    });

    test('preserves an existing destPath\'s mode when overwriting via the fast path', async () => {
        fs.writeFileSync(sourcePath, buildSourcePng({ name: 'Ghost' }));
        fs.writeFileSync(destPath, 'placeholder');
        fs.chmodSync(destPath, 0o640);

        await cardParser.writeCardToFile(sourcePath, destPath, JSON.stringify({ name: 'Ghost 2' }));

        const mode = fs.statSync(destPath).mode & 0o777;
        expect(mode).toBe(0o640);
    });

    test('produces a byte-identical result to the plain write() + writeFileAtomic path for the same input', async () => {
        const source = buildSourcePng({ name: 'Parity Check', spec: 'chara_card_v2', data: { description: 'x'.repeat(500) } });
        fs.writeFileSync(sourcePath, source);
        const newData = JSON.stringify({ name: 'Parity Check 2', spec: 'chara_card_v2', data: { description: 'y'.repeat(500) } });

        const result = await cardParser.writeCardToFile(sourcePath, destPath, newData);
        expect(result).toEqual({ reflinked: true });

        const fastPathOutput = fs.readFileSync(destPath);
        const slowPathOutput = cardParser.write(source, newData);
        expect(Buffer.compare(fastPathOutput, slowPathOutput)).toBe(0);
    });
});
