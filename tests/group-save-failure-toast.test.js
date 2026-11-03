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
    compareByRandomSeed: () => 0,
}));


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
    },
    buildCharacterQuery: ({ sortField, sortOrder = 'asc', randomSeed } = {}) => {
        const filter = {};
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
    chatOpenSendKeys: jest.fn(() => []),
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

jest.unstable_mockModule('../public/scripts/character-list.js', () => ({
    getCharacters: jest.fn(),
    showCharacterSyncFailedToast: jest.fn(),
    SYNC_REQUEST_TIMEOUT_MS: 60000,
    queryWithSortFallback: async (filter, sort, request) => ({ sort, result: await request(sort) }),
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
    FILTER_STATES: { SELECTED: { key: 'SELECTED' }, EXCLUDED: { key: 'EXCLUDED' }, UNDEFINED: { key: 'UNDEFINED' } },
    isFilterState: () => false,
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

/** @type {typeof import('../public/scripts/group-chats.js')} */
let groupChats;

beforeAll(async () => {
    groupChats = await import('../public/scripts/group-chats.js');
});

const originalFetch = globalThis.fetch;

/**
 * @param {Record<string, number>} statusByUrl
 */
function fakeFetch(statusByUrl) {
    globalThis.fetch = jest.fn(async (url) => {
        const status = statusByUrl[url] ?? 200;
        return { ok: status < 400, status, json: async () => (status < 400 ? { chat_id: 'new-chat', chats: ['new-chat'] } : { error: 'failed' }) };
    });
}

beforeEach(() => {
    existsMock.mockReset();
    characters.length = 0;
    charactersById = new Map();
    global.toastr = { warning: jest.fn(), info: jest.fn(), success: jest.fn(), error: jest.fn() };
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('a failed group write shows an error toast', () => {
    test('saveGroupProperty() (POST /api/groups/save-partial), via renameGroupChat()', async () => {
        groupChats.groupsStore.create({ id: 'g-rename', members: [], chats: ['c1'], chat_id: 'c1' });
        fakeFetch({ '/api/groups/save-partial': 500 });

        await groupChats.renameGroupChat('g-rename', 'c1', 'c2');

        expect(globalThis.fetch).toHaveBeenCalledWith('/api/groups/save-partial', expect.anything());
        expect(global.toastr.error).toHaveBeenCalledTimes(1);
    });

    test('createNewGroupChat() (POST /api/chats/new)', async () => {
        groupChats.groupsStore.create({ id: 'g-new-chat', members: [], chats: ['c1'], chat_id: 'c1' });
        fakeFetch({ '/api/chats/new': 500 });

        await groupChats.createNewGroupChat('g-new-chat');

        expect(global.toastr.error).toHaveBeenCalledTimes(1);
        expect(groupChats.groupsStore.get('g-new-chat').chats).toEqual(['c1']);
    });

    test('deleteGroupChatByName() replacing the last chat (POST /api/chats/new)', async () => {
        groupChats.groupsStore.create({ id: 'g-delete', members: [], chats: ['c1'], chat_id: 'c1' });
        fakeFetch({ '/api/chats/new': 500 });

        await groupChats.deleteGroupChatByName('g-delete', 'c1');

        expect(global.toastr.error).toHaveBeenCalledTimes(1);
    });
});
