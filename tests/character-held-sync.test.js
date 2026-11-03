import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import lodash from 'lodash';

const originalCwd = process.cwd();

const USER_HANDLE = 'held-sync-test-user';

/** @type {Map<string, Map<string, any>>} */
const localforageStores = new Map();
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
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ showHotswapFavs: noop, renderHotswap: noop }));
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
const takeInHeldGroupChanges = jest.fn(async () => {});
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ getGroupBlock: noop, takeInHeldGroupChanges }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {}, sortEntitiesList: noop }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    debounce: fn => fn,
    delay: async () => {},
    PAGINATION_TEMPLATE: '',
    localizePagination: noop,
    renderPaginationDropdown: noop,
    paginationDropdownChangeHandler: noop,
}));
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
/** @type {(ids: string[]) => Promise<Map<string, any>>} */
let readFullFromServer = async () => new Map();
const readFull = jest.fn(ids => readFullFromServer(ids));
jest.unstable_mockModule('../public/scripts/character-repository.js', () => ({
    characterRepository: { readFull },
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
    characterThumbnail: () => '',
    per_page_default: 50,
    selectCharacterByAvatar: async () => {},
}));

const toastrError = jest.fn();
globalThis.toastr = { error: toastrError, warning: noop, info: noop, success: noop };

const realFetch = globalThis.fetch;

