import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

const selectCharacterByAvatar = jest.fn(async () => {});
jest.unstable_mockModule('../public/script.js', () => ({ selectCharacterByAvatar }));

const {
    characters, charactersStore, resolveCharacterRef, resolveCharacterRefPair, CHARACTER_REF_MISMATCH, selectCharacterById,
    exposedCharacters, exposedGroups, setExposedGroupId, setCharacterId, onExposedEntitiesChange, holdCharacter,
} = await import('../public/scripts/character-store.js');
const { setGroups, rebuildGroupsStoreCore } = await import('../public/scripts/group-store.js');

const alpha = { avatar: 'alpha.png', name: 'Alpha' };
const digitStem = { avatar: '3.png', name: 'Digit stem' };
const gamma = { avatar: 'gamma.png', name: 'Gamma' };
const delta = { avatar: 'delta.png', name: 'Delta' };

/** A group whose members are the four characters, open by default, so upstream's indices 0-3 name them in order. */
const party = { id: 'party', name: 'Party', members: ['alpha.png', '3.png', 'gamma.png', 'delta.png'] };

/** @param {object[]} groupList */
function loadGroups(groupList) {
    setGroups(groupList);
    return rebuildGroupsStoreCore();
}

beforeEach(() => {
    setCharacterId(undefined);
    loadGroups([party]);
    setExposedGroupId('party');
    for (const character of [...characters]) {
        charactersStore.remove(character.avatar);
    }
    for (const character of [alpha, digitStem, gamma, delta]) {
        charactersStore.create(character);
    }
    selectCharacterByAvatar.mockClear();
});

describe('resolveCharacterRef', () => {
    test('a number is an index', () => {
        expect(resolveCharacterRef(0)).toBe(alpha);
        expect(resolveCharacterRef(2)).toBe(gamma);
    });

    test('a digit string is an index', () => {
        expect(resolveCharacterRef('0')).toBe(alpha);
        expect(resolveCharacterRef('3')).toBe(delta);
    });

    test('any other string is an avatar key', () => {
        expect(resolveCharacterRef('gamma.png')).toBe(gamma);
    });

    test('a digit-stem key is an avatar key, not an index', () => {
        expect(resolveCharacterRef('3.png')).toBe(digitStem);
    });

    test('an object resolves through its avatar', () => {
        expect(resolveCharacterRef({ avatar: 'gamma.png' })).toBe(gamma);
        expect(resolveCharacterRef(gamma)).toBe(gamma);
    });

    test('non-canonical index forms miss, as upstream\'s characters[ref] does', () => {
        expect(resolveCharacterRef(1.5)).toBeUndefined();
        expect(resolveCharacterRef('03')).toBeUndefined();
        expect(resolveCharacterRef(' 3')).toBeUndefined();
        expect(resolveCharacterRef('3.0')).toBeUndefined();
        expect(resolveCharacterRef('1.5')).toBeUndefined();
    });

    test('values upstream\'s characters[ref] hits on resolve to what upstream gets', () => {
        expect(resolveCharacterRef(-0)).toBe(alpha);
        expect(resolveCharacterRef([2])).toBe(gamma);
        expect(resolveCharacterRef(2n)).toBe(gamma);
        expect(resolveCharacterRef('length')).toBe(4);
    });

    test('a miss resolves to undefined', () => {
        expect(resolveCharacterRef(99)).toBeUndefined();
        expect(resolveCharacterRef('99')).toBeUndefined();
        expect(resolveCharacterRef(-1)).toBeUndefined();
        expect(resolveCharacterRef(Number.NaN)).toBeUndefined();
        expect(resolveCharacterRef(['gamma.png'])).toBeUndefined();
        expect(resolveCharacterRef('missing.png')).toBeUndefined();
        expect(resolveCharacterRef('')).toBeUndefined();
        expect(resolveCharacterRef({ avatar: 'missing.png' })).toBeUndefined();
        expect(resolveCharacterRef({ avatar: 1 })).toBeUndefined();
        expect(resolveCharacterRef({})).toBeUndefined();
        expect(resolveCharacterRef(null)).toBeUndefined();
        expect(resolveCharacterRef(undefined)).toBeUndefined();
        expect(resolveCharacterRef(true)).toBeUndefined();
    });
});

