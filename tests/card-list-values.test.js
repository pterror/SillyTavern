import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';
import { cardListValues } from '../src/card-list-values.js';
import { shallowCharacterData } from '../public/scripts/hash-utils.js';

/** @type {typeof import('../src/character-card-normalize.js').getCharaCardV2} */
let getCharaCardV2;

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    ({ getCharaCardV2 } = await import('../src/character-card-normalize.js'));
});

/**
 * A generator of random cards over the keys list rows read, each with a random creator-notes setting.
 * @param {number} seed
 */
function randomCards(seed) {
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const keys = ['name', 'tags', 'creator', 'character_version', 'creatorcomment', 'creator_notes', 'create_date', 'spec', 'extensions', 'world', 'data', 'fav'];
    const value = (depth) => {
        switch (Math.floor(rand() * (depth > 1 ? 6 : 8))) {
            case 0: return `s${Math.floor(rand() * 3)}`;
            case 1: return Math.floor(rand() * 10);
            case 2: return rand() < 0.5;
            case 3: return null;
            case 4: return '';
            case 5: return pick(['a, b', ',x,', 'y']);
            case 6: return Array.from({ length: Math.floor(rand() * 3) }, () => value(depth + 1));
            default: {
                const obj = {};
                for (let i = Math.floor(rand() * 4); i > 0; i--) obj[pick(keys)] = value(depth + 1);
                return obj;
            }
        }
    };
    return () => {
        const card = {};
        for (let k = Math.floor(rand() * 6); k > 0; k--) card[pick(keys)] = value(0);
        return { card, notes: rand() < 0.5 };
    };
}

const cards = [
    {
        name: 'Alice', description: 'A traveller.', tags: ['fantasy'], fav: false, creatorcomment: 'notes', spec: 'chara_card_v2', spec_version: '2.0',
        create_date: '2024-1-2 @03h04m05s678ms',
        data: {
            name: 'Alice', description: 'A traveller.', creator_notes: 'notes', tags: ['fantasy'], creator: 'bob', character_version: '1.0',
            alternate_greetings: ['hi'], extensions: { fav: false, world: 'Elsewhere', talkativeness: '0.5' }, character_book: { entries: [] },
        },
    },
    { name: 'V1 only', tags: 'a, b,,c', creator: 'me', creatorcomment: 'v1 notes', create_date: 1700000000000 },
    { name: 'V1 with data', data: { name: 'ignored', tags: ['x'] } },
    { spec: 'chara_card_v2', name: 'No data' },
    { spec: 'chara_card_v2', name: 'Top', data: { description: 'no name' } },
    { spec: 'chara_card_v2', name: 'Top', data: 'not an object' },
    { spec: 'chara_card_v2', data: { name: 5, creator: '', tags: 'a,b', extensions: { world: 7 } } },
    { spec: 'chara_card_v2', name: 'Old', tags: ['old'], data: { name: 'New', tags: [], extensions: 'odd' }, create_date: null },
    { spec: 'chara_card_v3', data: { name: 'Three', group_only_greetings: ['g'], tags: ['t'], creator_notes: 7 } },
    {},
];

/**
 * The list row values for `card` as getCharaCardV2() and toShallow() make them (the extensions' fav aside: a row
 * takes it from the store).
 * @param {unknown} card
 * @param {boolean} notes
 */
function check(card, notes) {
    const character = getCharaCardV2(structuredClone(card), {}, false);
    const expected = JSON.parse(JSON.stringify({ name: character.name, tags: character.tags, create_date: character.create_date, data: shallowCharacterData(character, notes) }));
    const { world, ...data } = cardListValues(card, notes).data;
    const got = JSON.parse(JSON.stringify({ ...cardListValues(card, notes), data: { ...data, extensions: { fav: expected.data.extensions.fav, world } } }));
    expect(got).toEqual(expected);
}

describe('cardListValues', () => {
    test('matches getCharaCardV2() and toShallow() on the usual shapes and on random cards', () => {
        expect.hasAssertions();
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        for (const card of cards) for (const notes of [false, true]) check(card, notes);
        const random = randomCards(777);
        for (let i = 0; i < 2000; i++) {
            const { card, notes } = random();
            check(card, notes);
        }
        warn.mockRestore();
    });
});
