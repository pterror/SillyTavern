import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import lodash from 'lodash';

import { characterContentFieldsFingerprint, characterRowFields, normalizeFav, normalizeTagIds, shallowCharacterData } from '../public/scripts/hash-utils.js';

const originalCwd = process.cwd();

const USER_HANDLE = 'delta-sync-fav-merge-test-user';

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

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;

const FULL_CARD = {
    spec: 'chara_card_v2', spec_version: '2.0', name: 'Full', tags: ['t1'],
    data: {
        name: 'Full', description: 'd', personality: '', scenario: '', first_mes: '', mes_example: '',
        character_version: '1.2', creator: 'someone', tags: ['t1'], creator_notes: 'notes',
        extensions: { talkativeness: 0.5, world: 'Lore' },
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

/**
 * @param {any} shallow
 */
function listFactsOf(shallow) {
    return {
        fav: { fav: normalizeFav(shallow?.fav), extFav: normalizeFav(shallow?.data?.extensions?.fav) },
        tagIds: normalizeTagIds(shallow?.tag_ids),
        content: characterContentFieldsFingerprint(shallow),
    };
}

/**
 * @param {any} record
 * @param {boolean} includeCreatorNotes
 */
function cachedListFacts(record, includeCreatorNotes) {
    const character = { ...record.character };
    for (const field of record.dedup ?? []) character[field] = character.data[field];
    return listFactsOf({
        name: character.name,
        fav: character.fav,
        tags: character.tags,
        tag_ids: character.tag_ids,
        data: shallowCharacterData(character, includeCreatorNotes),
    });
}

/**
 * @typedef {object} Mode
 * @property {typeof import('./converted-user.fixture.js')} fixture
 * @property {typeof import('../src/library-codes.js').TYPE} TYPE
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
        jest.resetModules();

        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

        const fixture = await import('./converted-user.fixture.js');
        const { TYPE } = await import('../src/library-codes.js');
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
            req.user = user.user;
            next();
        });
        app.use('/api/characters', router);
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        mode = { fixture, TYPE, characterList, server, baseUrl };
    });

    afterAll(async () => {
        await new Promise(resolve => mode.server.close(resolve));
        process.chdir(originalCwd);
        delete process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES;
        delete process.env.SILLYTAVERN_PERFORMANCE_LAZYLOADCHARACTERS;
    });

    beforeEach(async () => {
        user = await mode.fixture.emptyUser('st-delta-sync-fav-merge-test-');
        globalThis.DATA_ROOT = user.dataRoot;
        for (const records of localforageStores.values()) records.clear();
        residentCharacters.length = 0;
        toastrError.mockClear();
        globalThis.fetch = (url, init) => realFetch(String(url).startsWith('/') ? `${mode.baseUrl}${url}` : url, init);
    });

    afterEach(async () => {
        globalThis.fetch = realFetch;
        await user.close();
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

    /**
     * @param {number} expectedRows
     * @returns {Promise<Map<string, ReturnType<typeof listFactsOf>>>}
     */
    async function serverListFacts(expectedRows) {
        const page = await user.store.lib.query({ sortField: 'name', limit: expectedRows + 1, wantRows: true, includeCreatorNotes: creatorNotes });
        const rows = /** @type {any[]} */ (page.rows).map(row => row.item);
        expect(rows.length).toBe(expectedRows);
        return new Map(rows.map(row => [row.avatar, listFactsOf(row)]));
    }

    /**
     * @returns {Promise<{cached: Map<string, any>, fieldRequests: string[][]}>}
     */
    async function incrementalSync() {
        /** @type {string[][]} */
        const fieldRequests = [];
        const routed = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            const response = await routed(url, init);
            if (String(url) === '/api/characters/batch' && JSON.parse(String(init?.body)).hashes) {
                for (const { set, unset } of await response.clone().json()) fieldRequests.push([...Object.keys(set), ...unset].sort());
            }
            return response;
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

    /**
     * @param {string} avatar
     * @returns {Promise<boolean>}
     */
    async function storedFav(avatar) {
        return (await user.store.lib.entity(mode.TYPE.character, avatar))?.fav === true;
    }

    async function favMergeAgainstServer(avatar, favSequence) {
        const actual = [];
        const expected = [];
        const recordStep = async (step, { cached, fieldRequests }, expectedFieldRequests) => {
            const server = await serverListFacts(1);
            const hashes = [...cached].map(([id, record]) => [id, cachedListFacts(record, creatorNotes)]);
            actual.push({ step, fieldRequests, serverHasRows: server.size > 0, hashes: Object.fromEntries(hashes) });
            expected.push({ step, fieldRequests: expectedFieldRequests, serverHasRows: true, hashes: Object.fromEntries(server) });
        };

        const warm = await incrementalSync();
        const record = warm.cached.get(avatar);
        const row = { ...record.character };
        for (const field of record.dedup ?? []) row[field] = row.data[field];
        await recordStep('warm', warm, [[...characterRowFields(row).keys()].sort()]);
        const rowOf = async () => (await (await postJson('/api/characters/batch', { avatars: [avatar] })).json())[0];
        const changed = (a, b) => {
            const [fa, fb] = [characterRowFields(a), characterRowFields(b)];
            return [...new Set([...fa.keys(), ...fb.keys()])].filter(k => JSON.stringify(fa.get(k)) !== JSON.stringify(fb.get(k))).sort();
        };
        for (const [index, fav] of favSequence.entries()) {
            const before = await storedFav(avatar);
            const rowBefore = await rowOf();
            await postJson('/api/characters/fav', { avatar, fav });
            const fields = changed(rowBefore, await rowOf());
            expect(fields).toEqual(before === fav ? [] : expect.arrayContaining(FAV_FIELDS));
            await recordStep(`fav #${index} ${fav}`, await incrementalSync(), before === fav ? [] : [fields]);
        }
        return { actual, expected };
    }

    const FAV_CARD = { ...FULL_CARD, fav: true, data: { ...FULL_CARD.data, extensions: { ...FULL_CARD.data.extensions, fav: true } } };

    const FAV_FIELDS = ['["data","extensions","fav"]', '["fav"]'];

    describe('field-level merge after POST /fav', () => {
        test.each([...CARDS, ['fav-carrying', FAV_CARD]])('written %s card', async (_label, card) => {
            await user.store.lib.writeCard(user.directories, 'Char.png', JSON.stringify(card));
            const { actual, expected } = await favMergeAgainstServer('Char.png', [true, false, true]);
            expect(actual).toEqual(expected);
        });

        test('fav-carrying card unfavorited first', async () => {
            await user.store.lib.writeCard(user.directories, 'Char.png', JSON.stringify(FAV_CARD));
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
