import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getBetterSqlite3 } from '../src/endpoints/native-sqlite.js';
import { openNativeDatabase } from '../src/endpoints/sqlite-engine.js';
import { assembleCardsSync, cardLayoutOf } from '../src/character-card-reader.js';
import { canonicalCardHash, cardWithStoredFav } from '../src/character-card-storage.js';
import { defineCharacterStoreFunctions, foldName } from '../src/character-store-schema.js';
import { runConversion } from '../src/migrations/convert-character-store-to-fields.js';

/** The blob layout as staging leaves it, cut down to what the conversion reads and a few tables it copies. */
const BLOB_SCHEMA_SQL = `
    CREATE TABLE characters (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_fold TEXT NOT NULL, fav INTEGER NOT NULL, date_added INTEGER NOT NULL,
        create_date INTEGER, date_last_chat INTEGER NOT NULL, chat_size INTEGER NOT NULL, data_size INTEGER NOT NULL, world TEXT,
        creator TEXT, version TEXT, creator_notes TEXT, shallow_json TEXT NOT NULL, digest_fav INTEGER NOT NULL,
        digest_tag_ids INTEGER NOT NULL, digest_content INTEGER NOT NULL, change_seq INTEGER NOT NULL, active_chat TEXT,
        active_chat_checked INTEGER NOT NULL DEFAULT 0, card_json TEXT NOT NULL, content_hash TEXT, content_identity_hash TEXT,
        import_poisoned INTEGER NOT NULL DEFAULT 1, avatar_identity_hash TEXT, allow_global_styles INTEGER, create_date_raw,
        character_version TEXT
    );
    CREATE INDEX idx_characters_world ON characters(world);
    CREATE TABLE character_tags (character_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (character_id, tag_id));
    CREATE INDEX idx_character_tags_tag ON character_tags(tag_id, character_id);
    CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, op TEXT NOT NULL, fields TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE tags (id TEXT PRIMARY KEY, data TEXT NOT NULL, name_key TEXT);
    CREATE TABLE tag_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, tag_id TEXT);
    CREATE TRIGGER trg_tags_log AFTER DELETE ON tags BEGIN INSERT INTO tag_log (tag_id) VALUES (OLD.id); END;
    CREATE TABLE random_ranks (space TEXT NOT NULL, rank INTEGER NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY (space, rank)) WITHOUT ROWID;
    CREATE TABLE character_tag_sort (tag_id TEXT NOT NULL, entity_id TEXT NOT NULL, k_fav INTEGER, PRIMARY KEY (tag_id, entity_id)) WITHOUT ROWID;
    CREATE TRIGGER trg_characters_tagsort_ad AFTER DELETE ON characters BEGIN DELETE FROM character_tag_sort WHERE entity_id = OLD.id; END;
`;

/** @type {any} */
let Database;
/** @type {string[]} */
const dirs = [];

beforeAll(async () => {
    Database = await getBetterSqlite3();
    if (!Database) throw new Error('these tests need the native better-sqlite3 binding');
});

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const cards = [
    {
        name: 'Alice', description: 'A traveller.', fav: true, spec: 'chara_card_v2', spec_version: '2.0', create_date: '2024-1-2 @03h04m05s678ms',
        data: { name: 'Alice', description: 'A traveller.', tags: ['fantasy'], creator: 'bob', alternate_greetings: ['hi', 'hello'], extensions: { fav: true, world: 'Elsewhere', depth_prompt: { depth: 4 } }, character_book: { entries: [{ keys: ['a'] }] } },
    },
    { name: 'V1 only', tags: 'a, b', creator: 'me', create_date: 1700000000000 },
    { spec: 'chara_card_v3', data: { name: 'Three', group_only_greetings: ['g'], extensions: { fav: false } } },
];

/**
 * A data root with one user whose store is in the blob layout, holding `cards` (the stored fav is the opposite of the
 * first card's own, so the column, not the card, is what the conversion must keep).
 */
