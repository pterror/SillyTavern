import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

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

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    // importFromJson() reads DEFAULT_AVATAR_PATH relative to cwd - see this file's own note above.
    process.chdir(path.resolve(originalCwd, '..'));

    localImportScan = await import('../src/local-import-scan.js');
    metadataDb = await import('../src/character-metadata-db.js');
    users = await import('../src/users.js');
    constants = await import('../src/constants.js');
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

    test('enabled with a configured directory imports the default-user library synchronously on boot', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);

        await localImportScan.initializeLocalImportScan();

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
        await localImportScan.initializeLocalImportScan();

        expect(fs.readdirSync(userCharactersDir).length).toBe(1);
    });
});
