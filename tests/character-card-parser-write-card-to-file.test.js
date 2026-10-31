import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

const reflinkFileMock = jest.fn();

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

/**
 * @param {object} charaData
 * @param {'before-idat' | 'before-iend'} [position]
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

        expect(result.reflinked).toBe(true);
        const sourceChunks = extract(new Uint8Array(fs.readFileSync(sourcePath)));
        expect(result.avatarIdentityHash).toBe(cardParser.computeAvatarIdentityHashFromChunks(sourceChunks));
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

        expect(result.reflinked).toBe(false);
        expect(reflinkFileMock).not.toHaveBeenCalled();

        const written = fs.readFileSync(destPath);
        expect(JSON.parse(Buffer.from(readTextChunks(written).chara, 'base64').toString('utf8'))).toEqual({ name: 'Ghost 2' });
    });

    test('falls back to a full write when the reflink call itself fails (e.g. cross-filesystem)', async () => {
        fs.writeFileSync(sourcePath, buildSourcePng({ name: 'Ghost' }));
        reflinkFileMock.mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
        const newData = JSON.stringify({ name: 'Ghost 2' });

        const result = await cardParser.writeCardToFile(sourcePath, destPath, newData);

        expect(result.reflinked).toBe(false);
        const written = fs.readFileSync(destPath);
        expect(JSON.parse(Buffer.from(readTextChunks(written).chara, 'base64').toString('utf8'))).toEqual({ name: 'Ghost 2' });
        expect(fs.readdirSync(tempDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    });

    test('a source with no existing chara/ccv3 chunk at all still takes the fast path (nothing to remove, insert before IEND)', async () => {
        fs.writeFileSync(sourcePath, BLANK_PNG);
        const newData = JSON.stringify({ name: 'Fresh' });

        const result = await cardParser.writeCardToFile(sourcePath, destPath, newData);

        expect(result.reflinked).toBe(true);
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
        expect(result.reflinked).toBe(true);

        const fastPathOutput = fs.readFileSync(destPath);
        const slowPathOutput = cardParser.write(source, newData);
        expect(Buffer.compare(fastPathOutput, slowPathOutput)).toBe(0);
    });
});

describe('reclaimReflinkPrefix', () => {
    let tempDir;
    let sourcePath;
    let existingPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-reclaim-reflink-'));
        sourcePath = path.join(tempDir, 'source.png');
        existingPath = path.join(tempDir, 'existing.png');

        reflinkFileMock.mockReset();
        reflinkFileMock.mockImplementation(async (src, dst) => {
            fs.copyFileSync(src, dst);
            return 0;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('reclaims an already-imported file whose shared prefix genuinely matches its source', async () => {
        const source = buildSourcePng({ name: 'Original' });
        fs.writeFileSync(sourcePath, source);
        const alreadyImported = cardParser.write(source, JSON.stringify({ name: 'Imported Copy' }));
        fs.writeFileSync(existingPath, alreadyImported);

        const result = await cardParser.reclaimReflinkPrefix(existingPath, sourcePath);

        expect(result).toEqual({ reflinked: true });
        expect(reflinkFileMock).toHaveBeenCalledTimes(1);
        expect(Buffer.compare(fs.readFileSync(existingPath), alreadyImported)).toBe(0);
    });

    test('declines and leaves the file untouched when the prefix does not actually match (wrong/mismatched source)', async () => {
        const source = buildSourcePng({ name: 'Original' });
        fs.writeFileSync(sourcePath, source);

        const differentImageChunks = extract(new Uint8Array(BLANK_PNG));
        const idat = differentImageChunks.find(c => c.name === 'IDAT');
        idat.data = new Uint8Array(idat.data);
        idat.data[0] ^= 0xff;
        const differentImage = Buffer.from(encode(differentImageChunks));
        const unrelatedImported = cardParser.write(differentImage, JSON.stringify({ name: 'Unrelated' }));
        fs.writeFileSync(existingPath, unrelatedImported);

        const result = await cardParser.reclaimReflinkPrefix(existingPath, sourcePath);

        expect(result).toEqual({ reflinked: false, reason: 'prefix-mismatch-or-ineligible-layout' });
        expect(reflinkFileMock).not.toHaveBeenCalled();
        expect(Buffer.compare(fs.readFileSync(existingPath), unrelatedImported)).toBe(0);
    });

    test('declines when the candidate source has an ineligible chunk layout (chara chunk before IDAT)', async () => {
        const source = buildSourcePng({ name: 'Original' }, 'before-idat');
        fs.writeFileSync(sourcePath, source);
        const imported = cardParser.write(source, JSON.stringify({ name: 'Imported Copy' }));
        fs.writeFileSync(existingPath, imported);

        const result = await cardParser.reclaimReflinkPrefix(existingPath, sourcePath);

        expect(result).toEqual({ reflinked: false, reason: 'prefix-mismatch-or-ineligible-layout' });
        expect(reflinkFileMock).not.toHaveBeenCalled();
    });

    test('preserves the existing file own current tail bytes verbatim, not a re-derived value', async () => {
        const source = buildSourcePng({ name: 'Original' });
        fs.writeFileSync(sourcePath, source);
        const data = JSON.stringify({ name: 'V3 Card', spec: 'chara_card_v3', spec_version: '3.0' });
        const written = cardParser.write(source, data);
        const writtenChunks = extract(new Uint8Array(written));
        const ccv3Chunk = PNGtext.encode('ccv3', Buffer.from(data, 'utf8').toString('base64'));
        writtenChunks.splice(-1, 0, ccv3Chunk);
        const alreadyImported = Buffer.from(encode(writtenChunks));
        fs.writeFileSync(existingPath, alreadyImported);

        await cardParser.reclaimReflinkPrefix(existingPath, sourcePath);

        const result = fs.readFileSync(existingPath);
        expect(Buffer.compare(result, alreadyImported)).toBe(0);
        const chunks = extract(new Uint8Array(result)).filter(c => c.name === 'tEXt');
        expect(chunks.length).toBe(2);
    });

    test('leaves the file untouched when the reflink itself fails', async () => {
        const source = buildSourcePng({ name: 'Original' });
        fs.writeFileSync(sourcePath, source);
        const alreadyImported = cardParser.write(source, JSON.stringify({ name: 'Imported Copy' }));
        fs.writeFileSync(existingPath, alreadyImported);
        reflinkFileMock.mockRejectedValueOnce(new Error('reflink unsupported'));

        const result = await cardParser.reclaimReflinkPrefix(existingPath, sourcePath);

        expect(result).toEqual({ reflinked: false, reason: 'reflink-failed' });
        expect(Buffer.compare(fs.readFileSync(existingPath), alreadyImported)).toBe(0);
        expect(fs.readdirSync(tempDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    });
});
