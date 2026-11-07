import { describe, test, expect, jest, beforeEach, beforeAll, afterEach } from '@jest/globals';

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
    sortEntitiesList: jest.fn(),
    invalidateGroupsFuseIndex: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    RA_CountCharTokens: jest.fn(),
    humanizedDateTime: jest.fn(),
    dragElement: jest.fn(),
    showHotswapFavs: jest.fn(), renderHotswap: jest.fn(),
    getMessageTimeStamp: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/constants.js', () => ({
    debounce_timeout: { quick: 100 },
}));

jest.unstable_mockModule('../public/scripts/random-sort.js', () => ({
    getRandomSortSeed: jest.fn(() => 42),
    compareByRandomSeed: (aKey, bKey) => (aKey < bKey ? 1 : aKey > bKey ? -1 : 0),
}));

const queryMock = jest.fn();

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
        query: queryMock,
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
    isServerQueryableSort: (sortField) => sortField !== 'search',
    CharacterQueryError,
    isInvalidSortFieldError: (error) => error instanceof CharacterQueryError && error.reason === 'invalid-sort-field',
}));

jest.unstable_mockModule('../public/script.js', () => ({
    _snapshotMessages: jest.fn(),
    requestChatOpen: jest.fn(),
    takeChatOpenAnswer: jest.fn((_owner, answer) => answer),
    chatOpenAsk: jest.fn(() => ({})),
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
    dropLastMessage: jest.fn(),
    showSwipeButtons: jest.fn(),
    hideSwipeButtons: jest.fn(),
    updateChatMetadata: jest.fn(),
    characterAvatar: jest.fn(() => ({})),
    characterThumbnail: jest.fn(),
    setMenuType: jest.fn(),
    menu_type: '',
    select_selected_character: jest.fn(),
    cancelTtsPlay: jest.fn(),
    displayPastChats: jest.fn(),
    sendMessageAsUser: jest.fn(),
    getBiasStrings: jest.fn(),
    saveMetadata: jest.fn(),
    deactivateSendButtons: jest.fn(),
    activateSendButtons: jest.fn(),
    getCurrentChatId: jest.fn(),
    setCharacterSettingsOverrides: jest.fn(),
    system_avatar: '',
    setExternalAbortController: jest.fn(),
    baseChatReplace: jest.fn(),
    createLazyFields: jest.fn(),
    depth_prompt_depth_default: 0,
    loadItemizedPrompts: jest.fn(),
    animation_duration: 0,
    depth_prompt_role_default: '',
    shouldAutoContinue: jest.fn(),
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

const unsupportedSortWarnings = [];
jest.unstable_mockModule('../public/scripts/character-list.js', () => ({
    getCharacters: jest.fn(),
    printCharactersDebounced: jest.fn(),
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

jest.unstable_mockModule('../public/scripts/character-store.js', () => ({
    characters,
    charactersStore: charactersStoreMock,
    holdCharacter: jest.fn(character => character),
    setCharacterId: jest.fn(),
    setOpenGroupId: jest.fn(),
}));

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
    isProvisionalNodeId: jest.fn(() => false),
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
    saveUserImage: jest.fn(),
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
/** @type {typeof import('../public/scripts/group-chats.js').printGroupCandidates} */
let printGroupCandidates;
/** @type {typeof import('../public/scripts/group-chats.js').takeInHeldGroupChanges} */
let takeInHeldGroupChanges;
/** @type {typeof import('../public/scripts/power-user.js').power_user} */
let power_user;

beforeAll(async () => {
    ({ validateGroup, getGroupMembers, groupsStore, buildGroupCandidateQuery, printGroupCandidates, takeInHeldGroupChanges } = await import('../public/scripts/group-chats.js'));
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

function addResidentCharacter(avatar, name = avatar) {
    const character = { avatar, name };
    characters.push(character);
    charactersById.set(avatar, character);
    return character;
}

describe('validateGroup()', () => {
    const SAVE_URL = '/api/groups/save-partial';
    const FIND_URL = '/api/characters/find';
    const originalFetch = globalThis.fetch;
    /** @type {Record<string, string[]>} */
    let idsByName;
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

    test('keeps a member exists() says does not exist, warns, and writes nothing', async () => {
        existsMock.mockResolvedValue({ 'ghost.png': false });
        const group = { id: 'g1', members: ['ghost.png'], chats: [] };

        await validateGroup(group);

        expect(existsMock).toHaveBeenCalledWith(['ghost.png']);
        expect(group.members).toEqual(['ghost.png']);
        expect(globalThis.fetch).not.toHaveBeenCalledWith(SAVE_URL, expect.anything());
        expect(global.toastr.warning).toHaveBeenCalledWith(expect.stringContaining('ghost.png'), expect.anything(), expect.anything());
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
        existsMock.mockResolvedValue({ 'a.png': true });
        const group = { id: 'g1', members: ['a.png', 'b.png'], chats: [] };

        await validateGroup(group);

        expect(group.members).toEqual(['a.png', 'b.png']);
        expect(globalThis.fetch).not.toHaveBeenCalledWith(SAVE_URL, expect.anything());
    });

    test('writes nothing for duplicate chat ids: opening a group never writes', async () => {
        existsMock.mockRejectedValue(new Error('network down'));
        const group = { id: 'g1', members: ['ghost.png'], chats: ['c1', 'c1', 'c2'] };

        await validateGroup(group);

        expect(group.members).toEqual(['ghost.png']);
        expect(group.chats).toEqual(['c1', 'c1', 'c2']);
        expect(globalThis.fetch).not.toHaveBeenCalledWith(SAVE_URL, expect.anything());
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
        getManyMock.mockResolvedValue(new Map());
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

describe('the add-member picker shows the candidates a page at a time from the server', () => {
    const originalDollar = global.$;
    let searchOptionSelected = false;
    /** @type {import('../public/scripts/filters.js').FilterHelper} */
    let groupCandidatesFilter;
    /** @type {any} */
    let pager;

    beforeAll(async () => {
        ({ groupCandidatesFilter } = await import('../public/scripts/group-chats.js'));
    });

    beforeEach(() => {
        power_user.sort_field = 'name';
        power_user.sort_order = 'asc';
        queryMock.mockReset();
        unsupportedSortWarnings.length = 0;
        searchOptionSelected = false;
        pager = undefined;
        groupCandidatesFilter.filterData = {};
        groupCandidatesFilter.applyFiltersCalls = [];
        global.$ = (selector) => {
            if (selector === '#character_sort_order option[data-field="search"]') {
                return { is: () => searchOptionSelected };
            }
            if (selector === '#rm_group_add_members_pagination') {
                return { pagination: (options) => { pager = options; } };
            }
            return originalDollar(selector);
        };
    });

    afterEach(() => {
        global.$ = originalDollar;
    });

    const toEntity = (item) => ({ item, id: item.avatar, type: 'character' });

    /**
     * @param {number} pageNumber
     * @param {number} pageSize
     */
    function showPage(pageNumber, pageSize) {
        return new Promise((resolve, reject) => pager.ajaxFunction({ data: { pageNumber, pageSize }, success: resolve, error: reject }));
    }

    test('the first page is asked for once, at the page size shown, and later pages one at a time', async () => {
        const a = { avatar: 'a.png', name: 'A' };
        const b = { avatar: 'b.png', name: 'B' };
        queryMock.mockResolvedValueOnce({ rows: [a], total: 7 }).mockResolvedValueOnce({ rows: [b], total: 7 });

        await printGroupCandidates();
        expect(await showPage(1, 5)).toEqual({ rows: [toEntity(a)], total: 7 });
        expect(await showPage(2, 5)).toEqual({ rows: [toEntity(b)], total: 7 });

        expect(queryMock.mock.calls).toEqual([
            [{ excludeIds: [] }, { field: 'name', order: 'asc' }, 1, 5, ['rows', 'total']],
            [{ excludeIds: [] }, { field: 'name', order: 'asc' }, 2, 5, ['rows', 'total']],
        ]);
        expect(pager.totalNumberLocator({ total: '~7' })).toBe(7);
        expect(groupCandidatesFilter.applyFiltersCalls).toEqual([]);
    });

    test('a rejected sort is asked for again in name order, with the warning, and later pages keep that order', async () => {
        power_user.sort_field = 'made_up_field';
        queryMock
            .mockRejectedValueOnce(new CharacterQueryError('bad field', { status: 400, reason: 'invalid-sort-field' }))
            .mockResolvedValue({ rows: [], total: 0 });

        await printGroupCandidates();
        await showPage(1, 5);
        await showPage(2, 5);

        expect(queryMock.mock.calls.map(([, sort, page]) => [sort, page])).toEqual([
            [{ field: 'made_up_field', order: 'asc' }, 1],
            [{ field: 'name', order: 'asc' }, 1],
            [{ field: 'name', order: 'asc' }, 2],
        ]);
        expect(unsupportedSortWarnings).toEqual(['made_up_field']);
    });

    test('a search term is sent to the server in relevance order, with the members excluded', async () => {
        groupCandidatesFilter.filterData.search = 'ali';
        queryMock.mockResolvedValue({ rows: [], total: 0 });

        await printGroupCandidates();

        const [filter, sort] = queryMock.mock.calls[0];
        expect(filter).toEqual({ search: 'ali', excludeIds: [] });
        expect(sort).toEqual({ field: 'search', order: 'asc' });
    });

    test('the tag and fav filters are sent to the server', async () => {
        groupCandidatesFilter.filterData.tag = { selected: ['t1'], excluded: ['t2'] };
        groupCandidatesFilter.filterData.fav = 'SELECTED';
        queryMock.mockResolvedValue({ rows: [], total: 0 });

        await printGroupCandidates();

        expect(queryMock.mock.calls[0][0]).toEqual({ tags: { include: ['t1'], exclude: ['t2'], mode: 'and' }, fav: true, excludeIds: [] });
    });

    test('an excluded fav filter is sent as fav: false', async () => {
        groupCandidatesFilter.filterData.fav = 'EXCLUDED';
        queryMock.mockResolvedValue({ rows: [], total: 0 });

        await printGroupCandidates();

        expect(queryMock.mock.calls[0][0]).toEqual({ fav: false, excludeIds: [] });
    });

    test('the main list\'s "Search" option with no candidate term uses the saved sort, with no warning', async () => {
        searchOptionSelected = true;
        power_user.sort_field = 'date_added';
        power_user.sort_order = 'desc';
        queryMock.mockResolvedValue({ rows: [], total: 0 });

        await printGroupCandidates();

        expect(queryMock.mock.calls.map(([, sort]) => sort)).toEqual([{ field: 'date_added', order: 'desc' }]);
        expect(unsupportedSortWarnings).toEqual([]);
    });

    test('random order is the server\'s seeded order', async () => {
        power_user.sort_order = 'random';
        const a = { avatar: 'a.png', name: 'A' };
        const b = { avatar: 'b.png', name: 'B' };
        queryMock.mockResolvedValue({ rows: [a, b], total: 2 });

        await printGroupCandidates();

        expect(queryMock.mock.calls[0][1]).toEqual({ field: 'random', order: 'asc', seed: 42 });
        expect(await showPage(1, 5)).toEqual({ rows: [toEntity(a), toEntity(b)], total: 2 });
    });

    test.each(['group', 'folder'])('a selected %s filter shows no candidate and asks the server for none', async (type) => {
        groupCandidatesFilter.filterData[type] = 'SELECTED';

        await printGroupCandidates();

        expect(await showPage(1, 5)).toEqual({ rows: [], total: 0 });
        expect(await showPage(2, 5)).toEqual({ rows: [], total: 0 });
        expect(queryMock).not.toHaveBeenCalled();
    });

    test('a different server rejection (e.g. a 500) propagates instead of silently falling back', async () => {
        queryMock.mockRejectedValue(new CharacterQueryError('server exploded', { status: 500, reason: 'internal-error' }));

        await expect(printGroupCandidates()).rejects.toThrow('server exploded');
    });

    test('a network-level failure propagates instead of silently falling back', async () => {
        queryMock.mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(printGroupCandidates()).rejects.toThrow('Failed to fetch');
    });
});

describe('the held groups are brought up to the server\'s', () => {
    const originalFetch = globalThis.fetch;
    /** @type {Map<string, object>} */
    let served;
    /** @type {[string, any][]} */
    let asked;

    beforeEach(() => {
        for (const group of [...groupsStore.getAll()]) groupsStore.remove(group.id);
        served = new Map();
        asked = [];
        globalThis.fetch = jest.fn(async (url, options) => {
            const body = JSON.parse(options.body);
            asked.push([url, body]);
            if (url === '/api/groups/batch') {
                return { ok: true, status: 200, json: async () => body.ids.filter(id => served.has(id)).map(id => structuredClone(served.get(id))) };
            }
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        });
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('a held group changed on the server takes its fields as the server has them, and only held groups are read', async () => {
        groupsStore.create({ id: 'g1', name: 'Old', members: ['a.png'], disabled_members: [], avatar_thumbnail_still: 's.webp' });
        groupsStore.create({ id: 'g2', name: 'Kept', members: [], disabled_members: [] });
        const held = groupsStore.get('g1');
        served.set('g1', { id: 'g1', name: 'New', members: ['a.png'], disabled_members: [] });
        const changes = [];
        const stop = groupsStore.onChange(change => changes.push([change.op, change.id, change.patch]));

        await takeInHeldGroupChanges(new Set(['g1', 'unheld']), new Set(['other']));
        stop();

        expect(asked).toEqual([['/api/groups/batch', { ids: ['g1'] }]]);
        expect(groupsStore.get('g1')).toBe(held);
        expect(held).toEqual({ id: 'g1', name: 'New', members: ['a.png'], disabled_members: [] });
        expect(changes).toEqual([['updated', 'g1', { name: 'New' }]]);
        expect(groupsStore.get('g2')).toEqual({ id: 'g2', name: 'Kept', members: [], disabled_members: [] });
    });

    test('a held group deleted, or not there when read, is let go', async () => {
        groupsStore.create({ id: 'g1', members: [], disabled_members: [] });
        groupsStore.create({ id: 'g2', members: [], disabled_members: [] });

        await takeInHeldGroupChanges(new Set(['g2']), new Set(['g1']));

        expect(groupsStore.has('g1')).toBe(false);
        expect(groupsStore.has('g2')).toBe(false);
    });

    test('when nothing held changed, nothing is read', async () => {
        groupsStore.create({ id: 'g1', members: [], disabled_members: [] });

        const held = groupsStore.get('g1');
        await takeInHeldGroupChanges(new Set(['unheld']), new Set(['other']));
        expect(asked).toEqual([]);
        expect(groupsStore.get('g1')).toBe(held);
    });
});
