import { describe, test, expect } from '@jest/globals';
import tantivy from '@oxdev03/node-tantivy-binding';

import { buildSchema, buildSearchQuery, runSearch, DATA_FIELD, FAV_FIELD, fastFieldOrderValue, mergeSortedWindow } from '../src/endpoints/tantivy-search.js';

// Exercises buildSchema()/buildSearchQuery()/runSearch() against a real in-memory tantivy index, not a mock -
// this module's whole reason to exist is a handful of confirmed-by-direct-testing behaviors (prefix matching
// needs regexQuery, not the query-string parser's `*`; booleanQuery needs {occur, query} objects, not tuples)
// that a mock would happily let regress silently.

const FIELD_WEIGHTS = { name: 20, tags: 10 };
const FIELD_LABELS = { name: ['name'], tag: ['tags'], tags: ['tags'] };

function makeIndex(docs) {
    const schema = buildSchema(tantivy, ['name', 'tags']);
    const index = new tantivy.Index(schema);
    const writer = index.writer();
    for (const doc of docs) {
        writer.addDocument(tantivy.Document.fromDict({
            name: doc.name ?? '',
            tags: doc.tags ?? '',
            [DATA_FIELD]: JSON.stringify(doc),
            [FAV_FIELD]: Boolean(doc.fav),
        }, schema));
    }
    writer.commit();
    index.reload();
    return { index, schema };
}

function names(index, schema, term, maxRows = 10, options = {}) {
    const query = buildSearchQuery(tantivy, schema, term, FIELD_WEIGHTS, FIELD_LABELS, options);
    if (!query) {
        return { names: [], total: 0 };
    }
    const { results, total } = runSearch(index, query, maxRows);
    // runSearch() no longer parses DATA_FIELD itself (characters-search-index.js's slim id-only payload has
    // nothing to parse) - this test's own index still stores the full JSON doc there (matching
    // groups-search-index.js's unchanged behavior), so this helper parses it back itself.
    return { names: results.map(r => JSON.parse(r.raw).name), total };
}

