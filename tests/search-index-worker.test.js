import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

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

const TANTIVY_INDEX_SEQ_META_KEY = 'tantivy_char_index_seq';

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
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    await fs.promises.writeFile(path.join(directories.characters, `${name}.png`), cardParser.write(baseImage, cardJson(name)));
    await metadataDb.upsertCharacterFromWrite(directories, `${name}.png`, cardJson(name));
}

/**
 * A coordinator whose 'committed' messages are recorded with the time they arrived.
 * @param {object} [workerOptions]
 */
function makeCoordinator(workerOptions = {}) {
    /** @type {{ at: number, msg: any }[]} */
    const commits = [];
    const coordinator = coordinatorModule.createSearchIndexCoordinator({
        workerOptions,
        onCharactersCommitted: (msg) => commits.push({ at: performance.now(), msg }),
    });
    coordinators.push(coordinator);
    return { coordinator, commits };
}

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
});

afterEach(async () => {
    await Promise.all(coordinators.map(c => c.dispose()));
    metadataDb.disposeMetadataStores();
});

describe('search-index-worker.js (real worker thread)', () => {
    test('a delete reaches the index within about a second, ahead of an upsert backlog still queued in front of it', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;

        await seedCharacter('Doomed');
        await seedCharacter('Keeper');
        // One change-log page per tick, so the backlog below takes several ticks to drain.
        const { coordinator } = makeCoordinator({ tickBudgetMs: 0 });
        const reader = await coordinator.getIndex('h', directories, 'characters');
        expect(searchNames(reader, 'Doomed')).toEqual(['Doomed.png']);

        const keeperJson = await metadataDb.getCharacterCardJson(directories, 'Keeper.png');
        for (let i = 0; i < 3000; i++) {
            await metadataDb.upsertCharacterFromWrite(directories, 'Keeper.png', keeperJson);
        }
        await metadataDb.deleteCharacterRow(directories, 'Doomed.png');
        const deleteSeq = await metadataDb.getCurrentSeq(directories);
        const deletedAt = Date.now();

        await waitFor(async () => {
            const current = await coordinator.getIndex('h', directories, 'characters');
            return searchNames(current, 'Doomed').length === 0;
        });
        expect(Date.now() - deletedAt).toBeLessThan(2500);

        // The upsert backlog in front of the delete was not drained yet.
        expect(Number(await metadataDb.getMetaValue(directories, TANTIVY_INDEX_SEQ_META_KEY))).toBeLessThan(deleteSeq);
        expect(searchNames(await coordinator.getIndex('h', directories, 'characters'), 'Keeper')).toEqual(['Keeper.png']);
    }, 30000);

    test('searches are answered while a catch-up tick is running', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;

        await seedCharacter('Anchor');
        const { coordinator, commits } = makeCoordinator({ tickBudgetMs: 60000 });
        await coordinator.getIndex('h', directories, 'characters');

        // PNG-less characters: processCharacter() stats DEFAULT_AVATAR_PATH, which is repo-root-relative.
        const originalCwd = process.cwd();
        process.chdir(path.resolve(originalCwd, '..'));
        try {
            for (let i = 0; i < 3000; i++) {
                await metadataDb.upsertCharacterFromWrite(directories, `Bulk${i}.png`, cardJson(`Bulk${i}`));
            }

            /** @type {{ start: number, end: number }[]} */
            const searches = [];
            // A tick may already have taken part of the backlog while it was being written.
            while (commits.reduce((sum, c) => sum + c.msg.upserts, 0) < 3000) {
                const start = performance.now();
                const reader = await coordinator.getIndex('h', directories, 'characters');
                searchNames(reader, 'Anchor');
                searches.push({ start, end: performance.now() });
                await new Promise(resolve => setTimeout(resolve, 5));
            }

            const duringTick = searches.filter(s => commits.some(({ at, msg }) => s.start >= at - msg.ms && s.end <= at));
            expect(duringTick.length).toBeGreaterThan(3);
            for (const s of duringTick) {
                expect(s.end - s.start).toBeLessThan(100);
            }
            expect(searchNames(await coordinator.getIndex('h', directories, 'characters'), 'Bulk1234')).toEqual(['Bulk1234.png']);
        } finally {
            process.chdir(originalCwd);
        }
    }, 60000);

    test('consecutive ticks commit through the one long-lived writer', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;

        const errors = jest.spyOn(console, 'error');
        try {
            await seedCharacter('First');
            const { coordinator, commits } = makeCoordinator();
            await coordinator.getIndex('h', directories, 'characters');

            await seedCharacter('Second');
            await waitFor(() => commits.length >= 1);
            await seedCharacter('Third');
            await waitFor(() => commits.length >= 2);

            const reader = await coordinator.getIndex('h', directories, 'characters');
            expect(searchNames(reader, 'Second')).toEqual(['Second.png']);
            expect(searchNames(reader, 'Third')).toEqual(['Third.png']);
            expect(errors.mock.calls.filter(args => String(args[0]).includes('[search]'))).toEqual([]);
        } finally {
            errors.mockRestore();
        }
    }, 30000);

    test('dispose releases the writer, so a new worker on the same index can take it', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;

        await seedCharacter('Before');
        const first = makeCoordinator();
        await first.coordinator.getIndex('h', directories, 'characters');
        await first.coordinator.dispose('h');

        const second = makeCoordinator();
        expect(searchNames(await second.coordinator.getIndex('h', directories, 'characters'), 'Before')).toEqual(['Before.png']);
        await seedCharacter('After');
        await waitFor(() => second.commits.length >= 1);
        expect(searchNames(await second.coordinator.getIndex('h', directories, 'characters'), 'After')).toEqual(['After.png']);
    }, 30000);
});
