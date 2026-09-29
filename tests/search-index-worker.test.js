import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGINAL_CWD = process.cwd();
const HANDLE = 'h';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/search-engine.js')} */
let searchEngine;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let coordinatorModule;
/** @type {typeof import('../src/endpoints/tantivy-search.js')} */
let tantivySearch;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
/** @type {ReturnType<typeof coordinatorModule.createSearchIndexCoordinator>[]} */
let coordinators;
/** @type {{ at: number, seq: number }[]} HANDLE's 'search-index-updated' events this test, in arrival order. */
let indexUpdates;
const onSearchIndexUpdated = (handle, seq) => {
    if (handle === HANDLE) indexUpdates.push({ at: performance.now(), seq });
};

const TANTIVY_INDEX_SEQ_META_KEY = 'tantivy_char_index_seq';
const GROUPS_INDEX_VERSION_META_KEY = 'tantivy_group_index_version';

function cardJson(name) {
    return JSON.stringify({
        name,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '',
            extensions: { fav: false, world: '' },
        },
    });
}

/** A character with a real card PNG and a metadata row, so the worker can index it from any cwd. */
async function seedCharacter(name) {
    const baseImage = await fs.promises.readFile(path.join(REPO_ROOT, 'public', 'img', 'ai4.png'));
    await fs.promises.writeFile(path.join(directories.characters, `${name}.png`), cardParser.write(baseImage, cardJson(name)));
    await metadataDb.upsertCharacterFromWrite(directories, `${name}.png`, cardJson(name));
}

/** A group file and its row, written the way the groups endpoints write them. */
async function writeGroup(group) {
    await metadataDb.writeGroupFileAndRow(directories, group, () => {
        fs.writeFileSync(path.join(directories.groups, `${group.id}.json`), JSON.stringify(group));
    });
}

/** @param {object} [workerOptions] */
function makeCoordinator(workerOptions = {}) {
    const coordinator = coordinatorModule.createSearchIndexCoordinator({ workerOptions });
    coordinators.push(coordinator);
    return coordinator;
}

/** Whether a 'search-index-updated' event has said the index covers the change log up to `seq`. */
const indexCovers = (seq) => indexUpdates.some(update => update.seq >= seq);

/** @returns {string[]} The ids whose name matches `word`. */
function searchNames(reader, word) {
    const query = reader.index.parseQuery(word, ['name']);
    return tantivySearch.runSearch(reader.index, query, 100).results.map(r => r.raw).sort();
}

async function waitFor(check, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the search index worker');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchEngine = await import('../src/endpoints/search-engine.js');
    coordinatorModule = await import('../src/endpoints/search-index-coordinator.js');
    tantivySearch = await import('../src/endpoints/tantivy-search.js');
    metadataDb.characterChangeEmitter.on('search-index-updated', onSearchIndexUpdated);
});

