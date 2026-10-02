import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import Database from 'better-sqlite3';
import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import { openNativeDatabase, openWasmDatabase } from '../src/endpoints/sqlite-engine.js';

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
    CREATE TABLE fired (n INTEGER);
    INSERT INTO fired VALUES (0);
    CREATE TRIGGER t_au AFTER UPDATE ON t BEGIN UPDATE fired SET n = n + 1; END;
`;

describe.each([
    ['native', (/** @type {string} */ file) => openNativeDatabase(Database, file)],
    ['wasm', (/** @type {string} */ file) => openWasmDatabase(WasmDatabase, file)],
])('the %s engine skips writes that change nothing', (_kind, open) => {
    test('an UPDATE or upsert that sets stored values touches no row and fires no trigger; a real change does', () => {
        const db = open(path.join(tempDir(), 'x.sqlite'));
        try {
            db.exec(SCHEMA);
            db.run('INSERT INTO t (id, a, b) VALUES (@id, @a, @b)', { id: 'x', a: 'hello', b: 1 });
            const fired = () => db.get('SELECT n FROM fired').n;

            expect(db.run('UPDATE t SET a = @a, b = @b WHERE id = @id', { id: 'x', a: 'hello', b: 1 }).changes).toBe(0);
            expect(db.run('INSERT INTO t (id, a, b) VALUES (@id, @a, @b) ON CONFLICT(id) DO UPDATE SET a = excluded.a, b = excluded.b',
                { id: 'x', a: 'hello', b: 1 }).changes).toBe(0);
            expect(db.run('UPDATE t SET b = b + @d WHERE id = @id', { id: 'x', d: 0 }).changes).toBe(0);
            expect(fired()).toBe(0);

            expect(db.run('UPDATE t SET a = @a, b = @b WHERE id = @id', { id: 'x', a: 'hello', b: 2 }).changes).toBe(1);
            expect(db.run('INSERT INTO t (id, a, b) VALUES (@id, @a, @b) ON CONFLICT(id) DO UPDATE SET a = excluded.a, b = excluded.b',
                { id: 'x', a: 'bye', b: 2 }).changes).toBe(1);
            expect(fired()).toBe(2);
            expect(db.get('SELECT a, b FROM t WHERE id = @id', { id: 'x' })).toEqual({ a: 'bye', b: 2 });
        } finally {
            db.close();
        }
    });
});

describe('a write that changes nothing adds no WAL frames', () => {
    test('engine: same-value UPDATE, same-value upsert, delete of a missing row', () => {
        const file = path.join(tempDir(), 'x.sqlite');
        const db = openNativeDatabase(Database, file);
        try {
            db.exec(SCHEMA);
            db.run('INSERT INTO t (id, a, b) VALUES (@id, @a, @b)', { id: 'x', a: 'hello', b: 1 });
            walFrames(file, { reset: true });
            db.run('UPDATE t SET a = @a WHERE id = @id', { id: 'x', a: 'hello' });
            db.run('INSERT INTO t (id, a, b) VALUES (@id, @a, @b) ON CONFLICT(id) DO UPDATE SET a = excluded.a', { id: 'x', a: 'hello', b: 1 });
            db.run('DELETE FROM t WHERE id = @id', { id: 'nope' });
            expect(walFrames(file)).toBe(0);
            db.run('UPDATE t SET a = @a WHERE id = @id', { id: 'x', a: 'changed' });
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
                return db.prepare('SELECT COUNT(*) AS n FROM changes').get().n;
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

        const changed = JSON.stringify({ ...JSON.parse(card), data: { name: 'Rex', description: 'a good dog', extensions: {} } });
        await metadataDb.upsertCharacterFromWrite(directories, 'rex.png', changed);
        expect(walFrames(file)).toBeGreaterThan(0);
        expect(changesRows()).toBe(before + 1);
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
    });
});