describe('tantivy-search.js', () => {
    const docs = [
        { name: 'Vampire Lord', tags: 'gothic romance' },
        { name: 'Vampire Hunter', tags: 'action' },
        { name: 'Werewolf Lord', tags: 'gothic' },
        { name: 'Sunny Bard', tags: 'cheerful' },
    ];
    const { index, schema } = makeIndex(docs);

    test('buildSearchQuery() returns null for an empty search term', () => {
        expect(buildSearchQuery(tantivy, schema, '', FIELD_WEIGHTS, FIELD_LABELS)).toBeNull();
        expect(buildSearchQuery(tantivy, schema, '   ', FIELD_WEIGHTS, FIELD_LABELS)).toBeNull();
    });

    test('a partial word prefix-matches, not just a full word (the bug this module exists to fix)', () => {
        const { names: matched } = names(index, schema, 'vamp');
        expect(matched.sort()).toEqual(['Vampire Hunter', 'Vampire Lord']);
    });

    test('a non-prefix substring does NOT match (regexQuery matches whole tokens, not "contains")', () => {
        const { names: matched } = names(index, schema, 'amp');
        expect(matched).toEqual([]);
    });

    test('multiple bare words AND-combine across the default field set', () => {
        const { names: matched } = names(index, schema, 'vamp lord');
        expect(matched).toEqual(['Vampire Lord']);
    });

    test('prefix matching is case-insensitive', () => {
        const { names: matched } = names(index, schema, 'VAMP');
        expect(matched.sort()).toEqual(['Vampire Hunter', 'Vampire Lord']);
    });

    test('a label:value token scopes matching to just that field - a later bare word is unaffected', () => {
        // No doc has "bard" in its name or tags alongside a name starting with "vamp", so this should match
        // nothing - it also confirms name:vamp doesn't accidentally leak into matching "bard" against name too.
        expect(names(index, schema, 'name:vamp bard').names).toEqual([]);
        // Sanity: dropping the second word finds the same two vampire docs the bare-word test above found.
        expect(names(index, schema, 'name:vamp').names.sort()).toEqual(['Vampire Hunter', 'Vampire Lord']);
    });

    test('the tag: label scopes to the tags field only, not name', () => {
        const { names: matched } = names(index, schema, 'tag:gothic');
        expect(matched.sort()).toEqual(['Vampire Lord', 'Werewolf Lord']);
    });

    test('a regex metacharacter in the search term is escaped, not interpreted as a pattern', () => {
        expect(() => names(index, schema, 'vamp(1')).not.toThrow();
        expect(names(index, schema, 'vamp(1').names).toEqual([]);
    });

    test('runSearch() returns the true total independent of a smaller maxRows/limit', () => {
        const query = buildSearchQuery(tantivy, schema, 'lord', FIELD_WEIGHTS, FIELD_LABELS);
        const { results, total } = runSearch(index, query, 1);
        expect(total).toBe(2);
        expect(results).toHaveLength(1);
    });

    test('results are sorted ascending-by-score (lower is better), matching the SQLite tier\'s bm25 convention', () => {
        // "Vampire Lord" matches both "vampire" and "lord" (double weight); "Vampire Hunter"/"Werewolf Lord" only
        // match one term each - Vampire Lord's more-negative (better) score must sort first.
        const query = buildSearchQuery(tantivy, schema, 'vampire lord werewolf', FIELD_WEIGHTS, FIELD_LABELS);
        const { results } = runSearch(index, query, 10);
        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].score).toBeLessThanOrEqual(results[i].score);
        }
    });

    test('the stored data field round-trips the full original document, not just the indexed fields', () => {
        const query = buildSearchQuery(tantivy, schema, 'sunny', FIELD_WEIGHTS, FIELD_LABELS);
        const { results: hits } = runSearch(index, query, 10);
        expect(hits).toHaveLength(1);
        expect(JSON.parse(hits[0].raw)).toEqual(docs[3]);
    });

    test('a negated label:value token (-tag:foo) excludes matching docs instead of matching on them', () => {
        // Without negation, tag:gothic matches Vampire Lord and Werewolf Lord (see the test above). Negating it
        // should invert that: everything EXCEPT those two.
        const { names: matched } = names(index, schema, '-tag:gothic');
        expect(matched.sort()).toEqual(['Sunny Bard', 'Vampire Hunter']);
    });

    test('negation is general to any recognized label, not special-cased to tag:', () => {
        const { names: matched } = names(index, schema, '-name:vamp');
        expect(matched.sort()).toEqual(['Sunny Bard', 'Werewolf Lord']);
    });

    test('a normal (non-negated) query is unaffected by negation support existing', () => {
        const { names: matched } = names(index, schema, 'tag:gothic');
        expect(matched.sort()).toEqual(['Vampire Lord', 'Werewolf Lord']);
    });

    test('negation combines with a positive term: AND-must the positive, AND-exclude the negative', () => {
        // "lord" alone matches Vampire Lord + Werewolf Lord; excluding tag:romance should drop Vampire Lord
        // (whose tags include "romance"), leaving only Werewolf Lord.
        const { names: matched } = names(index, schema, 'lord -tag:romance');
        expect(matched).toEqual(['Werewolf Lord']);
    });

    test('negating a label:value that matches nothing excludes nothing - all docs still match', () => {
        const { names: matched } = names(index, schema, '-tag:nonexistentzzz');
        expect(matched.sort()).toEqual(['Sunny Bard', 'Vampire Hunter', 'Vampire Lord', 'Werewolf Lord']);
    });

    test('a query made entirely of negated tokens still matches (falls back to allQuery as the positive base)', () => {
        const { names: matched } = names(index, schema, '-tag:gothic -tag:cheerful');
        expect(matched.sort()).toEqual(['Vampire Hunter']);
    });

    test('a double leading dash (--tag:foo) is not parsed as a label filter at all (regex requires exactly one)', () => {
        // parseLabeledToken()'s regex only captures a single optional leading '-', so "--tag:foo" doesn't match
        // the label pattern and falls through to a bare-word search instead - it should not throw, and should
        // find nothing since no doc's searchable fields contain the literal text "--tag:foo".
        expect(() => names(index, schema, '--tag:gothic')).not.toThrow();
        expect(names(index, schema, '--tag:gothic').names).toEqual([]);
    });

    test('an unrecognized label negated (-nope:foo) is not a filter and is not silently dropped', () => {
        // "nope" isn't in FIELD_LABELS, so parseLabeledToken() returns null and this whole token falls back to a
        // bare-word search across the default field set - it should not silently vanish from the query.
        expect(names(index, schema, '-nope:gothic').names).toEqual([]);
    });
});

// Real bug this covers: characters.js's /api/characters/all search branch caps results at `maxRows` by text
// relevance alone (unbounded fetch is a documented OOM risk - see characters-search-index.js's querySqliteIndex()
// doc comment), so a client combining "favorites only" with a search term used to get whatever survived that
// relevance cap silently narrowed further by fav - which can easily be nothing at all, on a library where
// favorite status has no correlation with which docs rank best for a common term. `favOnly` fixes this by making
// the fav restriction part of the query itself, so it applies *before* the cap, not after.
describe('tantivy-search.js: favOnly restricts matches before maxRows caps them (not after)', () => {
    // Every doc matches "lord" by BM25_WEIGHTS-equivalent fields, but the two non-favorited docs match it via the
    // higher-weighted `name` field while the only favorited doc matches it solely via the lower-weighted `tags`
    // field - guaranteeing it ranks worse than both, deterministically, regardless of BM25 length normalization.
    // That's the exact shape of the reported bug: a maxRows cap of 1 returns only the top-ranked non-favorited
    // doc, and a naive post-filter over that page would find zero favorites even though one genuinely matches.
    const docs = [
        { name: 'Lord Vampire', tags: 'gothic', fav: false },
        { name: 'Lord Skeleton', tags: 'undead', fav: false },
        { name: 'Werewolf', tags: 'lord', fav: true },
    ];
    const { index, schema } = makeIndex(docs);

    test('without favOnly, a small maxRows cap can exclude the only favorited match entirely', () => {
        const { names: matched } = names(index, schema, 'lord', 1);
        expect(matched).toEqual(expect.arrayContaining([expect.stringMatching(/^Lord /)]));
        expect(matched).not.toContain('Werewolf');
    });

    test('favOnly restricts to favorited docs regardless of relevance rank, even under the same small maxRows', () => {
        const { names: matched, total } = names(index, schema, 'lord', 1, { favOnly: true });
        expect(matched).toEqual(['Werewolf']);
        expect(total).toBe(1);
    });

    test('favOnly with no favorited matches returns nothing, not an unfiltered fallback', () => {
        const { names: matched, total } = names(index, schema, 'skeleton', 10, { favOnly: true });
        expect(matched).toEqual([]);
        expect(total).toBe(0);
    });
});

