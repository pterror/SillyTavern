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

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

/**
 * These tests exercise the real fix (search-index-coordinator.js's `openStale` cold-start path, wired into
 * characters-search-index.js via openPersistedTantivyIndexStale()) end to end: real on-disk tantivy index, real
 * character-metadata-db change log, real character cards - no mocks. They only mean anything on an install where
 * tantivy is actually the resolved engine (this repo's - see tantivy-engine.js); on an install where it fell back
 * to SQLite, the cold-start fix doesn't apply (SQLite's buildSqliteIndex() has no persisted-index-reopen path at
 * all - see this file's own header on why), so they skip rather than asserting something the current engine tier
 * was never meant to do.
 *
 * Coordinator-level guarantees this fix depends on (serve-stale-immediately, coalesce concurrent cold starts into
 * one background build) are unit-tested directly against fake db handles in search-index-coordinator.test.js -
 * that's the right layer for "exactly one build ran" assertions (jest.fn call counts), which a real tantivy Index
 * doesn't expose a way to observe. What's real-tested here is the actual production shape: a boot-time bulk
 * import (reconcile() discovering a batch of new cards, exactly what a boot-time import scan does) landing before
 * any search, followed by the first search after it.
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
        const start = Date.now();
        const alphaResult = await searchIndex.searchCharacterIds('cold-handle', directories, 'Alpha');
        const elapsedMs = Date.now() - start;

        expect(alphaResult.backend).toBe('tantivy');
        expect(alphaResult.ids.sort()).toEqual(['Alpha0.png', 'Alpha1.png', 'Alpha2.png', 'Alpha3.png', 'Alpha4.png'].sort());
        // Generous bound - this is a correctness assertion (it must not be paying the catch-up cost inline), not
        // a tight performance benchmark; a synchronous catch-up of 20 changed characters would still likely clear
        // this, so the real proof is the very next assertion.
        expect(elapsedMs).toBeLessThan(3000);

        // The real proof it's serving the STALE state rather than having silently caught up already: queried
        // immediately afterward (no `await` of anything that could let the background catch-up's real disk I/O
        // finish), the newly bulk-imported characters must not be visible yet.
        const bravoResultImmediately = await searchIndex.searchCharacterIds('cold-handle', directories, 'Bravo');
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

    test('a cold search against a directory that was never indexed before falls back to the original blocking full build, and still returns correct results', async () => {
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
