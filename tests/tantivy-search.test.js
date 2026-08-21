import { describe, test, expect } from '@jest/globals';
import tantivy from '@oxdev03/node-tantivy-binding';

import { buildSchema, buildSearchQuery, runSearch, DATA_FIELD } from '../src/endpoints/tantivy-search.js';

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
        }, schema));
    }
    writer.commit();
    index.reload();
    return { index, schema };
}

function names(index, schema, term, maxRows = 10) {
    const query = buildSearchQuery(tantivy, schema, term, FIELD_WEIGHTS, FIELD_LABELS);
    if (!query) {
        return { names: [], total: 0 };
    }
    const { results, total } = runSearch(index, query, maxRows);
    return { names: results.map(r => r.item.name), total };
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
        expect(hits[0].item).toEqual(docs[3]);
    });
});
