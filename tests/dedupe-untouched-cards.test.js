import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

// A minimal valid 1x1 transparent PNG - same fixture character-card-parser-write-card-to-file.test.js uses.
const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

const reflinkFileMock = jest.fn();

// Same reasoning as character-card-parser-write-card-to-file.test.js: @reflink/reflink is a real native
// binding, not something a unit test should depend on this platform/filesystem actually supporting - mocked
// here so reclaimReflinkPrefix()'s fast-path-vs-decline behavior is deterministic regardless of what /tmp
// happens to be mounted on in CI.
jest.unstable_mockModule('@reflink/reflink', () => ({
    reflinkFile: reflinkFileMock,
}));

/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../scripts/dedupe-untouched-cards.mjs')} */
let dedupeScript;
/** @type {typeof import('png-chunks-extract').default} */
let extract;
/** @type {typeof import('../src/png/encode.js').default} */
let encode;
/** @type {typeof import('better-sqlite3').default} */
let Database;

beforeAll(async () => {
    cardParser = await import('../src/character-card-parser.js');
    dedupeScript = await import('../scripts/dedupe-untouched-cards.mjs');
    ({ default: extract } = await import('png-chunks-extract'));
    ({ default: encode } = await import('../src/png/encode.js'));
    ({ default: Database } = await import('better-sqlite3'));
});

