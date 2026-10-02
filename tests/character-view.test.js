import { describe, test, expect } from '@jest/globals';
import { canonicalSearchField, parseSearchText, sameView, serializeSearchText, viewToQueryState } from '../public/scripts/character-view.js';

/** @returns {import('../public/scripts/character-view.js').CharacterView} */
function view(overrides = {}) {
    return {
        text: '',
        conditions: [],
        tags: { include: [], exclude: [] },
        fav: undefined,
        group: undefined,
        sort: { field: 'name', order: 'asc' },
        folderCase: null,
        ...overrides,
    };
}

describe('character view', () => {
    test('aliases name their canonical field, and unknown labels name none', () => {
        expect(canonicalSearchField('by')).toBe('creator');
        expect(canonicalSearchField('Author')).toBe('creator');
        expect(canonicalSearchField('desc')).toBe('description');
        expect(canonicalSearchField('members')).toBe('member');
        expect(canonicalSearchField('http')).toBeNull();
    });

    test('a search string splits into conditions and free text the way the server reads it', () => {
        expect(parseSearchText('vampire by:alice -tag:"slow burn" http://x.y castle')).toEqual({
            text: 'vampire http://x.y castle',
            conditions: [
                { field: 'creator', op: 'contains', value: 'alice' },
                { field: 'tag', op: 'not_contains', value: '"slow burn"' },
            ],
        });
        expect(parseSearchText('   ')).toEqual({ text: '', conditions: [] });
    });

    test('a view written out and read back is the same view', () => {
        const written = serializeSearchText({
            text: 'castle',
            conditions: [{ field: 'creator', op: 'contains', value: 'alice' }, { field: 'name', op: 'not_contains', value: 'bob' }],
        });
        expect(written).toBe('creator:alice -name:bob castle');
        expect(parseSearchText(written)).toEqual({
            text: 'castle',
            conditions: [{ field: 'creator', op: 'contains', value: 'alice' }, { field: 'name', op: 'not_contains', value: 'bob' }],
        });
    });

    test('an empty condition sends nothing', () => {
        expect(serializeSearchText({ text: '', conditions: [{ field: 'name', op: 'contains', value: '  ' }] })).toBe('');
    });

    test('the request carries the search, tags, fav, group and sort, and the seed only for random', () => {
        const state = viewToQueryState(view({
            text: 'castle',
            conditions: [{ field: 'creator', op: 'contains', value: 'alice' }],
            tags: { include: ['t1'], exclude: ['t2'] },
            fav: true,
            group: false,
            sort: { field: 'date_added', order: 'desc' },
        }), { includeGroups: true });
        expect(state).toEqual({
            searchTerm: 'creator:alice castle',
            tagsInclude: ['t1'],
            tagsExclude: ['t2'],
            fav: true,
            sortField: 'date_added',
            sortOrder: 'desc',
            randomSeed: undefined,
            includeGroups: true,
            group: false,
        });
        expect(viewToQueryState(view({ sort: { field: 'random', order: 'asc', seed: 42 } })).randomSeed).toBe(42);
    });

    test('views are the same list regardless of how they are spelled', () => {
        const a = view({ text: 'castle', conditions: [{ field: 'creator', op: 'contains', value: 'alice' }], tags: { include: ['b', 'a'], exclude: [] } });
        const b = view({ ...parseSearchText('creator:alice castle'), tags: { include: ['a', 'b'], exclude: [] } });
        expect(sameView(a, b)).toBe(true);
        expect(sameView(a, view({ ...a, fav: true }))).toBe(false);
    });
});
