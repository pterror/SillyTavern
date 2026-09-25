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
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;

let tempDir;
let charactersDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/**
 * A minimal valid Spec V2 card, matching character-metadata-db.test.js's own cardJson()/writeCardFile() helpers
 * (reused here for the same reason: bootstrapIfNeeded()/reconcile() - and therefore getCurrentRev()/
 * getChangesSince(), which this test's whole point rides on - only see a card that's actually readable off disk
 * as a real PNG, not a bare metadata-db row).
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
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-cold-start-test-'));
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

afterEach(async () => {
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
});

/**
 * End to end, with a real search index worker, on-disk tantivy index, change log and character cards: a cold
 * search reopens the persisted index and is answered before the worker's first catch-up tick, which then brings
 * the index up to date in the background. They only mean anything on an install where tantivy is the resolved
 * engine, so they skip otherwise. Coordinator-level guarantees (ready gating, one worker per handle) are
 * unit-tested against a fake worker in search-index-coordinator.test.js.
 */
describe('characters-search-index.js: cold-start search does not block on catching up a stale persisted index', () => {
    test('a cold search after a bulk import returns fast, serves the stale (pre-import) result set immediately, then background catch-up makes a later search see the new characters', async () => {
        const engine = await searchEngine.resolveSearchEngine();
        if (engine.tier !== 'tantivy') {
            return; // this install's resolved engine isn't tantivy - the fix under test doesn't apply, see header
        }

        // Phase 1: five pre-existing characters, indexed and persisted - simulates "the server has been running,
        // search has already been used, the on-disk tantivy index is caught up as of this point."
        for (let i = 0; i < 5; i++) {
            await writeCard(`Alpha${i}`);
        }
        await metadataDb.bootstrapIfNeeded(directories);
        const buildResult = await searchIndex.rebuildCharacterSearchIndex('warm-handle', directories);
        expect(buildResult).toEqual({ ok: true, backend: 'tantivy' });
        // Its worker holds the index's writer; the cold handle's worker needs it.
        await searchCoordinator.disposeSearchWorkers('warm-handle');

        // Phase 2: a bulk import lands - twenty new characters - entirely through the metadata store's own
        // discovery path (reconcile(), the same mechanism a boot-time import scan drives), never touching search
        // at all. This is deliberately BEFORE the first search on the handle used below, so that search's first
        // call really is a cold start (search-index-coordinator.js's `indexes` map has no entry for it yet) with
        // a real backlog to catch up on - the exact shape that produced the confirmed 60+ second block.
        for (let i = 0; i < 20; i++) {
            await writeCard(`Bravo${i}`);
        }
        await metadataDb.reconcile(directories);

        // Phase 3: the cold search itself, on a handle that has never touched the coordinator - same on-disk
        // directories as the warm build above (a fresh handle, not a fresh install: this reuses the persisted
        // index files under directories.root/search-index, which is what makes it a genuine "reopen what was
        // last persisted" cold start rather than a from-scratch first-ever build).
        // Both answered as soon as the persisted index is open, before the worker's first catch-up tick.
        const start = Date.now();
        const [alphaResult, bravoResultImmediately] = await Promise.all([
            searchIndex.searchCharacterIds('cold-handle', directories, 'Alpha'),
            searchIndex.searchCharacterIds('cold-handle', directories, 'Bravo'),
        ]);
        const elapsedMs = Date.now() - start;

        expect(alphaResult.backend).toBe('tantivy');
        expect(alphaResult.ids.sort()).toEqual(['Alpha0.png', 'Alpha1.png', 'Alpha2.png', 'Alpha3.png', 'Alpha4.png'].sort());
        // Generous bound: a correctness assertion, not a benchmark. The proof no catch-up ran first is the next one.
        expect(elapsedMs).toBeLessThan(3000);
        expect(bravoResultImmediately.ids).toEqual([]);

        // Phase 4: the background catch-up this cold start kicked off eventually lands - poll a later search on
        // the same handle until it does (bounded, so a genuine regression fails the test instead of hanging).
        let bravoResult = { ids: [] };
        const deadline = Date.now() + 10000;
        while (bravoResult.ids.length === 0 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
            bravoResult = await searchIndex.searchCharacterIds('cold-handle', directories, 'Bravo');
        }
        expect(bravoResult.ids.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `Bravo${i}.png`).sort());
    }, 20000);

    test('concurrent cold searches on the same never-before-seen handle all get served immediately with the same stale result, none of them blocks on the other', async () => {
        const engine = await searchEngine.resolveSearchEngine();
        if (engine.tier !== 'tantivy') {
            return;
        }

        for (let i = 0; i < 3; i++) {
            await writeCard(`Gamma${i}`);
        }
        await metadataDb.bootstrapIfNeeded(directories);
        await searchIndex.rebuildCharacterSearchIndex('warm-handle-2', directories);
        await searchCoordinator.disposeSearchWorkers('warm-handle-2');

        for (let i = 0; i < 10; i++) {
            await writeCard(`Delta${i}`);
        }
        await metadataDb.reconcile(directories);

        const start = Date.now();
        const [r1, r2, r3] = await Promise.all([
            searchIndex.searchCharacterIds('cold-handle-concurrent', directories, 'Gamma'),
            searchIndex.searchCharacterIds('cold-handle-concurrent', directories, 'Gamma'),
            searchIndex.searchCharacterIds('cold-handle-concurrent', directories, 'Gamma'),
        ]);
        const elapsedMs = Date.now() - start;

        expect(elapsedMs).toBeLessThan(3000);
        const expected = ['Gamma0.png', 'Gamma1.png', 'Gamma2.png'].sort();
        expect(r1.ids.sort()).toEqual(expected);
        expect(r2.ids.sort()).toEqual(expected);
        expect(r3.ids.sort()).toEqual(expected);
    }, 20000);

    test('startSearchWorkerIfIndexed() starts no worker for a never-indexed directory, and starts one for an indexed directory', async () => {
        const engine = await searchEngine.resolveSearchEngine();
        if (engine.tier !== 'tantivy') {
            return;
        }

        await writeCard('Epsilon0');
        await metadataDb.bootstrapIfNeeded(directories);
        expect(await searchIndex.startSearchWorkerIfIndexed('boot-handle', directories)).toBe(false);

        await searchIndex.rebuildCharacterSearchIndex('warm-handle-3', directories);
        await searchCoordinator.disposeSearchWorkers('warm-handle-3');

        expect(await searchIndex.startSearchWorkerIfIndexed('boot-handle', directories)).toBe(true);
        const result = await searchIndex.searchCharacterIds('boot-handle', directories, 'Epsilon0');
        expect(result.ids).toEqual(['Epsilon0.png']);
    }, 20000);

    test('a cold search against a directory that was never indexed before waits for the worker\'s first full build, and still returns correct results', async () => {
        const engine = await searchEngine.resolveSearchEngine();
        if (engine.tier !== 'tantivy') {
            return;
        }

        await writeCard('OnlyOne');
        await metadataDb.bootstrapIfNeeded(directories);

        const result = await searchIndex.searchCharacterIds('fresh-handle', directories, 'OnlyOne');
        expect(result.backend).toBe('tantivy');
        expect(result.ids).toEqual(['OnlyOne.png']);
    }, 20000);
});