describe('tantivy-search.js: fast-field sort order values', () => {
    const values = [0, 5, 1727000000000, 2 ** 48 + 123456789012, 2 ** 49 + 7, 2 ** 49 + 7, 2 ** 49 + 4100];

    function makeSortIndex() {
        const schema = buildSchema(tantivy, ['name'], ['k']);
        const index = new tantivy.Index(schema);
        const writer = index.writer();
        values.forEach((k, i) => writer.addDocument(tantivy.Document.fromDict({ name: 'doc', k, [DATA_FIELD]: `id${i}`, [FAV_FIELD]: false }, schema)));
        writer.commit();
        index.reload();
        return { index, schema };
    }

    test.each(['asc', 'desc'])('fastFieldOrderValue() equals the order tantivy reports on each hit (%s)', (order) => {
        const { index, schema } = makeSortIndex();
        const query = buildSearchQuery(tantivy, schema, 'doc', { name: 1 }, { name: ['name'] });
        const { results } = runSearch(index, query, 100, { orderByField: 'k', order, count: false });
        expect(results).toHaveLength(values.length);
        for (const r of results) {
            expect(r.order).toBe(fastFieldOrderValue(values[Number(r.raw.slice(2))], order));
        }
        const orders = results.map(r => r.order);
        expect(orders).toEqual([...orders].sort((a, b) => b - a));
    });
});

describe('tantivy-search.js: mergeSortedWindow()', () => {
    /** Reference: the whole merged list, characters before groups on equal order. */
    function fullMerge(chars, groups) {
        const all = [
            ...chars.map((c, i) => ({ type: 'character', id: c.id, order: c.order, t: 0, i })),
            ...groups.map((g, i) => ({ type: 'group', id: g.id, order: g.order, t: 1, i })),
        ];
        all.sort((a, b) => b.order - a.order || a.t - b.t || a.i - b.i);
        return all.map(({ type, id }) => ({ type, id }));
    }

    function windowFor(chars, groups, offset, count) {
        const charStart = Math.max(0, offset - groups.length);
        const limit = offset + count - charStart;
        const slice = chars.slice(charStart, charStart + limit);
        if (slice.length === 0 && charStart > 0) {
            return chars.length > 0
                ? { chars: chars.slice(-1), charStart: chars.length - 1, charsExhausted: true }
                : { chars: [], charStart: 0, charsExhausted: true };
        }
        return { chars: slice, charStart, charsExhausted: slice.length < limit };
    }

    const cases = {
        'groups interleaved': {
            chars: [100, 90, 90, 80, 70, 60, 50, 40, 30, 20, 10].map((order, i) => ({ id: `c${i}`, order })),
            groups: [95, 90, 55, 5].map((order, i) => ({ id: `g${i}`, order })),
        },
        'groups all first': {
            chars: [10, 9, 8, 7, 6, 5].map((order, i) => ({ id: `c${i}`, order })),
            groups: [50, 40, 30].map((order, i) => ({ id: `g${i}`, order })),
        },
        'groups all last': {
            chars: [10, 9, 8, 7, 6, 5].map((order, i) => ({ id: `c${i}`, order })),
            groups: [3, 2, 1].map((order, i) => ({ id: `g${i}`, order })),
        },
        'no groups': {
            chars: [10, 9, 8, 7, 6, 5].map((order, i) => ({ id: `c${i}`, order })),
            groups: [],
        },
        'no characters': {
            chars: [],
            groups: [3, 2, 1].map((order, i) => ({ id: `g${i}`, order })),
        },
    };

    for (const [name, { chars, groups }] of Object.entries(cases)) {
        test(`every page matches the full merge: ${name}`, () => {
            const expected = fullMerge(chars, groups);
            for (const count of [1, 2, 3, 7]) {
                for (let offset = 0; offset <= expected.length + 2; offset++) {
                    const merged = mergeSortedWindow({ ...windowFor(chars, groups, offset, count), groups, offset, count });
                    expect(merged).toEqual(expected.slice(offset, offset + count));
                }
            }
        });
    }
});
