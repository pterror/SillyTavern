import { describe, test, expect, jest, beforeEach, beforeAll } from '@jest/globals';

// group-chats.js (public/scripts/) pulls in script.js and a wide chunk of the client UI stack, none of which is
// safely importable in a plain node test env (jQuery/DOM assumptions throughout) - same problem
// character-repository.test.js solves by mocking at the module boundary. Everything below is mocked the same
// way: real behavior only where a test needs it (characterRepository, `characters`/`charactersStore`,
// `onlyUnique`, `power_user`, FILTER_TYPES), inert stand-ins everywhere else.

// group-chats.js has a top-level `jQuery(() => { ... })` DOM-wiring block (pre-existing, not introduced by
// this change) that runs at module import time regardless of what's mocked above - it needs `jQuery`/`$`/`CSS`
// globals to exist so the import itself doesn't throw. A Proxy-based infinite-chainable stands in for jQuery's
// chaining API ($(...).on(...).fadeIn(...) etc.) since nothing under test here depends on it doing anything.
function makeChainable() {
    const target = () => makeChainable();
    return new Proxy(target, {
        get: () => () => makeChainable(),
        apply: () => makeChainable(),
    });
}
global.$ = makeChainable();
global.jQuery = (fn) => { if (typeof fn === 'function') fn(); return makeChainable(); };
global.CSS = { supports: () => true };
if (typeof global.document === 'undefined') global.document = {};

const existsMock = jest.fn();
const getManyMock = jest.fn();
const getMock = jest.fn();

// `characters` is a single stable array reference, mutated in place (never reassigned) - jest's ESM module
// mocking snapshots a plain exported property's value at mock-factory-eval time rather than exposing a true
// live getter, so reassigning this binding (`characters = []`) in beforeEach would silently orphan
// group-chats.js's already-bound reference to the old (now-stale, forever-empty) array. Mutating in place keeps
// both sides pointing at the same object.
/** @type {{avatar: string, name: string}[]} */
const characters = [];
/** @type {Map<string, {avatar: string, name: string}>} */
let charactersById;

const charactersStoreMock = {
    get: (id) => charactersById.get(id),
    has: (id) => charactersById.has(id),
    onChange: () => () => {},
};

jest.unstable_mockModule('../public/lib.js', () => ({ Fuse: class {} }));

jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: { sort_order: 'asc', sort_field: 'name' },
    loadMovingUIState: jest.fn(),
    sortEntitiesList: jest.fn(),
    invalidateGroupsFuseIndex: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    RA_CountCharTokens: jest.fn(),
    humanizedDateTime: jest.fn(),
    dragElement: jest.fn(),
    favsToHotswap: jest.fn(),
    getMessageTimeStamp: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/constants.js', () => ({
    debounce_timeout: { quick: 100 },
}));

jest.unstable_mockModule('../public/scripts/random-sort.js', () => ({
    getRandomSortSeed: jest.fn(() => 42),
    // Reverse key order, so a test can tell the seeded order from the order the rows came in.
    compareByRandomSeed: (aKey, bKey) => (aKey < bKey ? 1 : aKey > bKey ? -1 : 0),
}));

// buildCharacterQuery/isServerQueryableSort/CharacterQueryError/isInvalidSortFieldError are re-implemented
// minimally here (they're pure, and the real versions live in character-repository.js which itself depends on
// script.js).
const queryAllMock = jest.fn();

class CharacterQueryError extends Error {
    constructor(message, { status, reason } = {}) {
        super(message);
        this.name = 'CharacterQueryError';
        this.status = status;
        this.reason = reason;
    }
}