function blobLibrary({ unreadable = false } = {}) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-fields-'));
    dirs.push(dataRoot);
    fs.mkdirSync(path.join(dataRoot, 'u'));
    const db = new Database(path.join(dataRoot, 'u', 'character-metadata.sqlite'));
    db.pragma('journal_mode = WAL');
    db.exec(BLOB_SCHEMA_SQL);
    const insert = db.prepare(`INSERT INTO characters (id, name, name_fold, fav, date_added, create_date, date_last_chat, chat_size, data_size,
        shallow_json, digest_fav, digest_tag_ids, digest_content, change_seq, active_chat, card_json, content_hash, import_poisoned, allow_global_styles)
        VALUES (@id, @name, @fold, @fav, @i, NULL, @i, @i, @i, '{}', 0, 0, 0, @seq, @chat, @json, @hash, 0, @ags)`);
    cards.forEach((card, i) => {
        insert.run({ id: `c${i}.png`, name: String(card.name ?? ''), fold: foldName(card.name), fav: i === 0 ? 0 : 1, i: i + 1, seq: 10 + i, chat: i === 1 ? 'chat-1' : null, json: JSON.stringify(card), hash: `h${i}`, ags: i === 2 ? 1 : null });
        db.prepare('INSERT INTO changes (id, op) VALUES (?, \'upsert\')').run(`c${i}.png`);
    });
    if (unreadable) insert.run({ id: 'broken.png', name: 'x', fold: 'x', fav: 0, i: 9, seq: 99, chat: null, json: '{not json', hash: null, ags: null });
    // The newest change row is gone, so the high-water mark is above every row left.
    db.prepare('DELETE FROM changes WHERE seq = (SELECT MAX(seq) FROM changes)').run();
    db.prepare('INSERT INTO character_tags VALUES (\'c0.png\', \'t1\'), (\'c1.png\', \'t1\')').run();
    db.prepare('INSERT INTO tags (id, data, name_key) VALUES (\'t1\', \'{"name":"T"}\', \'t\')').run();
    db.prepare('INSERT INTO random_ranks VALUES (\'a\', 0, \'c\', \'c0.png\'), (\'f0\', 0, \'c\', \'c0.png\'), (\'t\u001ft1\', 0, \'c\', \'c0.png\')').run();
    db.prepare('INSERT INTO character_tag_sort VALUES (\'t1\', \'c0.png\', 0)').run();
    db.prepare('INSERT INTO meta (key, value) VALUES (\'tag_sort_tables_filled\', \'1\'), (\'random_ranks_fill_upto_c\', \'x\'), (\'random_ranks_filled\', \'1\'), (\'name_order_filled\', \'1\'), (\'bootstrap_completed\', \'1\')').run();
    db.close();
    return dataRoot;
}

const notRunning = async () => ({ running: false, lines: [] });

/** @param {string} dataRoot @param {object} [more] */
async function convert(dataRoot, more = {}) {
    const lines = [];
    const code = await runConversion({ dataRoot, handle: 'u', serverStopped: true, Database, probeServer: notRunning, log: l => lines.push(l), warn: l => lines.push(l), ...more });
    return { code, lines };
}

