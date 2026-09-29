import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import lodash from 'lodash';

// A sort the server doesn't know falls back to name order, or relevance with a search term, with a one-time warning
// (queryWithSortFallback, character-list.js), and the import/create flash finds its page through /query
// (findCharacterListPage). Real client modules against the real server route; only what can't load in node is
// replaced: IndexedDB (localforage) by an in-memory store, and the DOM-bound modules character-list.js imports.

const originalCwd = process.cwd();
const USER_HANDLE = 'sort-fallback-test-user';
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

const powerUser = { bogus_folders: false, fuzzy_search: false, sort_field: 'name', sort_order: 'asc', sort_rule: undefined };

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
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ getGroups: async () => {}, getGroupBlock: noop }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: powerUser,
    sortEntitiesList: () => { throw new Error('the list is never sorted in the browser'); },
    fuzzySearchCharacters: () => { throw new Error('the list is never searched in the browser'); },
    fuzzySearchGroups: () => { throw new Error('the list is never searched in the browser'); },
    fuzzySearchPersonas: () => [],
    fuzzySearchWorldInfo: () => [],
    fuzzySearchTags: () => [],
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
    tags: [],
    filterByTagState: noop,
    isBogusFolder: () => false,
    isBogusFolderOpen: noop,
    getTagBlock: noop,
    printTagFilters: noop,
    printTagList: noop,
    tag_filter_type: {},
    compareTagsForSort: () => 0,
    applyTagsOnCharacterSelect: noop,
    applyTagsOnGroupSelect: noop,
    tagsStore: {},
    isTagAssignedToKey: () => { throw new Error('the list never reads tag assignments in the browser'); },
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
/** Whether the sort dropdown's "Search" option is selected; the only thing `$` is asked here. */
let searchOptionSelected = false;
globalThis.$ = () => ({ is: () => searchOptionSelected });

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
/** Bodies of the /query requests the client sent, in order. */
let queryRequests;
/** The title and message of each warning toast, in order. */
let warnings;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    searchEngine = await import('../src/endpoints/search-engine.js');
    const { router } = await import('../src/endpoints/characters.js');
    const groupsModule = await import('../src/endpoints/groups.js');
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
    app.use('/api/groups', groupsModule.router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-list-sort-fallback-test-'));
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
    powerUser.sort_field = 'name';
    powerUser.sort_order = 'asc';
    searchOptionSelected = false;
    const { FILTER_TYPES } = filters;
    const filter = characterList.entitiesFilter;
    // Suppressed: a change would reprint the list, which needs the DOM.
    filter.setFilterData(FILTER_TYPES.SEARCH, '', true);
    filter.setFilterData(FILTER_TYPES.FAV, false, true);
    filter.setFilterData(FILTER_TYPES.GROUP, false, true);
    filter.setFilterData(FILTER_TYPES.FOLDER, false, true);
    filter.setFilterData(FILTER_TYPES.TAG, { excluded: [], selected: [] }, true);

    queryRequests = [];
    warnings = [];
    globalThis.toastr.warning = (message, title) => { warnings.push([title, message]); };
    globalThis.fetch = jest.fn(async (url, init) => {
        if (url === '/api/characters/query') queryRequests.push(JSON.parse(String(init?.body)));
        return realFetch(String(url).startsWith('/') ? `${baseUrl}${url}` : url, init);
    });
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    globalThis.toastr.warning = noop;
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

const NAME_ASC = { field: 'name', order: 'asc' };

/** @param {any} row */
const rowKey = row => {
    const { type, item } = repository.normalizeQueryRow(row);
    return type === 'group' ? `group:${item.id}` : item.avatar;
};

/**
 * queryWithSortFallback() running one /query page of `pageSize` rows.
 * @param {object} filter
 * @param {object|undefined} sort
 */
function queryPage(filter, sort, pageSize = 10) {
    return characterList.queryWithSortFallback(filter, sort,
        trySort => repository.characterRepository.query(filter, trySort, 1, pageSize, ['rows', 'total']));
}

describe('queryWithSortFallback', () => {
    test('a sort the server rejects falls back to name order, warning once per sort named', async () => {
        await seedCharacter('Cara.png');
        await seedCharacter('Abe.png');
        await seedGroup('g1', 'Bea');

        const filter = { includeGroups: true };
        const first = await queryPage(filter, { field: 'nonsense-a', order: 'desc' });
        expect(first.sort).toEqual(NAME_ASC);
        expect(first.result.rows.map(rowKey)).toEqual(['Abe.png', 'group:g1', 'Cara.png']);
        expect(queryRequests.map(body => body.sort)).toEqual([{ field: 'nonsense-a', order: 'desc' }, NAME_ASC]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0][1]).toContain('"nonsense-a"');

        // Asked again, the server is asked again, and there is no second warning for the same sort.
        queryRequests.length = 0;
        const again = await queryPage(filter, { field: 'nonsense-a', order: 'asc' });
        expect(again.sort).toEqual(NAME_ASC);
        expect(queryRequests.map(body => body.sort)).toEqual([{ field: 'nonsense-a', order: 'asc' }, NAME_ASC]);
        expect(warnings).toHaveLength(1);

        // Another unknown sort gets its own warning.
        await queryPage(filter, { field: 'nonsense-b', order: 'asc' });
        expect(warnings).toHaveLength(2);
        expect(warnings[1][1]).toContain('"nonsense-b"');
    }, 30000);

    test('a sort the server knows is used as it is, with no warning', async () => {
        await seedCharacter('Abe.png');
        await seedCharacter('Cara.png');

        const sort = { field: 'name', order: 'desc' };
        const answer = await queryPage({}, sort);
        expect(answer.sort).toBe(sort);
        expect(answer.result.rows.map(rowKey)).toEqual(['Cara.png', 'Abe.png']);
        expect(queryRequests.map(body => body.sort)).toEqual([sort]);
        expect(warnings).toEqual([]);
    }, 30000);

    test('relevance order with no search term goes to name order without asking for it', async () => {
        await seedCharacter('Cara.png');
        await seedCharacter('Abe.png');

        const answer = await queryPage({}, { field: 'search', order: 'asc' });
        expect(answer.sort).toEqual(NAME_ASC);
        expect(answer.result.rows.map(rowKey)).toEqual(['Abe.png', 'Cara.png']);
        expect(queryRequests.map(body => body.sort)).toEqual([NAME_ASC]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0][1]).toContain('"search"');
    }, 30000);

    test('any other failure is not a fallback: it reaches the caller, with no warning', async () => {
        await seedCharacter('Abe.png');

        const failing = characterList.queryWithSortFallback({}, { field: 'random', order: 'asc' },
            trySort => repository.characterRepository.query({}, trySort, 1, 10, ['rows']));
        await expect(failing).rejects.toMatchObject({ reason: 'random-seed-required' });
        expect(queryRequests).toHaveLength(1);
        expect(warnings).toEqual([]);
    }, 30000);

    test('with a search term, a rejected sort falls back to relevance order', async () => {
        if ((await searchEngine.resolveSearchEngine()).tier !== 'tantivy') return;
        await seedCharacter('Vlad.png', { name: 'Vlad the Vampire', file: true });
        await seedCharacter('Human.png', { name: 'Human', file: true });

        const filter = { search: 'vampire', includeGroups: true };
        // Repeats until the search index has caught up.
        let answer;
        const deadline = Date.now() + 10000;
        do {
            await new Promise(resolve => setTimeout(resolve, 100));
            answer = await queryPage(filter, { field: 'nonsense-search', order: 'asc' });
        } while (answer.result.rows.length === 0 && Date.now() < deadline);

        expect(answer.sort).toEqual({ field: 'search', order: 'asc' });
        expect(answer.result.rows.map(rowKey)).toEqual(['Vlad.png']);
        expect(queryRequests.slice(0, 2).map(body => body.sort)).toEqual([{ field: 'nonsense-search', order: 'asc' }, { field: 'search', order: 'asc' }]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0][1]).toContain('"nonsense-search"');
    }, 30000);
});

