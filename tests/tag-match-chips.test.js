import { describe, test, expect } from '@jest/globals';
import path from 'node:path';

/**
 * The tag chips above a searched character list (public/scripts/tag-match-chips.js): the words a picked tag takes out
 * of the search, and the view it leads to; and `/query`'s hash-mode answer carrying them (the server's encoder and
 * the page's decoder).
 */

const { withoutMatchedWords, viewForTagChip } = await import('../public/scripts/tag-match-chips.js');

describe('tag match chips', () => {
    test('the words matching the name go, the others stay', () => {
        expect(withoutMatchedWords('dragon knight', 'dragon')).toBe('knight');
        expect(withoutMatchedWords('knight dragon', 'Dragon Riders')).toBe('knight');
        expect(withoutMatchedWords('knight drag', 'dragon')).toBe('knight');
        expect(withoutMatchedWords('drag knight', 'dragon')).toBe('drag knight');
        expect(withoutMatchedWords('"dark knight" love', 'dark knight')).toBe('love');
        expect(withoutMatchedWords('élan', 'Elan')).toBe('');
        expect(withoutMatchedWords('dragon-riders', 'dragon riders')).toBe('');
        expect(withoutMatchedWords('"dra"', 'dragon')).toBe('"dra"');
    });

    test('a picked chip adds the tag and keeps the rest of the view', () => {
        const view = { text: 'dragon knight', conditions: [{ field: 'creator', op: 'contains', value: 'x' }], tags: { include: ['t1'], exclude: ['t9'], mode: 'and' }, fav: true, group: undefined, sort: { field: 'search', order: 'asc' }, folderCase: null };
        const next = viewForTagChip(/** @type {any} */ (view), { id: 't9', name: 'dragon' });
        expect(next.text).toBe('knight');
        expect(next.tags).toEqual({ include: ['t1', 't9'], exclude: [], mode: 'and' });
        expect(next.conditions).toEqual(view.conditions);
        expect(next.fav).toBe(true);
    });
});

describe('hash-mode tag matches', () => {
    test('the encoder and decoder agree, with and without them', async () => {
        const { setConfigFilePath } = await import('../src/util.js');
        setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
        const { serializeQueryHashesBinary } = await import('../src/endpoints/characters.js');
        const { deserializeQueryHashesBinary } = await import('../public/scripts/query-hashes-binary.js');
        const row = { id: 'a.png', isGroup: false, version: 3, date_added: 1, create_date: null, date_last_chat: 0, chat_size: 0, data_size: 5, chat: null };
        const decode = (/** @type {Buffer} */ b) => deserializeQueryHashesBinary(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        const tagMatches = [{ id: 't-1', name: 'dragon riders', carriers: 12 }, { id: 'тег', name: 'Ünï', carriers: 0 }];
        const withTags = decode(serializeQueryHashesBinary({ seq: 4, token: 'tok', total: 9, approxTotal: false, hashRows: [row], tagMatches, tagMatchesExact: false, hidden: 3 }));
        expect([withTags.tagMatches, withTags.tagMatchesExact, withTags.hidden, withTags.token, withTags.hashRows.length]).toEqual([tagMatches, false, 3, 'tok', 1]);
        const without = decode(serializeQueryHashesBinary({ seq: 4, token: 'tok', total: 9, approxTotal: false, hashRows: [row], cursor: 'c' }));
        expect([without.tagMatches, without.cursor, without.hidden]).toEqual([undefined, 'c', undefined]);
    });
});
