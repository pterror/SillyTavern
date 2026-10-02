/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "expectLossless"] }] */
import { describe, test, expect } from '@jest/globals';
import { splitCard, assembleCard, canonicalCardHash, canonicalJson } from '../src/character-card-storage.js';

function roundTrip(card) {
    const parts = JSON.parse(JSON.stringify(splitCard(card)));
    return assembleCard(parts);
}

function expectLossless(card) {
    expect(canonicalCardHash(roundTrip(card))).toBe(canonicalCardHash(card));
}

const v2Card = {
    name: 'Alice',
    description: 'A traveller.',
    personality: 'curious',
    scenario: 'a tavern',
    first_mes: 'Hello!',
    mes_example: '<START>\n{{user}}: hi',
    creatorcomment: 'notes',
    avatar: 'none',
    talkativeness: '0.5',
    fav: false,
    tags: ['fantasy', 'tavern'],
    spec: 'chara_card_v2',
    spec_version: '2.0',
    create_date: '2024-1-2 @03h04m05s678ms',
    data: {
        name: 'Alice',
        description: 'A traveller.',
        personality: 'curious',
        scenario: 'a tavern',
        first_mes: 'Hello!',
        mes_example: '<START>\n{{user}}: hi',
        creator_notes: 'notes',
        system_prompt: '',
        post_history_instructions: '',
        tags: ['fantasy', 'tavern'],
        creator: 'bob',
        character_version: '1.0',
        alternate_greetings: ['Hi there', 'Greetings'],
        extensions: { talkativeness: '0.5', fav: false, world: 'Elsewhere', depth_prompt: { prompt: 'x', depth: 4, role: 'system' } },
        character_book: { name: 'book', entries: [{ keys: ['a'], content: 'b', id: 0 }] },
    },
};

describe('character card storage', () => {
    test('a full v2 card round-trips exactly', () => {
        expectLossless(v2Card);
    });

    test('mirrors are one value: a V1 key equal to its data counterpart is stored as a marker', () => {
        const parts = splitCard(v2Card);
        expect(parts.extra.filter(r => r.path.startsWith('mirror:')).map(r => r.path).sort()).toEqual(
            ['mirror:creatorcomment', 'mirror:description', 'mirror:fav', 'mirror:first_mes', 'mirror:mes_example', 'mirror:name', 'mirror:personality', 'mirror:scenario', 'mirror:tags', 'mirror:talkativeness'].sort());
        expect(parts.fields.find(f => f.field === 'description')?.value).toBe('A traveller.');
        expect(parts.columns).toEqual({ name: 'Alice', creator: 'bob', character_version: '1.0', fav: false, world: 'Elsewhere', create_date: '2024-1-2 @03h04m05s678ms' });
        expect(parts.tags).toEqual([{ position: 0, name: 'fantasy' }, { position: 1, name: 'tavern' }]);
        expect(parts.extra.some(r => r.path === 'data:tags' || r.path === 'top:create_date')).toBe(false);
        expect(parts.greetings).toEqual([
            { list: 'alternate_greetings', position: 0, text: 'Hi there' },
            { list: 'alternate_greetings', position: 1, text: 'Greetings' },
        ]);
    });

    test('tag names that are not a non-empty list of strings are not tag rows', () => {
        for (const tags of [[], ['a', 2], null]) {
            const card = { data: { tags } };
            expectLossless(card);
            expect(splitCard(card).tags).toEqual([]);
            expect(splitCard(card).extra.some(r => r.path === 'data:tags')).toBe(true);
        }
        expectLossless({ data: { tags: 'a,b' } });
        const drifted = { tags: ['old'], data: { tags: ['new'] } };
        expectLossless(drifted);
        expect(splitCard(drifted).extra.some(r => r.path === 'top:tags')).toBe(true);
    });

    test('create_date is a column when it is a string or a number, otherwise extra; absent and null stay apart', () => {
        expect(splitCard({ create_date: 1700000000000 }).columns.create_date).toBe(1700000000000);
        expect(splitCard({ create_date: '' }).columns.create_date).toBe('');
        for (const createDate of [null, true, { at: 1 }, [1]]) {
            const card = { create_date: createDate };
            expectLossless(card);
            expect(splitCard(card).columns.create_date).toBeUndefined();
            expect(splitCard(card).extra.some(r => r.path === 'top:create_date')).toBe(true);
        }
        expect(Object.hasOwn(/** @type {object} */ (roundTrip({ name: 'x' })), 'create_date')).toBe(false);
        expect(roundTrip({ create_date: null })).toEqual({ create_date: null });
    });

    test('a V1 key that drifted from data keeps both values', () => {
        const drifted = { ...v2Card, description: 'old text' };
        expectLossless(drifted);
        expect(splitCard(drifted).extra.some(r => r.path === 'top:description')).toBe(true);
    });

    test('empty and missing containers round-trip', () => {
        expectLossless({});
        expectLossless({ data: {} });
        expectLossless({ data: { extensions: {} } });
        expectLossless({ data: { alternate_greetings: [] } });
        expectLossless({ name: 'x' });
        expectLossless({ data: null });
        expectLossless({ data: 'not an object' });
        expectLossless({ data: { extensions: 'nope' } });
    });

    test('values of an unexpected type are carried, never coerced', () => {
        expectLossless({ data: { name: 5, creator: null, character_version: ['1'], extensions: { fav: 'yes', world: 3 } } });
        expectLossless({ data: { alternate_greetings: ['a', 2, null] } });
        expectLossless({ data: { group_only_greetings: ['g'] }, spec: 'chara_card_v3', spec_version: '3.0' });
    });

    test('a non-object card is carried whole', () => {
        expectLossless('a string');
        expectLossless([1, 2]);
        expectLossless(null);
    });

    test('random cards round-trip exactly', () => {
        let seed = 12345;
        const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        const pick = (list) => list[Math.floor(rand() * list.length)];
        const keys = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'creatorcomment',
            'tags', 'fav', 'talkativeness', 'creator', 'character_version', 'alternate_greetings', 'group_only_greetings',
            'extensions', 'character_book', 'system_prompt', 'unknown_field', 'world', 'spec', 'data', 'create_date'];
        const value = (depth) => {
            const kind = Math.floor(rand() * (depth > 2 ? 5 : 8));
            switch (kind) {
                case 0: return `s${Math.floor(rand() * 5)}`;
                case 1: return Math.floor(rand() * 10);
                case 2: return rand() < 0.5;
                case 3: return null;
                case 4: return '';
                case 5: return Array.from({ length: Math.floor(rand() * 3) }, () => value(depth + 1));
                default: {
                    const obj = {};
                    for (let i = Math.floor(rand() * 4); i > 0; i--) obj[pick(keys)] = value(depth + 1);
                    return obj;
                }
            }
        };
        for (let i = 0; i < 2000; i++) {
            const card = {};
            for (let k = Math.floor(rand() * 8); k > 0; k--) card[pick(keys)] = value(0);
            if (rand() < 0.7) {
                const data = {};
                for (let k = Math.floor(rand() * 10); k > 0; k--) data[pick(keys)] = value(1);
                card.data = data;
                // Make some V1 keys true mirrors.
                for (const k of ['name', 'description', 'tags']) if (rand() < 0.5 && k in data) card[k] = JSON.parse(JSON.stringify(data[k]));
            }
            const before = canonicalJson(card);
            expectLossless(card);
            expect(canonicalJson(card)).toBe(before);
        }
    });
});