describe('findCharacterListPage', () => {
    const byAvatar = avatar => entity => entity.type === 'character' && entity.item.avatar === avatar;

    test('gives the page an entity is on, in the list\'s sort, or -1', async () => {
        for (let i = 0; i < 25; i++) await seedCharacter(`c${String(i).padStart(2, '0')}.png`);
        // Sorts between c12 and c13 by name.
        await seedGroup('g1', 'c12x');

        expect(await characterList.findCharacterListPage(byAvatar('c00.png'), 10)).toBe(1);
        expect(await characterList.findCharacterListPage(byAvatar('c09.png'), 10)).toBe(1);
        expect(await characterList.findCharacterListPage(byAvatar('c10.png'), 10)).toBe(2);
        expect(await characterList.findCharacterListPage(entity => entity.type === 'group' && entity.item.id === 'g1', 10)).toBe(2);
        // The group pushes c19 to index 20.
        expect(await characterList.findCharacterListPage(byAvatar('c19.png'), 10)).toBe(3);
        expect(await characterList.findCharacterListPage(byAvatar('nobody.png'), 10)).toBe(-1);
        // The list's filters, sort and groups go with every request.
        expect(queryRequests.every(body => body.sort?.field === 'name' && body.sort.order === 'asc' && body.filter.includeGroups === true)).toBe(true);

        powerUser.sort_order = 'desc';
        expect(await characterList.findCharacterListPage(byAvatar('c24.png'), 10)).toBe(1);
        expect(await characterList.findCharacterListPage(byAvatar('c00.png'), 10)).toBe(3);
        expect(warnings).toEqual([]);
    }, 60000);

    test('the list\'s filters apply: an entity they leave out isn\'t found', async () => {
        for (let i = 0; i < 6; i++) await seedCharacter(`c${i}.png`, { fav: i % 2 === 1 });

        const { FILTER_TYPES, FILTER_STATES } = filters;
        characterList.entitiesFilter.setFilterData(FILTER_TYPES.FAV, FILTER_STATES.SELECTED.key, true);
        expect(await characterList.findCharacterListPage(byAvatar('c0.png'), 1)).toBe(-1);
        expect(await characterList.findCharacterListPage(byAvatar('c1.png'), 1)).toBe(1);
        expect(await characterList.findCharacterListPage(byAvatar('c5.png'), 1)).toBe(3);
        expect(queryRequests.every(body => body.filter.fav === true)).toBe(true);
    }, 30000);

    test('a saved sort the server rejects is looked up in name order, with the warning', async () => {
        for (let i = 0; i < 5; i++) await seedCharacter(`c${i}.png`);
        powerUser.sort_field = 'nonsense-find';
        powerUser.sort_order = 'desc';

        expect(await characterList.findCharacterListPage(byAvatar('c3.png'), 2)).toBe(2);
        expect(queryRequests.map(body => body.sort)).toEqual([{ field: 'nonsense-find', order: 'desc' }, NAME_ASC]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0][1]).toContain('"nonsense-find"');
    }, 30000);

    test('"Search" selected with no term uses the saved sort', async () => {
        for (let i = 0; i < 3; i++) await seedCharacter(`c${i}.png`);
        searchOptionSelected = true;
        powerUser.sort_order = 'desc';

        expect(await characterList.findCharacterListPage(byAvatar('c2.png'), 1)).toBe(1);
        expect(queryRequests.map(body => body.sort)).toEqual([{ field: 'name', order: 'desc' }]);
        expect(warnings).toEqual([]);
    }, 30000);

    test('reads the list a chunk at a time, past the first chunk', async () => {
        const count = 1003;
        for (let i = 0; i < count; i++) await seedCharacter(`c${String(i).padStart(4, '0')}.png`);

        expect(await characterList.findCharacterListPage(byAvatar('c0999.png'), 7)).toBe(Math.floor(999 / 7) + 1);
        expect(queryRequests.map(body => [body.page, body.pageSize])).toEqual([[1, 1000]]);

        queryRequests.length = 0;
        expect(await characterList.findCharacterListPage(byAvatar('c1002.png'), 7)).toBe(Math.floor(1002 / 7) + 1);
        expect(queryRequests.map(body => [body.page, body.pageSize])).toEqual([[1, 1000], [2, 1000]]);

        queryRequests.length = 0;
        expect(await characterList.findCharacterListPage(byAvatar('nobody.png'), 7)).toBe(-1);
        expect(queryRequests.map(body => body.page)).toEqual([1, 2]);
    }, 120000);
});
