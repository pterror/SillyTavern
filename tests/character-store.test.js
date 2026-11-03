import { describe, test, expect, jest, beforeEach } from '@jest/globals';

const { characters, charactersStore, setOpenGroupId, setCharacterId, holdCharacter, keepHeldCharacters } = await import('../public/scripts/character-store.js');
const { groups, groupsStore, keepHeldGroups } = await import('../public/scripts/group-store.js');
keepHeldGroups(() => groups.map(group => group.id));

const alpha = { avatar: 'alpha.png', name: 'Alpha' };
const gamma = { avatar: 'gamma.png', name: 'Gamma' };
const delta = { avatar: 'delta.png', name: 'Delta' };

const pair = { id: 'pair', name: 'Pair', members: ['alpha.png', 'gamma.png'] };

beforeEach(() => {
    setCharacterId(undefined);
    setOpenGroupId(null);
    for (const group of [...groups]) groupsStore.remove(group.id);
    groupsStore.create(pair);
    for (const character of [...characters]) {
        charactersStore.remove(character.avatar);
    }
    for (const character of [alpha, gamma, delta]) {
        charactersStore.create(character);
    }
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

describe('what the page keeps holding', () => {
    test('the open character and the open group\'s members are kept; the others are let go', () => {
        jest.useFakeTimers();
        try {
            setOpenGroupId('pair');
            setCharacterId('delta.png');
            jest.advanceTimersByTime(5000);
            expect(characters.map(character => character.avatar).sort()).toEqual(['alpha.png', 'delta.png', 'gamma.png']);

            setOpenGroupId(null);
            jest.advanceTimersByTime(5000);
            expect(characters.map(character => character.avatar)).toEqual(['delta.png']);
        } finally {
            jest.useRealTimers();
        }
    });

    test('a keeper keeps the characters it names', () => {
        jest.useFakeTimers();
        const stop = keepHeldCharacters(() => ['gamma.png']);
        try {
            setCharacterId('alpha.png');
            jest.advanceTimersByTime(5000);
            expect(characters.map(character => character.avatar).sort()).toEqual(['alpha.png', 'gamma.png']);
        } finally {
            stop();
            jest.useRealTimers();
        }
    });
});