jest.unstable_mockModule('../public/scripts/character-repository.js', () => ({
    characterRepository: {
        exists: existsMock,
        getMany: getManyMock,
        get: getMock,
        queryAll: queryAllMock,
    },
    buildCharacterQuery: ({ searchTerm = '', tagsInclude = [], tagsExclude = [], fav, sortField, sortOrder = 'asc', randomSeed } = {}) => {
        const filter = {};
        const search = String(searchTerm ?? '').trim();
        if (search) filter.search = search;
        if (tagsInclude.length > 0 || tagsExclude.length > 0) filter.tags = { include: tagsInclude, exclude: tagsExclude, mode: 'and' };
        if (typeof fav === 'boolean') filter.fav = fav;
        let sort;
        if (sortField === 'random') sort = { field: 'random', order: sortOrder, seed: randomSeed };
        else if (sortField) sort = { field: sortField, order: sortOrder };
        return { filter, sort };
    },
    // Mirrors the real function's current contract (character-repository.js): true for everything except
    // 'search' - the client no longer pre-validates individual column names against a hand-maintained list.
    isServerQueryableSort: (sortField) => sortField !== 'search',
    CharacterQueryError,
    isInvalidSortFieldError: (error) => error instanceof CharacterQueryError && error.reason === 'invalid-sort-field',
}));

jest.unstable_mockModule('../public/script.js', () => ({
    sendSystemMessage: jest.fn(),
    printMessages: jest.fn(),
    substituteParams: jest.fn(),
    default_avatar: '',
    addOneMessage: jest.fn(),
    clearChat: jest.fn(),
    Generate: jest.fn(),
    select_rm_info: {},
    setCharacterName: jest.fn(),
    setEditedMessageId: jest.fn(),
    is_send_press: false,
    resetChatState: jest.fn(),
    setSendButtonState: jest.fn(),
    system_message_types: {},
    online_status: '',
    talkativeness_default: 50,
    selectRightMenuWithAnimation: jest.fn(),
    deleteLastMessage: jest.fn(),
    showSwipeButtons: jest.fn(),
    hideSwipeButtons: jest.fn(),
    updateChatMetadata: jest.fn(),
    getThumbnailUrl: jest.fn(),
    setMenuType: jest.fn(),
    menu_type: '',
    select_selected_character: jest.fn(),
    cancelTtsPlay: jest.fn(),
    displayPastChats: jest.fn(),
    sendMessageAsUser: jest.fn(),
    getBiasStrings: jest.fn(),
    saveChatConditional: jest.fn(),
    deactivateSendButtons: jest.fn(),
    activateSendButtons: jest.fn(),
    getCurrentChatId: jest.fn(),
    setCharacterSettingsOverrides: jest.fn(),
    system_avatar: '',
    isChatSaving: false,
    setExternalAbortController: jest.fn(),
    baseChatReplace: jest.fn(),
    createLazyFields: jest.fn(),
    depth_prompt_depth_default: 0,
    loadItemizedPrompts: jest.fn(),
    animation_duration: 0,
    depth_prompt_role_default: '',
    shouldAutoContinue: jest.fn(),
    unshallowCharacter: jest.fn(),
    chatElement: { find: () => ({ remove: jest.fn() }) },
    ensureMessageMediaIsArray: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    printTagList: jest.fn(),
    createTagMapFromList: jest.fn(),
    applyTagsOnCharacterSelect: jest.fn(),
    applyTagsOnGroupSelect: jest.fn(),
    printTagFilters: jest.fn(),
    tag_filter_type: {},
    removeEntityTags: jest.fn(),
    tagsStore: {},
    heldTagsForIds: () => [],
    compareTagsForSort: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/character-field-editor.js', () => ({
    blockWhileFieldEditing: jest.fn(),
}));

// queryWithSortFallback's contract (character-list.js, covered against the real route by
// character-list-sort-fallback.test.js): a rejected sort, or `search` with no term, is run again in name order, or
// relevance order with a term, after a warning; any other failure reaches the caller.
const unsupportedSortWarnings = [];
jest.unstable_mockModule('../public/scripts/character-list.js', () => ({
    getCharacters: jest.fn(),
    showCharacterSyncFailedToast: jest.fn(),
    SYNC_REQUEST_TIMEOUT_MS: 60000,
    queryWithSortFallback: async (filter, sort, request) => {
        if (!(sort?.field === 'search' && !filter.search)) {
            try {
                return { sort, result: await request(sort) };
            } catch (error) {
                if (!(error instanceof CharacterQueryError && error.reason === 'invalid-sort-field')) throw error;
            }
        }
        unsupportedSortWarnings.push(String(sort?.field));
        const fallback = filter.search ? { field: 'search', order: 'asc' } : { field: 'name', order: 'asc' };
        return { sort: fallback, result: await request(fallback) };
    },
}));

