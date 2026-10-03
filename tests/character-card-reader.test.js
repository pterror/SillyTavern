import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getSqliteEngine } from '../src/endpoints/sqlite-engine.js';
import { CARD_LAYOUT_META_KEY, CARD_TABLES_SQL, assembleCardsSync, cardLayoutOf, cardListValues, cardNameText, listRowsFromFieldsSync } from '../src/character-card-reader.js';
import { splitCard, canonicalCardHash, cardWithStoredFav } from '../src/character-card-storage.js';
import { getCharaCardV2 } from '../src/character-card-normalize.js';
import { shallowCharacterData, normalizeTagIds } from '../public/scripts/hash-utils.js';

const FIELDS_CHARACTERS_SQL = `
    CREATE TABLE characters (
        id TEXT PRIMARY KEY, name TEXT, creator TEXT, character_version TEXT, world TEXT, create_date_raw,
        fav INTEGER NOT NULL, date_added INTEGER NOT NULL, create_date INTEGER, date_last_chat INTEGER NOT NULL,
        chat_size INTEGER NOT NULL, data_size INTEGER NOT NULL, active_chat TEXT, allow_global_styles INTEGER
    );
    CREATE TABLE character_tags (character_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (character_id, tag_id));
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

/** @type {string} */
let dir;
/** @type {import('../src/endpoints/sqlite-engine.js').SqliteEngineHandle} */
let db;
let next = 0;

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-reader-'));
    const engine = await getSqliteEngine();
    if (!engine) throw new Error('no sqlite engine');
    db = engine.openDatabase(path.join(dir, 'fields.sqlite'));
    db.exec(FIELDS_CHARACTERS_SQL);
    db.exec(CARD_TABLES_SQL);
    db.run('INSERT INTO meta (key, value) VALUES (?, \'fields\')', [CARD_LAYOUT_META_KEY]);
});

afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Stores `card` in the fields layout as a character with the given row values; returns its id.
 * @param {unknown} card
 * @param {{ fav?: boolean, activeChat?: string | null, allowGlobalStyles?: number | null, tagIds?: string[] }} [row]
 */
function store(card, { fav = false, activeChat = null, allowGlobalStyles = null, tagIds = [] } = {}) {
    const id = `c${next++}.png`;
    const parts = splitCard(card);
    const { columns } = parts;
    db.run(`INSERT INTO characters (id, name, creator, character_version, world, create_date_raw, fav, date_added, create_date, date_last_chat, chat_size, data_size, active_chat, allow_global_styles)
        VALUES (@id, @name, @creator, @character_version, @world, @create_date_raw, @fav, 111, NULL, 222, 333, 444, @active_chat, @allow_global_styles)`, {
        id, name: columns.name ?? null, creator: columns.creator ?? null, character_version: columns.character_version ?? null,
        world: columns.world ?? null, create_date_raw: columns.create_date ?? null, fav: fav ? 1 : 0, active_chat: activeChat, allow_global_styles: allowGlobalStyles,
    });
    const cardColumns = Object.keys(parts.card);
    db.run(`INSERT INTO cards (character_id${cardColumns.map(c => `, ${c}`).join('')}) VALUES (?${cardColumns.map(() => ', ?').join('')})`, [id, ...cardColumns.map(c => parts.card[c])]);
    for (const g of parts.greetings) db.run('INSERT INTO card_greetings VALUES (?, ?, ?, ?)', [id, g.list, g.position, g.text]);
    for (const t of parts.tags) db.run('INSERT INTO card_tags VALUES (?, ?, ?)', [id, t.position, t.name]);
    for (const e of parts.extensions) db.run('INSERT INTO card_extensions VALUES (?, ?, ?)', [id, e.key, e.value]);
    for (const x of parts.extra) db.run('INSERT INTO card_extra VALUES (?, ?, ?)', [id, x.path, x.value]);
    for (const tagId of tagIds) db.run('INSERT INTO character_tags VALUES (?, ?)', [id, tagId]);
    return id;
}

/**
 * The list row the blob layout keeps for `card` with these row values, as buildRow() and its later patches make it.
 * @param {object} card
 * @param {string} id
 * @param {{ fav: boolean, activeChat: string | null, allowGlobalStyles: number | null, tagIds: string[], includeCreatorNotes: boolean }} row
 */
function expectedListRow(card, id, { fav, activeChat, allowGlobalStyles, tagIds, includeCreatorNotes }) {
    const character = getCharaCardV2(structuredClone(card), {}, false);
    const data = shallowCharacterData(character, includeCreatorNotes);
    data.extensions.fav = fav;
    const shallow = {
        shallow: true, name: character.name, avatar: id, chat: activeChat ?? undefined, fav, date_added: 111,
        create_date: character.create_date, date_last_chat: 222, chat_size: 333, data_size: 444, tags: character.tags,
        tag_ids: normalizeTagIds(tagIds), data,
        ...(allowGlobalStyles !== null ? { allow_global_styles: !!allowGlobalStyles } : {}),
    };
    return JSON.parse(JSON.stringify(shallow));
}

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

describe('character card reader (fields layout)', () => {
    test('cardLayoutOf reads the layout from the meta row', async () => {
        expect(cardLayoutOf(db)).toBe('fields');
        const engine = await getSqliteEngine();
        const blob = /** @type {NonNullable<typeof engine>} */ (engine).openDatabase(path.join(dir, 'blob.sqlite'));
        expect(cardLayoutOf(blob)).toBe('blob');
        // A store from before card_json existed has neither card_json nor the meta row.
        blob.exec('CREATE TABLE characters (id TEXT PRIMARY KEY, shallow_json TEXT NOT NULL); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
        expect(cardLayoutOf(blob)).toBe('blob');
        blob.close();
    });

    test('a stored card assembles to the card with its favourite flag from the row', () => {
        const ids = cards.map((card, i) => store(card, { fav: i % 2 === 0 }));
        const assembled = assembleCardsSync(db, [...ids, 'missing.png']);
        expect(assembled.has('missing.png')).toBe(false);
        ids.forEach((id, i) => {
            expect(canonicalCardHash(assembled.get(id))).toBe(canonicalCardHash(cardWithStoredFav(cards[i], i % 2 === 0)));
        });
    });

    test('cardNameText is the blob layout\'s name column', () => {
        expect(cards.map(cardNameText)).toEqual(['Alice', 'V1 only', 'V1 with data', 'No data', 'Top', 'Top', '5', 'New', 'Three', '']);
    });

    for (const includeCreatorNotes of [false, true]) {
        test(`list rows are the blob layout's shallow copies (creator notes ${includeCreatorNotes ? 'on' : 'off'})`, () => {
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const rows = cards.map((card, i) => ({
                card, fav: i % 3 === 0, activeChat: i % 2 === 0 ? `chat-${i}` : null, allowGlobalStyles: [null, 0, 1][i % 3], tagIds: i % 2 ? ['t2', 't1'] : [], includeCreatorNotes,
            }));
            const ids = rows.map(r => store(r.card, r));
            const got = listRowsFromFieldsSync(db, ids, includeCreatorNotes);
            ids.forEach((id, i) => {
                expect(JSON.parse(JSON.stringify(got.get(id)))).toEqual(expectedListRow(/** @type {object} */ (rows[i].card), id, rows[i]));
            });
            warn.mockRestore();
        });
    }

    test('list rows carry tag ids as character_tags stores them', () => {
        const id = store({ name: 'n' }, { tagIds: ['kept', 'merged-away'] });
        expect(listRowsFromFieldsSync(db, [id], false).get(id)?.tag_ids).toEqual(['kept', 'merged-away']);
    });

    test('cardListValues matches getCharaCardV2() and toShallow() on random cards', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const random = randomCards(777);
        for (let i = 0; i < 2000; i++) {
            const { card, notes } = random();
            const character = getCharaCardV2(structuredClone(card), {}, false);
            const expected = JSON.parse(JSON.stringify({ name: character.name, tags: character.tags, create_date: character.create_date, data: shallowCharacterData(character, notes) }));
            const { world, ...data } = cardListValues(card, notes).data;
            const got = JSON.parse(JSON.stringify({ ...cardListValues(card, notes), data: { ...data, extensions: { fav: expected.data.extensions.fav, world } } }));
            expect(got).toEqual(expected);
        }
        warn.mockRestore();
    });

    test('list rows of random stored cards are the blob layout\'s shallow copies', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const random = randomCards(4242);
        for (const includeCreatorNotes of [false, true]) {
            const stored = [];
            for (let i = 0; i < 1000; i++) {
                const { card } = random();
                const row = { fav: i % 2 === 0, activeChat: null, allowGlobalStyles: null, tagIds: [], includeCreatorNotes };
                stored.push({ id: store(card, row), card, row });
            }
            const got = listRowsFromFieldsSync(db, stored.map(s => s.id), includeCreatorNotes);
            for (const { id, card, row } of stored) {
                expect(JSON.parse(JSON.stringify(got.get(id)))).toEqual(expectedListRow(card, id, row));
            }
        }
        warn.mockRestore();
    });
});
