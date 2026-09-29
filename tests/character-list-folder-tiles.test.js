import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import lodash from 'lodash';

// The character list's folder tiles (getFolderTileEntities, character-list.js) come from POST
// /api/characters/folder-tiles. Real client modules against the real server route; only what can't load in node
// is replaced: IndexedDB (localforage) by an in-memory store, and the DOM-bound modules character-list.js imports.

const originalCwd = process.cwd();
const USER_HANDLE = 'folder-tiles-client-test-user';
const noop = () => {};

function createFakeLocalforageInstance() {
    const records = new Map();
    return {
        getItem: async key => (records.has(key) ? structuredClone(records.get(key)) : null),
        setItem: async (key, value) => { records.set(key, structuredClone(value)); return value; },
        removeItem: async key => { records.delete(key); },
        clear: async () => { records.clear(); },
        keys: async () => [...records.keys()],
        iterate: async () => {},
    };
}

/** The client's tag list. One stable array, mutated in place: the mocked module's export is bound once. */
const clientTags = [];
const powerUser = { bogus_folders: true, fuzzy_search: false };

jest.unstable_mockModule('../public/lib.js', () => ({
    lodash,
    localforage: { createInstance: createFakeLocalforageInstance },
}));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => USER_HANDLE }));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ favsToHotswap: noop }));
jest.unstable_mockModule('../public/scripts/character-store.js', () => ({
    characters: [],
    charactersStore: { get: () => undefined, has: () => false, onChange: () => noop, reindex: noop, reset: noop },
    resolveCharacterRef: () => undefined,
    this_avatar: undefined,
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ groups: [], getGroups: async () => {}, getGroupBlock: noop }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: powerUser,
    sortEntitiesList: noop,
    fuzzySearchCharacters: () => { throw new Error('the tiles never search characters in the browser'); },
    fuzzySearchGroups: () => { throw new Error('the tiles never search groups in the browser'); },
    fuzzySearchPersonas: () => [],
    fuzzySearchWorldInfo: () => [],
    // Stands in for Fuse: a tag matches when its name starts with the term.
    fuzzySearchTags: term => clientTags.filter(tag => tag.name.toLowerCase().startsWith(term.toLowerCase())).map(item => ({ item, score: 0 })),
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    debounce: fn => fn,
    delay: async () => {},
    PAGINATION_TEMPLATE: '',
    localizePagination: noop,
    renderPaginationDropdown: noop,
    paginationDropdownChangeHandler: noop,
    includesIgnoreCaseAndAccents: (text, term) => String(text ?? '').toLowerCase().includes(String(term).toLowerCase()),
}));
jest.unstable_mockModule('../public/scripts/constants.js', () => ({ debounce_timeout: { quick: 100 } }));
jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    tags: clientTags,
    filterByTagState: noop,
    isBogusFolder: tag => tag?.folder_type !== undefined && tag.folder_type !== 'NONE',
    isBogusFolderOpen: noop,
    getTagBlock: noop,
    printTagFilters: noop,
    printTagList: noop,
    tag_filter_type: {},
    compareTagsForSort: (a, b) => a.sort_order - b.sort_order,
    applyTagsOnCharacterSelect: noop,
    applyTagsOnGroupSelect: noop,
    tagsStore: {},
    isTagAssignedToKey: () => { throw new Error('the tiles never read tag assignments in the browser'); },
}));
jest.unstable_mockModule('../public/scripts/random-sort.js', () => ({ getRandomSortSeed: () => 42 }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (strings, ...values) => String.raw(strings, ...values) }));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({ updatePersonaConnectionsAvatarList: noop }));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({ Popup: { show: { text: async () => {} } } }));
jest.unstable_mockModule('../public/scripts/templates.js', () => ({ renderTemplateAsync: async () => '' }));
jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: {} }));
jest.unstable_mockModule('../public/scripts/welcome-screen.js', () => ({ getPermanentAssistantAvatar: () => '' }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({ event_types: {}, eventSource: { on: noop, emit: async () => {} } }));
jest.unstable_mockModule('../public/script.js', () => ({
    default_avatar: '',
    getCurrentCharacter: noop,
    per_page_default: 50,
    selectCharacterByAvatar: async () => {},
    unshallowCharacter: async () => {},
}));

globalThis.toastr = { error: noop, warning: noop, info: noop, success: noop };

const realFetch = globalThis.fetch;

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('../src/endpoints/search-engine.js')} */
let searchEngine;
/** @type {typeof import('../public/scripts/character-list.js')} */
let characterList;
/** @type {typeof import('../public/scripts/character-repository.js')} */
let repository;
/** @type {typeof import('../public/scripts/filters.js')} */
let filters;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {any} */
let directories;
/** Bodies of the /folder-tiles requests the client sent, in order. */
let tileRequests;
let inFlight;
let maxInFlight;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    searchEngine = await import('../src/endpoints/search-engine.js');
    const { router } = await import('../src/endpoints/characters.js');
    characterList = await import('../public/scripts/character-list.js');
    repository = await import('../public/scripts/character-repository.js');
    filters = await import('../public/scripts/filters.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-list-folder-tiles-test-'));
    directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    clientTags.length = 0;
    powerUser.bogus_folders = true;
    powerUser.fuzzy_search = false;
    const { FILTER_TYPES } = filters;
    const filter = characterList.entitiesFilter;
    // Suppressed: a change would reprint the list, which needs the DOM.
    filter.setFilterData(FILTER_TYPES.SEARCH, '', true);
    filter.setFilterData(FILTER_TYPES.FAV, false, true);
    filter.setFilterData(FILTER_TYPES.GROUP, false, true);
    filter.setFilterData(FILTER_TYPES.FOLDER, false, true);
    filter.setFilterData(FILTER_TYPES.TAG, { excluded: [], selected: [] }, true);

    tileRequests = [];
    inFlight = 0;
    maxInFlight = 0;
    globalThis.fetch = jest.fn(async (url, init) => {
        if (url === '/api/characters/folder-tiles') {
            tileRequests.push(JSON.parse(String(init?.body)));
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
        }
        try {
            return await realFetch(String(url).startsWith('/') ? `${baseUrl}${url}` : url, init);
        } finally {
            if (url === '/api/characters/folder-tiles') inFlight--;
        }
    });
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/**
 * @param {string} avatar
 * @param {{ name?: string, fav?: boolean, file?: boolean }} [options] file: also write the PNG, which search indexes.
 */