jest.unstable_mockModule('../public/scripts/chat-state.js', () => ({
    chat: [],
    chat_metadata: {},
}));

jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({
    getRequestHeaders: jest.fn(() => ({})),
}));

jest.unstable_mockModule('../public/scripts/character-store.js', () => {
    // The real resolveCharacterRef, resolveCharacterRefPair and CHARACTER_REF_MISMATCH over this mock's stores.
    const CHARACTER_REF_MISMATCH = Symbol('CHARACTER_REF_MISMATCH');
    const resolveCharacterRef = (ref) => {
        const upstreamHit = characters[ref];
        if (upstreamHit !== undefined) {
            return upstreamHit;
        }
        if (typeof ref === 'string') {
            return charactersStoreMock.get(ref);
        }
        if (typeof ref === 'object' && ref !== null && typeof ref.avatar === 'string') {
            return charactersStoreMock.get(ref.avatar);
        }
        return undefined;
    };
    const resolveCharacterRefPair = (ref, avatar) => {
        const character = resolveCharacterRef(ref);
        return typeof character?.avatar === 'string' && character.avatar === avatar ? character : CHARACTER_REF_MISMATCH;
    };
    return {
        characters,
        charactersStore: charactersStoreMock,
        exposedGroups: [],
        setCharacterId: jest.fn(),
        setExposedGroupId: jest.fn(),
        resolveCharacterRef,
        resolveCharacterRefPair,
        CHARACTER_REF_MISMATCH,
    };
});

jest.unstable_mockModule('../public/scripts/events.js', () => ({
    eventSource: { emit: jest.fn() },
    event_types: {},
}));

jest.unstable_mockModule('../public/scripts/chat-store.js', () => ({
    _setCurrentTarget: jest.fn(),
    updateMessage: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/node-identity.js', () => ({
    provisionalNodeId: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/filters.js', () => ({
    FILTER_TYPES: { SEARCH: 'search', TAG: 'tag', FOLDER: 'folder', FAV: 'fav', GROUP: 'group' },
    FILTER_STATES: {
        SELECTED: { key: 'SELECTED', class: 'selected' },
        EXCLUDED: { key: 'EXCLUDED', class: 'excluded' },
        UNDEFINED: { key: 'UNDEFINED', class: 'undefined' },
    },
    isFilterState: (a, b) => (typeof a === 'string' ? a : a?.key) === (typeof b === 'string' ? b : b?.key),
    FilterHelper: class {
        constructor() { this.filterData = {}; this.applyFiltersCalls = []; }
        getFilterData(type) { return this.filterData[type]; }
        setFilterData(type, value) { this.filterData[type] = value; }
        applyFilters(data, options) { this.applyFiltersCalls.push(options); return data; }
        clearFuzzySearchCaches() {}
    },
}));

jest.unstable_mockModule('../public/scripts/chats.js', () => ({
    isExternalMediaAllowed: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    POPUP_TYPE: {},
    Popup: { show: { confirm: jest.fn() } },
    callGenericPopup: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), ''),
}));

jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getItem: jest.fn(), setItem: jest.fn() },
}));

jest.unstable_mockModule('../public/scripts/request-compression.js', () => ({
    compressRequest: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    shuffle: (arr) => arr,
    onlyUnique: (value, index, self) => self.indexOf(value) === index,
    debounce: (fn) => fn,
    delay: jest.fn(),
    isDataURL: jest.fn(),
    createThumbnail: jest.fn(),
    extractAllWords: jest.fn(),
    saveBase64AsFile: jest.fn(),
    PAGINATION_TEMPLATE: '',
    getBase64Async: jest.fn(),
    resetScrollHeight: jest.fn(),
    initScrollHeight: jest.fn(),
    localizePagination: jest.fn(),
    renderPaginationDropdown: jest.fn(),
    paginationDropdownChangeHandler: jest.fn(),
    waitUntilCondition: jest.fn(),
    uuidv4: jest.fn(),
}));

