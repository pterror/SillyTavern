import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';

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

const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

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
 * @param {string} dir
 * @param {string} filename
 * @param {object} [overrides]
 * @returns {string}
 */
function writeJsonCharacterFile(dir, filename, overrides = {}) {
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, JSON.stringify({ name: 'Ghost', description: 'A local-import test character', ...overrides }));
    return filePath;
}

/**
 * @param {import('../src/users.js').UserDirectoryList} directories
 * @returns {Promise<string[]>}
 */
async function charactersOf(directories) {
    const { lib } = await stores.userStore(directories);
    const page = await lib.query({ wantRows: true, wantTotal: false, includeGroups: false, limit: 1000, sortField: 'name' });
    return /** @type {any[]} */ (page.rows).map(r => r.item.avatar).sort();
}

/**
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

        globalThis.DATA_ROOT = tempDir;
    });

    afterEach(() => user.close());

    const characters = () => charactersOf(directories);

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

        await new Promise(resolve => setTimeout(resolve, 10));
        fs.writeFileSync(filePath, JSON.stringify({ name: 'Ghost the Second' }));

        await localImportScan.scanDirectory(state, directories);

        expect((await characters()).length).toBe(2);
    });

    describe('lastSeenMtimeMs cache-miss fallback (2026-09 unbounded-memory fix: bounded LRU cache, DB fallback on a miss)', () => {
        test('an evicted (or never-warmed) entry is still correctly skipped without re-reading the file, via the persisted local_import_mtimes fallback', async () => {
            const filePath = writeJsonCharacterFile(sourceDir, 'ghost.json');

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);
            expect((await characters()).length).toBe(1);
            expect(state.lastSeenMtimeMs.has('ghost.json')).toBe(true);

            state.lastSeenMtimeMs.delete('ghost.json');

            const readFileSpy = jest.spyOn(fs.promises, 'readFile');
            try {
                await localImportScan.scanDirectory(state, directories);
            } finally {
                readFileSpy.mockRestore();
            }

            const sourceReads = readFileSpy.mock.calls.filter(call => call[0] === filePath);
            expect(sourceReads.length).toBe(0);
            expect((await characters()).length).toBe(1);
            expect(state.lastSeenMtimeMs.get('ghost.json')).toBe(fs.statSync(filePath).mtimeMs);
        });

        test('an evicted entry for a file that changed in the meantime is still correctly re-processed, not incorrectly skipped', async () => {
            const filePath = writeJsonCharacterFile(sourceDir, 'ghost.json', { name: 'Ghost' });

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);
            expect((await characters()).length).toBe(1);

            state.lastSeenMtimeMs.delete('ghost.json');

            await new Promise(resolve => setTimeout(resolve, 10));
            fs.writeFileSync(filePath, JSON.stringify({ name: 'Ghost the Second' }));

            await localImportScan.scanDirectory(state, directories);

            expect((await characters()).length).toBe(2);
        });

        test('touchLastSeenMtime() enforces a hard, fixed ceiling on state.lastSeenMtimeMs regardless of how many distinct files are touched, evicting least-recently-touched first (LRU)', () => {
            const state = buildState();

            for (let i = 0; i < localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES + 1; i++) {
                localImportScan.touchLastSeenMtime(state, `file-${i}.json`, i);
            }

            expect(state.lastSeenMtimeMs.size).toBe(localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES);
            expect(state.lastSeenMtimeMs.has('file-0.json')).toBe(false);
            expect(state.lastSeenMtimeMs.get(`file-${localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES}.json`)).toBe(localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES);

            const sizeBeforeRetouch = state.lastSeenMtimeMs.size;
            localImportScan.touchLastSeenMtime(state, `file-${localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES}.json`, 999);
            expect(state.lastSeenMtimeMs.size).toBe(sizeBeforeRetouch);
            expect(state.lastSeenMtimeMs.get(`file-${localImportScan.MAX_LAST_SEEN_MTIME_ENTRIES}.json`)).toBe(999);
        });
    });

    test('watcher-triggered processFile() and the periodic scan agree on dedup (no double-import across the two trigger paths)', async () => {
        writeJsonCharacterFile(sourceDir, 'ghost.json');

        const state = buildState();
        await localImportScan.scanDirectory(state, directories);

        await localImportScan.scanDirectory(state, directories);

        expect((await characters()).length).toBe(1);
    });

    test('dedup: two different PNG source files with byte-identical content only import once, and the worker-owned write path never leaves a second character behind (2026-08 worker-owned-write extension)', async () => {
        const cardBuffer = cardParser.write(BLANK_PNG, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Ghost' } }));
        fs.writeFileSync(path.join(sourceDir, 'ghost.png'), cardBuffer);
        fs.writeFileSync(path.join(sourceDir, 'ghost-copy.png'), cardBuffer);

        await localImportScan.scanDirectory(buildState(), directories);

        const files = await characters();
        expect(files.length).toBe(1);
        const row = await rowOf(directories, files[0]);
        expect(row).toBeDefined();
        expect(row.name).toBe('Ghost');
    });

    test('a PNG card\'s image is its source file as it is (reflinked or copied, never re-encoded or hardlinked); it goes out without its text chunks, and the store is its card', async () => {
        const cardBuffer = cardParser.write(BLANK_PNG, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Ghost' } }));
        const sourcePath = path.join(sourceDir, 'ghost.png');
        fs.writeFileSync(sourcePath, cardBuffer);

        await localImportScan.scanDirectory(buildState(), directories);

        const [avatar] = await characters();
        const file = path.join(directories.characters, avatar);
        expect(fs.readFileSync(file).equals(cardBuffer)).toBe(true);
        expect(fs.statSync(file).ino).not.toBe(fs.statSync(sourcePath).ino);
        expect(fs.statSync(file).nlink).toBe(1);
        expect(fs.readdirSync(directories.characters).filter(name => name.endsWith('.next'))).toEqual([]);

        const { stripPngText } = await import('../src/png-text-strip.js');
        const { pipeline } = await import('node:stream/promises');
        const { Writable } = await import('node:stream');
        /** @type {Buffer[]} */
        const sent = [];
        await pipeline(fs.createReadStream(file), stripPngText(), new Writable({ write(chunk, _e, done) { sent.push(chunk); done(); } }));
        const { default: extract } = await import('png-chunks-extract');
        const sentChunks = extract(new Uint8Array(Buffer.concat(sent)));
        expect(sentChunks.map(c => c.name)).not.toContain('tEXt');
        expect(sentChunks.filter(c => c.name === 'IDAT')).toEqual(extract(new Uint8Array(BLANK_PNG)).filter(c => c.name === 'IDAT'));

        const { materializeCardPng } = await import('../src/endpoints/characters.js');
        const stored = structuredClone((await user.store.lib.cards([avatar]))[0]);
        stored.data.name = 'Ghost Renamed';
        stored.name = 'Ghost Renamed';
        await user.store.lib.writeCard(directories, avatar, JSON.stringify(stored));
        const exported = await materializeCardPng(directories, avatar);
        expect(JSON.parse(cardParser.read(exported.buffer)).data.name).toBe('Ghost Renamed');
        expect(JSON.parse(cardParser.read(fs.readFileSync(file))).data.name).toBe('Ghost');
    });

    test('a source directory that does not exist is skipped without throwing', async () => {
        const missingState = { sourceDir: path.join(tempDir, 'does-not-exist'), lastSeenMtimeMs: new Map(), watcher: null, watchTimers: new Map() };
        await expect(localImportScan.scanDirectory(missingState, directories)).resolves.toBeUndefined();
    });

    describe('content-identity duplicate fallback (performance.allowExpensiveDuplicateFallback)', () => {
        afterEach(() => {
            delete process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK;
        });

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
         * @param {object} data
         */
        async function seedPoisonedRow(data) {
            const { getCharaCardV2 } = await import('../src/character-card-normalize.js');
            await user.store.lib.writeCard(directories, 'Poisoned.png', JSON.stringify(getCharaCardV2(structuredClone(data), directories, false)));
            expect(await characters()).toEqual(['Poisoned.png']);
        }

        test('flag on: a semantically-identical byte-different PNG dropped in is recognized as a duplicate of the poisoned row, not re-imported', async () => {
            process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'true';

            const data = poisonedCardData();
            await seedPoisonedRow(data);

            const discoveredBuffer = cardParser.write(BLANK_PNG, JSON.stringify(data));
            fs.writeFileSync(path.join(sourceDir, 'discovered.png'), discoveredBuffer);

            await localImportScan.scanDirectory(buildState(), directories);

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

            const readFileSpy = jest.spyOn(fs.promises, 'readFile');
            try {
                await localImportScan.scanDirectory(buildState(), directories);
            } finally {
                readFileSpy.mockRestore();
            }

            const sourceReads = readFileSpy.mock.calls.filter(call => call[0] === sourcePath);
            expect(sourceReads.length).toBe(0);

            expect((await characters()).length).toBe(1);
        });
    });

    describe('permanently skipping non-character .json files (2026-08 retry-loop fix)', () => {
        let warnSpy;

        beforeEach(() => {
            warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        });

        afterEach(() => {
            warnSpy.mockRestore();
        });

        test('PNG-content-with-.json-extension: not valid JSON at all - skipped, not imported, logged once, and never re-attempted on a later pass', async () => {
            const misnamedPath = path.join(sourceDir, 'Nirana.json');
            fs.writeFileSync(misnamedPath, BLANK_PNG);

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);

            expect((await characters()).length).toBe(0);
            expect(fs.existsSync(misnamedPath)).toBe(true);

            const skip = await user.store.lib.localImportSkip(misnamedPath);
            expect(skip).not.toBeNull();
            expect(skip.reason).toBe('not-json');

            const permSkipWarnings = warnSpy.mock.calls.filter(call => String(call[0]).includes('Permanently skipping'));
            expect(permSkipWarnings.length).toBe(1);

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

            await localImportScan.scanDirectory(buildState(), directories);
            expect(warnSpy.mock.calls.filter(call => String(call[0]).includes('Permanently skipping')).length).toBe(1);

            await localImportScan.scanDirectory(buildState(), directories);

            expect(warnSpy.mock.calls.filter(call => String(call[0]).includes('Permanently skipping')).length).toBe(1);
            expect((await characters()).length).toBe(0);
        });

        test('a previously-skipped file that is edited into a real character card gets a fresh classification attempt and imports normally', async () => {
            const filePath = path.join(sourceDir, 'maybe-a-character.json');
            fs.writeFileSync(filePath, JSON.stringify({ entries: {} }));

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);
            expect((await characters()).length).toBe(0);
            expect((await user.store.lib.localImportSkip(filePath)).reason).toBe('unrecognized-shape');

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
            const brokenPngPath = path.join(sourceDir, 'broken.png');
            fs.writeFileSync(brokenPngPath, Buffer.from('this is not a png'));

            const state = buildState();
            await localImportScan.scanDirectory(state, directories);
            await localImportScan.scanDirectory(state, directories);

            expect((await characters()).length).toBe(0);
            expect(fs.existsSync(brokenPngPath)).toBe(true);
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

    const userCharacters = () => charactersOf(userDirectories);

    beforeEach(() => {
        sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-import-scan-boot-watched-'));
        delete process.env.SILLYTAVERN_LOCALIMPORT_ENABLED;
        delete process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES;
        delete process.env.SILLYTAVERN_LOCALIMPORT_SCANINTERVALMS;
        delete process.env.SILLYTAVERN_LOCALIMPORT_WATCHENABLED;
        process.env.SILLYTAVERN_LOCALIMPORT_SCANINTERVALMS = String(24 * 60 * 60 * 1000);
        process.env.SILLYTAVERN_LOCALIMPORT_WATCHENABLED = 'false';
    });

    afterEach(async () => {
        localImportScan.disposeLocalImportScan();
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

        await localImportScan.initializeLocalImportScan();
        await localImportScan.waitForCurrentScanPass();
        expect((await userCharacters()).length).toBe(1);

        localImportScan.disposeLocalImportScan();

        const readFileSpy = jest.spyOn(fs.promises, 'readFile');
        try {
            await localImportScan.initializeLocalImportScan();
            await localImportScan.waitForCurrentScanPass();
        } finally {
            readFileSpy.mockRestore();
        }

        const sourceReads = readFileSpy.mock.calls.filter(call => call[0] === filePath);
        expect(sourceReads.length).toBe(0);
        expect((await userCharacters()).length).toBe(1);
    });

    test('a file that changes while the server is down (different mtime) IS re-read and re-processed on the next boot, despite the persisted mtime record for its old mtime', async () => {
        const filePath = writeJsonCharacterFile(sourceDir, 'ghost.json', { name: 'Ghost Restart Test Original' });
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);

        await localImportScan.initializeLocalImportScan();
        await localImportScan.waitForCurrentScanPass();
        localImportScan.disposeLocalImportScan();

        await new Promise(resolve => setTimeout(resolve, 10));
        fs.writeFileSync(filePath, JSON.stringify({ name: 'Ghost Restart Test Edited' }));

        await localImportScan.initializeLocalImportScan();
        await localImportScan.waitForCurrentScanPass();

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
            await localImportScan.waitForCurrentScanPass();
            expect((await userCharacters()).length).toBe(0);

            writeJsonCharacterFile(sourceDir, 'ghost.json');
            await jest.advanceTimersByTimeAsync(500);
            expect((await userCharacters()).length).toBe(0);

            await jest.advanceTimersByTimeAsync(600);
            await localImportScan.waitForCurrentScanPass();
            expect((await userCharacters()).length).toBe(1);
        } finally {
            jest.useRealTimers();
        }
    });
});
