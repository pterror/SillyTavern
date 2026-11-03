import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';
import process from 'node:process';
import lodash from 'lodash';
import { installBrowserStorage } from './util/browser-storage.js';
import { LIST_CREATOR_NOTES_CHARS } from '../public/scripts/hash-utils.js';

const originalCwd = process.cwd();

const USER_HANDLE = 'hash-hit-shape-test-user';

/** @type {Map<string, Map<string, any>>} */
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
    registerFolderCaseHandlers: noop,
    takeInExtensionTagWrites: noop,
    searchTagsByName: async () => ({ rows: [], cursor: null }),
    readTagsForIds: async () => ({ tags: new Map(), gone: new Set() }),
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
    heldTagsForIds: () => [],
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
    characterThumbnail: () => '',
    per_page_default: 50,
    selectCharacterByAvatar: async () => {},
    unshallowCharacter: async () => {},
}));

const toastrError = jest.fn();
globalThis.toastr = { error: toastrError, warning: noop, info: noop, success: noop };

const realFetch = globalThis.fetch;

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
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
const SPARSE_CARD = {
    spec: 'chara_card_v2', spec_version: '2.0', name: 'Sparse',
    data: { name: 'Sparse', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', extensions: {} },
};
const BARE_CARD = { spec: 'chara_card_v2', spec_version: '2.0', name: 'Bare', data: { extensions: {} } };
const DRIFT_CARD = {
    spec: 'chara_card_v2', spec_version: '2.0', name: 'Old name', tags: ['old'],
    data: {
        name: 'New name', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
        character_version: '', creator: '', tags: ['new'], creator_notes: 'n', extensions: { world: '' },
    },
};
const V1_CARD = { name: 'Legacy', description: 'd', creatorcomment: 'legacy notes', creator: 'c', tags: ['a', 'b'] };

const CARDS = [['full', FULL_CARD], ['sparse', SPARSE_CARD], ['bare', BARE_CARD], ['drifted', DRIFT_CARD], ['V1', V1_CARD]];

describe.each([false, true])('lazyLoadCharacters=%p', (lazy) => {
    /** @type {{ fixture: typeof import('./converted-user.fixture.js'), stores: typeof import('../src/user-stores.js'), characterList: typeof import('../public/scripts/character-list.js'), server: import('node:http').Server, baseUrl: string }} */
    let mode;

    /** @type {() => void} */
    let restoreStorage;

    beforeAll(async () => {
        restoreStorage = installBrowserStorage({ quota: 1e9 });
        process.env.SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS = String(lazy);
        jest.resetModules();

        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

        const fixture = await import('./converted-user.fixture.js');
        const stores = await import('../src/user-stores.js');
        const { router } = await import('../src/endpoints/characters.js');
        const characterList = await import('../public/scripts/character-list.js');

        process.chdir(path.resolve(originalCwd, '..'));

        const express = (await import('express')).default;
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            req.user = user.user;
            next();
        });
        app.use('/api/characters', router);
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        mode = { fixture, stores, characterList, server, baseUrl };
    });

    afterAll(async () => {
        await new Promise(resolve => mode.server.close(resolve));
        process.chdir(originalCwd);
        restoreStorage();
        delete process.env.SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS;
    });

    beforeEach(async () => {
        user = await mode.fixture.emptyUser('st-hash-hit-shape-test-', mode.stores);
        ({ directories } = user);
        globalThis.DATA_ROOT = user.dataRoot;
        clearClientCaches();
        toastrError.mockClear();
        globalThis.fetch = jest.fn((url, init) => realFetch(String(url).startsWith('/') ? `${mode.baseUrl}${url}` : url, init));
    });

    afterEach(async () => {
        globalThis.fetch = realFetch;
        await user.close();
    });

    function clearClientCaches() {
        for (const records of localforageStores.values()) records.clear();
        residentCharacters.length = 0;
    }

    /**
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
        await user.store.lib.writeCard(directories, 'Char.png', JSON.stringify(card));

        const miss = await clientResolve('Char.png');
        expect(miss.batched).toBe(true);

        const hitOnMissRecord = await clientResolve('Char.png');
        expect(hitOnMissRecord.batched).toBe(false);
        expect(hitOnMissRecord.row).toStrictEqual(miss.row);
        expect(Array.from(/** @type {any} */ (miss.row).data.creator_notes).length).toBeLessThanOrEqual(LIST_CREATOR_NOTES_CHARS);
    }, 30000);

    test('a row shown again after its character changed is downloaded again, with the change', async () => {
        await user.store.lib.writeCard(directories, 'Char.png', JSON.stringify(FULL_CARD));
        expect((await clientResolve('Char.png')).batched).toBe(true);
        expect((await clientResolve('Char.png')).batched).toBe(false);

        for (const fav of [true, false]) {
            const response = await realFetch(`${mode.baseUrl}/api/characters/fav`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ avatar: 'Char.png', fav }),
            });
            expect(response.status).toBeLessThan(300);
            const changed = await clientResolve('Char.png');
            expect(changed.batched).toBe(true);
            expect(/** @type {any} */ (changed.row).fav).toBe(fav);
            expect((await clientResolve('Char.png')).batched).toBe(false);
        }
    }, 30000);
});
