import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_PAGE_SIZE, listSource, pageAnswer, pageHash, parsePageRequest } from './catalog-page.js';

test('a request\'s page fields: page size clamped, cursor, distinct ids, trimmed search', () => {
    assert.deepEqual(parsePageRequest({}), { request: { pageSize: 50, cursor: null, ids: undefined, search: undefined, ifHash: undefined } });
    assert.equal(/** @type {any} */ (parsePageRequest({ pageSize: 10_000 })).request.pageSize, MAX_PAGE_SIZE);
    assert.equal(/** @type {any} */ (parsePageRequest({ pageSize: 0 })).request.pageSize, 50);
    assert.equal(/** @type {any} */ (parsePageRequest({ pageSize: 7.9 }, { defaultPageSize: 20 })).request.pageSize, 7);
    assert.deepEqual(/** @type {any} */ (parsePageRequest({ filter: { ids: ['a', 'a', 'b'], search: '  x ' }, cursor: 'c' })).request,
        { pageSize: 50, cursor: 'c', ids: ['a', 'b'], search: 'x', ifHash: undefined });
});

test('malformed page fields are refused with a reason', () => {
    assert.deepEqual(parsePageRequest({ ifHash: 1 }), { reason: 'invalid-if-hash' });
    assert.deepEqual(parsePageRequest({ cursor: 3 }), { reason: 'invalid-cursor' });
    assert.deepEqual(parsePageRequest({ filter: { search: [] } }), { reason: 'invalid-search' });
    assert.equal(/** @type {any} */ (parsePageRequest({ filter: { ids: [1] } })).reason, 'invalid-ids');
    assert.equal(/** @type {any} */ (parsePageRequest({ filter: { ids: ['a', 'b', 'c'] } }, { maxIds: 2 })).reason, 'too-many-ids');
});

test('the hash is of canonical JSON, so key order doesn\'t change it; a current copy gets only the hash', () => {
    const page = { rows: [{ b: 1, a: 2 }], cursor: null };
    assert.equal(pageHash(page), pageHash({ cursor: null, rows: [{ a: 2, b: 1 }] }));
    assert.deepEqual(pageAnswer(page, undefined), page);
    const hash = pageHash(page);
    assert.deepEqual(pageAnswer(page, ''), { ...page, hash });
    assert.deepEqual(pageAnswer(page, hash), { unchanged: true, hash });
});

test('a list source pages by key, filters by ids and by a prefix of the name ignoring case and accents', async () => {
    const rows = ['delta', 'Alpha', 'Écho', 'bravo', 'charlie'].map(name => ({ key: name.toLowerCase(), name }));
    const source = listSource(rows, row => row.key, row => row.name);
    const request = { pageSize: 2, cursor: null, ids: undefined, search: undefined, ifHash: undefined };
    const first = await source.query(request, {});
    assert.deepEqual(first, { rows: [rows[1], rows[3]], cursor: 'bravo' });
    const second = await source.query({ ...request, cursor: first.cursor }, {});
    assert.deepEqual(second, { rows: [rows[4], rows[0]], cursor: 'delta' });
    assert.deepEqual(await source.query({ ...request, cursor: 'delta' }, {}), { rows: [rows[2]], cursor: null });
    assert.deepEqual(await source.query({ ...request, search: 'ech' }, {}), { rows: [rows[2]], cursor: null });
    assert.deepEqual(await source.query({ ...request, ids: ['delta', 'nope'] }, {}), { rows: [rows[0]], cursor: null });
    // A cursor past every key is the end.
    assert.deepEqual(await source.query({ ...request, cursor: '\uffff' }, {}), { rows: [], cursor: null });
});
