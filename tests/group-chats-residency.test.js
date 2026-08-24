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
}));

// buildCharacterQuery/isServerQueryableSort/CharacterQueryError/isInvalidSortFieldError are re-implemented
// minimally here (they're pure, and the real versions live in character-repository.js which itself depends on
// script.js) - this mock is what getGroupCharacters()'s buildGroupCandidateQuery() and
// canUseServerQueryForGroupCandidates() actually call. `queryAllMock` backs `characterRepository.queryAll()`,
// the candidate-path call `getGroupCharacters()` attempts and falls back from on a caught
// `isInvalidSortFieldError()` - see the "getGroupCharacters() candidates" describe block below.
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
        queryAll: queryAllMock,
    },
    buildCharacterQuery: ({ sortField, sortOrder = 'asc', randomSeed } = {}) => {
        const filter = {};
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
    chat: [],
    sendSystemMessage: jest.fn(),
    printMessages: jest.fn(),
    substituteParams: jest.fn(),
    characters,
    charactersStore: charactersStoreMock,
    default_avatar: '',
    addOneMessage: jest.fn(),
    clearChat: jest.fn(),
    Generate: jest.fn(),
    select_rm_info: {},
    setCharacterId: jest.fn(),
    setCharacterName: jest.fn(),
    setEditedMessageId: jest.fn(),
    is_send_press: false,
    resetChatState: jest.fn(),
    setSendButtonState: jest.fn(),
    getCharacters: jest.fn(),
    system_message_types: {},
    online_status: '',
    talkativeness_default: 50,
    selectRightMenuWithAnimation: jest.fn(),
    deleteLastMessage: jest.fn(),
    showSwipeButtons: jest.fn(),
    hideSwipeButtons: jest.fn(),
    chat_metadata: {},
    updateChatMetadata: jest.fn(),
    getThumbnailUrl: jest.fn(),
    getRequestHeaders: jest.fn(() => ({})),
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
    eventSource: { emit: jest.fn() },
    event_types: {},
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
}));

jest.unstable_mockModule('../public/scripts/filters.js', () => ({
    FILTER_TYPES: { SEARCH: 'search', TAG: 'tag', FOLDER: 'folder', FAV: 'fav', GROUP: 'group' },
    FilterHelper: class {
        constructor() { this.filterData = {}; }
        getFilterData(type) { return this.filterData[type]; }
        setFilterData(type, value) { this.filterData[type] = value; }
        applyFilters(data) { return data; }
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
    test('keeps members that resolve locally without calling exists()', async () => {
        addResidentCharacter('alice.png', 'Alice');
        const group = { id: 'g1', members: ['alice.png'], chats: ['c1'] };

        await validateGroup(group);

        expect(existsMock).not.toHaveBeenCalled();
        expect(group.members).toEqual(['alice.png']);
    });

    test('keeps a legacy display-name member that resolves via the name fallback, without calling exists()', async () => {
        addResidentCharacter('bob-real.png', 'Bob');
        const group = { id: 'g1', members: ['Bob'], chats: [] };

        await validateGroup(group);

        expect(existsMock).not.toHaveBeenCalled();
        expect(group.members).toEqual(['Bob']);
    });

    test('prunes a member exists() authoritatively says does not exist, and saves', async () => {
        existsMock.mockResolvedValue({ 'ghost.png': false });
        const group = { id: 'g1', members: ['ghost.png'], chats: [] };

        await validateGroup(group);

        expect(existsMock).toHaveBeenCalledWith(['ghost.png']);
        expect(group.members).toEqual([]);
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
    });

    test('§4.2: aborts the member-pruning mutation when exists() returns a partial answer', async () => {
        // Requested two ids, server only answered for one - must not be read as "the other one is gone".
        existsMock.mockResolvedValue({ 'a.png': true });
        const group = { id: 'g1', members: ['a.png', 'b.png'], chats: [] };

        await validateGroup(group);

        expect(group.members).toEqual(['a.png', 'b.png']);
    });

    test('still dedupes chat ids even when the member existence check aborts', async () => {
        existsMock.mockRejectedValue(new Error('network down'));
        const group = { id: 'g1', members: ['ghost.png'], chats: ['c1', 'c1', 'c2'] };

        await validateGroup(group);

        expect(group.members).toEqual(['ghost.png']);
        expect(group.chats).toEqual(['c1', 'c2']);
    });

    test('does nothing (no dirty save) when there is nothing to prune or dedupe', async () => {
        addResidentCharacter('alice.png', 'Alice');
        const group = { id: 'g1', members: ['alice.png'], chats: ['c1'] };
        const before = { members: [...group.members], chats: [...group.chats] };

        await validateGroup(group);

        expect(group.members).toEqual(before.members);
        expect(group.chats).toEqual(before.chats);
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
    // canUseServerQueryForGroupCandidates() reads `$('#character_sort_order option[data-field="search"]').is(':selected')`
    // - the module-wide chainable jQuery stand-in (top of this file) makes every jQuery call return a truthy
    // Proxy, including `.is(...)`, which would make that check always short-circuit to "no search sort
    // selected... wait, selected" and always decline the server path. This block swaps in a narrower `$` for
    // just that one selector so the candidates path can actually be exercised, and restores the original after.
    const originalDollar = global.$;

    beforeEach(() => {
        power_user.sort_field = 'name';
        power_user.sort_order = 'asc';
        queryAllMock.mockReset();
        global.$ = (selector) => {
            if (selector === '#character_sort_order option[data-field="search"]') {
                return { is: () => false };
            }
            return originalDollar(selector);
        };
    });

    afterEach(() => {
        global.$ = originalDollar;
    });

    test('doFilter: true with a queryable sort attempts characterRepository.queryAll() and uses its rows', async () => {
        const remote = { avatar: 'remote.png', name: 'Remote' };
        queryAllMock.mockResolvedValue([remote]);

        const result = await getGroupCharacters({ doFilter: true, onlyMembers: false });

        expect(queryAllMock).toHaveBeenCalledTimes(1);
        expect(result).toEqual([{ item: remote, id: 'remote.png', type: 'character' }]);
    });

    test('a 400 invalid-sort-field rejection falls back to the local resident character scan', async () => {
        addResidentCharacter('alice.png', 'Alice');
        queryAllMock.mockRejectedValue(new CharacterQueryError('bad field', { status: 400, reason: 'invalid-sort-field' }));

        const result = await getGroupCharacters({ doFilter: true, onlyMembers: false });

        expect(queryAllMock).toHaveBeenCalledTimes(1);
        expect(result).toEqual([{ item: charactersById.get('alice.png'), id: 'alice.png', type: 'character' }]);
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
