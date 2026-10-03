import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defineCharacterStoreFunctions } from '../src/character-store-schema.js';
import { deleteEntityRaw, deleteTagRowRaw, insertEntityRaw, insertTagRowRaw, setFavRaw } from './util/stored-counters.js';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/** While armed, the transaction call with this 1-based number throws instead of running. */
let crashAtTransaction = 0;
let transactionCalls = 0;
let inTransaction = false;
/** @type {string[]} The SQL of every write made through the store's handle. */
let runSql = [];
/** @type {(() => void) | null} Called after each transaction of the store's handle commits. */
let afterCommit = null;
/** @type {(() => void) | null} Called when a read outside a transaction has been read to the end. */
let afterRead = null;

/** @param {any} handle */
function instrumentedHandle(handle) {
    const wrapped = { ...handle };
    wrapped.transaction = (fn) => {
        transactionCalls++;
        if (crashAtTransaction && transactionCalls === crashAtTransaction) {
            throw new Error('simulated stop');
        }
        inTransaction = true;
        let result;
        try {
            result = handle.transaction(fn);
        } finally {
            inTransaction = false;
        }
        afterCommit?.();
        return result;
    };
    wrapped.run = (sql, params) => {
        runSql.push(sql);
        return handle.run(sql, params);
    };
    wrapped.iterate = function* (sql, params) {
        const outside = !inTransaction;
        yield* handle.iterate(sql, params);
        if (outside) afterRead?.();
    };
    return wrapped;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    const sqliteEngine = await import('../src/endpoints/sqlite-engine.js');
    const engine = await sqliteEngine.getSqliteEngine();
    const openDatabase = engine.openDatabase;
    engine.openDatabase = (dbPath, options) => instrumentedHandle(openDatabase(dbPath, options));

    metadataDb = await import('../src/character-metadata-db.js');
    Database = (await import('better-sqlite3')).default;
});

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-entity-count-fill-test-'));
    directories = /** @type {any} */ ({
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    crashAtTransaction = 0;
    transactionCalls = 0;
    inTransaction = false;
    runSql = [];
    afterCommit = null;
    afterRead = null;
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @type {import('better-sqlite3').Database | null} A second connection standing in for the server's live writes. */
let liveDb = null;
function live() {
    if (!liveDb) {
        const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
        defineCharacterStoreFunctions({ defineFunction: (name, fn) => db.function(name, { deterministic: true }, fn) });
        liveDb = db;
    }
    return liveDb;
}
afterEach(() => {
    liveDb?.close();
    liveDb = null;
});

/** @param {import('better-sqlite3').Database} db */
function fillState(db) {
    return Array.from(db.prepare('SELECT kind, upto, done FROM entity_count_fill ORDER BY kind').iterate());
}

/**
 * Every counter that differs from a direct COUNT over the filled range, as [table, key, stored, actual].
 * @param {import('better-sqlite3').Database} db
 */
function counterMismatches(db) {
    const filled = (kind, column) => `EXISTS (SELECT 1 FROM entity_count_fill f WHERE f.kind = '${kind}' AND (f.done = 1 OR ${column} <= f.upto))`;
    const expectedEntities = Array.from(db.prepare(`
        SELECT 'character' AS kind, fav, COUNT(*) AS n FROM characters WHERE ${filled('character', 'id')} GROUP BY fav
        UNION ALL
        SELECT 'group' AS kind, fav, COUNT(*) AS n FROM groups WHERE ${filled('group', 'id')} GROUP BY fav
    `).iterate());
    const expectedTags = Array.from(db.prepare(`
        SELECT t.tag_id, 'character' AS kind, c.fav, COUNT(*) AS n FROM character_tags t JOIN characters c ON c.id = t.character_id
            WHERE ${filled('character', 'c.id')} GROUP BY t.tag_id, c.fav
        UNION ALL
        SELECT t.tag_id, 'group' AS kind, g.fav, COUNT(*) AS n FROM group_tags t JOIN groups g ON g.id = t.group_id
            WHERE substr(t.group_id, -4) <> '.png' AND ${filled('group', 'g.id')} GROUP BY t.tag_id, g.fav
    `).iterate());
    const storedEntities = Array.from(db.prepare('SELECT kind, fav, count AS n FROM entity_counts WHERE count <> 0').iterate());
    const storedTags = Array.from(db.prepare('SELECT tag_id, kind, fav, count AS n FROM entity_tag_counts WHERE count <> 0').iterate());

    const mismatches = [];
    const compare = (table, expected, stored, keyOf) => {
        const want = new Map(expected.map(r => [keyOf(r), r.n]));
        const have = new Map(stored.map(r => [keyOf(r), r.n]));
        for (const key of new Set([...want.keys(), ...have.keys()])) {
            if (want.get(key) !== have.get(key)) mismatches.push([table, key, have.get(key) ?? 0, want.get(key) ?? 0]);
        }
    };
    compare('entity_counts', expectedEntities, storedEntities, r => `${r.kind}/${r.fav}`);
    compare('entity_tag_counts', expectedTags, storedTags, r => `${r.tag_id}/${r.kind}/${r.fav}`);
    return mismatches;
}

/** @param {import('better-sqlite3').Database} db */
function fullyFilledMismatches(db) {
    expect(fillState(db).map(({ kind, done }) => ({ kind, done }))).toEqual([{ kind: 'character', done: 1 }, { kind: 'group', done: 1 }]);
    return counterMismatches(db);
}

const CHARACTERS = 2500;
const GROUPS = 2100;
const charId = (/** @type {number} */ i) => `c${String(i).padStart(5, '0')}.png`;
const groupId = (/** @type {number} */ i) => `g${String(i).padStart(5, '0')}`;

/**
 * Opens the store and writes, straight into the tables, CHARACTERS characters and GROUPS groups with a mix of fav
 * values and tags, legacy .png group rows with tag rows, and tag rows with no entity row.
 */
async function seedLibrary() {
    await metadataDb.ensureSchemaMigrated(directories);
    const db = live();
    db.exec(`
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${CHARACTERS})
        INSERT INTO characters (id, name, fav, date_added, date_last_chat, chat_size, data_size, version)
        SELECT printf('c%05d.png', i), 'c', i % 3 = 0, 0, 0, 0, 0, 0 FROM n;

        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${CHARACTERS})
        INSERT INTO character_tags (character_id, tag_id)
        SELECT printf('c%05d.png', i), 't' || (i % 5) FROM n
        UNION ALL SELECT printf('c%05d.png', i), 'tx' FROM n WHERE i % 7 = 0;

        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${GROUPS})
        INSERT INTO groups (id, name, fav) SELECT printf('g%05d', i), 'g', i % 4 = 0 FROM n;

        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${GROUPS})
        INSERT INTO group_tags (group_id, tag_id) SELECT printf('g%05d', i), 't' || (i % 3) FROM n WHERE i % 2 = 0;

        INSERT INTO groups (id, name, fav) VALUES ('legacy.png', 'legacy', 1);
        INSERT INTO group_tags (group_id, tag_id) VALUES ('legacy.png', 't0'), ('legacy.png', 't1');
        INSERT INTO character_tags (character_id, tag_id) VALUES ('ghost.png', 't0'), ('zz-ghost.png', 't1');
        INSERT INTO group_tags (group_id, tag_id) VALUES ('ghost-group', 't0');
    `);
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_counts').get().n + db.prepare('SELECT COUNT(*) AS n FROM entity_tag_counts').get().n).toBe(0);
}

const insertCharacterSql = 'INSERT INTO characters (id, name, fav, date_added, date_last_chat, chat_size, data_size, version) VALUES (?, \'n\', ?, 0, 0, 0, 0, 0)';

let liveWriteRound = 0;
/**
 * One round of live writes on each kind, on both sides of that kind's frontier (and inside the range a fill batch
 * is about to count, when called between its page read and its transaction): an insert with tags, a delete of an
 * entity with tags, a fav flip, a tag assign and a tag unassign, each counted as the store's write path counts it
 * (another connection writing through character-metadata-db.js).
 * @param {import('better-sqlite3').Database} db
 */
function liveWrites(db) {
    liveWriteRound++;
    const r = liveWriteRound;
    const state = Object.fromEntries(fillState(db).map(row => [row.kind, row]));
    const sides = [
        { kind: 'character', table: 'characters', tagTable: 'character_tags', column: 'character_id', idOf: charId, count: CHARACTERS },
        { kind: 'group', table: 'groups', tagTable: 'group_tags', column: 'group_id', idOf: groupId, count: GROUPS },
    ];
    for (const side of sides) {
        const upto = state[side.kind].upto;
        // An existing id just below the frontier (or the first one), and one well above it.
        const below = upto === null ? side.idOf(0) : db.prepare(`SELECT id FROM ${side.table} WHERE id <= ? ORDER BY id DESC LIMIT 1`).pluck().get(upto);
        const above = db.prepare(`SELECT id FROM ${side.table} WHERE id > ? ORDER BY id LIMIT 1 OFFSET 700`).pluck().get(upto ?? '');
        for (const id of [below, above].filter(Boolean)) {
            setFavRaw(db, side.kind, id, 1 - db.prepare(`SELECT fav FROM ${side.table} WHERE id = ?`).pluck().get(id));
            insertTagRowRaw(db, side.tagTable, id, `live${r}`);
            const first = db.prepare(`SELECT MIN(tag_id) FROM ${side.tagTable} WHERE ${side.column} = ?`).pluck().get(id);
            if (first !== null) deleteTagRowRaw(db, side.tagTable, id, first);
        }
        // New entities just past the frontier and far above it, each with tags.
        const base = upto ?? side.idOf(0);
        for (const id of [`${base}~live${r}`, `z-live${r}${side.kind === 'character' ? '.png' : ''}`]) {
            insertEntityRaw(db, side.kind, id, r % 2, () => {
                if (side.kind === 'character') db.prepare(insertCharacterSql).run(id, r % 2);
                else db.prepare('INSERT INTO groups (id, name, fav) VALUES (?, \'n\', ?)').run(id, r % 2);
            });
            insertTagRowRaw(db, side.tagTable, id, 't0');
            insertTagRowRaw(db, side.tagTable, id, `live${r}`);
        }
        // Deletes of entities with tags, the entity row first as the store does: the one before `below` and the one
        // after `above`.
        const doomed = [
            below && db.prepare(`SELECT id FROM ${side.table} WHERE id < ? ORDER BY id DESC LIMIT 1`).pluck().get(below),
            above && db.prepare(`SELECT id FROM ${side.table} WHERE id > ? ORDER BY id LIMIT 1`).pluck().get(above),
        ];
        for (const id of doomed.filter(Boolean)) deleteEntityRaw(db, side.kind, id);
    }
}

describe('fillEntityCountsIfNeeded', () => {
    test('after the fill every counter equals a direct COUNT, for both kinds', async () => {
        await seedLibrary();
        const result = await metadataDb.fillEntityCountsIfNeeded(directories);
        expect(result?.batches).toBeGreaterThanOrEqual(Math.ceil(CHARACTERS / 1000) + Math.ceil(GROUPS / 1000));
        withRawDb(db => {
            expect(fullyFilledMismatches(db)).toEqual([]);
            // The seeded library really reaches every counter kind, and .png group tag rows and ghost rows count nowhere.
            expect(db.prepare('SELECT COUNT(DISTINCT kind || fav) AS n FROM entity_counts').get().n).toBe(4);
            expect(db.prepare('SELECT SUM(count) AS n FROM entity_counts WHERE kind = \'group\'').get().n).toBe(GROUPS + 1);
            expect(db.prepare('SELECT SUM(count) AS n FROM entity_tag_counts WHERE kind = \'group\'').get().n).toBe(Math.ceil(GROUPS / 2));
            expect(db.prepare('SELECT SUM(count) AS n FROM entity_tag_counts WHERE kind = \'character\' AND tag_id = \'t0\'').get().n).toBe(CHARACTERS / 5);
        });
    }, 60000);

    test('an empty store is marked done for both kinds', async () => {
        await metadataDb.ensureSchemaMigrated(directories);
        await metadataDb.fillEntityCountsIfNeeded(directories);
        withRawDb(db => {
            expect(fillState(db)).toEqual([{ kind: 'character', upto: null, done: 1 }, { kind: 'group', upto: null, done: 1 }]);
            expect(counterMismatches(db)).toEqual([]);
        });
    });

    test('live writes between batches leave the counters exact at every batch boundary and at the end', async () => {
        await seedLibrary();
        /** @type {unknown[][]} */
        const boundaries = [];
        afterCommit = () => {
            boundaries.push(counterMismatches(live()));
            liveWrites(live());
            boundaries.push(counterMismatches(live()));
        };
        await metadataDb.fillEntityCountsIfNeeded(directories);
        afterCommit = null;
        expect(boundaries.length).toBeGreaterThanOrEqual(2 * 5);
        expect(boundaries.filter(m => m.length > 0)).toEqual([]);
        withRawDb(db => expect(fullyFilledMismatches(db)).toEqual([]));
        expect(liveWriteRound).toBeGreaterThan(0);
    }, 60000);

    test('live writes between a batch\'s page read and its transaction are counted exactly', async () => {
        await seedLibrary();
        afterRead = () => liveWrites(live());
        await metadataDb.fillEntityCountsIfNeeded(directories);
        afterRead = null;
        withRawDb(db => expect(fullyFilledMismatches(db)).toEqual([]));
    }, 60000);

    test('an interrupted fill resumes from its frontier and finishes exact', async () => {
        await seedLibrary();
        transactionCalls = 0;
        crashAtTransaction = 2;
        await expect(metadataDb.fillEntityCountsIfNeeded(directories)).rejects.toThrow('simulated stop');
        crashAtTransaction = 0;
        withRawDb(db => {
            const state = fillState(db);
            expect(state[0]).toEqual({ kind: 'character', upto: charId(999), done: 0 });
            expect(counterMismatches(db)).toEqual([]);
        });
        liveWrites(live());

        metadataDb.disposeMetadataStores();
        transactionCalls = 0;
        const result = await metadataDb.fillEntityCountsIfNeeded(directories);
        // Resumed after the first committed page (c00000-c00999): only the characters past it and the groups are walked.
        expect(result?.batches).toBe(Math.ceil((CHARACTERS - 1000 + 1) / 1000) + Math.ceil((GROUPS + 1) / 1000));
        withRawDb(db => expect(fullyFilledMismatches(db)).toEqual([]));
    }, 60000);

    test('a finished store writes nothing and runs no transaction on the next run', async () => {
        await seedLibrary();
        await metadataDb.fillEntityCountsIfNeeded(directories);
        runSql = [];
        transactionCalls = 0;
        expect(await metadataDb.fillEntityCountsIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
        expect(runSql).toEqual([]);
        expect(transactionCalls).toBe(0);
    }, 60000);

    test('a kind already done is not walked again while the other kind is filled', async () => {
        await seedLibrary();
        live().prepare('UPDATE entity_count_fill SET done = 1 WHERE kind = \'character\'').run();
        live().exec(`INSERT INTO entity_counts (kind, fav, count) SELECT 'character', fav, COUNT(*) FROM characters GROUP BY fav;
            INSERT INTO entity_tag_counts (tag_id, kind, fav, count) SELECT t.tag_id, 'character', c.fav, COUNT(*)
                FROM character_tags t JOIN characters c ON c.id = t.character_id GROUP BY t.tag_id, c.fav;`);
        const result = await metadataDb.fillEntityCountsIfNeeded(directories);
        expect(result?.batches).toBe(Math.ceil((GROUPS + 1) / 1000));
        withRawDb(db => expect(fullyFilledMismatches(db)).toEqual([]));
    }, 60000);

    test('runs last in MIGRATION_PASSES', async () => {
        const { MIGRATION_PASSES } = await import('../src/metadata-migration-coordinator.js');
        expect(MIGRATION_PASSES[MIGRATION_PASSES.length - 1]).toBe('fillEntityCountsIfNeeded');
    });
});

/** @template T @param {(db: import('better-sqlite3').Database) => T} fn @returns {T} */
function withRawDb(fn) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    defineCharacterStoreFunctions({ defineFunction: (name, f) => db.function(name, { deterministic: true }, f) });
    try {
        return fn(db);
    } finally {
        db.close();
    }
}
