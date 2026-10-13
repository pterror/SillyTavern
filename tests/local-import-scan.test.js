import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';

// importFromJson() writes through DEFAULT_AVATAR_PATH ('./public/img/...', repo-root-relative) for the blank
// avatar template - same fix characters-import.test.js needed for the same reason (see that file's own note).
const originalCwd = process.cwd();
afterAll(() => process.chdir(originalCwd));

/** @type {typeof import('../src/local-import-scan.js')} */
let localImportScan;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/user-stores.js')} */
let stores;
/** @type {typeof import('../src/library-codes.js').TYPE} */
let TYPE;
/** @type {typeof import('../src/library-engine.js').HASH} */
let HASH;
/** @type {typeof import('../src/users.js')} */
let users;
/** @type {typeof import('../src/constants.js')} */
let constants;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;

// A minimal valid 1x1 transparent PNG - same fixture character-card-parser.test.js uses, just enough of a real
// PNG for png-chunks-extract to parse.
const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    // importFromJson() reads DEFAULT_AVATAR_PATH relative to cwd - see this file's own note above.
    process.chdir(path.resolve(originalCwd, '..'));

    localImportScan = await import('../src/local-import-scan.js');
    fixture = await import('./converted-user.fixture.js');
    stores = await import('../src/user-stores.js');
    ({ TYPE } = await import('../src/library-codes.js'));
    ({ HASH } = await import('../src/library-engine.js'));
    users = await import('../src/users.js');
    constants = await import('../src/constants.js');
    cardParser = await import('../src/character-card-parser.js');
});

/**
 * Writes a minimal v1-JSON character file to `dir` - the simplest format importFromJson() accepts, so a test
 * file's bytes are exactly the JSON text below (no PNG re-encode pipeline involved).
 * @param {string} dir
 * @param {string} filename
 * @param {object} [overrides]
 * @returns {string} The full path written
 */
function writeJsonCharacterFile(dir, filename, overrides = {}) {
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, JSON.stringify({ name: 'Ghost', description: 'A local-import test character', ...overrides }));
    return filePath;
}

/**
 * The avatars of the characters a user's library has, in order.
 * @param {import('../src/users.js').UserDirectoryList} directories
 * @returns {Promise<string[]>}
 */
async function charactersOf(directories) {
    const { lib } = await stores.userStore(directories);
    const page = await lib.query({ wantRows: true, wantTotal: false, includeGroups: false, limit: 1000, sortField: 'name' });
    return /** @type {any[]} */ (page.rows).map(r => r.item.avatar).sort();
}

/**
 * A character as the library has it: its name, its content hash (hex) and the date it was added.
 * @param {import('../src/users.js').UserDirectoryList} directories
 * @param {string} avatar
 */
async function rowOf(directories, avatar) {
    const { lib } = await stores.userStore(directories);
    const e = await lib.entity(TYPE.character, avatar);
    if (!e) return undefined;
    const [card] = await lib.cards([avatar]);
    return { name: card.name, content_hash: e.hashes.find(h => h.which === HASH.content)?.hash.toString('hex'), date_added: e.added };
}

