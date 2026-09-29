import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import lodash from 'lodash';

// Hash-mode /query (character-repository.js) resolves a row from the client's character cache when the row's
// hashes match, and fetches it from /batch otherwise. Consumers get the row either way and can't tell which, so
// a hit must be the same row object a miss is - whether the cached record came from a miss or from delta-sync's
// whole-record fetch (character-list.js). Real client modules against the real server routes; only what can't
// load in node is replaced: IndexedDB (localforage) by an in-memory store that structured-clones like
// IndexedDB does, and the DOM-bound modules character-list.js imports.

// writeCharacterData()'s DEFAULT_AVATAR_PATH ('./public/img/...') is repo-root-relative.
const originalCwd = process.cwd();

const USER_HANDLE = 'hash-hit-shape-test-user';

/** @type {Map<string, Map<string, any>>} localforage instance name -> key -> record */
const localforageStores = new Map();

function createFakeLocalforageInstance({ name }) {
    let records = localforageStores.get(name);
    if (!records) {
        records = new Map();
        localforageStores.set(name, records);
    }
    return {
        getItem: async key => (records.has(key) ? structuredClone(records.get(key)) : null),
        setItem: async (key, value) => { records.set(key, structuredClone(value)); return value; },
        removeItem: async key => { records.delete(key); },
        clear: async () => { records.clear(); },
        keys: async () => [...records.keys()],
        iterate: async (fn) => {
            for (const [key, value] of records) {
                const result = fn(structuredClone(value), key);
                if (result !== undefined) return result;
            }
        },
    };
}