async function seedCharacter(avatar, { name = avatar.replace(/\.png$/, ''), fav = false, file = false } = {}) {
    const card = JSON.stringify({
        name, fav, spec: 'chara_card_v2', spec_version: '2.0',
        data: {
            name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav, world: '' },
        },
    });
    if (file) {
        const image = await fs.promises.readFile(path.join(originalCwd, '..', 'public', 'img', 'ai4.png'));
        await fs.promises.writeFile(path.join(directories.characters, avatar), cardParser.write(image, card));
    }
    await metadataDb.upsertCharacterFromWrite(directories, avatar, card);
}

/** @param {string} id @param {string} name */
async function seedGroup(id, name) {
    const group = { id, name, members: [], chats: [], fav: false };
    await metadataDb.writeGroupFileAndRow(directories, group, () => fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group)));
}

/** @param {string} id @param {string[]} tagIds */
async function tag(id, tagIds) {
    for (const tagId of tagIds) await metadataDb.assignEntityTag(directories, id, tagId);
}

/**
 * Saves the tags on the server and gives the client the same list.
 * @param {object[]} definitions
 */
async function defineTags(definitions) {
    expect(await metadataDb.saveTagDefinitions(directories, definitions)).toBe('ok');
    clientTags.push(...definitions.map((definition, index) => ({ sort_order: index, ...definition })));
}

const NAME_ASC = { field: 'name', order: 'asc' };

/** @param {import('../public/scripts/character-list.js').Entity} entity */
const entityKey = entity => entity.type === 'group' ? `group:${entity.id}` : entity.item.avatar;