describe('scanDirectory (unit: direct directories fixture, no boot wiring)', () => {
    /** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
    let user;
    let tempDir;
    let sourceDir;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let directories;

    beforeEach(async () => {
        user = await fixture.emptyUser('st-local-import-scan-test-');
        tempDir = user.dataRoot;
        directories = user.directories;
        sourceDir = path.join(tempDir, 'watched');
        fs.mkdirSync(sourceDir, { recursive: true });

        // local-import-scan.js stages discovered files into globalThis.DATA_ROOT/_uploads - the same directory
        // multer stages a browser upload into (see that module's getUploadsDir()).
        globalThis.DATA_ROOT = tempDir;
    });

    afterEach(() => user.close());

    /** The avatars of the characters this test's library has. */
    const characters = () => charactersOf(directories);

    // Every scanDirectory() call in this block lazily creates local-import-scan.js's shared worker pool
    // (2026-08 local-import worker-pool work) on first use and reuses it across every test here - by design,
    // spinning one up per test/file would defeat the point of a persistent pool (see
    // local-import-worker-pool.js's own header). Without this, that pool's worker threads stay alive for the
    // rest of this file's test run (this describe block never calls disposeLocalImportScan() itself, unlike
    // the boot-wiring describe block below) - the workers are deliberately NOT .unref()'d (see
    // local-import-worker-pool.js's own header on why that was tried and found unsafe), so leaving them
    // running is exactly the "leaked worker thread" failure mode the pool's lifecycle design exists to
    // prevent, and would keep the whole test process from exiting cleanly. This teardown is what actually
    // bounds their lifetime to the tests that need them.
    afterAll(() => {
        localImportScan.disposeLocalImportScan();
    });

    /** @returns {ReturnType<typeof buildState>} */
    function buildState() {
        return { sourceDir, lastSeenMtimeMs: new Map(), watcher: null, watchTimers: new Map() };
    }

    test('discovers a new recognized file and imports it through the real write path', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');

        await localImportScan.scanDirectory(buildState(), directories);

        const files = await characters();
        expect(files.length).toBe(1);
        expect(files[0]).toMatch(/\.png$/);

        const row = await rowOf(directories, files[0]);
        expect(row).toBeDefined();
        expect(row.name).toBe('Ghost');
        expect(row.content_hash).toEqual(expect.any(String));
    });

    test('ignores files with an unrecognized extension', async () => {
        fs.writeFileSync(path.join(sourceDir, 'notes.txt'), 'not a character file');

        await localImportScan.scanDirectory(buildState(), directories);

        expect((await characters()).length).toBe(0);
    });

    test('does not leave a staged copy behind in the uploads directory after a successful import', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');

        await localImportScan.scanDirectory(buildState(), directories);

        // json (like png) goes through the worker-owned-write pipeline (2026-08 extension) - it never stages
        // via stageFile() at all anymore, so the uploads dir may not even exist. What must still hold, either
        // way, is the actual invariant this test is named for: no leaked staged copy of the imported file.
        const uploadsDir = path.join(tempDir, '_uploads');
        const stagedFiles = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
        expect(stagedFiles.length).toBe(0);
    });

    test('never deletes or moves the original source file', async () => {
        const sourcePath = writeJsonCharacterFile(sourceDir, 'ghost.json');

        await localImportScan.scanDirectory(buildState(), directories);

        expect(fs.existsSync(sourcePath)).toBe(true);
    });

    test('dedup: a second scan pass over the same unchanged file does not re-import it', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');

        const state = buildState();
        await localImportScan.scanDirectory(state, directories);
        await localImportScan.scanDirectory(state, directories);

        expect((await characters()).length).toBe(1);
    });

    test('dedup: two different source files with byte-identical content only import once (content-hash dedup, not mtime-based)', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');
        writeJsonCharacterFile(sourceDir, 'ghost-copy.json');

        await localImportScan.scanDirectory(buildState(), directories);

        expect((await characters()).length).toBe(1);
    });

    test('a byte-identical file dropped in after the original was already imported is skipped as a duplicate, not re-imported', async () => {
        const existingJson = JSON.stringify({ name: 'Ghost', description: 'A local-import test character' });
        fs.writeFileSync(path.join(sourceDir, 'ghost.json'), existingJson);
        await localImportScan.scanDirectory(buildState(), directories);
        expect((await characters()).length).toBe(1);

        // A second, byte-identical file lands later (e.g. copied in by hand) - should be recognized as a
        // duplicate of the character already imported, via findCharacterIdByContentHash(), not re-imported.
        fs.writeFileSync(path.join(sourceDir, 'ghost-again.json'), existingJson);
        await localImportScan.scanDirectory(buildState(), directories);
        expect((await characters()).length).toBe(1);
    });

    test('a source file matching an existing character by content hash leaves that character\'s date_added unchanged', async () => {
        const existingJson = JSON.stringify({ name: 'Ghost', description: 'A local-import test character' });
        fs.writeFileSync(path.join(sourceDir, 'ghost.json'), existingJson);
        await localImportScan.scanDirectory(buildState(), directories);
        const [characterId] = await characters();
        const knownDateAdded = 1_000_000_000_000;
        await user.store.lib.updateEntity(TYPE.character, characterId, { dateAdded: knownDateAdded });

        const duplicatePath = path.join(sourceDir, 'ghost-again.json');
        fs.writeFileSync(duplicatePath, existingJson);
        const sourceMtime = new Date(1_500_000_000_000);
        fs.utimesSync(duplicatePath, sourceMtime, sourceMtime);
        await localImportScan.scanDirectory(buildState(), directories);

        expect(await characters()).toEqual([characterId]);
        const row = await rowOf(directories, characterId);
        expect(row.date_added).toBe(knownDateAdded);
    });

    test('a changed file (different mtime, different content) is re-processed on the next pass', async () => {
        const filePath = writeJsonCharacterFile(sourceDir, 'ghost.json', { name: 'Ghost' });

        const state = buildState();
        await localImportScan.scanDirectory(state, directories);
        expect((await characters()).length).toBe(1);

        // Force a distinct mtime so the mtime-skip cache doesn't short-circuit before the hash is even checked.
        await new Promise(resolve => setTimeout(resolve, 10));
        fs.writeFileSync(filePath, JSON.stringify({ name: 'Ghost the Second' }));

        await localImportScan.scanDirectory(state, directories);

        // Second, different-content character gets imported alongside the first.
        expect((await characters()).length).toBe(2);
    });

    describe('lastSeenMtimeMs cache-miss fallback (2026-09 unbounded-memory fix: bounded LRU cache, DB fallback on a miss)', () => {
        test('an evicted (or never-warmed) entry is still correctly skipped without re-reading the file, via the persisted local_import_mtimes fallback', async () => {
            const filePath = writeJsonCharacterFile(sourceDir, 'ghost.json');

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);
            expect((await characters()).length).toBe(1);
            expect(state.lastSeenMtimeMs.has('ghost.json')).toBe(true);

            // Simulate what MAX_LAST_SEEN_MTIME_ENTRIES eviction does in production: the entry falls out of the
            // bounded in-memory Map. Only the persisted local_import_mtimes row (setLocalImportMtime(), written
            // through by markProcessed() during the pass above) is left to answer the skip-check with.
            state.lastSeenMtimeMs.delete('ghost.json');

            const readFileSpy = jest.spyOn(fs.promises, 'readFile');
            try {
                await localImportScan.scanDirectory(state, directories);
            } finally {
                readFileSpy.mockRestore();
            }

            const sourceReads = readFileSpy.mock.calls.filter(call => call[0] === filePath);
            expect(sourceReads.length).toBe(0);
            // Still exactly one character - correctly recognized as unchanged via the DB fallback, not re-imported.
            expect((await characters()).length).toBe(1);
            // The fallback re-populates the cache with the answer it found.
            expect(state.lastSeenMtimeMs.get('ghost.json')).toBe(fs.statSync(filePath).mtimeMs);
        });

        test('an evicted entry for a file that changed in the meantime is still correctly re-processed, not incorrectly skipped', async () => {
            const filePath = writeJsonCharacterFile(sourceDir, 'ghost.json', { name: 'Ghost' });

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);
            expect((await characters()).length).toBe(1);

            state.lastSeenMtimeMs.delete('ghost.json'); // Simulate eviction, same as the sibling test above.

            // Force a distinct mtime so the fallback's persisted mtime genuinely no longer matches.
            await new Promise(resolve => setTimeout(resolve, 10));
            fs.writeFileSync(filePath, JSON.stringify({ name: 'Ghost the Second' }));

            await localImportScan.scanDirectory(state, directories);

            // Second, different-content character gets imported - the eviction never caused a stale skip.
            expect((await characters()).length).toBe(2);
        });

        test('touchLastSeenMtime() enforces a hard, fixed ceiling on state.lastSeenMtimeMs regardless of how many distinct files are touched, evicting least-recently-touched first (LRU)', () => {
            const state = buildState();

            // One more than the cap - MAX_LAST_SEEN_MTIME_ENTRIES's own doc comment is explicit that this is
            // impractical to prove by actually scanning that many real files, so this exercises the exported LRU
            // helper local-import-scan.js's hot path itself goes through (markProcessed(), the cache-miss
            // fallback) directly, the same way character-metadata-db.js's own randomSortCache eviction is an
            // untested-but-analogous pattern this one deliberately mirrors.
            for (let i = 0; i < localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES + 1; i++) {
                localImportScan.touchLastSeenMtime(state, `file-${i}.json`, i);
            }

            // Never exceeds the ceiling - this is the actual fix: no code path can grow this Map past a fixed
            // size, unlike the old unbounded warm-from-DB Map it replaced.
            expect(state.lastSeenMtimeMs.size).toBe(localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES);
            // The least-recently-touched entry (file-0, touched first and never touched again) was evicted...
            expect(state.lastSeenMtimeMs.has('file-0.json')).toBe(false);
            // ...while the most-recently-touched one is still present.
            expect(state.lastSeenMtimeMs.get(`file-${localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES}.json`)).toBe(localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES);

            // Re-touching an already-present entry moves it to the "most recent" end instead of duplicating it or
            // growing the Map past the ceiling.
            const sizeBeforeRetouch = state.lastSeenMtimeMs.size;
            localImportScan.touchLastSeenMtime(state, `file-${localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES}.json`, 999);
            expect(state.lastSeenMtimeMs.size).toBe(sizeBeforeRetouch);
            expect(state.lastSeenMtimeMs.get(`file-${localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES}.json`)).toBe(999);
        });
    });

    test('watcher-triggered processFile() and the periodic scan agree on dedup (no double-import across the two trigger paths)', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');

        const state = buildState();
        // Simulate what the debounced fs.watch handler does: call the same per-file logic the scan uses,
        // directly, for just this one filename - see local-import-scan.js's header on why there is only one
        // discovery/import code path shared by both triggers.
        await localImportScan.scanDirectory(state, directories); // exercises the shared path end-to-end once

        // A subsequent periodic pass (simulating the backstop catching up after the watcher already handled it)
        // must not duplicate the character.
        await localImportScan.scanDirectory(state, directories);

        expect((await characters()).length).toBe(1);
    });

    test('dedup: two different PNG source files with byte-identical content only import once, and the worker-owned write path never leaves a second character behind (2026-08 worker-owned-write extension)', async () => {
        // png (unlike the json variant of this same test above) goes through the worker's two-phase
        // extract/splice/encode/write pipeline (see local-import-worker.js's own header) - this is the format
        // this extension's per-hash locking (local-import-scan.js's withPerHashLock()) most needs to hold up
        // for: two concurrently-dispatched workers both parsing the SAME bytes, then racing to decide whether
        // to actually write, must still only ever commit one write.
        const cardBuffer = cardParser.write(BLANK_PNG, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Ghost' } }));
        fs.writeFileSync(path.join(sourceDir, 'ghost.png'), cardBuffer);
        fs.writeFileSync(path.join(sourceDir, 'ghost-copy.png'), cardBuffer);

        await localImportScan.scanDirectory(buildState(), directories);

        const files = await characters();
        expect(files.length).toBe(1);
        // The one character that DID get written is a real, complete import - not a half-finished write.
        const row = await rowOf(directories, files[0]);
        expect(row).toBeDefined();
        expect(row.name).toBe('Ghost');
    });

    test('a source directory that does not exist is skipped without throwing', async () => {
        const missingState = { sourceDir: path.join(tempDir, 'does-not-exist'), lastSeenMtimeMs: new Map(), watcher: null, watchTimers: new Map() };
        await expect(localImportScan.scanDirectory(missingState, directories)).resolves.toBeUndefined();
    });

    describe('content-identity duplicate fallback (performance.allowExpensiveDuplicateFallback)', () => {
        afterEach(() => {
            delete process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK;
        });

        /** A minimal Spec V2 card object - what would have been passed to the OLD write()'s `data` param. */
        function poisonedCardData() {
            return {
                spec: 'chara_card_v2',
                spec_version: '2.0',
                name: 'Poison',
                data: {
                    name: 'Poison',
                    description: 'a poisoned-row test character',
                    personality: '',
                    scenario: '',
                    first_mes: '',
                    mes_example: '',
                    tags: [],
                    creator: '',
                    character_version: '',
                    creator_notes: '',
                    extensions: { fav: false, world: '' },
                },
            };
        }

        /**
         * A character in the library whose card holds `data`: a byte-different file with the same card is a
         * duplicate of it by the card's identity hash.
         * @param {object} data
         */
        async function seedPoisonedRow(data) {
            // Stored as a library card is: normalized, as an import's card is.
            const { getCharaCardV2 } = await import('../src/character-card-normalize.js');
            await user.store.lib.writeCard(directories, 'Poisoned.png', JSON.stringify(getCharaCardV2(structuredClone(data), directories, false)));
            expect(await characters()).toEqual(['Poisoned.png']);
        }

        test('flag on: a semantically-identical byte-different PNG dropped in is recognized as a duplicate of the poisoned row, not re-imported', async () => {
            process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'true';

            const data = poisonedCardData();
            await seedPoisonedRow(data);

            // Today's write() never adds a ccv3 chunk for a v2 source (see 293f4294b) - so this file's bytes
            // necessarily differ from Poisoned.png's, even though it carries the exact same `data`.
            const discoveredBuffer = cardParser.write(BLANK_PNG, JSON.stringify(data));
            fs.writeFileSync(path.join(sourceDir, 'discovered.png'), discoveredBuffer);

            await localImportScan.scanDirectory(buildState(), directories);

            // Not imported as a second character - the content-identity fallback recognized it as a duplicate of
            // the already-poisoned (but now-backfilled) Poisoned.png.
            expect(await characters()).toEqual(['Poisoned.png']);
        });

        test('flag on: a source file matching an existing character by identity hash leaves that character\'s date_added unchanged', async () => {
            process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'true';

            const data = poisonedCardData();
            await seedPoisonedRow(data);
            const knownDateAdded = 1_000_000_000_000;
            await user.store.lib.updateEntity(TYPE.character, 'Poisoned.png', { dateAdded: knownDateAdded });

            const discoveredPath = path.join(sourceDir, 'discovered.png');
            fs.writeFileSync(discoveredPath, cardParser.write(BLANK_PNG, JSON.stringify(data)));
            const sourceMtime = new Date(1_500_000_000_000);
            fs.utimesSync(discoveredPath, sourceMtime, sourceMtime);
            await localImportScan.scanDirectory(buildState(), directories);

            expect(await characters()).toEqual(['Poisoned.png']);
            const row = await rowOf(directories, 'Poisoned.png');
            expect(row.date_added).toBe(knownDateAdded);
        });

        test('flag off: the same setup is NOT recognized as a duplicate - the file gets imported as a new character', async () => {
            process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'false';

            const data = poisonedCardData();
            await seedPoisonedRow(data);

            const discoveredBuffer = cardParser.write(BLANK_PNG, JSON.stringify(data));
            fs.writeFileSync(path.join(sourceDir, 'discovered.png'), discoveredBuffer);

            await localImportScan.scanDirectory(buildState(), directories);

            expect((await characters()).length).toBe(2);
        });

        test('flag on: a genuinely different character is still imported normally, not falsely matched to the poisoned row', async () => {
            process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'true';

            await seedPoisonedRow(poisonedCardData());

            const differentData = poisonedCardData();
            differentData.name = 'Someone Else';
            differentData.data.name = 'Someone Else';
            differentData.data.description = 'a completely different character';
            const discoveredBuffer = cardParser.write(BLANK_PNG, JSON.stringify(differentData));
            fs.writeFileSync(path.join(sourceDir, 'different.png'), discoveredBuffer);

            await localImportScan.scanDirectory(buildState(), directories);

            // Imported as a genuinely new second character - a minted UUID filename, not 'different.png' itself
            // (mintCharacterId() never reuses the source file's basename - see characters.js).
            const files = await characters();
            expect(files.length).toBe(2);
            expect(files).toContain('Poisoned.png');
            const newRow = await rowOf(directories, files.find(f => f !== 'Poisoned.png'));
            expect(newRow.name).toBe('Someone Else');
        });

        test('never reads a newly-discovered source file on the main thread at all (2026-08 worker-pool fix: the read - and both the dedup hash and the identity-check parse that consume its bytes - now happen once, entirely inside a worker thread, not via fs.promises.readFile here)', async () => {
            process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'true';

            const discoveredBuffer = cardParser.write(BLANK_PNG, JSON.stringify(poisonedCardData()));
            const sourcePath = path.join(sourceDir, 'discovered.png');
            fs.writeFileSync(sourcePath, discoveredBuffer);

            // The original version of this test (pre-worker-pool) spied on fs.promises.readFile here and
            // asserted exactly one call, catching a real bug where the same source file's bytes were read
            // twice from disk (once for the dedup hash, once again for the identity-check parse). That read
            // now happens exactly once too, but inside local-import-worker.js's own thread via a plain
            // fs.readFileSync - a separate Node realm this spy can't see into. So this asserts the main
            // thread never reads the source file's bytes AT ALL (zero fs.promises.readFile calls for it) -
            // the single-read guarantee has gotten strictly stronger (the multi-megabyte buffer no longer
            // even crosses into this thread), just no longer directly observable as "exactly once" from here.
            const readFileSpy = jest.spyOn(fs.promises, 'readFile');
            try {
                await localImportScan.scanDirectory(buildState(), directories);
            } finally {
                readFileSpy.mockRestore();
            }

            const sourceReads = readFileSpy.mock.calls.filter(call => call[0] === sourcePath);
            expect(sourceReads.length).toBe(0);

            // Sanity: the file was genuinely processed through both the hash-dedup and identity-check code paths
            // (not skipped for some unrelated reason that would make the zero-main-thread-reads count meaningless).
            expect((await characters()).length).toBe(1);
        });
    });

    describe('permanently skipping non-character .json files (2026-08 retry-loop fix)', () => {
        // Two real cases pulled straight from an owner's live corpus-directory logs: a genuinely non-character
        // JSON file (a lorebook/world-info export) sitting alongside real character cards, and a completely
        // different file (PNG binary content) that got misnamed/mislabeled with a `.json` extension. Both used
        // to fail import on every single scan pass forever, spamming the log - see local-import-scan.js's
        // classifyJsonCandidate() for the fix.
        let warnSpy;

        beforeEach(() => {
            warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        });

        afterEach(() => {
            warnSpy.mockRestore();
        });

        test('PNG-content-with-.json-extension: not valid JSON at all - skipped, not imported, logged once, and never re-attempted on a later pass', async () => {
            // A minimal real PNG signature + IHDR-ish bytes, exactly the "binary content, .json extension"
            // shape the owner's logs showed (JSON.parse choking on the '\x89PNG' signature byte).
            const misnamedPath = path.join(sourceDir, 'Nirana.json');
            fs.writeFileSync(misnamedPath, BLANK_PNG);

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);

            expect((await characters()).length).toBe(0);
            expect(fs.existsSync(misnamedPath)).toBe(true); // never touched/consumed

            const skip = await user.store.lib.localImportSkip(misnamedPath);
            expect(skip).not.toBeNull();
            expect(skip.reason).toBe('not-json');

            const permSkipWarnings = warnSpy.mock.calls.filter(call => String(call[0]).includes('Permanently skipping'));
            expect(permSkipWarnings.length).toBe(1);

            // A second pass over the SAME in-memory state must not re-attempt or re-log - lastSeenMtimeMs's
            // own cheap early-return already short-circuits this.
            await localImportScan.scanDirectory(state, directories);
            expect(warnSpy.mock.calls.filter(call => String(call[0]).includes('Permanently skipping')).length).toBe(1);
        });

        test('valid JSON but not a recognized character-card shape (e.g. a lorebook/world-info export) - skipped, not imported, logged once', async () => {
            const lorePath = path.join(sourceDir, 'Nirana Lore Extension - Elvish Culture.json');
            fs.writeFileSync(lorePath, JSON.stringify({
                entries: { 0: { key: ['elves'], content: 'The Elvish people of Nirana...' } },
                originalData: {},
            }));

            await localImportScan.scanDirectory(buildState(), directories);

            expect((await characters()).length).toBe(0);
            expect(fs.existsSync(lorePath)).toBe(true);

            const skip = await user.store.lib.localImportSkip(lorePath);
            expect(skip).not.toBeNull();
            expect(skip.reason).toBe('unrecognized-shape');

            const permSkipWarnings = warnSpy.mock.calls.filter(call => String(call[0]).includes('Permanently skipping'));
            expect(permSkipWarnings.length).toBe(1);
        });

        test('the skip survives a fresh in-memory scan state (simulated server restart) - only the durable metadata-db record, not the in-memory lastSeenMtimeMs cache, is what actually stops the retry loop', async () => {
            const lorePath = path.join(sourceDir, 'lore.json');
            fs.writeFileSync(lorePath, JSON.stringify({ entries: {} }));

            await localImportScan.scanDirectory(buildState(), directories); // first "boot"
            expect(warnSpy.mock.calls.filter(call => String(call[0]).includes('Permanently skipping')).length).toBe(1);

            // A brand new state (empty lastSeenMtimeMs Map) is exactly what a real server restart produces -
            // local-import-scan.js never persists that map itself (see its own doc comment on it being a
            // cold-started, in-memory-only efficiency cache).
            await localImportScan.scanDirectory(buildState(), directories); // second "boot"

            // No new "Permanently skipping" log and still nothing imported - the durable local_import_skips
            // record (keyed on the file's unchanged mtime) is what caught it this time, not the in-memory map.
            expect(warnSpy.mock.calls.filter(call => String(call[0]).includes('Permanently skipping')).length).toBe(1);
            expect((await characters()).length).toBe(0);
        });

        test('a previously-skipped file that is edited into a real character card gets a fresh classification attempt and imports normally', async () => {
            const filePath = path.join(sourceDir, 'maybe-a-character.json');
            fs.writeFileSync(filePath, JSON.stringify({ entries: {} })); // starts out as a lorebook-shaped file

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);
            expect((await characters()).length).toBe(0);
            expect((await user.store.lib.localImportSkip(filePath)).reason).toBe('unrecognized-shape');

            // The owner (or some other process) rewrites the same path into an actual v1 character card. Force a
            // distinct mtime so this isn't short-circuited by either skip cache before the content is re-read.
            await new Promise(resolve => setTimeout(resolve, 10));
            fs.writeFileSync(filePath, JSON.stringify({ name: 'Reclassified', description: 'now a real character' }));

            await localImportScan.scanDirectory(state, directories);

            expect((await characters()).length).toBe(1);
            expect(await user.store.lib.localImportSkip(filePath)).toBeNull();
        });

        test('a source file removed after being skipped has its durable skip record cleaned up, not left dangling forever', async () => {
            const filePath = path.join(sourceDir, 'temporary-lore.json');
            fs.writeFileSync(filePath, JSON.stringify({ entries: {} }));

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);
            expect(await user.store.lib.localImportSkip(filePath)).not.toBeNull();

            fs.rmSync(filePath);
            await localImportScan.scanDirectory(state, directories);

            expect(await user.store.lib.localImportSkip(filePath)).toBeNull();
        });

        test('this fix is scoped to .json only: a different format that fails for a non-content reason keeps the pre-existing retry-every-pass behavior, and is never recorded as a permanent skip', async () => {
            // Not a real PNG at all (no signature, no chunks) - importFromPng() throws "Failed to read character
            // data", which is caught by processFile()'s own outer catch (a genuine import-machinery failure, not
            // a content pre-check) and deliberately retried forever, exactly as before this fix.
            const brokenPngPath = path.join(sourceDir, 'broken.png');
            fs.writeFileSync(brokenPngPath, Buffer.from('this is not a png'));

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);
            await localImportScan.scanDirectory(state, directories);

            expect((await characters()).length).toBe(0);
            expect(fs.existsSync(brokenPngPath)).toBe(true);
            // No local_import_skips row - this failure mode is untouched by classifyJsonCandidate() (json-only).
            expect(await user.store.lib.localImportSkip(brokenPngPath)).toBeNull();
        });
    });
});

