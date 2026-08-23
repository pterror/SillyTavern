import { describe, test, expect, jest, beforeEach, beforeAll } from '@jest/globals';

global.toastr = { warning: jest.fn(), error: jest.fn(), info: jest.fn(), success: jest.fn() };
// branchSwipe() scrolls the fork message into view after switching chats - a real DOM lookup, not
// something these tests exercise, so a no-op stand-in is enough.
global.document = { querySelector: jest.fn(() => null) };

// bookmarks.js pulls in script.js and a wide swath of UI modules (jQuery/DOM assumptions
// throughout), none of which are safely importable in a plain node test env - so, same pattern as
// tests/character-repository.test.js uses for script.js, the whole import surface is mocked at the
// module boundary. Every name bookmarks.js actually imports has to be present on these mocks (ESM
// named imports are resolved eagerly at link time), even the ones these tests never touch.
// `chat` and `chat_metadata` are exported as stable references and mutated *in place* between tests
// (never reassigned) - a Jest synthetic-ESM mock's exports are snapshotted once at first import, so
// reassigning `chatState.chat = [...]` in a test would silently stop being visible to bookmarks.js.
// Same reasoning is why there's no per-test `selected_group` toggle here: it's a primitive, so it
// can't be live-mutated the way an array/object can - the group-chat-specific cases live in their
// own file (branch-nav-group.test.js) with `selected_group` baked in from that file's first import.
const chatState = { chat: [], chat_metadata: {} };
const openCharacterChatMock = jest.fn(async () => {});
const openGroupChatMock = jest.fn(async () => {});
const saveChatMock = jest.fn(async () => {});
const getCurrentCharacterMock = jest.fn(() => ({ avatar: 'char.png', name: 'Char', chat: 'current-chat' }));
const getCurrentChatDetailsMock = jest.fn(() => ({ sessionName: 'current-chat' }));
const groupsStoreMock = { get: jest.fn() };

/** Replaces the mocked chat array's contents in place, keeping its identity stable across tests. */
function setChat(messages) {
    chatState.chat.length = 0;
    chatState.chat.push(...messages);
}

/** Replaces the mocked chat_metadata object's contents in place, keeping its identity stable. */
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
    chat_metadata: chatState.chat_metadata,
    getRequestHeaders: jest.fn(() => ({})),
    getThumbnailUrl: jest.fn(),
    getCharacters: jest.fn(),
    chat: chatState.chat,
    saveChatConditional: jest.fn(),
    saveItemizedPrompts: jest.fn(),
    setActiveGroup: jest.fn(),
    getCurrentChatDetails: getCurrentChatDetailsMock,
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
// the branch-nav paths these tests cover).
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
    saveChatMock.mockClear().mockResolvedValue(undefined);
    // Default: no existing chats found (createBranch's getExistingChatNames call) / no fork data.
    // Individual tests override this when they need a specific fetch response.
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

describe('createBranch() - sibling data model', () => {
    test('keys the new sibling under the message\'s active swipe id, not a flat list', async () => {
        setChat([makeMessage({ swipe_id: 2 })]);

        const name = await bookmarks.createBranch(0);

        expect(name).toBe('current-chat - Branch #1');
        expect(chatState.chat[0].extra.branches).toEqual({ '2': ['current-chat - Branch #1'] });
    });

    test('forking a specific swipe id (not the active one) keys under that swipe, independently', async () => {
        setChat([makeMessage({ swipe_id: 0, branches: { '0': ['already-there - Branch #1'] } })]);
        chatState.chat[0].swipes = ['hello', 'alt swipe'];
        // getExistingChatNames() reads real chat files on disk (via this fetch), not extra.branches -
        // that's a name-collision check, separate from sibling tracking. Mocked here so the new
        // branch's auto-generated name realistically avoids the one that's already on disk.
        global.fetch.mockResolvedValue({ ok: true, json: async () => [{ file_name: 'current-chat - Branch #1.jsonl' }] });

        const name = await bookmarks.createBranch(0, { swipeId: 1 });

        expect(name).toBe('current-chat - Branch #2');
        // Swipe 0's sibling group is untouched; swipe 1 gets its own, independent group (#branch-nav
        // treats each (mesId, swipeId) as its own fork point, per the owner's tree framing).
        expect(chatState.chat[0].extra.branches).toEqual({
            '0': ['already-there - Branch #1'],
            '1': ['current-chat - Branch #2'],
        });
    });

    test('records the fork point (mesId + resolved swipeId) on the new branch\'s own metadata', async () => {
        setChat([makeMessage(), makeMessage({ swipe_id: 3 })]);

        await bookmarks.createBranch(1);

        expect(saveChatMock).toHaveBeenCalledTimes(1);
        const { withMetadata } = saveChatMock.mock.calls[0][0];
        expect(withMetadata.main_chat).toBe('current-chat');
        expect(withMetadata.fork_point).toEqual({ mesId: 1, swipeId: 3 });
    });

    test('appends to an existing sibling group instead of clobbering it', async () => {
        setChat([makeMessage({ swipe_id: 0, branches: { '0': ['first - Branch #1'] } })]);
        global.fetch.mockResolvedValue({ ok: true, json: async () => [{ file_name: 'current-chat - Branch #1.jsonl' }] });

        await bookmarks.createBranch(0);

        expect(chatState.chat[0].extra.branches['0']).toEqual(['first - Branch #1', 'current-chat - Branch #2']);
    });
});

