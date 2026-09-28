import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/endpoints/characters-search-index.js')} */
let searchIndex;
/** @type {typeof import('../src/endpoints/groups-search-index.js')} */
let groupsSearchIndex;
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

/** @param {string} id */
async function writeGroup(id) {
    const group = { id, name: id, members: [], fav: false, date_added: 1 };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, id, { fav: false, group });
}

/**
 * Polls a character search until `predicate` holds or 5 s pass: the index catches up on the worker's own tick.
 * @param {string} handle
 * @param {string} term
 * @param {(ids: string[]) => boolean} predicate
 */
async function pollSearch(handle, term, predicate) {
    let ids = [];
    const deadline = Date.now() + 5000;
    do {
        ids = (await searchIndex.searchCharacterIds(handle, directories, term)).ids;
        if (predicate(ids)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return ids;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    searchIndex = await import('../src/endpoints/characters-search-index.js');
    groupsSearchIndex = await import('../src/endpoints/groups-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchEngine = await import('../src/endpoints/search-engine.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-tag-delete-test-'));
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
});

afterEach(async () => {
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
});

async function setUp(handle) {
    await writeCard('Ann');
    await writeCard('Ben');
    await metadataDb.bootstrapIfNeeded(directories);
    await metadataDb.saveTagDefinitions(directories, [
        { id: 'tag-x', name: 'Xylophone' },
        { id: 'tag-y', name: 'Yodel' },
        { id: 'tag-d', name: 'Dulcimer' },
    ]);
    expect(await metadataDb.assignEntityTag(directories, 'Ann.png', 'tag-x')).toBe('ok');
    expect(await metadataDb.assignEntityTag(directories, 'Ben.png', 'tag-d')).toBe('ok');
    expect(await searchIndex.rebuildCharacterSearchIndex(handle, directories)).toEqual({ ok: true, backend: 'tantivy' });
}

describe('search after a tag is deleted', () => {
    test('a tag filter on the merge target matches a character still indexed under the deleted tag', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
        const handle = 'tag-delete-filter';
        await setUp(handle);
        await metadataDb.deleteTagDefinition(directories, 'tag-x', 'tag-y');

        const include = await searchIndex.searchCharacterIds(handle, directories, 'Ann', undefined, { tags: { include: ['tag-y'] } });
        expect(include.ids).toEqual(['Ann.png']);
        const exclude = await searchIndex.searchCharacterIds(handle, directories, 'Ann', undefined, { tags: { exclude: ['tag-y'] } });
        expect(exclude.ids).toEqual([]);
        const sorted = await searchIndex.searchCharacterIdsSorted(handle, directories, 'Ann', 'name', 'asc', 0, 10, { tags: { include: ['tag-x'] } });
        expect(sorted.hits.map(h => h.id)).toEqual(['Ann.png']);
    }, 20000);

    test('a tag filter on a tag deleted with no merge target matches nothing', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
        const handle = 'tag-delete-none';
        await setUp(handle);
        await metadataDb.deleteTagDefinition(directories, 'tag-d');

        expect((await searchIndex.searchCharacterIds(handle, directories, 'Ben', undefined, { tags: { include: ['tag-d'] } })).ids).toEqual([]);
        expect((await searchIndex.searchCharacterIds(handle, directories, 'Ben', undefined, { tags: { exclude: ['tag-d'] } })).ids).toEqual(['Ben.png']);
    }, 20000);

    test('the catch-up re-indexes the deleted tag\'s characters under the merge target\'s name', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
        const handle = 'tag-delete-names';
        await setUp(handle);
        expect((await searchIndex.searchCharacterIds(handle, directories, 'Xylophone')).ids).toEqual(['Ann.png']);
        await metadataDb.deleteTagDefinition(directories, 'tag-x', 'tag-y');

        expect(await pollSearch(handle, 'Yodel', ids => ids.length > 0)).toEqual(['Ann.png']);
        expect((await searchIndex.searchCharacterIds(handle, directories, 'Xylophone')).ids).toEqual([]);
    }, 20000);

    test('groups: a tag filter on the merge target matches a group carrying the deleted tag', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
        const handle = 'tag-delete-groups';
        await setUp(handle);
        await writeGroup('gx');
        expect(await metadataDb.assignEntityTag(directories, 'gx', 'tag-x')).toBe('ok');
        // The groups index rebuilds on the worker's tick; wait until it holds gx under tag-x.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && (await groupsSearchIndex.searchGroupIds(handle, directories, 'gx', undefined, { tags: { include: ['tag-x'] } })).ids.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        await metadataDb.deleteTagDefinition(directories, 'tag-x', 'tag-y');

        expect((await groupsSearchIndex.searchGroupIds(handle, directories, 'gx', undefined, { tags: { include: ['tag-y'] } })).ids).toEqual(['gx']);
        const sorted = await groupsSearchIndex.searchGroupsSorted(handle, directories, 'gx', 'name', 'asc', { tags: { include: ['tag-y'] } });
        expect(sorted.groups.map(g => g.id)).toEqual(['gx']);
    }, 20000);
});
