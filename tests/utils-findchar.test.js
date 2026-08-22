import { describe, test, expect, jest, beforeEach, beforeAll } from '@jest/globals';

// utils.js (public/scripts/) pulls in script.js and a wide chunk of the client UI stack, none of which is
// safely importable in a plain node test env (jQuery/DOM assumptions throughout) - same problem
// character-repository.test.js and group-chats-residency.test.js solve by mocking at the module boundary.
// Only `findChar()`'s own dependencies (characters/charactersStore, getCurrentCharacter, groupsStore/
// selected_group, getTagsList) carry real-ish behavior below; everything else utils.js imports is an inert
// stand-in.

global.toastr = { warning: jest.fn(), error: jest.fn() };

const getCurrentCharacterMock = jest.fn(() => undefined);
const getTagsListMock = jest.fn(() => []);

/** @type {{avatar: string, name: string}[]} */
const characters = [];
/** @type {Map<string, {avatar: string, name: string}>} */
const charactersById = new Map();

// Same live-binding constraint tests/group-chats-residency.test.js documents: `characters` has to stay a single
// array reference, mutated in place per test, since jest's ESM module mocking doesn't expose a true live
// getter for a plain reassigned export.
const charactersStoreMock = {
    get: (id) => charactersById.get(id),
    has: (id) => charactersById.has(id),
    onChange: () => () => {},
};

jest.unstable_mockModule('../public/lib.js', () => ({
    moment: jest.fn(),
    DOMPurify: {},
    Readability: class {},
    isProbablyReaderable: jest.fn(),
    lodash: {},
}));

jest.unstable_mockModule('../public/script.js', () => ({
    animation_duration: 0,
    characters,
    charactersStore: charactersStoreMock,
    getCurrentCharacter: getCurrentCharacterMock,
    getRequestHeaders: jest.fn(),
    processDroppedFiles: jest.fn(),
    user_avatar: '',
}));

jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    isMobile: jest.fn(() => false),
}));

jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    collapseNewlines: jest.fn(x => x),
    power_user: {},
    personaStore: { get: jest.fn(), has: jest.fn(), onChange: jest.fn(() => () => {}) },
}));

jest.unstable_mockModule('../public/scripts/constants.js', () => ({
    debounce_timeout: { quick: 100 },
}));

jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: class {},
    POPUP_RESULT: {},
    POPUP_TYPE: {},
}));

jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandClosure.js', () => ({
    SlashCommandClosure: class {},
}));

jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    getTagsList: getTagsListMock,
}));

// `selected_group` stays null throughout - the group-member branch of findChar() wasn't reshaped by the phase 5
// residency pass (still an O(1) charactersStore lookup per member, same as before) and exercising it here would
// need the same live-binding workaround tests/group-chats-residency.test.js calls out for `characters`. What
// changed - tag-conjunction laziness, avatar-exact precedence, ambiguity warnings - lives entirely in the
// non-group path exercised below.
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    groupsStore: { get: jest.fn(), has: jest.fn(), onChange: jest.fn(() => () => {}) },
    selected_group: null,
}));

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    getCurrentLocale: jest.fn(() => 'en'),
    t: (strings, ...values) => strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), ''),
}));

jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    importWorldInfo: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/hash-utils.js', () => ({
    getStringHash: jest.fn(),
}));

/** @type {typeof import('../public/scripts/utils.js').findChar} */
let findChar;

beforeAll(async () => {
    ({ findChar } = await import('../public/scripts/utils.js'));
});

/** Replaces the resident character set + tag lookup for a test. */
function setCharacters(list, tagsByAvatar = {}) {
    characters.length = 0;
    characters.push(...list);
    charactersById.clear();
    list.forEach(c => charactersById.set(c.avatar, c));
    getTagsListMock.mockImplementation((avatar) => (tagsByAvatar[avatar] ?? []).map(name => ({ name })));
}

beforeEach(() => {
    jest.clearAllMocks();
    getCurrentCharacterMock.mockReturnValue(undefined);
    setCharacters([]);
});

