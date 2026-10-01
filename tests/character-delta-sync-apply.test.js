import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import lodash from 'lodash';

// The real delta-sync client (character-list.js getCharacters()) against the real server routes: a sync applies
// the changes the feed names to the characters the page holds, takes in none it doesn't hold, and never reads the
// whole cache; boot reads none of the cache into memory. Only modules that
// can't load in node are replaced: IndexedDB (localforage) by an in-memory store, and character-list.js's
// DOM-bound UI imports. The character store is the real EntityStore over the shared array.

const originalCwd = process.cwd();

const USER_HANDLE = 'delta-sync-apply-test-user';

/** @type {Map<string, Map<string, any>>} localforage instance name -> key -> record */
const localforageStores = new Map();
/** Whole-store reads (iterate/keys) since the last reset. */
const wholeStoreReads = { count: 0 };

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
        keys: async () => { wholeStoreReads.count++; return [...records.keys()]; },
        iterate: async (fn) => {
            wholeStoreReads.count++;
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
/** @type {import('../public/scripts/entity-store.js').EntityStore<any>} */
let store;

jest.unstable_mockModule('../public/lib.js', () => ({
    lodash,
    localforage: { createInstance: createFakeLocalforageInstance },
}));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => USER_HANDLE }));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ favsToHotswap: noop }));
jest.unstable_mockModule('../public/scripts/character-store.js', async () => {
    const { EntityStore } = await import('../public/scripts/entity-store.js');
    store = new EntityStore(residentCharacters, c => c.avatar);
    return {
        characters: residentCharacters,
        charactersStore: store,
        resolveCharacterRef: ref => residentCharacters[ref],
        this_avatar: undefined,
    };
});
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
    readFolderTileTags: async () => ({ tags: [], rest: null }),
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
jest.unstable_mockModule('../public/scripts/character-repository.js', () => ({
    characterRepository: {},
    buildCharacterQuery: noop,
    isServerQueryableSort: noop,
    isInvalidSortFieldError: noop,
    normalizeQueryRow: noop,
    parseQueryTotal: noop,
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
}));

const toastrError = jest.fn();
globalThis.toastr = { error: toastrError, warning: noop, info: noop, success: noop };

const realFetch = globalThis.fetch;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

