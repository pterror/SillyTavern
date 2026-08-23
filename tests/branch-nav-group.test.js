import { describe, test, expect, jest, beforeEach, beforeAll } from '@jest/globals';

// Group-chat variant of branch-nav.test.js's mock scaffold, split into its own file because
// `selected_group` is a primitive export that a Jest synthetic-ESM mock snapshots once at first
// import - see branch-nav.test.js's header comment. Here it's just baked in as truthy from the
// start instead of toggled between tests.
global.toastr = { warning: jest.fn(), error: jest.fn(), info: jest.fn(), success: jest.fn() };
global.document = { querySelector: jest.fn(() => null) };

const chatState = { chat: [], chat_metadata: {} };
const openCharacterChatMock = jest.fn(async () => {});
const openGroupChatMock = jest.fn(async () => {});
const groupsStoreMock = { get: jest.fn(() => ({ chat_id: 'current-chat' })) };

function setChat(messages) {
    chatState.chat.length = 0;
    chatState.chat.push(...messages);
}

jest.unstable_mockModule('../public/script.js', () => ({
    getCurrentCharacter: jest.fn(() => ({ avatar: 'char.png', name: 'Char', chat: 'current-chat' })),
    getSelectionState: jest.fn(() => ({ type: 'group' })),
    saveChat: jest.fn(),
    system_message_types: {},
    syncSwipeToMes: jest.fn(() => true),
    openCharacterChat: openCharacterChatMock,
    chat_metadata: chatState.chat_metadata,
    getRequestHeaders: jest.fn(() => ({})),
    getThumbnailUrl: jest.fn(),
    getCharacters: jest.fn(),
    chat: chatState.chat,
    saveChatConditional: jest.fn(),
    saveItemizedPrompts: jest.fn(),
    setActiveGroup: jest.fn(),
    getCurrentChatDetails: jest.fn(() => ({ sessionName: 'current-chat' })),
}));

jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    humanizedDateTime: jest.fn(() => '2026-01-01'),
}));

jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    DEFAULT_AUTO_MODE_DELAY: 5,
    group_activation_strategy: {},
    group_generation_mode: {},
    groups: [],
    groupsStore: groupsStoreMock,
    openGroupById: jest.fn(),
    openGroupChat: openGroupChatMock,
    saveGroupBookmarkChat: jest.fn(),
    selected_group: 'group-1',
}));

jest.unstable_mockModule('../public/scripts/action-loader.js', () => ({
    loader: {
        show: jest.fn(() => ({ hide: jest.fn(async () => {}) })),
        ToastMode: { STATIC: 'static' },
    },
}));

jest.unstable_mockModule('../public/scripts/macros.js', () => ({
    getLastMessageId: jest.fn(() => 0),
}));

jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: { show: { input: jest.fn(), text: jest.fn() } },
}));

jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommand.js', () => ({
    SlashCommand: { fromProps: jest.fn(x => x) },
}));

jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: {},
    SlashCommandArgument: { fromProps: jest.fn(x => x) },
    SlashCommandNamedArgument: { fromProps: jest.fn(x => x) },
}));

jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
    commonEnumProviders: { messages: jest.fn(), boolean: jest.fn(() => jest.fn()) },
}));

jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: { addCommandObject: jest.fn(), commands: {} },
}));

jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    createTagMapFromList: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/templates.js', () => ({
    renderTemplateAsync: jest.fn(async () => ''),
}));

jest.unstable_mockModule('../public/scripts/request-compression.js', () => ({
    compressRequest: jest.fn(async req => req),
}));

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), ''),
}));

jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    getUniqueName: jest.fn(),
    isTrueBoolean: jest.fn(),
    uuidv4: () => 'test-uuid',
}));

/** @type {typeof import('../public/scripts/bookmarks.js')} */
let bookmarks;

beforeAll(async () => {
    bookmarks = await import('../public/scripts/bookmarks.js');
});

beforeEach(() => {
    setChat([]);
    openCharacterChatMock.mockClear();
    openGroupChatMock.mockClear();
    global.fetch = jest.fn(async () => ({ ok: false }));
});

function makeMessage({ swipe_id = 0, branches = undefined } = {}) {
    return {
        name: 'Char',
        is_user: false,
        mes: 'hello',
        swipe_id,
        swipes: ['hello'],
        extra: branches ? { branches } : {},
    };
}

describe('branchSwipe() for group chats', () => {
    test('uses openGroupChat instead of openCharacterChat, keyed off the group id', async () => {
        setChat([makeMessage({ swipe_id: 0, branches: { '0': ['sib-a'] } })]);

        await bookmarks.branchSwipe(0, 1);

        expect(openGroupChatMock).toHaveBeenCalledWith('group-1', 'sib-a');
        expect(openCharacterChatMock).not.toHaveBeenCalled();
    });
});

describe('resolveForkRing() for group chats', () => {
    test('origin group chat still resolves locally (no fetch needed)', async () => {
        setChat([makeMessage({ swipe_id: 0, branches: { '0': ['sib-a', 'sib-b'] } })]);

        const result = await bookmarks.resolveForkRing(0, 0);

        expect(result).toEqual({ ring: ['current-chat', 'sib-a', 'sib-b'], selfIndex: 0 });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('never attempts the cross-file fetch from a sibling group chat (no lightweight lookup endpoint for groups)', async () => {
        setChat([makeMessage()]);
        Object.assign(chatState.chat_metadata, { main_chat: 'origin-chat', fork_point: { mesId: 0, swipeId: 0 } });

        expect(await bookmarks.resolveForkRing(0, 0)).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