describe('dedupe-untouched-cards.mjs', () => {
    let tempDir;
    let charactersDir;
    let dbPath;
    let db;
    let PNGtext;

    beforeAll(async () => {
        PNGtext = (await import('png-chunk-text')).default ?? await import('png-chunk-text');
    });

    /**
     * @param {object} charaData
     * @returns {Buffer}
     */
    function makeSourcePng(charaData) {
        const base64 = Buffer.from(JSON.stringify(charaData), 'utf8').toString('base64');
        const chunks = extract(new Uint8Array(BLANK_PNG));
        chunks.splice(-1, 0, PNGtext.encode('chara', base64));
        return Buffer.from(encode(chunks));
    }

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dedupe-untouched-cards-'));
        charactersDir = path.join(tempDir, 'characters');
        fs.mkdirSync(charactersDir, { recursive: true });
        dbPath = path.join(tempDir, 'character-metadata.sqlite');

        db = new Database(dbPath);
        // Minimal slice of character-metadata-db.js's real `characters` table shape - only the three columns
        // this script's own query touches. Seeded and queried with the SAME SQL shape the script uses, not a
        // mocked-away db layer.
        db.exec(`
            CREATE TABLE characters (
                id TEXT PRIMARY KEY,
                content_identity_hash TEXT,
                avatar_identity_hash TEXT
            );
        `);

        reflinkFileMock.mockReset();
        reflinkFileMock.mockImplementation(async (src, dst) => {
            fs.copyFileSync(src, dst);
            return 0;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    /**
     * @param {{id: string, content_identity_hash: string, avatar_identity_hash?: string | null}[]} rows
     */
    function seedRows(rows) {
        const insert = db.prepare('INSERT INTO characters (id, content_identity_hash, avatar_identity_hash) VALUES (@id, @content_identity_hash, @avatar_identity_hash)');
        for (const row of rows) {
            insert.run({ avatar_identity_hash: null, ...row });
        }
    }

    /** Same query shape the script itself runs against the real db. */
    function queryRows() {
        return db.prepare('SELECT id, content_identity_hash, avatar_identity_hash FROM characters WHERE content_identity_hash IS NOT NULL').all();
    }

    test('reflinks two rows that share content_identity_hash and have byte-identical image prefixes', async () => {
        const source = makeSourcePng({ name: 'Original' });
        fs.writeFileSync(path.join(charactersDir, 'Alice.png'), source);
        // Same shared-prefix shape reclaimReflinkPrefix()'s own tests use: a differently-tagged copy of the
        // same underlying image, byte-identical up through the reflinkable prefix.
        const duplicate = cardParser.write(source, JSON.stringify({ name: 'Duplicate Copy' }));
        fs.writeFileSync(path.join(charactersDir, 'Bob.png'), duplicate);

        seedRows([
            { id: 'Alice.png', content_identity_hash: 'hash-a' },
            { id: 'Bob.png', content_identity_hash: 'hash-a' },
        ]);

        const counters = await dedupeScript.runDedupeSweep(queryRows(), { charactersDir, apply: true });

        expect(counters.groups).toBe(1);
        expect(counters.pairs).toBe(1);
        expect(counters.reflinked).toBe(1);
        expect(counters.declined).toBe(0);
        expect(counters.errors).toBe(0);
        expect(reflinkFileMock).toHaveBeenCalledTimes(1);
        // Content stays byte-identical to what was there before - only the on-disk sharing changed.
        expect(Buffer.compare(fs.readFileSync(path.join(charactersDir, 'Bob.png')), duplicate)).toBe(0);
    });

    test('declines a pair whose content_identity_hash matches but portraits genuinely differ, without erroring', async () => {
        const source = makeSourcePng({ name: 'Original' });
        fs.writeFileSync(path.join(charactersDir, 'Alice.png'), source);

        // A different image (mutated IDAT bytes), not just different metadata - matches the real-world shape
        // of a content_identity_hash collision with a genuinely different portrait.
        const differentImageChunks = extract(new Uint8Array(BLANK_PNG));
        const idat = differentImageChunks.find(c => c.name === 'IDAT');
        idat.data = new Uint8Array(idat.data);
        idat.data[0] ^= 0xff;
        const differentImage = Buffer.from(encode(differentImageChunks));
        const unrelated = cardParser.write(differentImage, JSON.stringify({ name: 'Unrelated' }));
        fs.writeFileSync(path.join(charactersDir, 'Bob.png'), unrelated);

        seedRows([
            { id: 'Alice.png', content_identity_hash: 'hash-a' },
            { id: 'Bob.png', content_identity_hash: 'hash-a' },
        ]);

        const counters = await dedupeScript.runDedupeSweep(queryRows(), { charactersDir, apply: true });

        expect(counters.reflinked).toBe(0);
        expect(counters.declined).toBe(1);
        expect(counters.errors).toBe(0);
        expect(reflinkFileMock).not.toHaveBeenCalled();
        expect(Buffer.compare(fs.readFileSync(path.join(charactersDir, 'Bob.png')), unrelated)).toBe(0);
    });

    test('dry-run mode (apply: false) touches no files', async () => {
        const source = makeSourcePng({ name: 'Original' });
        fs.writeFileSync(path.join(charactersDir, 'Alice.png'), source);
        const duplicate = cardParser.write(source, JSON.stringify({ name: 'Duplicate Copy' }));
        fs.writeFileSync(path.join(charactersDir, 'Bob.png'), duplicate);

        seedRows([
            { id: 'Alice.png', content_identity_hash: 'hash-a' },
            { id: 'Bob.png', content_identity_hash: 'hash-a' },
        ]);

        const counters = await dedupeScript.runDedupeSweep(queryRows(), { charactersDir, apply: false });

        expect(counters.pairs).toBe(1);
        expect(counters.reflinked).toBe(0);
        expect(counters.declined).toBe(0);
        expect(reflinkFileMock).not.toHaveBeenCalled();
        expect(Buffer.compare(fs.readFileSync(path.join(charactersDir, 'Bob.png')), duplicate)).toBe(0);
    });

    test('avatar_identity_hash prefilter skips a doomed pair without reading its files', async () => {
        const source = makeSourcePng({ name: 'Original' });
        fs.writeFileSync(path.join(charactersDir, 'Alice.png'), source);
        const duplicate = cardParser.write(source, JSON.stringify({ name: 'Duplicate Copy' }));
        fs.writeFileSync(path.join(charactersDir, 'Bob.png'), duplicate);

        // Same content_identity_hash, but avatar_identity_hash values are both non-null and disagree - known
        // to be different portraits, so the byte check is certain to fail; the prefilter should skip this pair
        // before ever calling reclaimReflinkPrefix() (and therefore before it reads either file).
        seedRows([
            { id: 'Alice.png', content_identity_hash: 'hash-a', avatar_identity_hash: 'avatar-1' },
            { id: 'Bob.png', content_identity_hash: 'hash-a', avatar_identity_hash: 'avatar-2' },
        ]);

        const reclaimSpy = jest.fn();
        const counters = await dedupeScript.runDedupeSweep(queryRows(), { charactersDir, apply: true, reclaim: reclaimSpy });

        expect(counters.skippedAvatarMismatch).toBe(1);
        expect(counters.reflinked).toBe(0);
        expect(counters.declined).toBe(0);
        expect(reclaimSpy).not.toHaveBeenCalled();
        expect(reflinkFileMock).not.toHaveBeenCalled();
    });

    test('isKnownAvatarMismatch only flags a pair when BOTH sides carry a non-null, differing avatar_identity_hash', () => {
        const a = { id: 'Alice.png', content_identity_hash: 'h', avatar_identity_hash: 'x' };
        const b = { id: 'Bob.png', content_identity_hash: 'h', avatar_identity_hash: 'y' };
        const c = { id: 'Carol.png', content_identity_hash: 'h', avatar_identity_hash: null };

        expect(dedupeScript.isKnownAvatarMismatch(a, b)).toBe(true);
        expect(dedupeScript.isKnownAvatarMismatch(a, c)).toBe(false);
        expect(dedupeScript.isKnownAvatarMismatch(c, c)).toBe(false);
    });

    test('buildReflinkCandidatePairs groups by content_identity_hash and skips singleton groups, picking the lowest id as source', () => {
        const rows = [
            { id: 'Zed.png', content_identity_hash: 'hash-a', avatar_identity_hash: null },
            { id: 'Alice.png', content_identity_hash: 'hash-a', avatar_identity_hash: null },
            { id: 'Solo.png', content_identity_hash: 'hash-b', avatar_identity_hash: null },
        ];

        const pairs = dedupeScript.buildReflinkCandidatePairs(rows);

        expect(pairs).toHaveLength(1);
        expect(pairs[0].source.id).toBe('Alice.png');
        expect(pairs[0].candidate.id).toBe('Zed.png');
    });
});