describe('delta sync applies only what changed', () => {
    let metadataDb;
    let searchCoordinator;
    let characterList;
    let server;
    let baseUrl;
    let uploadsDir;

    beforeAll(async () => {
        jest.resetModules();
        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

        metadataDb = await import('../src/character-metadata-db.js');
        searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
        const { router } = await import('../src/endpoints/characters.js');
        characterList = await import('../public/scripts/character-list.js');

        process.chdir(path.resolve(originalCwd, '..'));

        const express = (await import('express')).default;
        const multer = (await import('multer')).default;
        const app = express();
        uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-delta-sync-apply-uploads-'));
        app.use(multer({ dest: uploadsDir }).single('avatar'));
        app.use(express.json());
        app.use((req, res, next) => {
            req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
            next();
        });
        app.use('/api/characters', router);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
        process.chdir(originalCwd);
        fs.rmSync(uploadsDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-delta-sync-apply-test-'));
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
        for (const records of localforageStores.values()) records.clear();
        residentCharacters.length = 0;
        store.reindex();
        toastrError.mockClear();
        globalThis.fetch = (url, init) => realFetch(String(url).startsWith('/') ? `${baseUrl}${url}` : url, init);
        // As at boot: each test is a fresh tab over a fresh server.
        await characterList.seedCharactersFromCache();
    });

    afterEach(async () => {
        globalThis.fetch = realFetch;
        await searchCoordinator.disposeSearchWorkers();
        metadataDb.disposeMetadataStores();
        fs.rmSync(directories.root, { recursive: true, force: true });
    });

    async function postJson(urlPath, body) {
        const response = await realFetch(`${baseUrl}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        expect(response.status).toBeLessThan(300);
        return response;
    }

    async function createCharacter(name) {
        await postJson('/api/characters/create', { ch_name: name, file_name: name, description: 'd', creator_notes: 'n' });
        return `${name}.png`;
    }

    async function sync() {
        await characterList.getCharacters({ silent: true, silentGroups: true, skipPrint: true });
        expect(toastrError).not.toHaveBeenCalled();
    }

    const avatars = () => residentCharacters.map(c => c.avatar).sort();

    /** Holds these characters, as selecting one or opening a group does: read from the server into the store. */
    async function hold(...avatarKeys) {
        const records = await (await postJson('/api/characters/batch', { avatars: avatarKeys })).json();
        for (const record of records) {
            record.chat = record.chat ? String(record.chat) : '';
            store.create(record);
        }
    }

    test('a sync takes in no character the page does not hold', async () => {
        const a = await createCharacter('A');
        await createCharacter('B');
        await sync();
        expect(avatars()).toEqual([]);

        await hold(a);
        await createCharacter('C');
        await sync();
        expect(avatars()).toEqual([a]);
    });

    test('boot reads none of the cache into memory', async () => {
        await createCharacter('A');
        await createCharacter('B');
        await sync();

        wholeStoreReads.count = 0;
        await characterList.seedCharactersFromCache();

        expect(wholeStoreReads.count).toBe(0);
        expect(avatars()).toEqual([]);
    });

    test('a later sync reads no whole cache and applies the changes to the held characters', async () => {
        const a = await createCharacter('A');
        const b = await createCharacter('B');
        const c = await createCharacter('C');
        await sync();
        await hold(a, b, c);
        const heldA = store.get(a);
        const heldB = store.get(b);

        await postJson('/api/characters/fav', { avatar: a, fav: true });
        await postJson('/api/characters/delete', { avatar_urls: [c], delete_chats: false });
        const d = await createCharacter('D');

        wholeStoreReads.count = 0;
        await sync();

        expect(wholeStoreReads.count).toBe(0);
        expect(avatars()).toEqual([a, b]);
        // Updated in place, so every reference to the character sees the change.
        expect(store.get(a)).toBe(heldA);
        expect(heldA.fav).toBe(true);
        expect(store.get(b)).toBe(heldB);
        expect(store.has(c)).toBe(false);
        expect(store.has(d)).toBe(false);
    });

    test('a sync with nothing new leaves the held characters alone', async () => {
        const a = await createCharacter('A');
        await sync();
        await hold(a);
        const heldA = store.get(a);

        wholeStoreReads.count = 0;
        await sync();

        expect(wholeStoreReads.count).toBe(0);
        expect(avatars()).toEqual([a]);
        expect(store.get(a)).toBe(heldA);
    });

    test('a held character the cache does not have survives a sync that does not name it', async () => {
        const a = await createCharacter('A');
        await sync();
        await hold(a);
        // As selectCharacterByAvatar() holds a character it fetched on demand: in memory, not in the cache.
        store.create({ avatar: 'OnDemand.png', name: 'On demand', shallow: false });

        await postJson('/api/characters/fav', { avatar: a, fav: true });
        await sync();

        expect(avatars()).toEqual([a, 'OnDemand.png']);
    });

    test('a change another tab already took into the shared cache still reaches this tab', async () => {
        const cache = await import('../public/scripts/character-cache.js');
        const a = await createCharacter('A');
        const b = await createCharacter('B');
        await sync();
        await hold(a, b);
        const heldA = store.get(a);

        await postJson('/api/characters/fav', { avatar: a, fav: true });
        // Another tab syncs first: it writes the change into the cache and moves the shared cursor past it.
        const changes = await (await postJson('/api/characters/changes', { sinceSeq: await cache.getCachedCursor() })).json();
        const batchResponse = await postJson('/api/characters/batch', { avatars: [a] });
        const [record] = await batchResponse.json();
        record.chat = record.chat ? String(record.chat) : '';
        await cache.saveCachedCharacters([{ avatar: a, character: record }], { includeCreatorNotes: batchResponse.headers.get('X-Shallow-Characters-Include-Creator-Notes') === 'true' });
        await cache.setCachedCursor(changes.seq);

        wholeStoreReads.count = 0;
        await sync();

        expect(wholeStoreReads.count).toBe(0);
        expect(avatars()).toEqual([a, b]);
        expect(store.get(a)).toBe(heldA);
        expect(heldA.fav).toBe(true);
    });
});