// One stable array, mutated in place: the mocked module's export is bound once.
const residentCharacters = [];
const noop = () => {};

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
    characters: residentCharacters,
    charactersStore: { get: () => undefined, has: () => false, onChange: () => noop, reindex: noop, reset: noop },
    // The real resolveCharacterRef over this mock's stores: charactersStore.get() always misses.
    resolveCharacterRef: ref => residentCharacters[ref],
    this_avatar: undefined,
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ groups: [], getGroups: async () => {}, getGroupBlock: noop }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {}, sortEntitiesList: noop }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    debounce: fn => fn,
    delay: async () => {},
    PAGINATION_TEMPLATE: '',
    localizePagination: noop,
    renderPaginationDropdown: noop,
    paginationDropdownChangeHandler: noop,
}));
jest.unstable_mockModule('../public/scripts/constants.js', () => ({ debounce_timeout: { quick: 100 } }));
jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    tags: [],
    filterByTagState: noop,
    isBogusFolder: noop,
    isBogusFolderOpen: noop,
    getTagBlock: noop,
    printTagFilters: noop,
    printTagList: noop,
    tag_filter_type: {},
    compareTagsForSort: noop,
    applyTagsOnCharacterSelect: noop,
    applyTagsOnGroupSelect: noop,
    tagsStore: {},
}));
jest.unstable_mockModule('../public/scripts/filters.js', () => ({
    FILTER_STATES: {},
    FILTER_TYPES: {},
    FilterHelper: class {},
    isFilterState: noop,
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

const toastrError = jest.fn();
globalThis.toastr = { error: toastrError, warning: noop, info: noop, success: noop };

const realFetch = globalThis.fetch;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

const FULL_CARD = {
    spec: 'chara_card_v2', spec_version: '2.0', name: 'Full', tags: ['t1'],
    data: {
        name: 'Full', description: 'd', personality: 'p', scenario: 's', first_mes: 'f', mes_example: 'm',
        character_version: '1.2', creator: 'someone', tags: ['t1'], creator_notes: 'notes',
        extensions: { talkativeness: 0.5, world: 'Lore', depth_prompt: { depth: 4, prompt: 'dp', role: 'system' } },
    },
};
// No character_version/creator/tags/creator_notes/world, so the server's shallow projection fills in its defaults.
const SPARSE_CARD = {
    spec: 'chara_card_v2', spec_version: '2.0', name: 'Sparse',
    data: { name: 'Sparse', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', extensions: {} },
};
// Not even data.name.
const BARE_CARD = { spec: 'chara_card_v2', spec_version: '2.0', name: 'Bare', data: { extensions: {} } };
// Top-level V1 mirrors disagreeing with data.*.
const DRIFT_CARD = {
    spec: 'chara_card_v2', spec_version: '2.0', name: 'Old name', tags: ['old'],
    data: {
        name: 'New name', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
        character_version: '', creator: '', tags: ['new'], creator_notes: 'n', extensions: { world: '' },
    },
};
// No spec at all.
const V1_CARD = { name: 'Legacy', description: 'd', creatorcomment: 'legacy notes', creator: 'c', tags: ['a', 'b'] };

const CARDS = [['full', FULL_CARD], ['sparse', SPARSE_CARD], ['bare', BARE_CARD], ['drifted', DRIFT_CARD], ['V1', V1_CARD]];

const MODES = [
    { creatorNotes: false, lazy: false },
    { creatorNotes: true, lazy: false },
    { creatorNotes: false, lazy: true },
    { creatorNotes: true, lazy: true },
];

describe.each(MODES)('shallowCharactersIncludeCreatorNotes=$creatorNotes, lazyLoadCharacters=$lazy', ({ creatorNotes, lazy }) => {
    /** @type {{ metadataDb: typeof import('../src/character-metadata-db.js'), searchCoordinator: typeof import('../src/endpoints/search-index-coordinator.js'), characterList: typeof import('../public/scripts/character-list.js'), server: import('node:http').Server, baseUrl: string }} */
    let mode;

    beforeAll(async () => {
        process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES = String(creatorNotes);
        process.env.SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS = String(lazy);
        // Both settings are read at module load, so each mode gets its own module instances.
        jest.resetModules();

        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

        const metadataDb = await import('../src/character-metadata-db.js');
        const searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
        const { router } = await import('../src/endpoints/characters.js');
        const characterList = await import('../public/scripts/character-list.js');

        process.chdir(path.resolve(originalCwd, '..'));

        const express = (await import('express')).default;
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
            next();
        });
        app.use('/api/characters', router);
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        mode = { metadataDb, searchCoordinator, characterList, server, baseUrl };
    });

    afterAll(async () => {
        await new Promise(resolve => mode.server.close(resolve));
        process.chdir(originalCwd);
        delete process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES;
        delete process.env.SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS;
    });

    beforeEach(() => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-hash-hit-shape-test-'));
        directories = {
            root: tempDir,
            characters: path.join(tempDir, 'characters'),
            chats: path.join(tempDir, 'chats'),
            groups: path.join(tempDir, 'groups'),
            groupChats: path.join(tempDir, 'groupChats'),
            backups: path.join(tempDir, 'backups'),
            thumbnailsAvatar: path.join(tempDir, 'thumbnails', 'avatar'),
            worlds: path.join(tempDir, 'worlds'),
        };
        for (const dir of Object.values(directories)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        clearClientCaches();
        toastrError.mockClear();
        // The client issues root-relative URLs; route them to the test server.
        globalThis.fetch = jest.fn((url, init) => realFetch(String(url).startsWith('/') ? `${mode.baseUrl}${url}` : url, init));
    });

    afterEach(async () => {
        globalThis.fetch = realFetch;
        await mode.searchCoordinator.disposeSearchWorkers();
        mode.metadataDb.disposeMetadataStores();
        fs.rmSync(directories.root, { recursive: true, force: true });
    });

    function clearClientCaches() {
        for (const records of localforageStores.values()) records.clear();
        residentCharacters.length = 0;
    }

    /** @param {string} id */
    function cachedRecord(id) {
        return localforageStores.get(`SillyTavern_CharacterCache_${USER_HANDLE}`)?.get(id);
    }

    /**
     * One hash-mode /query for `id` through a freshly imported repository, so its per-request response cache is
     * empty and the row is resolved against the character cache.
     * @param {string} id
     * @returns {Promise<{row: object, batched: boolean}>}
     */
    async function clientResolve(id) {
        jest.resetModules();
        const { CharacterRepository } = await import('../public/scripts/character-repository.js');
        const store = { get: () => undefined, has: () => false, onChange: () => noop };
        const repo = new CharacterRepository(/** @type {any} */ (store));
        /** @type {jest.Mock} */ (globalThis.fetch).mockClear();
        const result = await repo.query({ ids: [id] }, undefined, 1, 1, ['rows']);
        const urls = /** @type {jest.Mock} */ (globalThis.fetch).mock.calls.map(([url]) => url);
        expect(result.rows).toHaveLength(1);
        return { row: result.rows[0], batched: urls.includes('/api/characters/batch') };
    }

    test.each(CARDS)('%s card: a hit is the row a miss returns', async (_label, card) => {
        await mode.metadataDb.upsertCharacterFromWrite(directories, 'Char.png', JSON.stringify(card));

        const miss = await clientResolve('Char.png');
        expect(miss.batched).toBe(true);

        // Hit on the record the miss cached.
        const hitOnMissRecord = await clientResolve('Char.png');
        expect(hitOnMissRecord.batched).toBe(false);
        expect(hitOnMissRecord.row).toStrictEqual(miss.row);

        // Hit on the record delta-sync cached from a whole-record /batch fetch.
        clearClientCaches();
        await mode.characterList.getCharacters({ silent: true, silentGroups: true, skipPrint: true });
        expect(toastrError).not.toHaveBeenCalled();
        expect(cachedRecord('Char.png')?.character.shallow === true).toBe(lazy);
        const hitOnSyncRecord = await clientResolve('Char.png');
        expect(hitOnSyncRecord.batched).toBe(false);
        expect(hitOnSyncRecord.row).toStrictEqual(miss.row);
    }, 30000);
});