/** @type {typeof import('../public/scripts/group-chats.js').validateGroup} */
let validateGroup;
/** @type {typeof import('../public/scripts/group-chats.js').getGroupMembers} */
let getGroupMembers;
/** @type {typeof import('../public/scripts/group-chats.js').groupsStore} */
let groupsStore;
/** @type {typeof import('../public/scripts/group-chats.js').buildGroupCandidateQuery} */
let buildGroupCandidateQuery;
/** @type {typeof import('../public/scripts/group-chats.js').getGroupCharacters} */
let getGroupCharacters;
/** @type {typeof import('../public/scripts/power-user.js').power_user} */
let power_user;

beforeAll(async () => {
    ({ validateGroup, getGroupMembers, groupsStore, buildGroupCandidateQuery, getGroupCharacters } = await import('../public/scripts/group-chats.js'));
    ({ power_user } = await import('../public/scripts/power-user.js'));
});

beforeEach(() => {
    existsMock.mockReset();
    getManyMock.mockReset();
    getMock.mockReset();
    characters.length = 0;
    charactersById = new Map();
    global.toastr = { warning: jest.fn(), info: jest.fn(), success: jest.fn(), error: jest.fn() };
});

/** Registers a resident character in both `characters` and `charactersStore`. */
function addResidentCharacter(avatar, name = avatar) {
    const character = { avatar, name };
    characters.push(character);
    charactersById.set(avatar, character);
    return character;
}