describe('getFolderTileEntities', () => {
    test('page 1 has the tiles, from one batched request; no other page asks', async () => {
        await defineTags([
            { id: 'big', name: 'Big', folder_type: 'OPEN' },
            { id: 'shut', name: 'Shut', folder_type: 'CLOSED' },
            { id: 'empty', name: 'Empty', folder_type: 'OPEN' },
            { id: 'plain', name: 'Plain' },
        ]);
        for (let i = 0; i < 13; i++) {
            const avatar = `c${String(i).padStart(2, '0')}.png`;
            await seedCharacter(avatar);
            await tag(avatar, ['big']);
        }
        await seedGroup('g1', 'Zeta');
        await tag('g1', ['big']);
        await seedCharacter('Hidden.png');
        await tag('Hidden.png', ['big', 'shut']);

        expect(await characterList.getFolderTileEntities(2, {}, NAME_ASC, 15)).toEqual([]);
        expect(tileRequests).toEqual([]);

        const tiles = await characterList.getFolderTileEntities(1, {}, NAME_ASC, 15);
        // `plain` isn't a folder; `empty` has nothing to show.
        expect(tiles.map(tile => tile.id)).toEqual(['big', 'shut']);
        expect(tileRequests).toEqual([{ tiles: ['big', 'shut', 'empty'], filter: {}, sort: NAME_ASC }]);

        const [big, shut] = tiles;
        expect(big).toMatchObject({ type: 'tag', item: { id: 'big', name: 'Big' }, total: 14, hidden: 1, isUseless: false });
        // The strip holds the first rows only, as entities.
        expect(big.entities.map(entityKey)).toEqual(['c00.png', 'c01.png', 'c02.png', 'c03.png', 'c04.png', 'c05.png', 'c06.png', 'c07.png', 'c08.png', 'c09.png']);
        expect(big.entities[0]).toMatchObject({ type: 'character', id: 'c00.png' });
        expect(shut).toMatchObject({ total: 1, hidden: 0 });
        expect(shut.entities.map(entityKey)).toEqual(['Hidden.png']);

        // A tile whose sub-list is the whole list is useless.
        const [whole] = await characterList.getFolderTileEntities(1, {}, NAME_ASC, 14);
        expect(whole).toMatchObject({ id: 'big', isUseless: true });
        const [approx] = await characterList.getFolderTileEntities(1, {}, NAME_ASC, '~14');
        expect(approx.isUseless).toBe(false);
    }, 30000);

    test('the list\'s filters reach the request, and folders the tag filter names get no tile', async () => {
        await defineTags([
            { id: 'a', name: 'A', folder_type: 'OPEN' },
            { id: 'b', name: 'B', folder_type: 'OPEN' },
            { id: 'c', name: 'C', folder_type: 'OPEN' },
        ]);
        await seedCharacter('Fav.png', { fav: true });
        await seedCharacter('Plain.png');
        await seedGroup('g1', 'Group');
        await tag('Fav.png', ['a', 'b', 'c']);
        await tag('Plain.png', ['a', 'c']);
        await tag('g1', ['a', 'b', 'c']);

        const { FILTER_TYPES, FILTER_STATES } = filters;
        const filter = characterList.entitiesFilter;
        filter.setFilterData(FILTER_TYPES.TAG, { selected: ['b'], excluded: [] }, true);
        filter.setFilterData(FILTER_TYPES.GROUP, FILTER_STATES.EXCLUDED.key, true);
        const listFilter = { fav: true, tags: { include: ['b'], exclude: [], mode: 'and' }, includeGroups: true };

        const tiles = await characterList.getFolderTileEntities(1, listFilter, NAME_ASC, 1);
        expect(tileRequests).toEqual([{ tiles: ['a', 'c'], filter: { fav: true, tags: listFilter.tags, group: false }, sort: NAME_ASC }]);
        expect(tiles.map(tile => [tile.id, tile.total, tile.entities.map(entityKey)])).toEqual([['a', 1, ['Fav.png']], ['c', 1, ['Fav.png']]]);

        filter.setFilterData(FILTER_TYPES.TAG, { selected: [], excluded: [] }, true);
        filter.setFilterData(FILTER_TYPES.GROUP, FILTER_STATES.SELECTED.key, true);
        tileRequests.length = 0;
        const groupTiles = await characterList.getFolderTileEntities(1, {}, NAME_ASC, 3);
        expect(tileRequests[0].filter).toEqual({ group: true });
        expect(groupTiles.map(tile => [tile.id, tile.entities.map(entityKey)])).toEqual([['a', ['group:g1']], ['b', ['group:g1']], ['c', ['group:g1']]]);

        // "Folders" excluded, or folders turned off: no tiles, no request.
        tileRequests.length = 0;
        filter.setFilterData(FILTER_TYPES.FOLDER, FILTER_STATES.EXCLUDED.key, true);
        expect(await characterList.getFolderTileEntities(1, {}, NAME_ASC, 3)).toEqual([]);
        filter.setFilterData(FILTER_TYPES.FOLDER, false, true);
        powerUser.bogus_folders = false;
        expect(await characterList.getFolderTileEntities(1, {}, NAME_ASC, 3)).toEqual([]);
        expect(tileRequests).toEqual([]);
    }, 30000);

    test('450 folders go in requests of 200, one after another', async () => {
        expect(repository.FOLDER_TILES_PER_REQUEST).toBe(200);
        const folders = Array.from({ length: 450 }, (_, i) => ({ id: `f${String(i).padStart(3, '0')}`, name: `F${i}`, folder_type: 'OPEN' }));
        await defineTags(folders);
        await seedCharacter('First.png');
        await seedCharacter('Last.png');
        await tag('First.png', ['f000']);
        await tag('Last.png', ['f449']);

        const tiles = await characterList.getFolderTileEntities(1, {}, NAME_ASC, 2);
        expect(tileRequests.map(body => body.tiles.length)).toEqual([200, 200, 50]);
        expect(tileRequests.flatMap(body => body.tiles)).toEqual(folders.map(folder => folder.id));
        expect(maxInFlight).toBe(1);
        expect(tiles.map(tile => [tile.id, tile.entities.map(entityKey)])).toEqual([['f000', ['First.png']], ['f449', ['Last.png']]]);
    }, 60000);

    test('a folder the server doesn\'t have gets no tile', async () => {
        await defineTags([{ id: 'a', name: 'A', folder_type: 'OPEN' }]);
        clientTags.push({ id: 'gone', name: 'Gone', folder_type: 'OPEN', sort_order: 1 });
        await seedCharacter('X.png');
        await tag('X.png', ['a']);

        const tiles = await characterList.getFolderTileEntities(1, {}, NAME_ASC, 1);
        expect(tileRequests[0].tiles).toEqual(['a', 'gone']);
        expect(tiles.map(tile => tile.id)).toEqual(['a']);
    }, 30000);

    test.each([
        ['plain matching', false],
        ['fuzzy matching', true],
    ])('with a search term (%s), only folders whose name matches get a tile, empty or not', async (_, fuzzy) => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
        powerUser.fuzzy_search = fuzzy;
        await defineTags([
            { id: 'vamps', name: 'Vampires', folder_type: 'OPEN' },
            { id: 'vempty', name: 'Vampire hunters', folder_type: 'OPEN' },
            { id: 'other', name: 'Other', folder_type: 'OPEN' },
        ]);
        await seedCharacter('Vlad.png', { name: 'Vlad the Vampire', file: true });
        await seedCharacter('Human.png', { name: 'Human', file: true });
        // The search also matches tag names, so nothing in `vamps` could be left out by it.
        await tag('Vlad.png', ['vamps', 'other']);
        await tag('Human.png', ['other']);

        const { FILTER_TYPES } = filters;
        characterList.entitiesFilter.setFilterData(FILTER_TYPES.SEARCH, 'vampire', true);
        const listFilter = { search: 'vampire', includeGroups: true };

        // Repeats until the search index has caught up: two answers in a row agree.
        const summary = tiles => tiles.map(tile => [tile.id, tile.total, tile.hidden, tile.entities.map(entityKey)]);
        let previous = JSON.stringify(summary(await characterList.getFolderTileEntities(1, listFilter, NAME_ASC, 1)));
        let next;
        const deadline = Date.now() + 10000;
        for (;;) {
            await new Promise(resolve => setTimeout(resolve, 100));
            next = summary(await characterList.getFolderTileEntities(1, listFilter, NAME_ASC, 1));
            if (JSON.stringify(next) === previous || Date.now() > deadline) break;
            previous = JSON.stringify(next);
        }

        expect(tileRequests.at(-1)).toEqual({ tiles: ['vamps', 'vempty'], filter: { search: 'vampire' }, sort: NAME_ASC });
        // `other` holds a match but its name doesn't match.
        expect(next).toEqual([['vamps', 1, 0, ['Vlad.png']], ['vempty', 0, 0, []]]);
    }, 30000);
});

describe('parseQueryTotal', () => {
    test('reads exact and approximate counts', () => {
        expect(repository.parseQueryTotal(12)).toEqual({ value: 12, approx: false });
        expect(repository.parseQueryTotal('~12')).toEqual({ value: 12, approx: true });
        expect(repository.parseQueryTotal(undefined)).toEqual({ value: 0, approx: false });
        expect(repository.parseQueryTotal('x')).toEqual({ value: 0, approx: false });
    });
});
