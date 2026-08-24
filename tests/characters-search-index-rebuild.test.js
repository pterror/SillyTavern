import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/endpoints/characters-search-index.js')} */
let searchIndex;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/search-engine.js')} */
let searchEngine;

let tempDir;
let charactersDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

// The on-disk layout characters-search-index.js's tantivyIndexDir()/tantivyIndexTempDir() build - duplicated here
// (rather than imported, since this module deliberately exports no internals) so these tests can inspect the real
// on-disk artifacts a rebuild produces/consumes, the same way the tests exercise everything else: through real
// files, not mocks.
function searchIndexDbDir() {
    return path.join(directories.root, 'search-index');
}
function tantivyRealIndexDir() {
    return path.join(searchIndexDbDir(), 'characters-tantivy');
}
// Must match TANTIVY_INDEX_SCHEMA_VERSION_META_KEY in characters-search-index.js.
const TANTIVY_INDEX_SCHEMA_VERSION_META_KEY = 'tantivy_char_index_schema_version';

/**
 * A minimal valid Spec V2 card - see characters-search-index-cold-start.test.js's identical helper for why this
 * shape and this base image specifically.
 * @param {string} name
 * @returns {Promise<void>}
 */
async function writeCard(name) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const card = {
        name,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '',
            extensions: { fav: false, world: '' },
        },
    };
    const buffer = cardParser.write(baseImage, JSON.stringify(card));
    await fs.promises.writeFile(path.join(charactersDir, `${name}.png`), buffer);
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    searchIndex = await import('../src/endpoints/characters-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchEngine = await import('../src/endpoints/search-engine.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-rebuild-test-'));
    charactersDir = path.join(tempDir, 'characters');
    fs.mkdirSync(charactersDir, { recursive: true });
    directories = {
        root: tempDir,
        characters: charactersDir,
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    fs.mkdirSync(directories.chats, { recursive: true });
    fs.mkdirSync(directories.groups, { recursive: true });
    fs.mkdirSync(directories.groupChats, { recursive: true });
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

/**
 * These tests exercise characters-search-index.js's "first-ever build, corruption recovery, and the explicit
 * repair endpoint are all the same 'fresh empty index + incremental catch-up from rev 0, built into a temp
 * directory and atomically swapped into place' sequence" refactor - real on-disk tantivy index, real
 * character-metadata-db, real character cards, no mocks, matching characters-search-index-cold-start.test.js's own
 * approach. They only mean anything on an install where tantivy is actually the resolved engine, for the same
 * reason that file's own header explains (the SQLite tier has no persisted-index-reopen/schema-version/atomic-swap
 * concept at all).
 */
describe('characters-search-index.js: unified fresh-rebuild path (schema version, atomic swap, crash recovery)', () => {
    test('a schema-version mismatch on the persisted index is treated as nothing usable persisted, and triggers a correct fresh rebuild rather than serving a stale/incompatible index', async () => {
        const engine = await searchEngine.resolveSearchEngine();
        if (engine.tier !== 'tantivy') {
            return;
        }

        await writeCard('Vera');
        await writeCard('Wendell');
        await metadataDb.bootstrapIfNeeded(directories);

        const buildResult = await searchIndex.rebuildCharacterSearchIndex('warm-handle', directories);
        expect(buildResult).toEqual({ ok: true, backend: 'tantivy' });

        // Simulate a persisted index left over from a previous, incompatible schema version - e.g. the running
        // process was upgraded to a build with a different TANTIVY_SCHEMA_VERSION since this index was last
        // written. The persisted index files themselves are untouched; only the recorded schema-version meta
        // value is wrong.
        await metadataDb.setMetaValue(directories, TANTIVY_INDEX_SCHEMA_VERSION_META_KEY, '999');

        // A handle that has never touched the in-process coordinator, so this goes through
        // openPersistedTantivyIndexStale()'s cold-start reopen path - the schema-version check under test.
        const result = await searchIndex.searchCharacterIds('never-before-seen-handle', directories, 'Vera');

        expect(result.backend).toBe('tantivy');
        expect(result.ids).toEqual(['Vera.png']);

        // Proof it was a genuine rebuild, not the mismatched index served anyway: the schema-version meta value
        // is back to reflecting the running process's real TANTIVY_SCHEMA_VERSION, which only a fresh build
        // writes.
        const schemaVersionAfter = await metadataDb.getMetaValue(directories, TANTIVY_INDEX_SCHEMA_VERSION_META_KEY);
        expect(schemaVersionAfter).not.toBe('999');
    }, 20000);

    test('a build that fails before it can complete never touches the real on-disk index directory - the previous index stays fully intact and queryable', async () => {
        const engine = await searchEngine.resolveSearchEngine();
        if (engine.tier !== 'tantivy') {
            return;
        }
        // Permission bits are meaningless to root - this deterministic failure-injection technique (making the
        // search-index directory unwritable) can't work under it.
        if (process.getuid && process.getuid() === 0) {
            return;
        }

        await writeCard('Ophelia');
        await metadataDb.bootstrapIfNeeded(directories);

        const firstBuild = await searchIndex.rebuildCharacterSearchIndex('crash-handle', directories);
        expect(firstBuild).toEqual({ ok: true, backend: 'tantivy' });
        const beforeIds = (await searchIndex.searchCharacterIds('crash-handle', directories, 'Ophelia')).ids;
        expect(beforeIds).toEqual(['Ophelia.png']);

        const dbDir = searchIndexDbDir();
        const dirEntriesBefore = fs.readdirSync(dbDir).sort();

        // Deny write access to search-index/ itself - createEmptyTantivyIndexAt()'s fs.mkdirSync(tempDir, ...)
        // (the very first disk write rebuildTantivyIndexFromScratch() performs) fails immediately, before a
        // single byte of the new index is written anywhere, and long before swapTantivyIndexIntoPlace() would
        // ever be reached. Readdir/stat (r-x) still work, so the rest of the rebuild's read-only bookkeeping
        // isn't what's under test here - only that a failure this early can't have touched `indexDir`.
        fs.chmodSync(dbDir, 0o555);
        try {
            await expect(searchIndex.rebuildCharacterSearchIndex('crash-handle', directories)).rejects.toThrow();
        } finally {
            fs.chmodSync(dbDir, 0o755);
        }

        // The real index directory's own contents are byte-identical to before the failed attempt - nothing
        // wiped, nothing partially overwritten, no stray temp/old-aside directory left under search-index/
        // either (the mkdir failure happened before one was even created).
        expect(fs.readdirSync(dbDir).sort()).toEqual(dirEntriesBefore);
        expect(fs.existsSync(tantivyRealIndexDir())).toBe(true);

        // Still fully queryable - both via the same handle's still-live in-process coordinator entry (the failed
        // forceRebuild() never replaced it, since the build rejected before the coordinator swaps anything in)
        // and, for good measure, via a brand-new handle that has to reopen the persisted index from scratch.
        const afterSameHandle = await searchIndex.searchCharacterIds('crash-handle', directories, 'Ophelia');
        expect(afterSameHandle.ids).toEqual(['Ophelia.png']);
        const afterFreshHandle = await searchIndex.searchCharacterIds('crash-handle-fresh-reader', directories, 'Ophelia');
        expect(afterFreshHandle.ids).toEqual(['Ophelia.png']);
    }, 20000);

    test('a leftover temp directory from a previous crashed rebuild attempt is cleaned up rather than breaking the next rebuild', async () => {
        const engine = await searchEngine.resolveSearchEngine();
        if (engine.tier !== 'tantivy') {
            return;
        }

        await writeCard('Percival');
        await metadataDb.bootstrapIfNeeded(directories);
        await searchIndex.rebuildCharacterSearchIndex('leftover-handle', directories);

        // Simulate debris from a process that crashed mid-build, after tantivyIndexTempDir() created its temp
        // directory but before swapTantivyIndexIntoPlace() ever ran to clean it up - the exact shape
        // cleanupStaleTantivyRebuildTempDirs() exists to sweep up.
        const dbDir = searchIndexDbDir();
        const staleTempDir = path.join(dbDir, 'characters-tantivy.rebuild-leftover-from-a-crash');
        fs.mkdirSync(staleTempDir, { recursive: true });
        fs.writeFileSync(path.join(staleTempDir, 'garbage.bin'), 'not a real tantivy index');

        const result = await searchIndex.rebuildCharacterSearchIndex('leftover-handle', directories);
        expect(result).toEqual({ ok: true, backend: 'tantivy' });

        expect(fs.existsSync(staleTempDir)).toBe(false);
        const remainingEntries = fs.readdirSync(dbDir);
        for (const entry of remainingEntries) {
            expect(entry.startsWith('characters-tantivy.rebuild-')).toBe(false);
            expect(entry.startsWith('characters-tantivy.old-')).toBe(false);
        }

        const afterIds = (await searchIndex.searchCharacterIds('leftover-handle', directories, 'Percival')).ids;
        expect(afterIds).toEqual(['Percival.png']);
    }, 20000);
});
