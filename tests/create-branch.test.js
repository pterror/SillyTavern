import { describe, test, expect, jest, beforeEach, beforeAll } from '@jest/globals';

global.toastr = { warning: jest.fn(), error: jest.fn(), info: jest.fn(), success: jest.fn() };

const chatState = await import('../public/scripts/chat-state.js');
const openCharacterChatMock = jest.fn(async () => {});
const openGroupChatMock = jest.fn(async () => {});
const saveChatMock = jest.fn(async ({ chatName, unique = false } = {}) => {
    if (!unique) return chatName;
    const response = await fetch('/api/characters/chats', { method: 'POST', headers: {}, body: '{}' });
    let existing = [];
    if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) existing = data.map(x => x.file_name.replace('.jsonl', ''));
    }
    for (let i = 1; ; i++) {
        const candidate = `${chatName} - Branch #${i}`;
        if (!existing.includes(candidate)) return candidate;
    }
});
const getCurrentCharacterMock = jest.fn(() => ({ avatar: 'char.png', name: 'Char', chat: 'current-chat' }));
const getCurrentChatDetailsMock = jest.fn(() => ({ sessionName: 'current-chat' }));
const groupsStoreMock = { get: jest.fn() };
const updateMessageMock = jest.fn((mesId, updates) => {
    const old = chatState.chat[mesId];
    if (!old) return old;
    const result = { ...old, ...updates };
    chatState.chat[mesId] = result;
    return result;
});
const hydrateSwipesMock = jest.fn(async (mesId, { index = null, all = false } = {}) => {
    const message = chatState.chat[mesId];
    if (!message || !Array.isArray(message.swipes)) return false;
    const isHole = i => typeof message.swipes[i] !== 'string';
    const wanted = all
        ? message.swipes.some((_, i) => isHole(i))
        : (index !== null && index >= 0 && index < message.swipes.length && isHole(index));
    return !wanted;
});
const ensureOpeningRowMock = jest.fn(async () => null);
const switchToNodeMock = jest.fn(async () => false);
const isStoredNodeIdMock = jest.fn((nodeId) => typeof nodeId === 'string' && nodeId.length > 0 && !nodeId.startsWith('card:'));

function setChat(messages) {
    chatState.chat.length = 0;
    chatState.chat.push(...messages);
}

function setChatMetadata(metadata) {
    for (const key of Object.keys(chatState.chat_metadata)) {
        delete chatState.chat_metadata[key];
    }
    Object.assign(chatState.chat_metadata, metadata);
}

jest.unstable_mockModule('../public/script.js', () => ({
    getCurrentCharacter: getCurrentCharacterMock,
    getSelectionState: jest.fn(() => ({ type: 'character' })),
    saveChat: saveChatMock,
    system_message_types: {},
    syncSwipeToMes: jest.fn(() => true),
    openCharacterChat: openCharacterChatMock,
    getRequestHeaders: jest.fn(() => ({})),
    characterAvatar: jest.fn(() => ({})),
    characterThumbnail: jest.fn(),
    saveChatConditional: jest.fn(),
    saveItemizedPrompts: jest.fn(),
    setActiveGroup: jest.fn(),
    getCurrentChatDetails: getCurrentChatDetailsMock,
    getChatLabelBase: () => 'current-chat',
    selectCharacterByAvatar: jest.fn(),
    updateMessage: updateMessageMock,
    hydrateSwipes: hydrateSwipesMock,
    ensureOpeningRow: ensureOpeningRowMock,
    switchToNode: switchToNodeMock,
    isStoredNodeId: isStoredNodeIdMock,
    isProvisionalNodeId: jest.fn((nodeId) => typeof nodeId === 'string' && nodeId.startsWith('card:')),
    takeChatOpenAnswer: jest.fn((_owner, answer) => answer),
    chatOpenSendKeys: jest.fn(() => []),
    adoptStored: jest.fn(),
    openingForRequest: jest.fn(() => null),
}));

jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    humanizedDateTime: jest.fn(() => '2026-01-01'),
}));

jest.unstable_mockModule('../public/scripts/character-list.js', () => ({
    getCharacters: jest.fn(),
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
    selected_group: null,
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
    getUniqueName: (baseName, exists, { nameBuilder = null, maxTries = 1000, startIndex = 0 } = {}) => {
        const build = nameBuilder ?? ((name, i) => (i === 0 ? name : `${name} (${i})`));
        for (let i = startIndex; i < maxTries + startIndex; i++) {
            const candidate = build(baseName, i);
            if (!exists(candidate)) return candidate;
        }
        return null;
    },
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
    setChatMetadata({});
    getCurrentCharacterMock.mockReturnValue({ avatar: 'char.png', name: 'Char', chat: 'current-chat' });
    getCurrentChatDetailsMock.mockReturnValue({ sessionName: 'current-chat' });
    openCharacterChatMock.mockClear();
    openGroupChatMock.mockClear();
    saveChatMock.mockClear();
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

describe('createBranch() on a message the server hasn\'t stored', () => {
    test('makes no branch, saves nothing and says why', async () => {
        setChat([makeMessage({ swipe_id: 2 })]);
        global.toastr.warning.mockClear();

        const name = await bookmarks.createBranch(0);

        expect(name).toBeUndefined();
        expect(chatState.chat[0].extra.branches).toBeUndefined();
        expect(saveChatMock).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(global.toastr.warning).toHaveBeenCalledWith(expect.stringContaining('isn\'t saved yet'), 'Branch creation failed');
    });

    test('a swipe of it makes none either', async () => {
        setChat([makeMessage({ swipe_id: 0 })]);
        chatState.chat[0].swipes = ['hello', 'alt swipe'];

        expect(await bookmarks.createBranch(0, { swipeId: 1 })).toBeUndefined();
        expect(saveChatMock).not.toHaveBeenCalled();
    });
});
