import { describe, test, expect, jest, beforeEach, beforeAll } from '@jest/globals';

global.toastr = { warning: jest.fn(), error: jest.fn(), info: jest.fn(), success: jest.fn() };

// bookmarks.js pulls in script.js and a wide swath of UI modules (jQuery/DOM assumptions
// throughout), none of which are safely importable in a plain node test env - so, same pattern as
// tests/character-repository.test.js uses for script.js, the whole import surface is mocked at the
// module boundary. Every name bookmarks.js actually imports has to be present on these mocks (ESM
// named imports are resolved eagerly at link time), even the ones these tests never touch.
// `chat`/`chat_metadata` are real, unmocked scripts/chat-state.js - importing the real module (rather
// than a synthetic mock of it) means these tests exercise the same live bindings bookmarks.js does,
// so there's no separate mock surface to drift out of sync with it. They're exported as stable
// references and mutated *in place* between tests (never reassigned), which is what makes sharing
// them this way work: reassigning `chatState.chat = [...]` would only rebind this file's local
// variable, not what bookmarks.js sees.
const chatState = await import('../public/scripts/chat-state.js');
const openCharacterChatMock = jest.fn(async () => {});
const openGroupChatMock = jest.fn(async () => {});
/**
 * Real saveChat() (generation.js, since a8bdcc599) sends the plain proposed name with `unique: true`
 * and returns whatever unique name the server actually saved under - naming is no longer computed
 * client-side. Mirrored here against the same existing-chats listing bookmarks.js's own
 * getExistingChatNames() fetches (these tests already drive that fetch per-case), so the mock produces
 * the same "<name> - Branch #N" result the server would.
 */
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
/**
 * Real updateMessage() (chat-store.js) shallow-merges into chat[mesId] and replaces the array slot
 * (it doesn't mutate the old object in place) - createBranch()/createNewBookmark() rely on exactly
 * that to land `extra.branches`/`extra.bookmark_link` where these tests read them back from
 * chatState.chat[0]. Deep-freezing the result is chat-store.js's own hygiene, not behavior any test
 * here depends on, so it's left out.
 */
const updateMessageMock = jest.fn((mesId, updates) => {
    const old = chatState.chat[mesId];
    if (!old) return old;
    const result = { ...old, ...updates };
    chatState.chat[mesId] = result;
    return result;
});
/**
 * Real hydrateSwipes() (script.js) only does anything when the requested swipe is a `null` hole;
 * every message these tests build has fully-populated string swipes, so the real fast path always
 * applies (return true, no fetch). Mirrors just that predicate rather than the fetch-and-fill branch,
 * which nothing here constructs a hole to exercise.
 */
const hydrateSwipesMock = jest.fn(async (mesId, { index = null, all = false } = {}) => {
    const message = chatState.chat[mesId];
    if (!message || !Array.isArray(message.swipes)) return false;
    const isHole = i => typeof message.swipes[i] !== 'string';
    const wanted = all
        ? message.swipes.some((_, i) => isHole(i))
        : (index !== null && index >= 0 && index < message.swipes.length && isHole(index));
    return !wanted;
});
/**
 * Real ensureOpeningRow() (chat-store.js) returns null for any message without a stored/provisional
 * node_id - true of every fixture here (isTreeStored() is always false in this file, so its return
 * value never actually gates anything below it either way).
 */
const ensureOpeningRowMock = jest.fn(async () => null);
/** switchToNode() is only wired to the .select_chat_block click handler, which these tests never trigger. */
const switchToNodeMock = jest.fn(async () => false);
/** Real, pure predicate (node-identity.js) - re-implemented here rather than imported so the mocked
 * utils.js (which node-identity.js itself imports getStringHash from) doesn't need widening for it. */
const isStoredNodeIdMock = jest.fn((nodeId) => typeof nodeId === 'string' && nodeId.length > 0 && !nodeId.startsWith('card:'));

/** Replaces the real chat array's contents in place, keeping its identity stable across tests. */
function setChat(messages) {
    chatState.chat.length = 0;
    chatState.chat.push(...messages);
}

/** Replaces the real chat_metadata object's contents in place, keeping its identity stable. */
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
    getThumbnailUrl: jest.fn(),
    saveChatConditional: jest.fn(),
    saveItemizedPrompts: jest.fn(),
    setActiveGroup: jest.fn(),
    getCurrentChatDetails: getCurrentChatDetailsMock,
    selectCharacterByAvatar: jest.fn(),
    updateMessage: updateMessageMock,
    hydrateSwipes: hydrateSwipesMock,
    ensureOpeningRow: ensureOpeningRowMock,
    switchToNode: switchToNodeMock,
    isStoredNodeId: isStoredNodeIdMock,
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

// utils.js is real code, but importing it for real drags in power-user.js/world-info.js/etc (the
// whole app's module graph, DOM assumptions and all) just for uuidv4()/getUniqueName(). Stubbed with
// the same pure logic instead, since bookmarks.js only uses these two plus isTrueBoolean (unused by
// the createBranch() paths these tests cover).
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
    // Default: no existing chats found (createBranch's getExistingChatNames call, also read by
    // saveChatMock's own unique-naming above). Individual tests override this when
    // they need a specific fetch response.
    global.fetch = jest.fn(async () => ({ ok: false }));
});

/** Builds a minimal assistant message. */
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

describe('createBranch() - legacy (non-tree) chat', () => {
    test('records the new branch name on the forked message as a flat list', async () => {
        setChat([makeMessage({ swipe_id: 2 })]);

        const name = await bookmarks.createBranch(0);

        expect(name).toBe('current-chat - Branch #1');
        expect(chatState.chat[0].extra.branches).toEqual(['current-chat - Branch #1']);
    });

    test('forking a non-active swipe appends to the same list', async () => {
        setChat([makeMessage({ swipe_id: 0, branches: ['already-there - Branch #1'] })]);
        chatState.chat[0].swipes = ['hello', 'alt swipe'];
        // getExistingChatNames() reads real chat files on disk (via this fetch), not extra.branches -
        // mocked so the new branch's generated name avoids the one already on disk.
        global.fetch.mockResolvedValue({ ok: true, json: async () => [{ file_name: 'current-chat - Branch #1.jsonl' }] });

        const name = await bookmarks.createBranch(0, { swipeId: 1 });

        expect(name).toBe('current-chat - Branch #2');
        expect(chatState.chat[0].extra.branches).toEqual(['already-there - Branch #1', 'current-chat - Branch #2']);
    });

    test('records the origin chat on the new branch\'s own metadata', async () => {
        setChat([makeMessage(), makeMessage({ swipe_id: 3 })]);

        await bookmarks.createBranch(1);

        expect(saveChatMock).toHaveBeenCalledTimes(1);
        const { withMetadata } = saveChatMock.mock.calls[0][0];
        expect(withMetadata).toEqual({ main_chat: 'current-chat' });
    });
});