describe('the page syncs only the characters and groups it holds', () => {
    let fixture;
    /** @type {typeof import('../public/scripts/group-store.js')} */
    let groupStore;
    let user;
    let characterList;
    let server;
    let baseUrl;
    let uploadsDir;
    /** @type {string[]} */
    let requested;

    beforeAll(async () => {
        jest.resetModules();
        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

        fixture = await import('./converted-user.fixture.js');
        const { router } = await import('../src/endpoints/characters.js');
        const { router: groupsRouter } = await import('../src/endpoints/groups.js');
        const settings = await import('../src/endpoints/settings.js');
        groupStore = await import('../public/scripts/group-store.js');

        process.chdir(path.resolve(originalCwd, '..'));

        const express = (await import('express')).default;
        const multer = (await import('multer')).default;
        const app = express();
        uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-held-sync-uploads-'));
        app.use(multer({ dest: uploadsDir }).single('avatar'));
        app.use(express.json());
        app.use((req, res, next) => {
            req.user = user.user;
            next();
        });
        app.use('/api/characters', router);
        app.use('/api/groups', groupsRouter);
        app.use('/api/settings', settings.router);
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
        user = await fixture.emptyUser('st-held-sync-test-');
        globalThis.DATA_ROOT = user.dataRoot;
        for (const records of localforageStores.values()) records.clear();
        residentCharacters.length = 0;
        for (const group of [...groupStore.groups]) groupStore.groupsStore.remove(group.id);
        toastrError.mockClear();
        readFull.mockClear();
        takeInHeldGroupChanges.mockClear();
        requested = [];
        globalThis.fetch = (url, init) => {
            requested.push(String(url));
            return realFetch(String(url).startsWith('/') ? `${baseUrl}${url}` : url, init);
        };
        readFullFromServer = async (ids) => {
            const records = await (await postJson('/api/characters/batch', { avatars: ids, full: true })).json();
            return new Map(records.map(record => [record.avatar, { ...record, chat: record.chat ? String(record.chat) : '', shallow: false }]));
        };
        characterList = await import('../public/scripts/character-list.js?' + Math.random());
    });

    afterEach(async () => {
        globalThis.fetch = realFetch;
        await user.close();
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

    async function startFromSettings() {
        const settings = await (await postJson('/api/settings/get', {})).json();
        expect(typeof settings.libraryChangesSeq).toBe('number');
        characterList.startLibraryChangesAt(settings.libraryChangesSeq);
    }

    async function sync() {
        requested = [];
        await characterList.getCharacters({ silent: true, skipPrint: true });
        expect(toastrError).not.toHaveBeenCalled();
    }

    const avatars = () => residentCharacters.map(c => c.avatar).sort();

    async function hold(...avatarKeys) {
        for (const [, record] of await readFullFromServer(avatarKeys)) store.create(record);
    }

    async function createGroup(name) {
        await new Promise(resolve => setTimeout(resolve, 2));
        const group = await (await postJson('/api/groups/create', { name, members: [] })).json();
        return String(group.id);
    }

    async function holdGroup(id) {
        const [group] = await (await postJson('/api/groups/batch', { ids: [id] })).json();
        groupStore.groupsStore.create(group);
    }

    const handedOn = () => takeInHeldGroupChanges.mock.calls.map(([upserted, deleted]) => [[...upserted].sort(), [...deleted].sort()]);

    test('a page that has not read its settings asks for nothing', async () => {
        await createCharacter('A');
        await createCharacter('B');
        await sync();
        expect(requested).toEqual([]);
        expect(avatars()).toEqual([]);
    });

    test('a first sync on a library with characters downloads none of them', async () => {
        for (const name of ['A', 'B', 'C']) await createCharacter(name);
        await startFromSettings();
        await sync();
        expect(requested.filter(url => url !== '/api/characters/changes')).toEqual([]);
        expect(readFull).not.toHaveBeenCalled();
        expect(avatars()).toEqual([]);
    });

    test('changes to characters the page does not hold download nothing', async () => {
        const a = await createCharacter('A');
        await startFromSettings();
        await hold(a);
        await createCharacter('B');
        await postJson('/api/characters/fav', { avatar: 'B.png', fav: true });
        await sync();
        expect(requested.filter(url => url !== '/api/characters/changes')).toEqual([]);
        expect(readFull).not.toHaveBeenCalled();
        expect(avatars()).toEqual([a]);
    });

    test('a held character changed or deleted after the settings were read is brought up to date', async () => {
        const a = await createCharacter('A');
        const b = await createCharacter('B');
        const c = await createCharacter('C');
        await startFromSettings();
        await hold(a, b, c);
        const heldA = store.get(a);
        const heldB = store.get(b);

        await postJson('/api/characters/fav', { avatar: a, fav: true });
        await postJson('/api/characters/delete', { avatar_urls: [c], delete_chats: false });
        await createCharacter('D');
        await sync();

        expect(readFull).toHaveBeenCalledTimes(1);
        expect(readFull).toHaveBeenCalledWith([a]);
        expect(avatars()).toEqual([a, b]);
        expect(store.get(a)).toBe(heldA);
        expect(heldA.fav).toBe(true);
        expect(store.get(b)).toBe(heldB);
    });

    test('a change made between reading the settings and holding the character still reaches it', async () => {
        const a = await createCharacter('A');
        await startFromSettings();
        await postJson('/api/characters/fav', { avatar: a, fav: true });
        await hold(a);
        await postJson('/api/characters/fav', { avatar: a, fav: false });
        await sync();
        expect(store.get(a).fav).toBe(false);
    });

    test('a sync with nothing new leaves the held characters alone and reads nothing again', async () => {
        const a = await createCharacter('A');
        await startFromSettings();
        await hold(a);
        await sync();
        readFull.mockClear();
        const heldA = store.get(a);

        await sync();

        expect(readFull).not.toHaveBeenCalled();
        expect(avatars()).toEqual([a]);
        expect(store.get(a)).toBe(heldA);
    });

    test('settings read again later do not move the start forward past unsynced changes', async () => {
        const a = await createCharacter('A');
        await startFromSettings();
        await hold(a);
        await postJson('/api/characters/fav', { avatar: a, fav: true });
        await startFromSettings();
        await sync();
        expect(store.get(a).fav).toBe(true);
    });

    test('a first sync on a library with groups downloads none of them', async () => {
        await createGroup('G1');
        await createGroup('G2');
        await startFromSettings();
        await sync();
        expect(requested).toEqual(['/api/characters/changes']);
        expect(handedOn()).toEqual([[[], []]]);
        expect(groupStore.groups).toEqual([]);
    });

    test('a held group changed or deleted after the settings were read is handed on; a group the page does not hold is not', async () => {
        const g1 = await createGroup('G1');
        const g2 = await createGroup('G2');
        const g3 = await createGroup('G3');
        await startFromSettings();
        await holdGroup(g1);
        await holdGroup(g2);

        await postJson('/api/groups/save-partial', { id: g1, props: { name: 'G1 renamed' } });
        await postJson('/api/groups/delete', { id: g2 });
        await postJson('/api/groups/save-partial', { id: g3, props: { name: 'G3 renamed' } });
        await createGroup('G4');
        await sync();

        expect(requested).toEqual(['/api/characters/changes']);
        expect(handedOn()).toEqual([[[g1], [g2]]]);
    });

    test('a chat another tab saves for a held character or group brings that owner up to date', async () => {
        const a = await createCharacter('A');
        const g1 = await createGroup('G1');
        await startFromSettings();
        await hold(a);
        await holdGroup(g1);
        const { newSessionKey } = await import('../src/chat-engine.js');
        const actor = { user: 'u', session: newSessionKey() };
        for (const owner of [{ avatar: a }, { group: g1 }]) {
            const tree = await fixture.treeOf(user.store, owner);
            expect((await user.store.chats.createBookmark({ tree, node_id: null, name: 'Elsewhere', actor })).ok).toBe(true);
        }
        await sync();

        expect(readFull).toHaveBeenCalledWith([a]);
        expect(handedOn()).toEqual([[[g1], []]]);
    });

    test('the whole group library can no longer be asked for', async () => {
        await createGroup('G1');
        const response = await realFetch(`${baseUrl}/api/groups/all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        expect(response.status).toBe(404);
    });

    test('/batch with full answers whole cards with their edit hashes, a bounded number at a time', async () => {
        const a = await createCharacter('A');
        const [record] = await (await postJson('/api/characters/batch', { avatars: [a], full: true })).json();
        expect(record.avatar).toBe(a);
        expect(record.description).toBe('d');
        expect(record.shallow).toBeUndefined();
        expect(typeof record._fieldsHash).toBe('number');
        expect(typeof record._bodyHash).toBe('number');

        const tooMany = Array.from({ length: 201 }, (_, i) => `c${i}.png`);
        const response = await realFetch(`${baseUrl}/api/characters/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatars: tooMany, full: true }),
        });
        expect(response.status).toBe(400);
    });
});