describe('convert-character-store-to-fields', () => {
    test('converts, verifies and swaps, keeping the old file', async () => {
        const dataRoot = blobLibrary();
        const { code, lines } = await convert(dataRoot, { batchRows: 2 });
        expect(code).toBe(0);
        const live = path.join(dataRoot, 'u', 'character-metadata.sqlite');
        expect(fs.existsSync(path.join(dataRoot, 'u', 'character-metadata.pre-fields.sqlite'))).toBe(true);
        expect(fs.existsSync(path.join(dataRoot, 'u', 'character-metadata.next.sqlite'))).toBe(false);
        expect(lines.some(l => l.includes('3 cards, every one checked'))).toBe(true);

        const db = openNativeDatabase(Database, live);
        defineCharacterStoreFunctions(db);
        try {
            expect(cardLayoutOf(db)).toBe('fields');
            expect(db.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
            const assembled = assembleCardsSync(db, cards.map((_c, i) => `c${i}.png`));
            cards.forEach((card, i) => {
                expect(canonicalCardHash(assembled.get(`c${i}.png`))).toBe(canonicalCardHash(cardWithStoredFav(card, i !== 0)));
            });
            expect(db.get('SELECT version, active_chat, allow_global_styles, content_hash FROM characters WHERE id = \'c1.png\'')).toEqual({ version: 11, active_chat: 'chat-1', allow_global_styles: null, content_hash: 'h1' });
            // Copied whole, the deleted top row's seq included, so it is never handed out again.
            expect(db.get('SELECT COUNT(*) AS n FROM character_tags')).toEqual({ n: 2 });
            expect(db.get('SELECT seq FROM sqlite_sequence WHERE name = \'changes\'')).toEqual({ seq: 3 });
            // Derived tables built on need are left out, with their markers and triggers; the rest of meta is kept.
            expect(db.get('SELECT name FROM sqlite_master WHERE name = \'character_tag_sort\'')).toBeUndefined();
            expect(db.get('SELECT name FROM sqlite_master WHERE name = \'trg_characters_tagsort_ad\'')).toBeUndefined();
            expect(Array.from(db.iterate('SELECT space FROM random_ranks ORDER BY space'), r => r.space)).toEqual(['a', 'f0']);
            expect(Array.from(db.iterate('SELECT key FROM meta ORDER BY key'), r => r.key)).toEqual(['bootstrap_completed', 'card_layout', 'fields_conversion_verified', 'name_order_filled']);
            // A copied trigger on a copied table still fires.
            db.run('DELETE FROM tags WHERE id = \'t1\'');
            expect(db.get('SELECT tag_id FROM tag_log')).toEqual({ tag_id: 't1' });
            // The name sort reads the fold index.
            const plan = Array.from(db.iterate('EXPLAIN QUERY PLAN SELECT id FROM characters WHERE fav = 1 ORDER BY st_fold(name), id'), r => r.detail).join(' ');
            expect(plan).toContain('idx_characters_sort_fav_name_fold_asc');
        } finally {
            db.close();
        }

        expect((await convert(dataRoot)).lines.at(-1)).toContain('already in the fields layout');
    });

    test('a card that can\'t be read stops it, listing the card, and leaves the old file in place', async () => {
        const dataRoot = blobLibrary({ unreadable: true });
        const live = path.join(dataRoot, 'u', 'character-metadata.sqlite');
        const before = fs.readFileSync(live);
        const { code, lines } = await convert(dataRoot);
        expect(code).toBe(1);
        expect(lines.some(l => l.includes('broken.png'))).toBe(true);
        expect(fs.readFileSync(live).equals(before)).toBe(true);
        expect(fs.existsSync(path.join(dataRoot, 'u', 'character-metadata.next.sqlite'))).toBe(false);
        expect(fs.existsSync(path.join(dataRoot, 'u', 'character-metadata.pre-fields.sqlite'))).toBe(false);
    });

    test('refuses without --server-stopped, while the server answers, or without room on disk', async () => {
        const dataRoot = blobLibrary();
        expect((await convert(dataRoot, { serverStopped: false })).code).toBe(1);
        expect((await convert(dataRoot, { probeServer: async () => ({ running: true, lines: [] }) })).code).toBe(1);
        const noRoom = await convert(dataRoot, { freeBytes: () => 0 });
        expect(noRoom.code).toBe(1);
        expect(noRoom.lines.some(l => l.includes('enough free disk space'))).toBe(true);
        const db = new Database(path.join(dataRoot, 'u', 'character-metadata.sqlite'), { readonly: true });
        expect(db.prepare('SELECT COUNT(*) AS n FROM characters').get()).toEqual({ n: 3 });
        db.close();
    });
});