describe('findChar() name/avatar resolution', () => {
    test('resolves by exact avatar, bypassing name matching entirely', () => {
        const alice = { avatar: 'alice.png', name: 'Not Alice At All' };
        setCharacters([alice]);

        expect(findChar({ name: 'alice.png', preferCurrentChar: false })).toBe(alice);
    });

    test('resolves avatar without the .png suffix', () => {
        const alice = { avatar: 'alice.png', name: 'Alice' };
        setCharacters([alice]);

        expect(findChar({ name: 'alice', preferCurrentChar: false })).toBe(alice);
    });

    test('avatar lookup is skipped when allowAvatar is false', () => {
        const alice = { avatar: 'bob.png', name: 'bob.png' };
        setCharacters([alice]);

        // name === 'bob.png' would resolve by avatar if allowed; with allowAvatar off it still resolves by
        // (case-insensitive) name match, since the character's display name happens to equal the string too.
        expect(findChar({ name: 'bob.png', allowAvatar: false, preferCurrentChar: false })).toBe(alice);
    });

    test('name matching is case- and accent-insensitive by default', () => {
        const zoe = { avatar: 'zoe.png', name: 'Zoé' };
        setCharacters([zoe]);

        expect(findChar({ name: 'ZOE', preferCurrentChar: false })).toBe(zoe);
    });

    test('insensitive: false requires an exact-case, exact-accent match', () => {
        const zoe = { avatar: 'zoe.png', name: 'Zoé' };
        setCharacters([zoe]);

        expect(findChar({ name: 'ZOE', insensitive: false, preferCurrentChar: false })).toBeNull();
        expect(findChar({ name: 'Zoé', insensitive: false, preferCurrentChar: false })).toBe(zoe);
    });

    test('warns (quiet=false) and returns the first match on ambiguous name matches', () => {
        const a = { avatar: 'a.png', name: 'Dup' };
        const b = { avatar: 'b.png', name: 'Dup' };
        setCharacters([a, b]);

        const result = findChar({ name: 'Dup', preferCurrentChar: false });
        expect(result).toBe(a);
        expect(global.toastr.warning).toHaveBeenCalledTimes(1);
    });

    test('quiet=true suppresses the toastr warning on ambiguity but still logs and returns first match', () => {
        const a = { avatar: 'a.png', name: 'Dup' };
        const b = { avatar: 'b.png', name: 'Dup' };
        setCharacters([a, b]);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = findChar({ name: 'Dup', preferCurrentChar: false, quiet: true });
        expect(result).toBe(a);
        expect(global.toastr.warning).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    test('returns null when nothing matches', () => {
        setCharacters([{ avatar: 'a.png', name: 'A' }]);
        expect(findChar({ name: 'nope', preferCurrentChar: false })).toBeNull();
    });
});

describe('findChar() tag conjunction (filteredByTags)', () => {
    test('only returns characters carrying every requested tag (AND, not OR)', () => {
        const both = { avatar: 'both.png', name: 'Both' };
        const oneTag = { avatar: 'one.png', name: 'One' };
        setCharacters([both, oneTag], {
            'both.png': ['red', 'round'],
            'one.png': ['red'],
        });

        expect(findChar({ filteredByTags: ['red', 'round'], preferCurrentChar: false })).toBe(both);
    });

    test('an avatar-exact match that fails the tag filter falls through instead of being returned', () => {
        const target = { avatar: 'target.png', name: 'Target' };
        setCharacters([target], { 'target.png': ['blue'] });

        // Exact avatar match exists, but it doesn't carry the required tag - must not be returned, and there's
        // no other candidate to fall back to.
        expect(findChar({ name: 'target.png', filteredByTags: ['red'], preferCurrentChar: false })).toBeNull();
    });

    test('tag filter composes with name matching', () => {
        const match = { avatar: 'match.png', name: 'Shared' };
        const wrongTag = { avatar: 'wrong.png', name: 'Shared' };
        setCharacters([match, wrongTag], {
            'match.png': ['red'],
            'wrong.png': ['blue'],
        });

        expect(findChar({ name: 'Shared', filteredByTags: ['red'], preferCurrentChar: false })).toBe(match);
    });

    test('does not consult tags at all when no tag filter is given (laziness)', () => {
        const alice = { avatar: 'alice.png', name: 'Alice' };
        setCharacters([alice]);

        findChar({ name: 'alice.png', preferCurrentChar: false });
        expect(getTagsListMock).not.toHaveBeenCalled();
    });

    test('an exact avatar hit resolves without scanning tags of every other resident character', () => {
        const target = { avatar: 'target.png', name: 'Target' };
        const decoy = { avatar: 'decoy.png', name: 'Decoy' };
        setCharacters([target, decoy], { 'target.png': ['red'], 'decoy.png': ['red'] });

        findChar({ name: 'target.png', filteredByTags: ['red'], preferCurrentChar: false });
        // Only the resolved candidate's tags get checked - the decoy is never consulted, because the avatar
        // match resolves the call before the name-scan fallback (which is what used to eagerly filter the
        // whole array) is ever reached.
        expect(getTagsListMock).toHaveBeenCalledTimes(1);
        expect(getTagsListMock).toHaveBeenCalledWith('target.png', false);
    });
});

describe('findChar() preferCurrentChar', () => {
    test('prefers the current character over other name matches when both match', () => {
        getCurrentCharacterMock.mockReturnValue({ avatar: 'current.png' });
        const current = { avatar: 'current.png', name: 'Shared' };
        const other = { avatar: 'other.png', name: 'Shared' };
        setCharacters([current, other]);

        expect(findChar({ name: 'Shared' })).toBe(current);
    });

    test('falls through to the general name scan when the current character does not match', () => {
        getCurrentCharacterMock.mockReturnValue({ avatar: 'current.png' });
        const current = { avatar: 'current.png', name: 'CurrentName' };
        const other = { avatar: 'other.png', name: 'OtherName' };
        setCharacters([current, other]);

        expect(findChar({ name: 'OtherName' })).toBe(other);
    });

    test('preferCurrentChar respects the tag filter too', () => {
        getCurrentCharacterMock.mockReturnValue({ avatar: 'current.png' });
        const current = { avatar: 'current.png', name: 'Shared' };
        const other = { avatar: 'other.png', name: 'Shared' };
        setCharacters([current, other], { 'current.png': ['blue'], 'other.png': ['red'] });

        // Current char doesn't carry the required tag, so it must not win by preference - the tagged match wins.
        expect(findChar({ name: 'Shared', filteredByTags: ['red'] })).toBe(other);
    });
});
