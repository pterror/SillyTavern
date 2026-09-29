import { describe, test, expect, jest, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import { isBusyError, openWasmDatabase, streamRows } from '../src/endpoints/sqlite-engine.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

// Records every engine call's method, SQL and arguments.
/** @type {{ method: string, sql: string, args: any[] }[]} */
const calls = [];

jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    getSqliteEngine: async () => ({
        kind: 'wasm',
        openDatabase: (dbPath, options) => {
            const handle = openWasmDatabase(WasmDatabase, dbPath, options);
            for (const method of ['all', 'get', 'iterate', 'run', 'readBounded']) {
                const real = handle[method];
                handle[method] = (sql, ...args) => {
                    calls.push({ method, sql, args });
                    return real(sql, ...args);
                };
            }
            return handle;
        },
    }),
    openWasmDatabase,
    openNativeDatabase: jest.fn(),
    streamRows,
    isBusyError,
}));

/** @type {typeof import('../src/message-tree-db.js')} */
let treeDb;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    treeDb = await import('../src/message-tree-db.js');
});

const tmpDirs = [];

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-tree-keyset-writes-test-'));
    tmpDirs.push(root);
    return { root };
}

afterEach(() => {
    treeDb.disposeMessageTreeStores();
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    calls.length = 0;
});

/** @param {{ sql: string }} call */
const oneLine = (call) => call.sql.replace(/\s+/g, ' ').trim();

/** @param {string} mes @param {boolean} [isUser] */
function makeMessage(mes, isUser = false) {
    return { name: isUser ? 'User' : 'Char', is_user: isUser, mes, send_date: 'd', extra: {}, swipes: [mes] };
}

describe('migrateIdentityHashSync reads the rows to hash in keyset chunks', () => {
    test('2001 non-anchor rows in a store that predates identity_hash: three bounded chunk reads, every row hashed, the anchor left NULL, the index added', async () => {
        const directories = makeDirectories();
        const anchorContent = treeDb.ANCHOR_CONTENT;
        /** @type {{ id: string, content: string }[]} */
        const replies = [];
        for (let i = 0; i < 2001; i++) {
            replies.push({ id: `m${String(i).padStart(5, '0')}`, content: JSON.stringify(makeMessage(`hello ${i}`)) });
        }

        const raw = new WasmDatabase(path.join(directories.root, 'message-tree.sqlite'));
        try {
            raw.exec(`CREATE TABLE messages (
                id               TEXT PRIMARY KEY,
                parent_id        TEXT REFERENCES messages(id),
                owner_id         TEXT NOT NULL,
                content          TEXT NOT NULL,
                label            TEXT,
                created_at       INTEGER NOT NULL,
                default_child_id TEXT REFERENCES messages(id),
                metadata         TEXT
            )`);
            raw.run('INSERT INTO messages (id, parent_id, owner_id, content, label, created_at, default_child_id, metadata) VALUES (?, NULL, ?, ?, NULL, 1, NULL, NULL)',
                ['anchor', 'owner-1', anchorContent]);
            raw.exec('BEGIN');
            replies.forEach(({ id, content }, i) => {
                raw.run('INSERT INTO messages (id, parent_id, owner_id, content, label, created_at, default_child_id, metadata) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
                    [id, 'anchor', 'owner-1', content, i === 0 ? 'main' : null, i + 2]);
            });
            raw.exec('COMMIT');
            raw.run('UPDATE messages SET default_child_id = ? WHERE id = ?', [replies[0].id, 'anchor']);
        } finally {
            raw.close();
        }

        calls.length = 0;
        const loaded = await treeDb.loadBranch(directories, 'owner-1', 'main');

        expect(loaded.messages.map(m => [m.node_id, m.mes])).toEqual([[replies[0].id, 'hello 0']]);

        const chunkSql = 'SELECT id, parent_id, content FROM messages WHERE parent_id IS NOT NULL AND identity_hash IS NULL AND id > ? ORDER BY id LIMIT ?';
        const chunkReads = calls.filter(c => oneLine(c) === chunkSql);
        expect(chunkReads.map(c => c.method)).toEqual(['readBounded', 'readBounded', 'readBounded']);
        for (const read of chunkReads) {
            expect(read.args[1]).toBe(1000);
            expect(read.args[0][1]).toBe(1000);
        }
        expect(calls.filter(c => c.method === 'all' && oneLine(c).includes('identity_hash IS NULL'))).toEqual([]);

        treeDb.disposeMessageTreeStores();
        const check = new WasmDatabase(path.join(directories.root, 'message-tree.sqlite'));
        try {
            expect(check.get('SELECT identity_hash AS h FROM messages WHERE id = ?', ['anchor'])).toEqual({ h: null });
            const hashes = new Map(Array.from(check.prepare('SELECT id, identity_hash AS h FROM messages WHERE parent_id IS NOT NULL').iterate(), r => [r.id, r.h]));
            expect(hashes.size).toBe(2001);
            for (const { id, content } of replies) {
                expect(hashes.get(id)).toBe(treeDb.identityHashOf('anchor', content));
            }
            expect(check.get('SELECT COUNT(*) AS c FROM sqlite_master WHERE type = \'index\' AND name = \'idx_messages_identity\'')).toEqual({ c: 1 });
        } finally {
            check.close();
        }
    });
});
