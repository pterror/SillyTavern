import { describe, test, expect, beforeEach } from '@jest/globals';

import { clearMergedTags, mergedTagTarget, shownTagIds, tagReadDrops, takeInMergedTags } from '../public/scripts/tag-merges.js';

beforeEach(() => clearMergedTags());

describe('a merged tag id on the page', () => {
    test('draws as its target, once next to the target itself', () => {
        takeInMergedTags({ x: 'y', old: 'y' });
        expect(shownTagIds(['x', 'z'])).toEqual([{ id: 'x', shownId: 'y' }, { id: 'z', shownId: 'z' }]);
        expect(shownTagIds(['x', 'y', 'old']).map(t => t.shownId)).toEqual(['y']);
        expect(mergedTagTarget('z')).toBe('z');
    });

    test('a tag read replaces a held merged tag with its target and drops a gone one, as the change feed does', () => {
        expect(tagReadDrops({ tags: [], gone: ['d'], merged: { x: 'y' } })).toEqual([{ id: 'd' }, { id: 'x', replaceWithId: 'y' }]);
        expect(tagReadDrops({ tags: [], gone: [] })).toEqual([]);
    });

    test('a saved filter on a merged id is moved to its target: the read names its replacement, not a removal', () => {
        const drops = new Map(tagReadDrops({ gone: [], merged: { x: 'y' } }).map(drop => [drop.id, drop.replaceWithId]));
        expect(drops.get('x')).toBe('y');
    });

    test('a read without merges keeps nothing as merged', () => {
        takeInMergedTags(undefined);
        takeInMergedTags({ a: 7, b: 'b' });
        expect(shownTagIds(['a', 'b']).map(t => t.shownId)).toEqual(['a', 'b']);
    });
});