describe('resolveForkRing()', () => {
    test('returns null for a message that was never forked', async () => {
        setChat([makeMessage()]);
        expect(await bookmarks.resolveForkRing(0, 0)).toBeNull();
    });

    test('origin chat: ring is [self, ...siblings] with selfIndex 0, no network fetch needed', async () => {
        setChat([makeMessage({ swipe_id: 0, branches: { '0': ['sib-a', 'sib-b'] } })]);

        const result = await bookmarks.resolveForkRing(0, 0);

        expect(result).toEqual({ ring: ['current-chat', 'sib-a', 'sib-b'], selfIndex: 0 });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('a different swipe id on the same message is a separate fork point with no siblings of its own', async () => {
        setChat([makeMessage({ swipe_id: 0, branches: { '0': ['sib-a'] } })]);
        expect(await bookmarks.resolveForkRing(0, 1)).toBeNull();
    });

    test('sibling branch: fetches the canonical list from the origin file and locates itself in it', async () => {
        setChat([makeMessage({ swipe_id: 0 })]);
        setChatMetadata({ main_chat: 'origin-chat', fork_point: { mesId: 0, swipeId: 0 } });
        getCurrentCharacterMock.mockReturnValue({ avatar: 'char.png', name: 'Char', chat: 'sib-a' });

        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => [
                { chat_metadata: {} }, // header row
                { name: 'Char', extra: { branches: { '0': ['sib-a', 'sib-b'] } } },
            ],
        });

        const result = await bookmarks.resolveForkRing(0, 0);

        expect(result).toEqual({ ring: ['origin-chat', 'sib-a', 'sib-b'], selfIndex: 1 });
        expect(global.fetch).toHaveBeenCalledWith('/api/chats/get', expect.objectContaining({
            body: JSON.stringify({ ch_name: 'Char', file_name: 'origin-chat', avatar_url: 'char.png' }),
        }));
    });

    test('sibling branch at a message that is not its own recorded fork point: no ring, no fetch', async () => {
        setChat([makeMessage(), makeMessage()]);
        setChatMetadata({ main_chat: 'origin-chat', fork_point: { mesId: 0, swipeId: 0 } });

        expect(await bookmarks.resolveForkRing(1, 0)).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

// Group-chat cases (selected_group truthy) live in branch-nav-group.test.js: `selected_group` is a
// primitive export snapshotted once at import, so it can't be toggled between tests in this file -
// see the note above chatState.

describe('branchSwipe()', () => {
    test('opens the next sibling in the ring', async () => {
        setChat([makeMessage({ swipe_id: 0, branches: { '0': ['sib-a', 'sib-b'] } })]);

        await bookmarks.branchSwipe(0, 1);

        expect(openCharacterChatMock).toHaveBeenCalledWith('sib-a');
    });

    test('wraps around past the last sibling back to the origin', async () => {
        setChat([makeMessage({ swipe_id: 0, branches: { '0': ['sib-a', 'sib-b'] } })]);

        await bookmarks.branchSwipe(0, -1);

        expect(openCharacterChatMock).toHaveBeenCalledWith('sib-b');
    });

    test('does nothing when the message has no sibling group', async () => {
        setChat([makeMessage()]);

        await bookmarks.branchSwipe(0, 1);

        expect(openCharacterChatMock).not.toHaveBeenCalled();
    });
});
