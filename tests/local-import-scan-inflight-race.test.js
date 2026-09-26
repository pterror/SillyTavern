import { describe, test, expect, jest, beforeAll, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';

// Regression coverage for a real bug (2026-09 investigation): the periodic scan and the (optional) directory
// watcher each have their own independent trigger for calling processFile() on a given filename, and nothing
// about WHEN either fires prevents them from both landing on the SAME filename at once - most simply, the
// mandatory very-first scan pass on every server boot always runs concurrently with a watcher that's already
// live by the time that pass starts (see initializeLocalImportScan()). withPerHashLock() does NOT close this:
// it only serializes the dedup-check-then-import DECISION within a single call - a file already recognized as
// a duplicate of something previously imported takes the identical short-circuit branch on every call
// regardless, so two genuinely concurrent processFile() calls for the same filename each independently ran the
// whole processFileImpl() pass. Fixed by a per-filename in-flight guard in local-import-scan.js's processFile():
// a second concurrent call for a filename already being processed just joins the first call's own promise
// instead of running its own redundant pass.
//
// findCharacterIdByContentHash() is counted because processFileImpl() calls it exactly once per run on the
// duplicate path, so its call count is the number of processFileImpl() runs. The stall makes the race
// deterministic: the second pass's dispatch for the same filename lands while the first is still in flight.
let findCharacterIdByContentHashCallCount = 0;
/** @type {number} */
let findCharacterIdByContentHashStallMs = 0;

const originalCwd = process.cwd();
afterAll(() => process.chdir(originalCwd));

// A minimal valid 1x1 transparent PNG - same fixture local-import-scan.test.js/character-card-parser.test.js use.
const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

/** @type {typeof import('../src/local-import-scan.js')} */
let localImportScan;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));
    // importFromPng() reads DEFAULT_AVATAR_PATH relative to cwd - same fix local-import-scan.test.js needed.
    process.chdir(path.resolve(originalCwd, '..'));

    const actualMetadataDb = await import('../src/character-metadata-db.js');
    jest.unstable_mockModule('../src/character-metadata-db.js', () => ({
        ...actualMetadataDb,
        findCharacterIdByContentHash: jest.fn(async (...args) => {
            findCharacterIdByContentHashCallCount++;
            if (findCharacterIdByContentHashStallMs > 0) {
                await new Promise(resolve => setTimeout(resolve, findCharacterIdByContentHashStallMs));
            }
            return actualMetadataDb.findCharacterIdByContentHash(...args);
        }),
    }));

    localImportScan = await import('../src/local-import-scan.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
});

describe('local-import-scan: concurrent processFile() calls for the SAME filename (watcher/periodic-scan overlap)', () => {
    let tempDir;
    let sourceDir;
    let charactersDir;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let directories;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-import-scan-inflight-test-'));
        sourceDir = path.join(tempDir, 'watched');
        charactersDir = path.join(tempDir, 'characters');
        const chatsDir = path.join(tempDir, 'chats');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.mkdirSync(charactersDir, { recursive: true });
        fs.mkdirSync(chatsDir, { recursive: true });
        directories = { root: tempDir, characters: charactersDir, chats: chatsDir };
        globalThis.DATA_ROOT = tempDir;

        findCharacterIdByContentHashCallCount = 0;
        findCharacterIdByContentHashStallMs = 0;
    });

    afterEach(() => {
        metadataDb.disposeMetadataStores();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    afterAll(() => {
        localImportScan.disposeLocalImportScan();
    });

    /** @returns {{ sourceDir: string, lastSeenMtimeMs: Map<string, number>, watcher: null, watchTimers: Map<string, NodeJS.Timeout> }} */
    function buildState() {
        return { sourceDir, lastSeenMtimeMs: new Map(), watcher: null, watchTimers: new Map() };
    }

    test('two concurrent scanDirectory() passes over a file that is ALREADY a duplicate only process it once, not once per pass', async () => {
        const cardBuffer = cardParser.write(BLANK_PNG, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Ghost' } }));
        fs.writeFileSync(path.join(sourceDir, 'ghost.png'), cardBuffer);
        const state = buildState();
        await localImportScan.scanDirectory(state, directories);
        expect(fs.readdirSync(charactersDir).length).toBe(1);
        findCharacterIdByContentHashCallCount = 0;

        fs.writeFileSync(path.join(sourceDir, 'ghost-copy.png'), cardBuffer);
        findCharacterIdByContentHashStallMs = 50;

        // Same shared `state` object for both - this is what makes it "the same filename, two concurrent
        // triggers", exactly like a periodic-scan pass and a watcher-triggered call sharing one DirectoryScanState
        // in the real module. Neither call is awaited before the other starts.
        await Promise.all([
            localImportScan.scanDirectory(state, directories),
            localImportScan.scanDirectory(state, directories),
        ]);

        // Still only one character on disk (dedup itself was never in question - see the other dedup tests in
        // local-import-scan.test.js) - what THIS test is actually about is below.
        expect(fs.readdirSync(charactersDir).length).toBe(1);

        // Without the in-flight guard, both passes run processFileImpl() for ghost-copy.png, each calling
        // findCharacterIdByContentHash() once (ghost.png is skipped by its unchanged mtime).
        expect(findCharacterIdByContentHashCallCount).toBe(1);
    });
});
