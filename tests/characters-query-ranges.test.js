import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defineCharacterStoreFunctions } from '../src/character-store-schema.js';

/**
 * Registers on a raw connection to the character store the functions its indexes and triggers call.
 * @template {import('better-sqlite3').Database} T
 * @param {T} db
 * @returns {T}
 */
function withStoreFunctions(db) {
    defineCharacterStoreFunctions({ defineFunction: (name, fn) => db.function(name, { deterministic: true }, fn) });
    return db;
}

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('express').Router} */
let router;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    Database = (await import('better-sqlite3')).default;
    ({ router } = await import('../src/endpoints/characters.js'));
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-query-ranges-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @param {string} sql @param {unknown[]} [params] */
function runSql(sql, params = []) {
    const db = withStoreFunctions(new Database(path.join(directories.root, 'character-metadata.sqlite')));
    try {
        return db.prepare(sql).run(...params);
    } finally {
        db.close();
    }
}

// Each character's create_date, date_last_chat, chat_size and data_size; a group's date_added stands for its create_date.
const CHARACTERS = Array.from({ length: 12 }, (_, i) => ({ id: `c${String(i).padStart(2, '0')}.png`, fav: i % 3 === 0 ? 1 : 0, created: 1000 + i * 100, lastChat: 5000 - i * 10, chatSize: i * 7, dataSize: 50 + i * 5 }));
const GROUPS = Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, fav: i % 2, created: 1050 + i * 300, lastChat: 4990 - i * 25, chatSize: i * 20 }));

