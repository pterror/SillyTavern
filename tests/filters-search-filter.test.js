import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

// FilterHelper.searchFilter matches characters and groups with the browser's fuzzy search (or a substring match with
// fuzzy search off) over the rows it's given, whatever the filter's search or fav state. It is what the upstream
// getEntitiesList({ doFilter: true }) runs over the page on screen.

const powerUser = { fuzzy_search: true };
const fuzzyCalls = [];
// What the mocked fuzzy searches search: they match names holding the term, case-insensitively.
let residentCharacters = [];
let residentGroups = [];

function fuzzyMatch(items, term) {
    return items
        .filter(item => item.name.toLowerCase().includes(term.toLowerCase()))
        .map((item, index) => ({ item, score: index / 10 }));
}

jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: powerUser,
    fuzzySearchCharacters: (term) => { fuzzyCalls.push(['characters', term]); return fuzzyMatch(residentCharacters, term); },
    fuzzySearchGroups: (term) => { fuzzyCalls.push(['groups', term]); return fuzzyMatch(residentGroups, term); },
    fuzzySearchTags: () => [],
    fuzzySearchPersonas: () => [],
    fuzzySearchWorldInfo: () => [],
}));
jest.unstable_mockModule('../public/scripts/tags.js', () => ({ isTagAssignedToKey: () => false }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    includesIgnoreCaseAndAccents: (text, term) => String(text ?? '').toLowerCase().includes(String(term).toLowerCase()),
}));

/** @type {typeof import('../public/scripts/filters.js')} */
let filters;

beforeAll(async () => {
    filters = await import('../public/scripts/filters.js');
});

const anna = { avatar: 'anna.png', name: 'Anna' };
const annabel = { avatar: 'annabel.png', name: 'Annabel' };
const bo = { avatar: 'bo.png', name: 'Bo' };
const annaGroup = { id: 'g-anna', name: 'Anna Group' };
const boGroup = { id: 'g-bo', name: 'Bo Group' };

const page = [
    { type: 'character', id: anna.avatar, item: anna },
    { type: 'character', id: bo.avatar, item: bo },
    { type: 'group', id: annaGroup.id, item: annaGroup },
    { type: 'group', id: boGroup.id, item: boGroup },
];

beforeEach(() => {
    fuzzyCalls.length = 0;
    powerUser.fuzzy_search = true;
    residentCharacters = [anna, annabel, bo];
    residentGroups = [annaGroup, boGroup];
});

describe('FilterHelper.searchFilter', () => {
    test('has no server rank map to take matches from', () => {
        const helper = new filters.FilterHelper(() => {});
        expect(helper).not.toHaveProperty('serverSearchResults');
        expect(helper).not.toHaveProperty('setServerSearchResults');
        expect(helper).not.toHaveProperty('usesServerSearchResults');
    });

    test('with fuzzy search on, keeps the rows the browser fuzzy search matches, in their order', () => {
        const helper = new filters.FilterHelper(() => {});
        helper.setFilterData(filters.FILTER_TYPES.SEARCH, 'anna', true);

        const result = helper.searchFilter(page);

        expect(result.map(entity => `${entity.type}.${entity.id}`)).toEqual(['character.anna.png', 'group.g-anna']);
        expect(fuzzyCalls).toEqual([['characters', 'anna'], ['groups', 'anna']]);
    });

    test('with the fav filter selected, still runs the browser fuzzy search', () => {
        const helper = new filters.FilterHelper(() => {});
        helper.setFilterData(filters.FILTER_TYPES.FAV, filters.FILTER_STATES.SELECTED.key, true);
        helper.setFilterData(filters.FILTER_TYPES.SEARCH, 'bo', true);

        const result = helper.searchFilter(page);

        expect(result.map(entity => `${entity.type}.${entity.id}`)).toEqual(['character.bo.png', 'group.g-bo']);
        expect(fuzzyCalls).toEqual([['characters', 'bo'], ['groups', 'bo']]);
    });

    test('keeps only rows it was given: a fuzzy match not on the page is not added', () => {
        const helper = new filters.FilterHelper(() => {});
        helper.setFilterData(filters.FILTER_TYPES.SEARCH, 'annabel', true);

        expect(helper.searchFilter(page)).toEqual([]);
    });

    test('with fuzzy search off, matches names by substring without the fuzzy search', () => {
        powerUser.fuzzy_search = false;
        const helper = new filters.FilterHelper(() => {});
        helper.setFilterData(filters.FILTER_TYPES.SEARCH, 'group', true);

        const result = helper.searchFilter(page);

        expect(result.map(entity => `${entity.type}.${entity.id}`)).toEqual(['group.g-anna', 'group.g-bo']);
        expect(fuzzyCalls).toEqual([]);
    });

    test('with no search term, returns the rows as given', () => {
        const helper = new filters.FilterHelper(() => {});
        expect(helper.searchFilter(page)).toBe(page);
        expect(fuzzyCalls).toEqual([]);
    });
});