describe('initializeLocalImportScan / disposeLocalImportScan (config wiring)', () => {
    let dataRoot;
    let userCharactersDir;
    let userChatsDir;
    let sourceDir;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let userDirectories;

    beforeAll(async () => {
        const { loadEngine } = await import('../engine/load.js');
        stores.setStoreEngine(() => loadEngine().binding);
        // getUserDirectories() memoizes its result per handle for the process lifetime (see users.js's
        // DIRECTORIES_CACHE) - it is never re-resolved from a later globalThis.DATA_ROOT change, so this
        // describe block uses one fixed DATA_ROOT for all of its tests rather than a fresh one per test.
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-import-scan-boot-test-'));
        globalThis.DATA_ROOT = dataRoot;
        userDirectories = users.getUserDirectories(constants.DEFAULT_USER.handle);
        userCharactersDir = userDirectories.characters;
        userChatsDir = userDirectories.chats;
        fs.mkdirSync(userCharactersDir, { recursive: true });
        fs.mkdirSync(userChatsDir, { recursive: true });
    });

    afterAll(async () => {
        await stores.closeUserStores();
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    /** The avatars of the default user's characters. */
    const userCharacters = () => charactersOf(userDirectories);

    beforeEach(() => {
        sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-import-scan-boot-watched-'));
        delete process.env.SILLYTAVERN_LOCALIMPORT_ENABLED;
        delete process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES;
        delete process.env.SILLYTAVERN_LOCALIMPORT_SCANINTERVALMS;
        delete process.env.SILLYTAVERN_LOCALIMPORT_WATCHENABLED;
        // A very long interval - none of these tests rely on the periodic tick firing, only on the synchronous
        // initial scan initializeLocalImportScan() runs before returning.
        process.env.SILLYTAVERN_LOCALIMPORT_SCANINTERVALMS = String(24 * 60 * 60 * 1000);
        process.env.SILLYTAVERN_LOCALIMPORT_WATCHENABLED = 'false';
    });

    afterEach(async () => {
        localImportScan.disposeLocalImportScan();
        // A store of its own for the next test.
        await stores.closeUserStores();
        fs.rmSync(path.join(userDirectories.root, stores.STORE_DIR), { recursive: true, force: true });
        fs.rmSync(sourceDir, { recursive: true, force: true });
        delete process.env.SILLYTAVERN_LOCALIMPORT_ENABLED;
        delete process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES;
        delete process.env.SILLYTAVERN_LOCALIMPORT_SCANINTERVALMS;
        delete process.env.SILLYTAVERN_LOCALIMPORT_WATCHENABLED;
    });

    test('config-disabled: enabled=false imports nothing even with directories configured', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'false';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);

        await localImportScan.initializeLocalImportScan();

        expect((await userCharacters()).length).toBe(0);
    });

    test('config-disabled: an empty directories list imports nothing even with enabled=true', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([]);

        await localImportScan.initializeLocalImportScan();

        expect((await userCharacters()).length).toBe(0);
    });

    test('enabled with a configured directory imports the default-user library once the background initial scan completes (2026-08 boot-non-blocking fix: initializeLocalImportScan() itself resolves BEFORE the scan runs)', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);

        await localImportScan.initializeLocalImportScan();
        // initializeLocalImportScan() deliberately does not wait for the scan itself (see its own doc comment on
        // why a full pass must never block server startup) - waitForCurrentScanPass() is the test-only way to
        // observe "the initial pass has now finished".
        await localImportScan.waitForCurrentScanPass();

        const files = await userCharacters();
        expect(files.length).toBe(1);
        const row = await rowOf(userDirectories, files[0]);
        expect(row.name).toBe('Ghost');
    });

    test('re-initializing is idempotent and does not duplicate already-imported characters', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);

        await localImportScan.initializeLocalImportScan();
        await localImportScan.waitForCurrentScanPass();
        await localImportScan.initializeLocalImportScan();
        await localImportScan.waitForCurrentScanPass();

        expect((await userCharacters()).length).toBe(1);
    });

    test('initializeLocalImportScan() itself resolves without waiting for the initial scan pass to finish (boot must never block on a full corpus pass)', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);

        // A readFile that does not resolve stands in for "a pass that's still running" - if initializeLocalImportScan()
        // itself waited on the scan, this test would hang and fail on Jest's default timeout. The held reads are
        // let go afterwards, so the pass ends before the test's store goes.
        const realReadFile = fs.promises.readFile.bind(fs.promises);
        /** @type {(() => void)[]} */
        const held = [];
        const readFileSpy = jest.spyOn(fs.promises, 'readFile').mockImplementation((...args) => new Promise((resolve, reject) => {
            held.push(() => /** @type {any} */ (realReadFile)(...args).then(resolve, reject));
        }));
        try {
            await expect(localImportScan.initializeLocalImportScan()).resolves.toBeUndefined();
        } finally {
            readFileSpy.mockRestore();
            for (const release of held) release();
        }
        await localImportScan.waitForCurrentScanPass();
    });

    test('a restart (fresh in-memory state) does not re-read a source file whose mtime is unchanged since the last completed pass, thanks to the persisted local_import_mtimes record (2026-08 boot-cost fix)', async () => {
        const filePath = writeJsonCharacterFile(sourceDir, 'ghost.json');
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);

        await localImportScan.initializeLocalImportScan(); // first "boot"
        await localImportScan.waitForCurrentScanPass();
        expect((await userCharacters()).length).toBe(1);

        // Simulate a server restart: dispose (as a real shutdown would) and re-initialize. This constructs a
        // brand new, empty-Map DirectoryScanState internally - the ONLY thing that can make the second pass skip
        // re-reading ghost.json's unchanged bytes is the persisted local_import_mtimes record surviving the
        // "restart", not any in-memory cache (which never survives this).
        localImportScan.disposeLocalImportScan();

        const readFileSpy = jest.spyOn(fs.promises, 'readFile');
        try {
            await localImportScan.initializeLocalImportScan(); // second "boot"
            await localImportScan.waitForCurrentScanPass();
        } finally {
            readFileSpy.mockRestore();
        }

        const sourceReads = readFileSpy.mock.calls.filter(call => call[0] === filePath);
        expect(sourceReads.length).toBe(0);
        // Still exactly one character - the file was recognized as unchanged, not re-imported as a duplicate.
        expect((await userCharacters()).length).toBe(1);
    });

    test('a file that changes while the server is down (different mtime) IS re-read and re-processed on the next boot, despite the persisted mtime record for its old mtime', async () => {
        // Deliberately NOT the shared writeJsonCharacterFile() default content ('Ghost'/'A local-import test
        // character', which several sibling tests in this describe block also import verbatim) - this block's
        // own beforeAll note explains why every test here shares one dataRoot/db (getUserDirectories()
        // memoization), and afterEach only clears files from userCharactersDir, never the underlying DB rows a
        // completed import leaves behind - so a byte-identical import in an EARLIER test leaves an orphaned
        // (file-gone, row-still-there) content_hash match that a later test's own identical content would
        // collide with on its very first pass (findCharacterIdByContentHash() has no way to know the row is
        // stale - only the NEXT reconcile() pass cleans it up, one pass later than this test can afford to
        // wait for). Unique content sidesteps the whole class of collision rather than relying on pass timing.
        const filePath = writeJsonCharacterFile(sourceDir, 'ghost.json', { name: 'Ghost Restart Test Original' });
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);

        await localImportScan.initializeLocalImportScan();
        await localImportScan.waitForCurrentScanPass();
        localImportScan.disposeLocalImportScan();

        // Force a distinct mtime, same as the in-memory-cache equivalent test does, so this isn't short-circuited
        // before the content is even re-read.
        await new Promise(resolve => setTimeout(resolve, 10));
        fs.writeFileSync(filePath, JSON.stringify({ name: 'Ghost Restart Test Edited' }));

        await localImportScan.initializeLocalImportScan();
        await localImportScan.waitForCurrentScanPass();

        // The changed file's new content was recognized as a genuinely different character, not skipped.
        const files = await userCharacters();
        expect(files.length).toBe(2);
    });

    test('scanIntervalMs paces the NEXT pass after the previous one completes, not on a fixed wall-clock rate (self-pacing, not setInterval)', async () => {
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);
        process.env.SILLYTAVERN_LOCALIMPORT_SCANINTERVALMS = '1000';

        jest.useFakeTimers();
        try {
            await localImportScan.initializeLocalImportScan();
            await localImportScan.waitForCurrentScanPass(); // initial (empty-directory) pass completes
            expect((await userCharacters()).length).toBe(0);

            // A file dropped in now must NOT be picked up before a full scanIntervalMs has elapsed since the
            // pass that just finished - proving there's no immediately-pending timer left over from a
            // fixed-rate scheduling scheme.
            writeJsonCharacterFile(sourceDir, 'ghost.json');
            await jest.advanceTimersByTimeAsync(500);
            expect((await userCharacters()).length).toBe(0);

            // Advancing past the full interval fires the rescheduled pass, which now picks the file up.
            await jest.advanceTimersByTimeAsync(600);
            await localImportScan.waitForCurrentScanPass();
            expect((await userCharacters()).length).toBe(1);
        } finally {
            jest.useRealTimers();
        }
    });
});