describe('resolveCharacterRefPair', () => {
    let warn;
    beforeEach(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        warn.mockRestore();
    });

    test('both forms naming the same character resolve to it without a warning', () => {
        expect(resolveCharacterRefPair(2, 'gamma.png')).toBe(gamma);
        expect(resolveCharacterRefPair('2', 'gamma.png')).toBe(gamma);
        expect(warn).not.toHaveBeenCalled();
    });

    test('forms naming different characters are a mismatch, with one warning naming both', () => {
        expect(resolveCharacterRefPair(0, 'gamma.png')).toBe(CHARACTER_REF_MISMATCH);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]).toEqual(expect.arrayContaining([0, 'gamma.png']));
    });

    test('one form missing while the other resolves is a mismatch, with one warning naming both', () => {
        expect(resolveCharacterRefPair(99, 'gamma.png')).toBe(CHARACTER_REF_MISMATCH);
        expect(resolveCharacterRefPair(2, 'missing.png')).toBe(CHARACTER_REF_MISMATCH);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[0]).toEqual(expect.arrayContaining([99, 'gamma.png']));
        expect(warn.mock.calls[1]).toEqual(expect.arrayContaining([2, 'missing.png']));
    });

    test('both forms missing is a mismatch, with one warning naming both', () => {
        expect(resolveCharacterRefPair(99, 'missing.png')).toBe(CHARACTER_REF_MISMATCH);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]).toEqual(expect.arrayContaining([99, 'missing.png']));
    });

    test('forms resolving to things that are not characters are a mismatch', () => {
        expect(resolveCharacterRefPair('length', 'map')).toBe(CHARACTER_REF_MISMATCH);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    test('the avatar form is never read as an index or an object', () => {
        expect(resolveCharacterRefPair(2, '2')).toBe(CHARACTER_REF_MISMATCH);
        expect(resolveCharacterRefPair(2, 2)).toBe(CHARACTER_REF_MISMATCH);
        expect(resolveCharacterRefPair(2, gamma)).toBe(CHARACTER_REF_MISMATCH);
        expect(resolveCharacterRefPair(2, null)).toBe(CHARACTER_REF_MISMATCH);
        expect(warn).toHaveBeenCalledTimes(4);
    });

    test('the upstream form accepts every resolveCharacterRef form', () => {
        expect(resolveCharacterRefPair('gamma.png', 'gamma.png')).toBe(gamma);
        expect(resolveCharacterRefPair(gamma, 'gamma.png')).toBe(gamma);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('selectCharacterById', () => {
    test('selects by index, digit string, avatar key and object', async () => {
        await selectCharacterById(2);
        await selectCharacterById('2', { switchMenu: false });
        await selectCharacterById('gamma.png');
        await selectCharacterById({ avatar: 'gamma.png' });
        expect(selectCharacterByAvatar.mock.calls).toEqual([
            ['gamma.png', { switchMenu: true }],
            ['gamma.png', { switchMenu: false }],
            ['gamma.png', { switchMenu: true }],
            ['gamma.png', { switchMenu: true }],
        ]);
    });

    test('an index that misses selects nothing', async () => {
        await selectCharacterById(99);
        await selectCharacterById('03');
        await selectCharacterById('length');
        expect(selectCharacterByAvatar).not.toHaveBeenCalled();
    });

    test('an avatar key the page does not hold is handed on, to be read from the server', async () => {
        await selectCharacterById('missing.png');
        expect(selectCharacterByAvatar.mock.calls).toEqual([['missing.png', { switchMenu: true }]]);
    });
});

describe('holdCharacter', () => {
    test('holds a full card, and refuses a shallow row', () => {
        const full = { avatar: 'full.png', name: 'Full', description: 'd', shallow: false };
        expect(holdCharacter(full)).toBe(full);
        expect(charactersStore.get('full.png')).toBe(full);

        expect(() => holdCharacter({ avatar: 'row.png', name: 'Row', shallow: true })).toThrow(TypeError);
        expect(charactersStore.has('row.png')).toBe(false);
        expect(() => setCharacterId({ avatar: 'row.png', name: 'Row', shallow: true })).toThrow(TypeError);
    });

    test('a character already held is kept as it is, even when handed its shallow row', () => {
        expect(holdCharacter({ avatar: 'gamma.png', name: 'Gamma', shallow: true })).toBe(gamma);
    });
});

describe('what extensions are shown', () => {
    test('nothing open shows no character and no group, and indices miss', () => {
        setExposedGroupId(null);
        expect(exposedCharacters).toEqual([]);
        expect(exposedGroups).toEqual([]);
        expect(resolveCharacterRef(0)).toBeUndefined();
        expect(resolveCharacterRef('length')).toBe(0);
    });

    test('the current character alone is shown at index 0; another held character is not, but its avatar still resolves', () => {
        setExposedGroupId(null);
        setCharacterId('gamma.png');
        expect(exposedCharacters).toEqual([gamma]);
        expect(exposedGroups).toEqual([]);
        expect(resolveCharacterRef(0)).toBe(gamma);
        expect(resolveCharacterRef(1)).toBeUndefined();
        expect(exposedCharacters.find(character => character.avatar === 'alpha.png')).toBeUndefined();
        expect(resolveCharacterRef('alpha.png')).toBe(alpha);
    });

    test('the open group is the only group shown, with its members in member order', () => {
        const other = { id: 'other', name: 'Other', members: ['gamma.png'] };
        loadGroups([party, other]);
        setExposedGroupId('party');
        expect(exposedGroups).toEqual([party]);
        expect(exposedCharacters).toEqual([alpha, digitStem, gamma, delta]);
    });

    test('a member the page does not hold is left out until it is held', () => {
        charactersStore.remove('delta.png');
        expect(exposedCharacters).toEqual([alpha, digitStem, gamma]);
        charactersStore.create(delta);
        expect(exposedCharacters).toEqual([alpha, digitStem, gamma, delta]);
    });

    test('the arrays are updated in place, so a kept reference stays current', () => {
        const kept = exposedCharacters;
        const keptGroups = exposedGroups;
        setExposedGroupId(null);
        setCharacterId('delta.png');
        expect(kept).toBe(exposedCharacters);
        expect(keptGroups).toBe(exposedGroups);
        expect(kept).toEqual([delta]);
        expect(keptGroups).toEqual([]);
    });

    test('a member change made through the groups store shows the new members', () => {
        const groupsStore = loadGroups([{ ...party }]);
        setExposedGroupId('party');
        groupsStore.update('party', { members: ['gamma.png'] });
        expect(exposedCharacters).toEqual([gamma]);
    });

    test('a rebuilt groups store is followed', async () => {
        const rebuiltParty = { ...party, members: ['delta.png'] };
        loadGroups([rebuiltParty]);
        await Promise.resolve();
        expect(exposedGroups).toEqual([rebuiltParty]);
        expect(exposedCharacters).toEqual([delta]);
    });

    test('listeners hear a change of what is shown, and only a change', () => {
        const listener = jest.fn();
        const unsubscribe = onExposedEntitiesChange(listener);
        setExposedGroupId('party');
        expect(listener).not.toHaveBeenCalled();
        setExposedGroupId(null);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        setCharacterId('alpha.png');
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
