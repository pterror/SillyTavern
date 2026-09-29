import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// While `clock` is set, every tick() page read returns one log row and moves the fake clock forward by that kind's
// step, so how many pages each loop takes depends only on the steps and the budget, never on real time.
/** @type {{ now: number, changeStepMs: number, renameStepMs: number, changePages: number, renamePages: number } | null} */
let clock = null;

/** @type {typeof import('../src/endpoints/characters-search-index.js')} */
let searchIndex;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/tantivy-engine.js')} */
let tantivyEngine;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;

let tempDir;
let charactersDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
let maintainer;

const BUDGET_MS = 100;

/** @param {string} name */
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
    await fs.promises.writeFile(path.join(charactersDir, `${name}.png`), cardParser.write(baseImage, JSON.stringify(card)));
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    const actualMetadataDb = await import('../src/character-metadata-db.js');
    jest.unstable_mockModule('../src/character-metadata-db.js', () => ({
        ...actualMetadataDb,
        getChangesSince: jest.fn(async (dirs, sinceSeq, options) => {
            if (!clock) return actualMetadataDb.getChangesSince(dirs, sinceSeq, options);
            const page = await actualMetadataDb.getChangesSince(dirs, sinceSeq, { limit: 1 });
            clock.changePages++;
            clock.now += clock.changeStepMs;
            return page;
        }),
        getTagNameChangesSince: jest.fn(async (dirs, sinceSeq, options) => {
            if (!clock) return actualMetadataDb.getTagNameChangesSince(dirs, sinceSeq, options);
            const page = await actualMetadataDb.getTagNameChangesSince(dirs, sinceSeq, { limit: 1 });
            clock.renamePages++;
            clock.now += clock.renameStepMs;
            return page;
        }),
    }));

    searchIndex = await import('../src/endpoints/characters-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    tantivyEngine = await import('../src/endpoints/tantivy-engine.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-tick-budget-test-'));
    charactersDir = path.join(tempDir, 'characters');
    directories = {
        root: tempDir,
        characters: charactersDir,
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [charactersDir, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    maintainer = null;
    clock = null;
});

afterEach(async () => {
    clock = null;
    jest.restoreAllMocks();
    maintainer?.close();
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Builds an index over five cards, then leaves `changes` change rows and `renames` tag renames for the next tick.
 * @param {{ changes: number, renames: number }} backlog
 * @returns {Promise<boolean>} false when tantivy isn't available here.
 */
async function setUp({ changes, renames }) {
    const tantivy = await tantivyEngine.getTantivyModule();
    if (!tantivy) return false;

    const names = ['A', 'B', 'C', 'D', 'E'].map(n => `Char${n}`);
    for (const name of names) await writeCard(name);
    await metadataDb.bootstrapIfNeeded(directories);
    const tags = [1, 2, 3, 4, 5].map(i => ({ id: `tag-${i}`, name: `Tag${i}` }));
    await metadataDb.saveTagDefinitions(directories, tags);
    expect(await metadataDb.assignEntityTag(directories, 'CharA.png', 'tag-1')).toBe('ok');

    maintainer = searchIndex.createCharacterIndexMaintainer(directories, tantivy, { tickBudgetMs: BUDGET_MS });
    expect(await maintainer.rebuild()).not.toBeNull();

    for (const name of names.slice(0, changes)) {
        await metadataDb.setCharacterFav(directories, `${name}.png`, true);
    }
    for (const tag of tags.slice(0, renames)) {
        expect((await metadataDb.editTagDefinition(directories, tag.id, { name: `${tag.name}Renamed` }))?.refused).toEqual([]);
    }
    return true;
}

/**
 * Runs one tick on the fake clock.
 * @param {{ changeStepMs: number, renameStepMs: number }} steps
 */
async function tickOnFakeClock({ changeStepMs, renameStepMs }) {
    clock = { now: 1_000_000, changeStepMs, renameStepMs, changePages: 0, renamePages: 0 };
    const c = clock;
    jest.spyOn(Date, 'now').mockImplementation(() => c.now);
    const result = await maintainer.tick();
    jest.restoreAllMocks();
    clock = null;
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('swapped');
    const r = /** @type {import('../src/endpoints/characters-search-index.js').TickResult} */ (result);
    return { changePages: c.changePages, renamePages: c.renamePages, renamesApplied: r.tagNameSeq - r.tagNameSeqFrom };
}

describe('characters-search-index.js: a tick splits its budget between changes and tag renames', () => {
    test('a change page that uses up the whole budget still leaves the rename loop a page', async () => {
        if (!await setUp({ changes: 5, renames: 1 })) return;
        const r = await tickOnFakeClock({ changeStepMs: BUDGET_MS, renameStepMs: 0 });
        expect(r.changePages).toBe(1);
        expect(r.renamesApplied).toBe(1);
    }, 20000);

    test('with renames waiting, the change loop stops at 75% of the budget', async () => {
        if (!await setUp({ changes: 5, renames: 1 })) return;
        // Pages end at 30, 60, 90: the third crosses 75.
        const r = await tickOnFakeClock({ changeStepMs: 30, renameStepMs: 0 });
        expect(r.changePages).toBe(3);
        expect(r.renamesApplied).toBe(1);
    }, 20000);

    test('with no renames waiting, the change loop gets the whole budget', async () => {
        if (!await setUp({ changes: 5, renames: 0 })) return;
        // Pages end at 30, 60, 90, 120: the fourth crosses 100.
        const r = await tickOnFakeClock({ changeStepMs: 30, renameStepMs: 0 });
        expect(r.changePages).toBe(4);
        expect(r.renamesApplied).toBe(0);
    }, 20000);

    test('the rename loop gets 25% of the budget from its own start when the change loop ran past 75%', async () => {
        if (!await setUp({ changes: 5, renames: 5 })) return;
        // Changes end at 90. Renames start there with until 115: pages end at 100, 110, 120.
        const r = await tickOnFakeClock({ changeStepMs: 30, renameStepMs: 10 });
        expect(r.changePages).toBe(3);
        expect(r.renamePages).toBe(3);
        expect(r.renamesApplied).toBe(3);
    }, 20000);

    test('the rename loop also gets what the change loop left unused', async () => {
        if (!await setUp({ changes: 1, renames: 5 })) return;
        // Changes drain at 10. Renames get until 100 (25% plus the 65 left of the change loop's 75): pages end at
        // 40, 70, 100.
        const r = await tickOnFakeClock({ changeStepMs: 10, renameStepMs: 30 });
        expect(r.changePages).toBe(1);
        expect(r.renamePages).toBe(3);
        expect(r.renamesApplied).toBe(3);
    }, 20000);
});
