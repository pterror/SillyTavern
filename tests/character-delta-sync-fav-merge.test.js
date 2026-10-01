import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import lodash from 'lodash';

// The real delta-sync client (character-list.js getCharacters() -> fetchCharactersDelta() -> character-cache.js)
// against the real server routes: after POST /fav, delta-sync merges only the changed field into the cached
// record, which must then carry the same fav/tag_ids/content hashes the server stores as its digest columns - the
// values hash-mode /query compares the cache against. Only modules that can't load in node are replaced: IndexedDB
// (localforage) by an in-memory store that structured-clones like IndexedDB does, and character-list.js's DOM-bound
// UI imports.

// writeCharacterData()'s and the JSON importer's DEFAULT_AVATAR_PATH ('./public/img/...') is repo-root-relative.
const originalCwd = process.cwd();

const USER_HANDLE = 'delta-sync-fav-merge-test-user';

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
        const Database = (await import('better-sqlite3')).default;
        const { router } = await import('../src/endpoints/characters.js');
        const characterList = await import('../public/scripts/character-list.js');

        process.chdir(path.resolve(originalCwd, '..'));

        const express = (await import('express')).default;
        const multer = (await import('multer')).default;
        const app = express();
        const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-delta-sync-fav-merge-uploads-'));
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

        mode = { metadataDb, searchCoordinator, Database, characterList, server, baseUrl };
    });

    afterAll(async () => {
        await new Promise(resolve => mode.server.close(resolve));
        process.chdir(originalCwd);
        delete process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES;
        delete process.env.SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS;
    });

    beforeEach(() => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-delta-sync-fav-merge-test-'));
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

    async function createCharacter(name) {
        await postJson('/api/characters/create', { ch_name: name, file_name: name, description: 'd', creator_notes: 'created notes' });
        return `${name}.png`;
    }

    /** @returns {Map<string, {fav: number, tagIds: number, content: number}>} every character row's digest columns (every test here holds exactly one) */
    function serverDigests() {
        const db = new mode.Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
        try {
            const rows = [...db.prepare('SELECT id, digest_fav, digest_tag_ids, digest_content FROM characters ORDER BY id LIMIT 2').iterate()];
            expect(rows.length).toBe(1);
            return new Map(rows.map(r => [r.id, { fav: r.digest_fav >>> 0, tagIds: r.digest_tag_ids >>> 0, content: r.digest_content >>> 0 }]));
        } finally {
            db.close();
        }
    }

    /**
     * Delta-syncs on top of whatever the cache already holds, recording each field-filtered /batch request.
     * @returns {Promise<{cached: Map<string, any>, fieldRequests: string[][]}>}
     */
    async function incrementalSync() {
        /** @type {string[][]} */
        const fieldRequests = [];
        const routed = globalThis.fetch;
        globalThis.fetch = (url, init) => {
            if (String(url) === '/api/characters/batch') {
                const { fields } = JSON.parse(String(init?.body));
                if (fields) fieldRequests.push(fields);
            }
            return routed(url, init);
        };
        try {
            await mode.characterList.getCharacters({ silent: true, silentGroups: true, skipPrint: true });
        } finally {
            globalThis.fetch = routed;
        }
        expect(toastrError).not.toHaveBeenCalled();
        const cache = localforageStores.get(`SillyTavern_CharacterCache_${USER_HANDLE}`) ?? new Map();
        return { cached: new Map([...cache].filter(([key]) => key.endsWith('.png'))), fieldRequests };
    }

    /** Syncs the written character into the cache, then toggles fav through /fav and syncs only that change. */
    async function favMergeAgainstServer(avatar, favSequence) {
        const actual = [];
        const expected = [];
        const recordStep = (step, { cached, fieldRequests }, expectedFieldRequests) => {
            const server = serverDigests();
            const hashes = [...cached].map(([id, record]) => [id, { fav: record.hashes.fav >>> 0, tagIds: record.hashes.tagIds >>> 0, content: record.hashes.content >>> 0 }]);
            actual.push({ step, fieldRequests, serverHasRows: server.size > 0, hashes: Object.fromEntries(hashes) });
            expected.push({ step, fieldRequests: expectedFieldRequests, serverHasRows: true, hashes: Object.fromEntries(server) });
        };

        recordStep('warm', await incrementalSync(), []);
        for (const [index, fav] of favSequence.entries()) {
            await postJson('/api/characters/fav', { avatar, fav });
            // The /fav change arrives as a field-level change, so this exercises the merge, not a whole-record fetch.
            recordStep(`fav #${index} ${fav}`, await incrementalSync(), [['fav']]);
        }
        return { actual, expected };
    }

    // A card carrying both fav mirrors, as an older client or an imported card wrote it.
    const FAV_CARD = { ...FULL_CARD, fav: true, data: { ...FULL_CARD.data, extensions: { ...FULL_CARD.data.extensions, fav: true } } };

    describe('field-level merge after POST /fav', () => {
        test.each([...CARDS, ['fav-carrying', FAV_CARD]])('written %s card', async (_label, card) => {
            await mode.metadataDb.upsertCharacterFromWrite(directories, 'Char.png', JSON.stringify(card));
            const { actual, expected } = await favMergeAgainstServer('Char.png', [true, false, true]);
            expect(actual).toEqual(expected);
        });

        test('fav-carrying card unfavorited first', async () => {
            await mode.metadataDb.upsertCharacterFromWrite(directories, 'Char.png', JSON.stringify(FAV_CARD));
            const { actual, expected } = await favMergeAgainstServer('Char.png', [false, true]);
            expect(actual).toEqual(expected);
        });

        test('POST /create character', async () => {
            const avatar = await createCharacter('Made');
            const { actual, expected } = await favMergeAgainstServer(avatar, [true, false]);
            expect(actual).toEqual(expected);
        });
    });
});
