import assert from 'node:assert/strict';
import { test } from 'node:test';

import { entityAsOf, mergeEntry, unmerged } from './entry-merge.js';

test('each field takes the side that changed it, nested fields one by one', () => {
    const base = { comment: 'Ilse', depth: 4, characterFilter: { isExclude: false, names: [], tags: [] } };
    const mine = { ...base, depth: 2, characterFilter: { ...base.characterFilter, isExclude: true } };
    const theirs = { ...base, comment: 'Ilse Varro', characterFilter: { ...base.characterFilter, tags: ['t'] } };
    assert.deepEqual(mergeEntry(base, mine, theirs), {
        merged: { comment: 'Ilse Varro', depth: 2, characterFilter: { isExclude: true, names: [], tags: ['t'] } },
    });
});

test('lists of names take both sides\' additions and removals; a field both set differently is a conflict', () => {
    const base = { key: ['a', 'b', 'c'], depth: 4 };
    assert.deepEqual(mergeEntry(base, { ...base, key: ['a', 'x', 'b', 'c'] }, { ...base, key: ['a', 'c', 'y'] }), {
        merged: { key: ['a', 'x', 'c', 'y'], depth: 4 },
    });
    assert.deepEqual(mergeEntry(base, { ...base, depth: 1 }, { ...base, depth: 1 }), { merged: { ...base, depth: 1 } }, 'both made the same change');
    assert.deepEqual(mergeEntry(base, { ...base, depth: 1 }, { ...base, depth: 2 }), {
        conflicts: [{ field: 'depth', base: 4, mine: 1, theirs: 2, merged: null }],
    });
});

test('text both changed merges where the changes are apart; else the conflict holds both texts laid together', () => {
    const base = { content: 'one two three' };
    assert.deepEqual(mergeEntry(base, { content: 'One two three' }, { content: 'one two Three' }), { merged: { content: 'One two Three' } });
    assert.deepEqual(mergeEntry(base, { content: 'one 2 three' }, { content: 'one II three' }), {
        conflicts: [{ field: 'content', base: 'one two three', mine: 'one 2 three', theirs: 'one II three', merged: 'one II2 three' }],
    });
    assert.deepEqual(mergeEntry({}, { comment: 'mine' }, { comment: 'theirs' }).conflicts?.[0]?.field, 'comment', 'a title neither had');
});

test('without the earlier version, every field the edit changes is a conflict', () => {
    assert.deepEqual(unmerged({ content: 'b', depth: 4 }, { content: 'a', depth: 4 }), [{ field: 'content', base: undefined, mine: 'b', theirs: 'a', merged: 'b' }]);
});

test('the entity as of an earlier version puts back each value and place changed since, or none when one is unknown', () => {
    const entity = /** @type {import('../entity-values.js').StoredEntity} */ ({
        id: 1n, type: 0, key: '1:0', added: 0, version: 9n, fav: false, tags: [], hashes: [],
        values: [{ field: 104, text: 'now' }, { field: 7, json: '2' }, { field: 1024, text: 'new key' }],
        items: [{ list: 0, item: 0, position: 10 }, { list: 0, item: 1, position: 20 }],
    });
    const was = entityAsOf(entity, [
        { field: 104, value: { json: false, value: 'then' }, unknown: false },
        { field: 7, value: null, unknown: false },
        { field: 1024, value: null, list: 0, item: 1, place: null, unknown: false },
        { field: 2048, value: { json: false, value: 'old key' }, list: 0, item: 2, place: 5, unknown: false },
    ]);
    assert.deepEqual(was?.values, [{ field: 104, text: 'then' }, { field: 2048, text: 'old key' }]);
    assert.deepEqual(was?.items, [{ list: 0, item: 2, position: 5 }, { list: 0, item: 0, position: 10 }]);
    assert.equal(entityAsOf(entity, [{ field: 104, unknown: true }]), null);
});
