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
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/users.js')} */
let users;
/** @type {typeof import('../src/constants.js')} */
let constants;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('png-chunks-extract').default} */
let extract;
/** @type {typeof import('png-chunk-text')} */
let PNGtext;
/** @type {typeof import('../src/png/encode.js').default} */
let pngEncode;

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
    metadataDb = await import('../src/character-metadata-db.js');
    users = await import('../src/users.js');
    constants = await import('../src/constants.js');
    cardParser = await import('../src/character-card-parser.js');
    ({ default: extract } = await import('png-chunks-extract'));
    PNGtext = (await import('png-chunk-text')).default ?? await import('png-chunk-text');
    ({ default: pngEncode } = await import('../src/png/encode.js'));
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

describe('scanDirectory (unit: direct directories fixture, no boot wiring)', () => {
    let tempDir;
    let sourceDir;
    let charactersDir;
    let chatsDir;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let directories;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-import-scan-test-'));
        sourceDir = path.join(tempDir, 'watched');
        charactersDir = path.join(tempDir, 'characters');
        chatsDir = path.join(tempDir, 'chats');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.mkdirSync(charactersDir, { recursive: true });
        fs.mkdirSync(chatsDir, { recursive: true });
        directories = { root: tempDir, characters: charactersDir, chats: chatsDir };

        // local-import-scan.js stages discovered files into globalThis.DATA_ROOT/_uploads - the same directory
        // multer stages a browser upload into (see that module's getUploadsDir()).
        globalThis.DATA_ROOT = tempDir;
    });

    afterEach(() => {
        metadataDb.disposeMetadataStores();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

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

        const files = fs.readdirSync(charactersDir);
        expect(files.length).toBe(1);
        expect(files[0]).toMatch(/\.png$/);

        const row = await metadataDb.getCharacterMetadataRow(directories, files[0]);
        expect(row).toBeDefined();
        expect(row.name).toBe('Ghost');
        expect(row.content_hash).toEqual(expect.any(String));
    });

    test('ignores files with an unrecognized extension', async () => {
        fs.writeFileSync(path.join(sourceDir, 'notes.txt'), 'not a character file');

        await localImportScan.scanDirectory(buildState(), directories);

        expect(fs.readdirSync(charactersDir).length).toBe(0);
    });

    test('does not leave a staged copy behind in the uploads directory after a successful import', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');

        await localImportScan.scanDirectory(buildState(), directories);

        // A successful import always creates the uploads dir (stageFile() mkdir's it before staging) - so its
        // absence here would itself be a bug, not a valid "nothing to check" case.
        const uploadsDir = path.join(tempDir, '_uploads');
        expect(fs.existsSync(uploadsDir)).toBe(true);
        expect(fs.readdirSync(uploadsDir).length).toBe(0);
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

        expect(fs.readdirSync(charactersDir).length).toBe(1);
    });

    test('dedup: two different source files with byte-identical content only import once (content-hash dedup, not mtime-based)', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');
        writeJsonCharacterFile(sourceDir, 'ghost-copy.json');

        await localImportScan.scanDirectory(buildState(), directories);

        expect(fs.readdirSync(charactersDir).length).toBe(1);
    });

    test('a byte-identical file dropped in after the original was already imported is skipped as a duplicate, not re-imported', async () => {
        const existingJson = JSON.stringify({ name: 'Ghost', description: 'A local-import test character' });
        fs.writeFileSync(path.join(sourceDir, 'ghost.json'), existingJson);
        await localImportScan.scanDirectory(buildState(), directories);
        expect(fs.readdirSync(charactersDir).length).toBe(1);

        // A second, byte-identical file lands later (e.g. copied in by hand) - should be recognized as a
        // duplicate of the character already imported, via findCharacterIdByContentHash(), not re-imported.
        fs.writeFileSync(path.join(sourceDir, 'ghost-again.json'), existingJson);
        await localImportScan.scanDirectory(buildState(), directories);
        expect(fs.readdirSync(charactersDir).length).toBe(1);
    });

    test('a changed file (different mtime, different content) is re-processed on the next pass', async () => {
        const filePath = writeJsonCharacterFile(sourceDir, 'ghost.json', { name: 'Ghost' });

        const state = buildState();
        await localImportScan.scanDirectory(state, directories);
        expect(fs.readdirSync(charactersDir).length).toBe(1);

        // Force a distinct mtime so the mtime-skip cache doesn't short-circuit before the hash is even checked.
        await new Promise(resolve => setTimeout(resolve, 10));
        fs.writeFileSync(filePath, JSON.stringify({ name: 'Ghost the Second' }));

        await localImportScan.scanDirectory(state, directories);

        // Second, different-content character gets imported alongside the first.
        expect(fs.readdirSync(charactersDir).length).toBe(2);
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

        expect(fs.readdirSync(charactersDir).length).toBe(1);
    });

    test('a source directory that does not exist is skipped without throwing', async () => {
        const missingState = { sourceDir: path.join(tempDir, 'does-not-exist'), lastSeenMtimeMs: new Map(), watcher: null, watchTimers: new Map() };
        await expect(localImportScan.scanDirectory(missingState, directories)).resolves.toBeUndefined();
    });

    describe('localImport.hardlinkDuplicateSourceFiles', () => {
        afterEach(() => {
            delete process.env.SILLYTAVERN_LOCALIMPORT_HARDLINKDUPLICATESOURCEFILES;
        });

        test('default (off): a duplicate source file is left as a regular, non-hardlinked file', async () => {
            const existingJson = JSON.stringify({ name: 'Ghost', description: 'A local-import test character' });
            fs.writeFileSync(path.join(sourceDir, 'ghost.json'), existingJson);
            await localImportScan.scanDirectory(buildState(), directories);

            const duplicatePath = path.join(sourceDir, 'ghost-again.json');
            fs.writeFileSync(duplicatePath, existingJson);
            await localImportScan.scanDirectory(buildState(), directories);

            const characterFile = fs.readdirSync(charactersDir)[0];
            const characterPath = path.join(charactersDir, characterFile);
            expect(fs.statSync(duplicatePath).ino).not.toBe(fs.statSync(characterPath).ino);
            expect(fs.readFileSync(duplicatePath, 'utf8')).toBe(existingJson);
        });

        test('enabled: a duplicate source file gets replaced in place with a hardlink to the canonical character file', async () => {
            process.env.SILLYTAVERN_LOCALIMPORT_HARDLINKDUPLICATESOURCEFILES = 'true';

            const existingJson = JSON.stringify({ name: 'Ghost', description: 'A local-import test character' });
            fs.writeFileSync(path.join(sourceDir, 'ghost.json'), existingJson);
            await localImportScan.scanDirectory(buildState(), directories);

            const duplicatePath = path.join(sourceDir, 'ghost-again.json');
            fs.writeFileSync(duplicatePath, existingJson);
            await localImportScan.scanDirectory(buildState(), directories);

            const characterFile = fs.readdirSync(charactersDir)[0];
            const characterPath = path.join(charactersDir, characterFile);
            // Same inode now: the duplicate source file's own bytes were replaced by a hardlink to the
            // canonical character file, not just left alone / copied.
            expect(fs.statSync(duplicatePath).ino).toBe(fs.statSync(characterPath).ino);
            // No second character record was created - this only affects the source file on disk.
            expect(fs.readdirSync(charactersDir).length).toBe(1);
        });

        test('enabled: never touches the ORIGINAL file that was actually imported (only later duplicates get hardlinked)', async () => {
            process.env.SILLYTAVERN_LOCALIMPORT_HARDLINKDUPLICATESOURCEFILES = 'true';

            const originalPath = writeJsonCharacterFile(sourceDir, 'ghost.json');
            await localImportScan.scanDirectory(buildState(), directories);

            const characterFile = fs.readdirSync(charactersDir)[0];
            const characterPath = path.join(charactersDir, characterFile);
            // The original source file was staged via a COPY into uploads (stageFile() -> copyCharacterFile()),
            // not linked directly to the final character file, so it keeps its own independent inode.
            expect(fs.statSync(originalPath).ino).not.toBe(fs.statSync(characterPath).ino);
        });

        test('enabled: a re-scan of an already-hardlinked duplicate is a harmless no-op (does not throw, does not re-import)', async () => {
            process.env.SILLYTAVERN_LOCALIMPORT_HARDLINKDUPLICATESOURCEFILES = 'true';

            const existingJson = JSON.stringify({ name: 'Ghost', description: 'A local-import test character' });
            fs.writeFileSync(path.join(sourceDir, 'ghost.json'), existingJson);
            const state = buildState();
            await localImportScan.scanDirectory(state, directories);

            fs.writeFileSync(path.join(sourceDir, 'ghost-again.json'), existingJson);
            await localImportScan.scanDirectory(state, directories);
            // Second pass: the now-hardlinked duplicate has a fresh mtime (from the rename), so it gets
            // re-hashed and re-matched as a duplicate again - this must recognize the already-shared inode
            // and just return, not throw or create another character.
            await localImportScan.scanDirectory(state, directories);

            expect(fs.readdirSync(charactersDir).length).toBe(1);
        });

        test('enabled: skips gracefully (does not throw, leaves source untouched) when the recorded canonical file is missing', async () => {
            process.env.SILLYTAVERN_LOCALIMPORT_HARDLINKDUPLICATESOURCEFILES = 'true';

            const existingJson = JSON.stringify({ name: 'Ghost', description: 'A local-import test character' });
            fs.writeFileSync(path.join(sourceDir, 'ghost.json'), existingJson);
            await localImportScan.scanDirectory(buildState(), directories);

            // Simulate a stale DB record: the canonical character file gets removed out from under it.
            const characterFile = fs.readdirSync(charactersDir)[0];
            fs.rmSync(path.join(charactersDir, characterFile));

            const duplicatePath = path.join(sourceDir, 'ghost-again.json');
            fs.writeFileSync(duplicatePath, existingJson);
            await expect(localImportScan.scanDirectory(buildState(), directories)).resolves.toBeUndefined();

            expect(fs.existsSync(duplicatePath)).toBe(true);
            expect(fs.readFileSync(duplicatePath, 'utf8')).toBe(existingJson);
        });
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
         * Writes a PNG straight into `charactersDir` byte-simulating the OLD (pre-293f4294b) write() - a 'chara'
         * chunk holding `data` verbatim plus a separately-written, spec-bumped 'ccv3' chunk - the exact shape a
         * real poisoned library row's PNG has (see character-card-parser.test.js's identical fixture).
         * @param {string} avatar
         * @param {object} data
         */
        function writePoisonedLibraryCard(avatar, data) {
            const pristineBase64 = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
            const bumped = { ...data, spec: 'chara_card_v3', spec_version: '3.0' };
            const bumpedBase64 = Buffer.from(JSON.stringify(bumped), 'utf8').toString('base64');
            const chunks = extract(new Uint8Array(BLANK_PNG));
            chunks.splice(-1, 0, PNGtext.encode('chara', pristineBase64));
            chunks.splice(-1, 0, PNGtext.encode('ccv3', bumpedBase64));
            fs.writeFileSync(path.join(charactersDir, avatar), Buffer.from(pngEncode(chunks)));
        }

        /**
         * Builds a poisoned library row (a real reconcile()-discovered PNG, then backfilled - the same two steps
         * a real boot's background chain performs) for `computeCandidateContentIdentityHash()`'s discovery-side
         * check to be compared against. Always seeds with the flag forced ON regardless of what the calling
         * test wants it set to for the scan itself below - backfillContentIdentityHashes() is gated on the exact
         * same flag (see its own doc comment), so a "flag off" test still needs a real backfilled hash to exist
         * in order to prove the scan-side gate (not "there was never anything to find") is what's actually being
         * exercised.
         * @param {object} data
         */
        async function seedBackfilledPoisonedRow(data) {
            writePoisonedLibraryCard('Poisoned.png', data);
            await metadataDb.reconcile(directories);
            const before = await metadataDb.getCharacterMetadataRow(directories, 'Poisoned.png');
            expect(before.import_poisoned).toBe(1);
            expect(before.content_identity_hash).toBeNull();

            const previousFlag = process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK;
            process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'true';
            await metadataDb.backfillContentIdentityHashes(directories);
            if (previousFlag === undefined) {
                delete process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK;
            } else {
                process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = previousFlag;
            }

            const after = await metadataDb.getCharacterMetadataRow(directories, 'Poisoned.png');
            expect(after.content_identity_hash).toEqual(expect.any(String));
        }

        test('flag on: a semantically-identical byte-different PNG dropped in is recognized as a duplicate of the poisoned row, not re-imported', async () => {
            process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'true';

            const data = poisonedCardData();
            await seedBackfilledPoisonedRow(data);

            // Today's write() never adds a ccv3 chunk for a v2 source (see 293f4294b) - so this file's bytes
            // necessarily differ from Poisoned.png's, even though it carries the exact same `data`.
            const discoveredBuffer = cardParser.write(BLANK_PNG, JSON.stringify(data));
            fs.writeFileSync(path.join(sourceDir, 'discovered.png'), discoveredBuffer);

            await localImportScan.scanDirectory(buildState(), directories);

            // Not imported as a second character - the content-identity fallback recognized it as a duplicate of
            // the already-poisoned (but now-backfilled) Poisoned.png.
            expect(fs.readdirSync(charactersDir).sort()).toEqual(['Poisoned.png']);
        });

        test('flag off: the same setup is NOT recognized as a duplicate - the file gets imported as a new character', async () => {
            process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'false';

            const data = poisonedCardData();
            await seedBackfilledPoisonedRow(data);

            const discoveredBuffer = cardParser.write(BLANK_PNG, JSON.stringify(data));
            fs.writeFileSync(path.join(sourceDir, 'discovered.png'), discoveredBuffer);

            await localImportScan.scanDirectory(buildState(), directories);

            expect(fs.readdirSync(charactersDir).length).toBe(2);
        });

        test('flag on: a genuinely different character is still imported normally, not falsely matched to the poisoned row', async () => {
            process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'true';

            await seedBackfilledPoisonedRow(poisonedCardData());

            const differentData = poisonedCardData();
            differentData.name = 'Someone Else';
            differentData.data.name = 'Someone Else';
            differentData.data.description = 'a completely different character';
            const discoveredBuffer = cardParser.write(BLANK_PNG, JSON.stringify(differentData));
            fs.writeFileSync(path.join(sourceDir, 'different.png'), discoveredBuffer);

            await localImportScan.scanDirectory(buildState(), directories);

            // Imported as a genuinely new second character - a minted UUID filename, not 'different.png' itself
            // (mintCharacterId() never reuses the source file's basename - see characters.js).
            const files = fs.readdirSync(charactersDir);
            expect(files.length).toBe(2);
            expect(files).toContain('Poisoned.png');
            const newRow = await metadataDb.getCharacterMetadataRow(directories, files.find(f => f !== 'Poisoned.png'));
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
            expect(fs.readdirSync(charactersDir).length).toBe(1);
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

            expect(fs.readdirSync(charactersDir).length).toBe(0);
            expect(fs.existsSync(misnamedPath)).toBe(true); // never touched/consumed

            const skip = await metadataDb.getLocalImportSkip(directories, misnamedPath);
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

            expect(fs.readdirSync(charactersDir).length).toBe(0);
            expect(fs.existsSync(lorePath)).toBe(true);

            const skip = await metadataDb.getLocalImportSkip(directories, lorePath);
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
            expect(fs.readdirSync(charactersDir).length).toBe(0);
        });

        test('a previously-skipped file that is edited into a real character card gets a fresh classification attempt and imports normally', async () => {
            const filePath = path.join(sourceDir, 'maybe-a-character.json');
            fs.writeFileSync(filePath, JSON.stringify({ entries: {} })); // starts out as a lorebook-shaped file

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);
            expect(fs.readdirSync(charactersDir).length).toBe(0);
            expect((await metadataDb.getLocalImportSkip(directories, filePath)).reason).toBe('unrecognized-shape');

            // The owner (or some other process) rewrites the same path into an actual v1 character card. Force a
            // distinct mtime so this isn't short-circuited by either skip cache before the content is re-read.
            await new Promise(resolve => setTimeout(resolve, 10));
            fs.writeFileSync(filePath, JSON.stringify({ name: 'Reclassified', description: 'now a real character' }));

            await localImportScan.scanDirectory(state, directories);

            expect(fs.readdirSync(charactersDir).length).toBe(1);
            expect(await metadataDb.getLocalImportSkip(directories, filePath)).toBeNull();
        });

        test('a source file removed after being skipped has its durable skip record cleaned up, not left dangling forever', async () => {
            const filePath = path.join(sourceDir, 'temporary-lore.json');
            fs.writeFileSync(filePath, JSON.stringify({ entries: {} }));

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);
            expect(await metadataDb.getLocalImportSkip(directories, filePath)).not.toBeNull();

            fs.rmSync(filePath);
            await localImportScan.scanDirectory(state, directories);

            expect(await metadataDb.getLocalImportSkip(directories, filePath)).toBeNull();
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

            expect(fs.readdirSync(charactersDir).length).toBe(0);
            expect(fs.existsSync(brokenPngPath)).toBe(true);
            // No local_import_skips row - this failure mode is untouched by classifyJsonCandidate() (json-only).
            expect(await metadataDb.getLocalImportSkip(directories, brokenPngPath)).toBeNull();
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

    beforeAll(() => {
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

    afterAll(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

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

    afterEach(() => {
        localImportScan.disposeLocalImportScan();
        metadataDb.disposeMetadataStores();
        fs.rmSync(sourceDir, { recursive: true, force: true });
        for (const file of fs.readdirSync(userCharactersDir)) {
            fs.rmSync(path.join(userCharactersDir, file), { force: true });
        }
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

        expect(fs.readdirSync(userCharactersDir).length).toBe(0);
    });

    test('config-disabled: an empty directories list imports nothing even with enabled=true', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([]);

        await localImportScan.initializeLocalImportScan();

        expect(fs.readdirSync(userCharactersDir).length).toBe(0);
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

        const files = fs.readdirSync(userCharactersDir);
        expect(files.length).toBe(1);
        const row = await metadataDb.getCharacterMetadataRow(userDirectories, files[0]);
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

        expect(fs.readdirSync(userCharactersDir).length).toBe(1);
    });

    test('initializeLocalImportScan() itself resolves without waiting for the initial scan pass to finish (boot must never block on a full corpus pass)', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);

        // A readFile that never resolves stands in for "a pass that's still running" - if initializeLocalImportScan()
        // itself waited on the scan, this test would hang and fail on Jest's default timeout.
        const readFileSpy = jest.spyOn(fs.promises, 'readFile').mockImplementation(() => new Promise(() => {}));
        try {
            await expect(localImportScan.initializeLocalImportScan()).resolves.toBeUndefined();
        } finally {
            readFileSpy.mockRestore();
        }
    });

    test('a restart (fresh in-memory state) does not re-read a source file whose mtime is unchanged since the last completed pass, thanks to the persisted local_import_mtimes record (2026-08 boot-cost fix)', async () => {
        const filePath = writeJsonCharacterFile(sourceDir, 'ghost.json');
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);

        await localImportScan.initializeLocalImportScan(); // first "boot"
        await localImportScan.waitForCurrentScanPass();
        expect(fs.readdirSync(userCharactersDir).length).toBe(1);

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
        expect(fs.readdirSync(userCharactersDir).length).toBe(1);
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
        const files = fs.readdirSync(userCharactersDir);
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
            expect(fs.readdirSync(userCharactersDir).length).toBe(0);

            // A file dropped in now must NOT be picked up before a full scanIntervalMs has elapsed since the
            // pass that just finished - proving there's no immediately-pending timer left over from a
            // fixed-rate scheduling scheme.
            writeJsonCharacterFile(sourceDir, 'ghost.json');
            await jest.advanceTimersByTimeAsync(500);
            expect(fs.readdirSync(userCharactersDir).length).toBe(0);

            // Advancing past the full interval fires the rescheduled pass, which now picks the file up.
            await jest.advanceTimersByTimeAsync(600);
            await localImportScan.waitForCurrentScanPass();
            expect(fs.readdirSync(userCharactersDir).length).toBe(1);
        } finally {
            jest.useRealTimers();
        }
    });
});