async function seed() {
    for (const c of CHARACTERS) {
        const cardJson = JSON.stringify({ name: c.id, data: { name: c.id, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await metadataDb.upsertCharacterFromWrite(directories, c.id, cardJson);
    }
    for (const g of GROUPS) {
        const group = { id: g.id, name: g.id, members: [], chats: [], fav: false };
        fs.writeFileSync(path.join(directories.groups, `${g.id}.json`), JSON.stringify(group));
        await metadataDb.upsertGroupRow(directories, g.id, g.id, { fav: false, group });
    }
    metadataDb.disposeMetadataStores();
    for (const c of CHARACTERS) {
        runSql('UPDATE characters SET fav = ?, create_date = ?, date_added = ?, date_last_chat = ?, chat_size = ?, data_size = ? WHERE id = ?',
            [c.fav, c.created, c.created, c.lastChat, c.chatSize, c.dataSize, c.id]);
    }
    for (const g of GROUPS) {
        runSql('UPDATE groups SET fav = ?, date_added = ?, date_last_chat = ?, chat_size = ? WHERE id = ?', [g.fav, g.created, g.lastChat, g.chatSize, g.id]);
    }
}

/**
 * Whether an entity is inside `ranges`; a group has no data_size, so a bound on it leaves groups out.
 * @param {{ type: string, created: number, lastChat: number, chatSize: number, dataSize?: number }} e
 * @param {Record<string, { min?: number, max?: number }>} ranges
 */
function inRanges(e, ranges) {
    const value = { create_date: e.created, date_last_chat: e.lastChat, chat_size: e.chatSize, data_size: e.type === 'group' ? null : e.dataSize };
    return Object.entries(ranges).every(([field, { min, max }]) => value[field] !== null
        && (min === undefined || value[field] >= min) && (max === undefined || value[field] <= max));
}

const ALL = [...CHARACTERS.map(c => ({ ...c, type: 'character' })), ...GROUPS.map(g => ({ ...g, type: 'group' }))];

const RANGES = [
    { create_date: { min: 1300, max: 1900 } },
    { date_last_chat: { max: 4950 } },
    { chat_size: { min: 20 } },
    { data_size: { min: 60, max: 90 } },
    { create_date: { min: 1100 }, chat_size: { max: 60 } },
];

/** @param {object} params */
async function listedSet(params) {
    const rows = [];
    for (let offset = 0; ; offset += 4) {
        const result = await metadataDb.queryEntities(directories, { offset, limit: 4, wantTotal: false, ...params });
        rows.push(...result.rows.map(r => `${r.type}:${r.id}`));
        if (result.rows.length < 4) break;
    }
    return rows;
}

describe('/query filter.ranges', () => {
    test('every sort and direction lists exactly the entities inside the ranges, paged', async () => {
        await seed();
        for (const ranges of RANGES) {
            const want = ALL.filter(e => inRanges(e, ranges)).map(e => `${e.type}:${e.id}`).sort();
            for (const sortField of ['name', 'create_date', 'date_last_chat', 'chat_size', 'data_size', 'fav']) {
                for (const sortOrder of ['asc', 'desc']) {
                    const rows = await listedSet({ ranges, sortField, sortOrder });
                    expect({ ranges, sortField, sortOrder, rows: [...rows].sort() }).toEqual({ ranges, sortField, sortOrder, rows: want });
                    expect(new Set(rows).size).toBe(rows.length);
                }
            }
        }
    });

    test('random order with ranges lists each entity inside them once', async () => {
        await seed();
        await metadataDb.fillRandomRanksIfNeeded(directories);
        for (const ranges of RANGES) {
            const want = ALL.filter(e => inRanges(e, ranges)).map(e => `${e.type}:${e.id}`).sort();
            const rows = await listedSet({ ranges, sortField: 'random', sortOrder: 'asc', seed: 7 });
            expect([...rows].sort()).toEqual(want);
            expect(new Set(rows).size).toBe(rows.length);
        }
    });

    test('ranges combine with fav, and the characters-only query applies them too', async () => {
        await seed();
        const ranges = { create_date: { min: 1100, max: 1800 } };
        const favWant = ALL.filter(e => e.fav === 1 && inRanges(e, ranges)).map(e => `${e.type}:${e.id}`).sort();
        expect((await listedSet({ ranges, fav: true, sortField: 'name', sortOrder: 'asc' })).sort()).toEqual(favWant);

        const result = await metadataDb.queryCharacters(directories, { ranges, sortField: 'name', sortOrder: 'asc', offset: 0, limit: 100, wantTotal: true });
        const charsWant = CHARACTERS.filter(c => inRanges({ ...c, type: 'character' }, ranges)).map(c => c.id).sort();
        expect(result.rows.map(r => r.avatar).sort()).toEqual(charsWant);
    });

    test('the total of a ranged query is right, whether counted or estimated', async () => {
        await seed();
        const ranges = { chat_size: { min: 20 } };
        const result = await metadataDb.queryEntities(directories, { ranges, offset: 0, limit: 2, wantTotal: true });
        const want = ALL.filter(e => inRanges(e, ranges)).length;
        expect(result.total).toBe(want);
    });

    test('the route checks filter.ranges: unknown fields and non-numbers are refused, empty bounds mean no filter', async () => {
        await seed();
        const post = body => fetch(`${baseUrl}/api/characters/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

        expect((await post({ filter: { ranges: { name: { min: 1 } } } })).status).toBe(400);
        expect((await post({ filter: { ranges: { chat_size: { min: 'a lot' } } } })).status).toBe(400);
        expect((await post({ filter: { ranges: [] } })).status).toBe(400);

        const ok = await post({ filter: { ranges: { chat_size: { min: 20 } }, includeGroups: true }, sort: { field: 'name', order: 'asc' }, pageSize: 100 });
        expect(ok.status).toBe(200);
        const body = await ok.json();
        const want = ALL.filter(e => inRanges(e, { chat_size: { min: 20 } })).length;
        expect(body.rows).toHaveLength(want);

        const empty = await post({ filter: { ranges: { chat_size: {} }, includeGroups: true }, sort: { field: 'name', order: 'asc' }, pageSize: 100 });
        expect((await empty.json()).rows).toHaveLength(ALL.length);
    });
});
