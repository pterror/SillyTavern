import { describe, test, expect } from '@jest/globals';

import { buildFtsQuery } from '../src/endpoints/search-query.js';

const CHARACTER_FIELD_LABELS = {
    name: 'name',
    tag: '{resolved_tags tags}',
    tags: '{resolved_tags tags}',
    creator: 'creator',
};

describe('buildFtsQuery()', () => {
    test('returns null for an empty or whitespace-only search term', () => {
        expect(buildFtsQuery('', CHARACTER_FIELD_LABELS)).toBeNull();
        expect(buildFtsQuery('   ', CHARACTER_FIELD_LABELS)).toBeNull();
    });

    test('wraps a single bare word as a quoted prefix match across all columns', () => {
        expect(buildFtsQuery('vampire', CHARACTER_FIELD_LABELS)).toBe('"vampire"*');
    });

    test('AND-combines multiple bare words', () => {
        expect(buildFtsQuery('vampire romance', CHARACTER_FIELD_LABELS)).toBe('"vampire"* AND "romance"*');
    });

    test('translates a recognized label into an FTS5 column-filter expression', () => {
        expect(buildFtsQuery('creator:someone', CHARACTER_FIELD_LABELS)).toBe('creator:"someone"*');
    });

    test('translates a recognized label into a multi-column {col1 col2}: group when configured that way', () => {
        expect(buildFtsQuery('tag:vampire', CHARACTER_FIELD_LABELS)).toBe('{resolved_tags tags}:"vampire"*');
    });

    test('label filter scopes only its own token - a later bare word still searches every column', () => {
        expect(buildFtsQuery('name:vamp bard', CHARACTER_FIELD_LABELS)).toBe('name:"vamp"* AND "bard"*');
    });

    test('multiple label filters combine with AND', () => {
        expect(buildFtsQuery('tag:vampire creator:someone', CHARACTER_FIELD_LABELS))
            .toBe('{resolved_tags tags}:"vampire"* AND creator:"someone"*');
    });

    test('an unrecognized label is treated as a literal bare term, colon included', () => {
        expect(buildFtsQuery('unknownlabel:foo', CHARACTER_FIELD_LABELS)).toBe('"unknownlabel:foo"*');
    });

    test('a token that merely contains a colon (like a URL) is treated as a literal bare term', () => {
        expect(buildFtsQuery('http://example.com', CHARACTER_FIELD_LABELS)).toBe('"http://example.com"*');
    });

    test('a recognized label with no value attached is treated as a literal bare term, not a filter', () => {
        expect(buildFtsQuery('name:', CHARACTER_FIELD_LABELS)).toBe('"name:"*');
    });

    test('a quoted multi-word phrase after a label stays together as that label\'s value', () => {
        expect(buildFtsQuery('tag:"cute girl"', CHARACTER_FIELD_LABELS)).toBe('{resolved_tags tags}:"cute girl"*');
    });

    test('a bare quoted multi-word phrase (no label) stays together as one literal term', () => {
        expect(buildFtsQuery('"vampire lord"', CHARACTER_FIELD_LABELS)).toBe('"vampire lord"*');
    });

    test('a stray double quote in a bare term is escaped, not left to break the FTS5 string literal', () => {
        expect(buildFtsQuery('foo"bar', CHARACTER_FIELD_LABELS)).toBe('"foo""bar"*');
    });

    test('label matching is case-insensitive', () => {
        expect(buildFtsQuery('TAG:vampire', CHARACTER_FIELD_LABELS)).toBe('{resolved_tags tags}:"vampire"*');
    });
});