afterAll(() => {
    metadataDb.characterChangeEmitter.off('search-index-updated', onSearchIndexUpdated);
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-index-worker-test-'));
    directories = /** @type {any} */ ({
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    coordinators = [];
    indexUpdates = [];
});

afterEach(async () => {
    // A test that timed out never reaches its own finally.
    process.chdir(ORIGINAL_CWD);
    await Promise.all(coordinators.map(c => c.dispose()));
    metadataDb.disposeMetadataStores();
});

describe('search-index-worker.js (real worker thread)', () => {
    test('a delete reaches the index within about a second, ahead of an upsert backlog still queued in front of it', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;

        await seedCharacter('Doomed');
        await seedCharacter('Keeper');
        // One change-log page per tick, so the backlog below takes several ticks to drain.
        const coordinator = makeCoordinator({ tickBudgetMs: 0 });
        const reader = await coordinator.getIndex(HANDLE, directories, 'characters');
        expect(searchNames(reader, 'Doomed')).toEqual(['Doomed.png']);

        const keeperJson = await metadataDb.getCharacterCardJson(directories, 'Keeper.png');
        for (let i = 0; i < 3000; i++) {
            await metadataDb.upsertCharacterFromWrite(directories, 'Keeper.png', keeperJson);
        }
        await metadataDb.deleteCharacterRow(directories, 'Doomed.png');
        const deleteSeq = await metadataDb.getCurrentSeq(directories);
        const deletedAt = Date.now();

        await waitFor(async () => {
            const current = await coordinator.getIndex(HANDLE, directories, 'characters');
            return searchNames(current, 'Doomed').length === 0;
        });
        expect(Date.now() - deletedAt).toBeLessThan(2500);

        // The upsert backlog in front of the delete was not drained yet.
        expect(Number(await metadataDb.getMetaValue(directories, TANTIVY_INDEX_SEQ_META_KEY))).toBeLessThan(deleteSeq);
        expect(searchNames(await coordinator.getIndex(HANDLE, directories, 'characters'), 'Keeper')).toEqual(['Keeper.png']);
    }, 30000);

    test('searches are answered while a catch-up tick is running', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;

        await seedCharacter('Anchor');
        const coordinator = makeCoordinator({ tickBudgetMs: 60000 });
        await coordinator.getIndex(HANDLE, directories, 'characters');

        // PNG-less characters: processCharacter() stats DEFAULT_AVATAR_PATH, which is repo-root-relative.
        process.chdir(REPO_ROOT);
        try {
            for (let i = 0; i < 3000; i++) {
                await metadataDb.upsertCharacterFromWrite(directories, `Bulk${i}.png`, cardJson(`Bulk${i}`));
            }
            const lastSeq = await metadataDb.getCurrentSeq(directories);
            const writtenAt = performance.now();

            // Every search between the last write and the event saying the index covers it runs while the catch-up
            // of that backlog is in progress.
            /** @type {{ start: number, end: number }[]} */
            const searches = [];
            const deadline = Date.now() + 50000;
            while (!indexCovers(lastSeq)) {
                if (Date.now() > deadline) throw new Error('timed out waiting for the search index worker');
                const start = performance.now();
                const reader = await coordinator.getIndex(HANDLE, directories, 'characters');
                searchNames(reader, 'Anchor');
                searches.push({ start, end: performance.now() });
                await new Promise(resolve => setTimeout(resolve, 5));
            }

            const coveredAt = indexUpdates.find(update => update.seq >= lastSeq).at;
            const duringCatchUp = searches.filter(s => s.start >= writtenAt && s.end <= coveredAt);
            expect(duringCatchUp.length).toBeGreaterThan(3);
            for (const s of duringCatchUp) {
                expect(s.end - s.start).toBeLessThan(100);
            }
            expect(searchNames(await coordinator.getIndex(HANDLE, directories, 'characters'), 'Bulk1234')).toEqual(['Bulk1234.png']);
        } finally {
            process.chdir(ORIGINAL_CWD);
        }
    }, 60000);

    test('consecutive ticks commit through the one long-lived writer', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;

        const errors = jest.spyOn(console, 'error');
        try {
            await seedCharacter('First');
            const coordinator = makeCoordinator();
            await coordinator.getIndex(HANDLE, directories, 'characters');

            await seedCharacter('Second');
            const secondSeq = await metadataDb.getCurrentSeq(directories);
            await waitFor(() => indexCovers(secondSeq));
            await seedCharacter('Third');
            const thirdSeq = await metadataDb.getCurrentSeq(directories);
            await waitFor(() => indexCovers(thirdSeq));

            const reader = await coordinator.getIndex(HANDLE, directories, 'characters');
            expect(searchNames(reader, 'Second')).toEqual(['Second.png']);
            expect(searchNames(reader, 'Third')).toEqual(['Third.png']);
            expect(errors.mock.calls.filter(args => String(args[0]).includes('[search]'))).toEqual([]);
        } finally {
            errors.mockRestore();
        }
    }, 30000);

    test('a rebuild-and-swap emits search-index-updated with the seq the rebuilt index covers', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;

        await seedCharacter('Rebuilt');
        const coordinator = makeCoordinator();
        await coordinator.getIndex(HANDLE, directories, 'characters');
        const seq = await metadataDb.getCurrentSeq(directories);
        // Past the once-per-second window of anything the startup emitted.
        await new Promise(resolve => setTimeout(resolve, 1100));
        indexUpdates = [];

        await expect(coordinator.rebuild(HANDLE, directories)).resolves.toBe(true);
        await waitFor(() => indexUpdates.length > 0, 2000);
        expect(indexUpdates.map(update => update.seq)).toEqual([seq]);
    }, 30000);

    test('the groups index records the groups version it was built from, as its reader\'s position and in its meta key', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;

        await writeGroup({ id: 'g1', name: 'First Coven', members: [] });
        const builtVersion = await metadataDb.getGroupsVersion(directories);
        expect(builtVersion).toBeGreaterThan(0);
        const coordinator = makeCoordinator();
        const reader = await coordinator.getIndex(HANDLE, directories, 'groups');
        expect(reader.position).toEqual({ version: builtVersion });
        expect(await metadataDb.getMetaValue(directories, GROUPS_INDEX_VERSION_META_KEY)).toBe(String(builtVersion));

        await writeGroup({ id: 'g2', name: 'Second Coven', members: [] });
        const rebuiltVersion = await metadataDb.getGroupsVersion(directories);
        expect(rebuiltVersion).toBeGreaterThan(builtVersion);
        await waitFor(async () => (await coordinator.getIndex(HANDLE, directories, 'groups')) !== reader);
        const rebuilt = await coordinator.getIndex(HANDLE, directories, 'groups');
        expect(rebuilt.position).toEqual({ version: rebuiltVersion });
        expect(searchNames(rebuilt, 'Second').length).toBe(1);
        expect(await metadataDb.getMetaValue(directories, GROUPS_INDEX_VERSION_META_KEY)).toBe(String(rebuiltVersion));
    }, 30000);

    test('dispose releases the writer, so a new worker on the same index can take it', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;

        await seedCharacter('Before');
        const first = makeCoordinator();
        await first.getIndex(HANDLE, directories, 'characters');
        await first.dispose(HANDLE);

        const second = makeCoordinator();
        expect(searchNames(await second.getIndex(HANDLE, directories, 'characters'), 'Before')).toEqual(['Before.png']);
        await seedCharacter('After');
        const afterSeq = await metadataDb.getCurrentSeq(directories);
        await waitFor(() => indexCovers(afterSeq));
        expect(searchNames(await second.getIndex(HANDLE, directories, 'characters'), 'After')).toEqual(['After.png']);
    }, 30000);
});
