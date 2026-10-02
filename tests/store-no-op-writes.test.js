import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import Database from 'better-sqlite3';
import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import { openNativeDatabase, openWasmDatabase } from '../src/endpoints/sqlite-engine.js';
import { writeRowIfChanged } from '../src/row-values.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/message-tree-db.js')} */
let treeDb;
/** @type {typeof import('../src/message-tree-meta.js')} */
let treeMeta;

beforeAll(async () => {
    const util = await import('../src/util.js');
    util.setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    treeDb = await import('../src/message-tree-db.js');
    treeMeta = await import('../src/message-tree-meta.js');
});

const tmpDirs = [];

afterEach(() => {
    metadataDb.disposeMetadataStores();
    treeDb.disposeMessageTreeStores();
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-store-no-op-writes-test-'));
    tmpDirs.push(dir);
    return dir;
}

/**
 * Frames the WAL holds since it was last reset, read through a second connection. `reset` folds and empties it first.
 * @param {string} file
 * @param {{ reset?: boolean }} [options]
 */
function walFrames(file, { reset = false } = {}) {
    const db = new Database(file);
    try {
        if (reset) db.pragma('wal_checkpoint(TRUNCATE)');
        return db.pragma('wal_checkpoint(PASSIVE)')[0].log;
    } finally {
        db.close();
    }
}

const SCHEMA = `
    CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT, b INTEGER);
    CREATE TABLE fired (col TEXT);
    CREATE TRIGGER t_au_a AFTER UPDATE OF a ON t BEGIN INSERT INTO fired VALUES ('a'); END;
    CREATE TRIGGER t_au_b AFTER UPDATE OF b ON t BEGIN INSERT INTO fired VALUES ('b'); END;
`;

/**
 * Adds a trigger, through a second connection, that logs each statement naming one of `columns` in its SET.
 * @param {string} file
 * @param {string} table
 * @param {string[]} columns
 * @returns {() => string[]} The columns logged so far.
 */
function logColumnWrites(file, table, columns) {
    const db = new Database(file);
    try {
        db.exec('CREATE TABLE IF NOT EXISTS test_column_writes (col TEXT)');
        for (const column of columns) {
            db.exec(`CREATE TRIGGER test_log_${table}_${column} AFTER UPDATE OF ${column} ON ${table} BEGIN INSERT INTO test_column_writes VALUES ('${column}'); END`);
        }
    } finally {
        db.close();
    }
    return () => {
        const reader = new Database(file, { readonly: true });
        try {
            return Array.from(reader.prepare('SELECT col FROM test_column_writes').iterate(), (/** @type {any} */ r) => r.col);
        } finally {
            reader.close();
        }
    };
}

describe.each([
    ['native', (/** @type {string} */ file) => openNativeDatabase(Database, file)],
    ['wasm', (/** @type {string} */ file) => openWasmDatabase(WasmDatabase, file)],
])('writeRowIfChanged on the %s engine', (_kind, open) => {
    test('writes nothing for stored values, only the changed column for a change, and inserts only when asked', () => {
        const file = path.join(tempDir(), 'x.sqlite');
        const db = open(file);
        try {
            db.exec(SCHEMA);
            db.run('INSERT INTO t (id, a, b) VALUES (@id, @a, @b)', { id: 'x', a: 'hello', b: 1 });
            const fired = () => Array.from(db.iterate('SELECT col FROM fired'), (/** @type {any} */ r) => r.col);

            expect(writeRowIfChanged(db, 't', { id: 'x' }, { a: 'hello', b: 1 })).toBe(false);
            expect(writeRowIfChanged(db, 't', { id: 'x' }, { a: 'hello', b: '1' })).toBe(false);
            expect(writeRowIfChanged(db, 't', { id: 'x' }, { a: 'hello' }, { insert: true })).toBe(false);
            expect(fired()).toEqual([]);

            expect(writeRowIfChanged(db, 't', { id: 'x' }, { a: 'hello', b: 2 })).toBe(true);
            expect(fired()).toEqual(['b']);
            expect(db.get('SELECT a, b FROM t WHERE id = @id', { id: 'x' })).toEqual({ a: 'hello', b: 2 });

            expect(writeRowIfChanged(db, 't', { id: 'y' }, { a: 'new' })).toBe(false);
            expect(db.get('SELECT 1 AS present FROM t WHERE id = @id', { id: 'y' })).toBeUndefined();
            expect(writeRowIfChanged(db, 't', { id: 'y' }, { a: 'new' }, { insert: true })).toBe(true);
            expect(db.get('SELECT a, b FROM t WHERE id = @id', { id: 'y' })).toEqual({ a: 'new', b: null });
        } finally {
            db.close();
        }
    });

    test('no SQL is rewritten: a hand-written same-value UPDATE runs as written', () => {
        const db = open(path.join(tempDir(), 'x.sqlite'));
        try {
            db.exec(SCHEMA);
            db.run('INSERT INTO t (id, a, b) VALUES (@id, @a, @b)', { id: 'x', a: 'hello', b: 1 });
            expect(db.run('UPDATE t SET a = @a WHERE id = @id', { id: 'x', a: 'hello' }).changes).toBe(1);
        } finally {
            db.close();
        }
    });
});

describe('a write that changes nothing adds no WAL frames', () => {
    test('writeRowIfChanged: same values, a missing row without insert', () => {
        const file = path.join(tempDir(), 'x.sqlite');
        const db = openNativeDatabase(Database, file);
        try {
            db.exec(SCHEMA);
            db.run('INSERT INTO t (id, a, b) VALUES (@id, @a, @b)', { id: 'x', a: 'hello', b: 1 });
            walFrames(file, { reset: true });
            writeRowIfChanged(db, 't', { id: 'x' }, { a: 'hello', b: 1 });
            writeRowIfChanged(db, 't', { id: 'x' }, { a: 'hello' }, { insert: true });
            writeRowIfChanged(db, 't', { id: 'nope' }, { a: 'hello' });
            db.run('DELETE FROM t WHERE id = @id', { id: 'nope' });
            expect(walFrames(file)).toBe(0);
            writeRowIfChanged(db, 't', { id: 'x' }, { a: 'changed' });
            expect(walFrames(file)).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    });

    test('character store: writing the same card again, the same fav, deleting a character that isn\'t there', async () => {
        const root = tempDir();
        const directories = /** @type {any} */ ({
            root,
            characters: path.join(root, 'characters'),
            chats: path.join(root, 'chats'),
            groups: path.join(root, 'groups'),
            groupChats: path.join(root, 'groupChats'),
        });
        for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const card = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Rex', data: { name: 'Rex', description: 'a dog', extensions: {} } });
        await metadataDb.upsertCharacterFromWrite(directories, 'rex.png', card);
        await metadataDb.setCharacterFav(directories, 'rex.png', true);
        const file = path.join(root, 'character-metadata.sqlite');
        const changesRows = () => {
            const db = new Database(file, { readonly: true });
            try {
                // The log's current seq: a change moves it by one, whether it adds a row or replaces the id's row.
                return db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM changes').get().n;
            } finally {
                db.close();
            }
        };
        const before = changesRows();
        walFrames(file, { reset: true });

        await metadataDb.upsertCharacterFromWrite(directories, 'rex.png', card);
        expect(walFrames(file)).toBe(0);
        await metadataDb.setCharacterFav(directories, 'rex.png', true);
        expect(walFrames(file)).toBe(0);
        await metadataDb.deleteCharacterRow(directories, 'nobody.png');
        expect(walFrames(file)).toBe(0);
        expect(changesRows()).toBe(before);

        // A change to the card writes the card, not the columns it leaves alone.
        const columnWrites = logColumnWrites(file, 'characters', ['fav', 'name', 'date_added']);
        const changed = JSON.stringify({ ...JSON.parse(card), data: { name: 'Rex', description: 'a good dog', extensions: {} } });
        await metadataDb.upsertCharacterFromWrite(directories, 'rex.png', changed);
        expect(walFrames(file)).toBeGreaterThan(0);
        expect(changesRows()).toBe(before + 1);
        expect(columnWrites()).toEqual([]);
    });

    test('message tree store: the same meta value, the same node metadata', async () => {
        const root = tempDir();
        const directories = /** @type {any} */ ({ root });
        const saved = /** @type {any} */ (await treeDb.saveChatToTree(directories, 'rex', 'main', [
            { chat_metadata: {} },
            { name: 'Rex', is_user: false, mes: 'Welcome.', send_date: 1, extra: {} },
        ]));
        const nodeId = saved.assignedNodeIds.at(-1).node_id;
        const db = /** @type {any} */ (await treeDb.getMessageTreeDb(directories));
        treeMeta.setTreeMetaSync(db, 'k', 'v');
        treeMeta.addTreeMetaSync(db, 'n', 3);
        treeDb.setNodeMetadataSync(db, nodeId, '{"a":1}');
        const file = path.join(root, 'message-tree.sqlite');
        walFrames(file, { reset: true });

        treeMeta.setTreeMetaSync(db, 'k', 'v');
        treeMeta.addTreeMetaSync(db, 'n', 0);
        treeDb.setNodeMetadataSync(db, nodeId, '{"a":1}');
        treeMeta.deleteTreeMetaSync(db, ['missing']);
        expect(walFrames(file)).toBe(0);

        treeMeta.setTreeMetaSync(db, 'k', 'w');
        expect(walFrames(file)).toBeGreaterThan(0);

        // A change to one column writes only that column.
        const columnWrites = logColumnWrites(file, 'messages', ['metadata', 'label', 'content', 'parent_id', 'identity_hash']);
        treeDb.setNodeMetadataSync(db, nodeId, '{"a":2}');
        expect(columnWrites()).toEqual(['metadata']);
        const { label } = db.get('SELECT label FROM messages WHERE id = @id', { id: nodeId });
        treeDb.labelNodeSync(db, nodeId, label, '{"a":3}');
        expect(columnWrites()).toEqual(['metadata', 'metadata']);
    });
});