describe('validateGroup()', () => {
    // validateGroup() saves through global fetch and there is no server here. saveGroupProperty() reads
    // nothing off the response, so a bare successful one is enough.
    const SAVE_URL = '/api/groups/save-partial';
    const FIND_URL = '/api/characters/find';
    const originalFetch = globalThis.fetch;
    /** Ids `/api/characters/find` answers per exact name; a name not listed matches nothing. */
    /** @type {Record<string, string[]>} */
    let idsByName;
    /** When set, `/api/characters/find` answers with this status instead. */
    /** @type {number|null} */
    let findFailStatus;

    beforeEach(() => {
        idsByName = {};
        findFailStatus = null;
        globalThis.fetch = jest.fn(async (url, options) => {
            if (url === FIND_URL) {
                if (findFailStatus !== null) return { ok: false, status: findFailStatus };
                const { name } = JSON.parse(options.body);
                return { ok: true, status: 200, json: async () => ({ ids: idsByName[name] ?? [], capped: false }) };
            }
            return { ok: true, status: 200 };
        });
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    /** Parsed JSON body of the single save-partial request. */
    function savedBody() {
        const saveCalls = globalThis.fetch.mock.calls.filter(([url]) => url === SAVE_URL);
        expect(saveCalls).toHaveLength(1);
        return JSON.parse(saveCalls[0][1].body);
    }

    test('keeps members that resolve locally without calling exists()', async () => {
        addResidentCharacter('alice.png', 'Alice');
        const group = { id: 'g1', members: ['alice.png'], chats: ['c1'] };

        await validateGroup(group);

        expect(existsMock).not.toHaveBeenCalled();
        expect(group.members).toEqual(['alice.png']);
    });

    test('keeps a legacy display-name member the server finds by exact name, though the page does not hold it', async () => {
        existsMock.mockResolvedValue({ 'Bob': false });
        idsByName = { 'Bob': ['bob-real.png'] };
        getMock.mockResolvedValue({ avatar: 'bob-real.png', name: 'Bob' });
        const group = { id: 'g1', members: ['Bob'], chats: [] };

        await validateGroup(group);

        const findCalls = globalThis.fetch.mock.calls.filter(([url]) => url === FIND_URL);
        expect(findCalls.map(([, options]) => JSON.parse(options.body))).toEqual([{ name: 'Bob', allowAvatar: false, insensitive: false }]);
        expect(group.members).toEqual(['Bob']);
        expect(globalThis.fetch).not.toHaveBeenCalledWith(SAVE_URL, expect.anything());
    });

    test('leaves members unchanged when the name lookup for a missing member fails', async () => {
        existsMock.mockResolvedValue({ 'Bob': false });
        findFailStatus = 500;
        const group = { id: 'g1', members: ['Bob'], chats: [] };

        await validateGroup(group);

        expect(group.members).toEqual(['Bob']);
        expect(globalThis.fetch).not.toHaveBeenCalledWith(SAVE_URL, expect.anything());
    });

    test('prunes a member exists() authoritatively says does not exist, and saves', async () => {
        existsMock.mockResolvedValue({ 'ghost.png': false });
        const group = { id: 'g1', members: ['ghost.png'], chats: [] };

        await validateGroup(group);

        expect(existsMock).toHaveBeenCalledWith(['ghost.png']);
        expect(group.members).toEqual([]);
        expect(globalThis.fetch).toHaveBeenCalledWith(SAVE_URL, expect.anything());
        expect(savedBody()).toEqual({ id: 'g1', props: { members: [] } });
    });

    test('keeps a non-resident member that exists() says still exists (not deleted, just not resident)', async () => {
        existsMock.mockResolvedValue({ 'notloaded.png': true });
        const group = { id: 'g1', members: ['notloaded.png'], chats: [] };

        await validateGroup(group);

        expect(group.members).toEqual(['notloaded.png']);
    });

    test('§4.2: aborts the member-pruning mutation (leaves members untouched) when exists() throws', async () => {
        existsMock.mockRejectedValue(new Error('network down'));
        const group = { id: 'g1', members: ['maybe-ghost.png'], chats: [] };

        await validateGroup(group);

        expect(group.members).toEqual(['maybe-ghost.png']);
        expect(globalThis.fetch).not.toHaveBeenCalledWith(SAVE_URL, expect.anything());
    });

    test('§4.2: aborts the member-pruning mutation when exists() returns a partial answer', async () => {
        // Requested two ids, server only answered for one - must not be read as "the other one is gone".
        existsMock.mockResolvedValue({ 'a.png': true });
        const group = { id: 'g1', members: ['a.png', 'b.png'], chats: [] };

        await validateGroup(group);

        expect(group.members).toEqual(['a.png', 'b.png']);
        expect(globalThis.fetch).not.toHaveBeenCalledWith(SAVE_URL, expect.anything());
    });

    test('still dedupes chat ids even when the member existence check aborts', async () => {
        existsMock.mockRejectedValue(new Error('network down'));
        const group = { id: 'g1', members: ['ghost.png'], chats: ['c1', 'c1', 'c2'] };

        await validateGroup(group);

        expect(group.members).toEqual(['ghost.png']);
        expect(group.chats).toEqual(['c1', 'c2']);
        expect(globalThis.fetch).toHaveBeenCalledWith(SAVE_URL, expect.anything());
        expect(savedBody()).toEqual({ id: 'g1', props: { chats: ['c1', 'c2'] } });
    });

    test('does nothing (no dirty save) when there is nothing to prune or dedupe', async () => {
        addResidentCharacter('alice.png', 'Alice');
        const group = { id: 'g1', members: ['alice.png'], chats: ['c1'] };
        const before = { members: [...group.members], chats: [...group.chats] };

        await validateGroup(group);

        expect(group.members).toEqual(before.members);
        expect(group.chats).toEqual(before.chats);
        expect(globalThis.fetch).not.toHaveBeenCalledWith(SAVE_URL, expect.anything());
    });

    test('does nothing for a null/undefined group', async () => {
        await expect(validateGroup(null)).resolves.toBeUndefined();
        await expect(validateGroup(undefined)).resolves.toBeUndefined();
        expect(existsMock).not.toHaveBeenCalled();
    });
});

describe('getGroupMembers()', () => {
    test('returns an empty resolved/unresolved split for an unknown group', async () => {
        const result = await getGroupMembers('does-not-exist');
        expect(result).toEqual({ resolved: [], unresolved: [] });
    });

    test('resolves resident members locally, in member order, without calling the repository', async () => {
        addResidentCharacter('alice.png', 'Alice');
        addResidentCharacter('bob.png', 'Bob');
        groupsStore.create({ id: 'g2', members: ['bob.png', 'alice.png'] });

        const result = await getGroupMembers('g2');

        expect(result.unresolved).toEqual([]);
        expect(result.resolved.map(c => c.avatar)).toEqual(['bob.png', 'alice.png']);
        expect(getManyMock).not.toHaveBeenCalled();
    });

    test('returns an explicit unresolved list instead of undefined holes for non-resident members', async () => {
        addResidentCharacter('alice.png', 'Alice');
        getManyMock.mockResolvedValue(new Map()); // repository has no answer either - a true miss
        groupsStore.create({ id: 'g3', members: ['alice.png', 'missing.png'] });

        const result = await getGroupMembers('g3');

        expect(result.resolved.map(c => c.avatar)).toEqual(['alice.png']);
        expect(result.unresolved).toEqual(['missing.png']);
        expect(getManyMock).toHaveBeenCalledWith(['missing.png']);
    });

    test('falls back to the repository for a valid but non-resident member, and it lands in resolved, not unresolved', async () => {
        const remote = { avatar: 'remote.png', name: 'Remote' };
        getManyMock.mockResolvedValue(new Map([['remote.png', remote]]));
        groupsStore.create({ id: 'g4', members: ['remote.png'] });

        const result = await getGroupMembers('g4');

        expect(result.resolved).toEqual([remote]);
        expect(result.unresolved).toEqual([]);
    });
});

describe('buildGroupCandidateQuery()', () => {
    beforeEach(() => {
        power_user.sort_field = 'name';
        power_user.sort_order = 'asc';
    });

    test('excludes the given member ids and maps the current sort state', () => {
        power_user.sort_field = 'name';
        power_user.sort_order = 'asc';

        const { filter, sort } = buildGroupCandidateQuery(['alice.png', 'bob.png']);

        expect(filter.excludeIds).toEqual(['alice.png', 'bob.png']);
        expect(sort).toEqual({ field: 'name', order: 'asc' });
    });

    test('carries a random sort seed through when sort_order is random', () => {
        power_user.sort_order = 'random';

        const { sort } = buildGroupCandidateQuery([]);

        expect(sort).toEqual({ field: 'random', order: 'asc', seed: 42 });
    });
});

describe('getGroupCharacters() candidates', () => {
    // The module-wide jQuery stand-in answers `.is(':selected')` with a truthy Proxy; this block answers the sort
    // dropdown's "Search" option from `searchOptionSelected` instead.
    const originalDollar = global.$;
    let searchOptionSelected = false;
    /** @type {import('../public/scripts/filters.js').FilterHelper} */
    let groupCandidatesFilter;

    beforeAll(async () => {
        ({ groupCandidatesFilter } = await import('../public/scripts/group-chats.js'));
    });

    beforeEach(() => {
        power_user.sort_field = 'name';
        power_user.sort_order = 'asc';
        queryAllMock.mockReset();
        unsupportedSortWarnings.length = 0;
        searchOptionSelected = false;
        groupCandidatesFilter.filterData = {};
        groupCandidatesFilter.applyFiltersCalls = [];
        global.$ = (selector) => {
            if (selector === '#character_sort_order option[data-field="search"]') {
                return { is: () => searchOptionSelected };
            }
            return originalDollar(selector);
        };
    });

    afterEach(() => {
        global.$ = originalDollar;
    });

    const toEntity = (item) => ({ item, id: item.avatar, type: 'character' });

    test('doFilter: true with a queryable sort attempts characterRepository.queryAll() and uses its rows', async () => {
        const remote = { avatar: 'remote.png', name: 'Remote' };
        queryAllMock.mockResolvedValue([remote]);

        const result = await getGroupCharacters({ doFilter: true, onlyMembers: false });

        expect(queryAllMock).toHaveBeenCalledTimes(1);
        expect(result).toEqual([toEntity(remote)]);
    });

    test('a rejected sort is asked for again in name order, with the warning, and never reads the resident characters', async () => {
        addResidentCharacter('resident.png', 'Resident');
        power_user.sort_field = 'made_up_field';
        const remote = { avatar: 'remote.png', name: 'Remote' };
        queryAllMock
            .mockRejectedValueOnce(new CharacterQueryError('bad field', { status: 400, reason: 'invalid-sort-field' }))
            .mockResolvedValueOnce([remote]);

        const result = await getGroupCharacters({ doFilter: true, onlyMembers: false });

        expect(queryAllMock.mock.calls.map(([, sort]) => sort)).toEqual([
            { field: 'made_up_field', order: 'asc' },
            { field: 'name', order: 'asc' },
        ]);
        expect(unsupportedSortWarnings).toEqual(['made_up_field']);
        expect(result).toEqual([toEntity(remote)]);
    });

    test('a search term is sent to the server in relevance order, with the members excluded', async () => {
        addResidentCharacter('alice.png', 'Alice');
        groupCandidatesFilter.filterData.search = 'ali';
        const remote = { avatar: 'alicia.png', name: 'Alicia' };
        queryAllMock.mockResolvedValue([remote]);

        const result = await getGroupCharacters({ doFilter: true, onlyMembers: false });

        expect(queryAllMock).toHaveBeenCalledTimes(1);
        const [filter, sort] = queryAllMock.mock.calls[0];
        expect(filter).toEqual({ search: 'ali', excludeIds: [] });
        expect(sort).toEqual({ field: 'search', order: 'asc' });
        expect(result).toEqual([toEntity(remote)]);
        // The server did the search, tags and fav; the browser's pass keeps only the other filters.
        expect(groupCandidatesFilter.applyFiltersCalls).toEqual([{
            tempOverrides: { search: '', tag: { selected: [], excluded: [] }, fav: 'UNDEFINED' },
        }]);
    });

    test('the tag and fav filters are sent to the server', async () => {
        groupCandidatesFilter.filterData.tag = { selected: ['t1'], excluded: ['t2'] };
        groupCandidatesFilter.filterData.fav = 'SELECTED';
        queryAllMock.mockResolvedValue([]);

        await getGroupCharacters({ doFilter: true, onlyMembers: false });

        const [filter] = queryAllMock.mock.calls[0];
        expect(filter).toEqual({ tags: { include: ['t1'], exclude: ['t2'], mode: 'and' }, fav: true, excludeIds: [] });
    });

    test('an excluded fav filter is sent as fav: false', async () => {
        groupCandidatesFilter.filterData.fav = 'EXCLUDED';
        queryAllMock.mockResolvedValue([]);

        await getGroupCharacters({ doFilter: true, onlyMembers: false });

        expect(queryAllMock.mock.calls[0][0]).toEqual({ fav: false, excludeIds: [] });
    });

    test('the main list\'s "Search" option with no candidate term uses the saved sort, with no warning', async () => {
        searchOptionSelected = true;
        power_user.sort_field = 'date_added';
        power_user.sort_order = 'desc';
        queryAllMock.mockResolvedValue([]);

        await getGroupCharacters({ doFilter: true, onlyMembers: false });

        expect(queryAllMock.mock.calls.map(([, sort]) => sort)).toEqual([{ field: 'date_added', order: 'desc' }]);
        expect(unsupportedSortWarnings).toEqual([]);
    });

    test('random order sorts the rows by the seed, since queryAll pages come unsorted', async () => {
        power_user.sort_order = 'random';
        const a = { avatar: 'a.png', name: 'A' };
        const b = { avatar: 'b.png', name: 'B' };
        queryAllMock.mockResolvedValue([a, b]);

        const result = await getGroupCharacters({ doFilter: true, onlyMembers: false });

        expect(queryAllMock.mock.calls[0][1]).toEqual({ field: 'random', order: 'asc', seed: 42 });
        expect(result).toEqual([toEntity(b), toEntity(a)]);
    });

    test('doFilter: false asks the server for every non-member in the saved sort, with no filters', async () => {
        addResidentCharacter('resident.png', 'Resident');
        groupCandidatesFilter.filterData.search = 'ali';
        const remote = { avatar: 'remote.png', name: 'Remote' };
        queryAllMock.mockResolvedValue([remote]);

        const result = await getGroupCharacters({ doFilter: false, onlyMembers: false });

        expect(queryAllMock.mock.calls).toEqual([[{ excludeIds: [] }, { field: 'name', order: 'asc' }]]);
        expect(groupCandidatesFilter.applyFiltersCalls).toEqual([]);
        expect(result).toEqual([toEntity(remote)]);
    });

    test('a different server rejection (e.g. a 500) propagates instead of silently falling back', async () => {
        queryAllMock.mockRejectedValue(new CharacterQueryError('server exploded', { status: 500, reason: 'internal-error' }));

        await expect(getGroupCharacters({ doFilter: true, onlyMembers: false })).rejects.toThrow('server exploded');
    });

    test('a network-level failure propagates instead of silently falling back', async () => {
        queryAllMock.mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(getGroupCharacters({ doFilter: true, onlyMembers: false })).rejects.toThrow('Failed to fetch');
    });
});
