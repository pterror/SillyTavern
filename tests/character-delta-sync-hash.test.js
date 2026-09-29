import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import lodash from 'lodash';

// The real delta-sync client (character-list.js getCharacters() -> fetchCharactersDelta() -> character-cache.js)
// against the real server routes: every character the server writes, fetched whole by delta-sync, must be cached
// with the same fav/tag_ids/content hashes the server stores as its digest columns - the values hash-mode /query
// compares the cache against. Only modules that can't load in node are replaced: IndexedDB (localforage) by an
// in-memory store that structured-clones like IndexedDB does, and character-list.js's DOM-bound UI imports.

// writeCharacterData()'s and the JSON importer's DEFAULT_AVATAR_PATH ('./public/img/...') is repo-root-relative.
const originalCwd = process.cwd();

const USER_HANDLE = 'delta-sync-hash-test-user';

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
jest.unstable_mockModule('../public/scripts/character-repository.js', () => ({
    characterRepository: {},
    buildCharacterQuery: noop,
    isServerQueryableSort: noop,
    isInvalidSortFieldError: noop,
    normalizeQueryRow: noop,
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

const FULL_CARD = {
    spec: 'chara_card_v2', spec_version: '2.0', name: 'Full', tags: ['t1'],
    data: {
        name: 'Full', description: 'd', personality: '', scenario: '', first_mes: '', mes_example: '',
        character_version: '1.2', creator: 'someone', tags: ['t1'], creator_notes: 'notes',
        extensions: { talkativeness: 0.5, world: 'Lore' },
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

/**
 * @typedef {object} Mode
 * @property {typeof import('../src/character-metadata-db.js')} metadataDb
 * @property {typeof import('../src/endpoints/search-index-coordinator.js')} searchCoordinator
 * @property {typeof import('../src/character-card-parser.js')} cardParser
 * @property {typeof import('better-sqlite3')} Database
 * @property {typeof import('../public/scripts/character-list.js')} characterList
 * @property {import('node:http').Server} server
 * @property {string} baseUrl
 */

const MODES = [
    { creatorNotes: false, lazy: false },
    { creatorNotes: true, lazy: false },
    { creatorNotes: false, lazy: true },
    { creatorNotes: true, lazy: true },
];

describe.each(MODES)('shallowCharactersIncludeCreatorNotes=$creatorNotes, lazyLoadCharacters=$lazy', ({ creatorNotes, lazy }) => {
    /** @type {Mode} */
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
        const cardParser = await import('../src/character-card-parser.js');
        const Database = (await import('better-sqlite3')).default;
        const { router } = await import('../src/endpoints/characters.js');
        const characterList = await import('../public/scripts/character-list.js');

        process.chdir(path.resolve(originalCwd, '..'));

        const express = (await import('express')).default;
        const multer = (await import('multer')).default;
        const app = express();
        const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-delta-sync-hash-uploads-'));
        app.use(multer({ dest: uploadsDir }).single('avatar'));
        app.use(express.json());
        app.use((req, res, next) => {
            req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
            next();
        });
        app.use('/api/characters', router);
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        mode = { metadataDb, searchCoordinator, cardParser, Database, characterList, server, baseUrl };
    });

    afterAll(async () => {
        await new Promise(resolve => mode.server.close(resolve));
        process.chdir(originalCwd);
        delete process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES;
        delete process.env.SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS;
    });

    beforeEach(() => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-delta-sync-hash-test-'));
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
        toastrError.mockClear();
        // The client issues root-relative URLs; route them to the test server.
        globalThis.fetch = (url, init) => realFetch(String(url).startsWith('/') ? `${mode.baseUrl}${url}` : url, init);
    });

    afterEach(async () => {
        globalThis.fetch = realFetch;
        await mode.searchCoordinator.disposeSearchWorkers();
        mode.metadataDb.disposeMetadataStores();
        fs.rmSync(directories.root, { recursive: true, force: true });
    });

    async function postJson(urlPath, body) {
        const response = await realFetch(`${mode.baseUrl}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        expect(response.status).toBeLessThan(300);
        return response;
    }

    async function writePng(fileName, card) {
        const baseImage = await fs.promises.readFile(path.join(originalCwd, '..', 'public', 'img', 'ai4.png'));
        await fs.promises.writeFile(path.join(directories.characters, fileName), mode.cardParser.write(baseImage, JSON.stringify(card)));
    }

    async function createCharacter(name) {
        await postJson('/api/characters/create', { ch_name: name, file_name: name, description: 'd', creator_notes: 'created notes' });
        return `${name}.png`;
    }

    async function importJson(card) {
        const formData = new FormData();
        formData.append('avatar', new Blob([JSON.stringify(card)], { type: 'application/json' }), 'card.json');
        formData.append('file_type', 'json');
        const response = await realFetch(`${mode.baseUrl}/api/characters/import`, { method: 'POST', body: formData });
        expect(response.status).toBe(200);
    }

    /**
     * @param {number} expectedRows how many character rows the calling test has written
     * @returns {Map<string, {fav: number, tagIds: number, content: number}>} every character row's digest columns
     */
    function serverDigests(expectedRows) {
        const db = new mode.Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
        try {
            const rows = [...db.prepare('SELECT id, digest_fav, digest_tag_ids, digest_content FROM characters ORDER BY id LIMIT ?').iterate(expectedRows + 1)];
            expect(rows.length).toBe(expectedRows);
            return new Map(rows.map(r => [r.id, { fav: r.digest_fav >>> 0, tagIds: r.digest_tag_ids >>> 0, content: r.digest_content >>> 0 }]));
        } finally {
            db.close();
        }
    }

    /** A fresh client's delta-sync from an empty cache, so every character comes back as a whole-record fetch. */
    async function deltaSync() {
        for (const records of localforageStores.values()) records.clear();
        residentCharacters.length = 0;
        await mode.characterList.getCharacters({ silent: true, silentGroups: true, skipPrint: true });
        expect(toastrError).not.toHaveBeenCalled();
        const cache = localforageStores.get(`SillyTavern_CharacterCache_${USER_HANDLE}`) ?? new Map();
        return new Map([...cache].filter(([key]) => key.endsWith('.png')).map(([key, record]) => [key, record]));
    }

    /**
     * A fresh client's delta-sync next to the server's digests, as { actual, expected } for the test to compare.
     * @param {number} expectedRows how many character rows the calling test has written
     */
    async function cachedAgainstServer(expectedRows) {
        const cached = await deltaSync();
        const server = serverDigests(expectedRows);
        const hashes = [...cached].map(([id, record]) => [id, { fav: record.hashes.fav >>> 0, tagIds: record.hashes.tagIds >>> 0, content: record.hashes.content >>> 0 }]);
        return {
            actual: {
                serverHasRows: server.size > 0,
                ids: [...cached.keys()].sort(),
                // Every whole-record fetch is a record the client does store: never the shallow_json projection itself.
                fields: [...cached].map(([id, record]) => ({ id, fields: record.character.shallow === true ? 'shallow' : 'full' })),
                hashes: Object.fromEntries(hashes),
            },
            expected: {
                serverHasRows: true,
                ids: [...server.keys()].sort(),
                fields: [...cached.keys()].map(id => ({ id, fields: lazy ? 'shallow' : 'full' })),
                hashes: Object.fromEntries(server),
            },
        };
    }

    describe('upsertCharacterFromWrite', () => {
        test.each(CARDS)('%s card', async (_label, card) => {
            await mode.metadataDb.upsertCharacterFromWrite(directories, 'Char.png', JSON.stringify(card));
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });
    });

    describe('bootstrap', () => {
        test.each(CARDS)('%s card', async (_label, card) => {
            await writePng('Char.png', card);
            await mode.metadataDb.bootstrapIfNeeded(directories);
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });
    });

    describe('reconcile (POST /metadata/rescan)', () => {
        test.each(CARDS)('%s card', async (_label, card) => {
            await createCharacter('Existing');
            await writePng('Char.png', card);
            await postJson('/api/characters/metadata/rescan', {});
            const { actual, expected } = await cachedAgainstServer(2);
            expect(actual).toEqual(expected);
        });
    });

    describe('import', () => {
        test.each(CARDS)('%s card as JSON', async (_label, card) => {
            await importJson(card);
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });
    });

    describe('character routes', () => {
        test('POST /create', async () => {
            await createCharacter('Made');
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });

        test('POST /edit', async () => {
            const avatar = await createCharacter('Made');
            await postJson('/api/characters/edit', { avatar_url: avatar, ch_name: 'Made', description: 'edited', creator_notes: 'edited notes', creator: 'me', character_version: '2', tags: 'x, y', world: 'Lore' });
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });

        test('POST /edit-attribute', async () => {
            const avatar = await createCharacter('Made');
            await postJson('/api/characters/edit-attribute', { avatar_url: avatar, ch_name: 'Made', field: 'creator_notes', value: 'attribute notes' });
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });

        test('POST /merge-attributes', async () => {
            const avatar = await createCharacter('Made');
            await postJson('/api/characters/merge-attributes', { avatar, data: { creator_notes: 'merged notes', creator: 'merged', extensions: { world: 'Merged' } } });
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });

        test('POST /rename', async () => {
            const avatar = await createCharacter('Made');
            await postJson('/api/characters/rename', { avatar_url: avatar, new_name: 'Renamed' });
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });

        test('POST /duplicate', async () => {
            const avatar = await createCharacter('Made');
            await postJson('/api/characters/duplicate', { avatar_url: avatar });
            const { actual, expected } = await cachedAgainstServer(2);
            expect(actual).toEqual(expected);
        });

        test.each([true, false])('POST /fav %p', async (fav) => {
            const avatar = await createCharacter('Made');
            await postJson('/api/characters/fav', { avatar, fav });
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });

        test('POST /chat', async () => {
            const avatar = await createCharacter('Made');
            await postJson('/api/characters/chat', { avatar, chat: 'Made - chat' });
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });

        test('POST /allow-global-styles', async () => {
            const avatar = await createCharacter('Made');
            await postJson('/api/characters/allow-global-styles', { avatar, allowed: true });
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });

        test.each(CARDS)('POST /fav on a written %s card', async (_label, card) => {
            await mode.metadataDb.upsertCharacterFromWrite(directories, 'Char.png', JSON.stringify(card));
            await postJson('/api/characters/fav', { avatar: 'Char.png', fav: true });
            const { actual, expected } = await cachedAgainstServer(1);
            expect(actual).toEqual(expected);
        });
    });
});
