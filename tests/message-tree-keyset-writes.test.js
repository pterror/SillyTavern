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
            const realTransaction = handle.transaction;
            handle.transaction = (fn) => {
                calls.push({ method: 'transaction', sql: '', args: [] });
                return realTransaction(fn);
            };
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

describe('renameCharacterInMessages reads the rows to rename in keyset chunks', () => {
    const insertSql = 'INSERT INTO messages (id, parent_id, owner_id, content, label, created_at, default_child_id, metadata, identity_hash) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?)';

    /**
     * Opens the store once so it has the current schema, then writes the rows straight into its file.
     * @param {{ root: string }} directories
     * @param {string} ownerId
     * @param {{ id: string, content: string }[]} replies Children of the owner's anchor.
     */
    async function seedStore(directories, ownerId, replies) {
        await treeDb.getDbHandle(directories);
        treeDb.disposeMessageTreeStores();
        const raw = new WasmDatabase(path.join(directories.root, 'message-tree.sqlite'));
        try {
            raw.exec('BEGIN');
            raw.run(insertSql, [`${ownerId}-anchor`, null, ownerId, treeDb.ANCHOR_CONTENT, 1, null]);
            replies.forEach(({ id, content }, i) => {
                raw.run(insertSql, [id, `${ownerId}-anchor`, ownerId, content, i + 2, treeDb.identityHashOf(`${ownerId}-anchor`, content)]);
            });
            raw.exec('COMMIT');
        } finally {
            raw.close();
        }
    }

    /** @param {{ root: string }} directories */
    function readRows(directories) {
        const check = new WasmDatabase(path.join(directories.root, 'message-tree.sqlite'));
        try {
            return new Map(Array.from(check.prepare('SELECT id, content, identity_hash FROM messages WHERE parent_id IS NOT NULL').iterate(), r => [r.id, r]));
        } finally {
            check.close();
        }
    }

    test('2001 character rows: three bounded chunk reads, every one renamed and rehashed, user/system/narrator rows untouched, a rerun opens no transaction', async () => {
        const directories = makeDirectories();
        /** @type {{ id: string, content: string }[]} */
        const characterRows = [];
        for (let i = 0; i < 2001; i++) {
            characterRows.push({ id: `c${String(i).padStart(5, '0')}`, content: JSON.stringify({ ...makeMessage(`hello ${i}`), name: 'Old' }) });
        }
        const keptRows = [
            { id: 'u00000', content: JSON.stringify(makeMessage('from the user', true)) },
            { id: 's00000', content: JSON.stringify({ ...makeMessage('a system note'), name: 'Old', is_system: true }) },
            { id: 'n00000', content: JSON.stringify({ ...makeMessage('the narrator speaks'), name: 'Old', extra: { type: 'narrator' } }) },
        ];
        await seedStore(directories, 'owner-1', [...characterRows, ...keptRows]);
        await treeDb.getDbHandle(directories);

        calls.length = 0;
        expect(await treeDb.renameCharacterInMessages(directories, 'owner-1', 'New')).toBe(2001);

        const chunkSql = 'SELECT id, parent_id, content FROM messages WHERE owner_id = @ownerId AND parent_id IS NOT NULL AND json_extract(content, \'$.is_user\') IS NOT 1 AND json_extract(content, \'$.is_system\') IS NOT 1 AND COALESCE(json_extract(content, \'$.extra.type\'), \'\') != \'narrator\' AND json_extract(content, \'$.name\') IS NOT @newName AND id > @lastId ORDER BY id LIMIT @limit';
        const chunkReads = calls.filter(c => oneLine(c) === chunkSql);
        expect(chunkReads.map(c => c.method)).toEqual(['readBounded', 'readBounded', 'readBounded']);
        expect(chunkReads.map(c => c.args[0].lastId)).toEqual(['', 'c00999', 'c01999']);
        for (const read of chunkReads) {
            expect(read.args[1]).toBe(1000);
            expect(read.args[0].limit).toBe(1000);
        }
        expect(calls.filter(c => c.method === 'all' && oneLine(c).startsWith('SELECT id, parent_id, content FROM messages WHERE owner_id = @ownerId'))).toEqual([]);

        calls.length = 0;
        expect(await treeDb.renameCharacterInMessages(directories, 'owner-1', 'New')).toBe(0);
        expect(calls.filter(c => c.method === 'transaction' || c.method === 'run')).toEqual([]);

        treeDb.disposeMessageTreeStores();
        const rows = readRows(directories);
        for (const { id, content } of characterRows) {
            const expected = JSON.stringify({ ...JSON.parse(content), name: 'New' });
            expect(rows.get(id).content).toBe(expected);
            expect(rows.get(id).identity_hash).toBe(treeDb.identityHashOf('owner-1-anchor', expected));
        }
        for (const { id, content } of keptRows) {
            expect(rows.get(id).content).toBe(content);
            expect(rows.get(id).identity_hash).toBe(treeDb.identityHashOf('owner-1-anchor', content));
        }
    });

    test('a row whose rename would collide with a sibling that already has the new name and the same text keeps its old name', async () => {
        const directories = makeDirectories();
        const sibling = { id: 't00000', content: JSON.stringify({ ...makeMessage('same words'), name: 'New' }) };
        const twin = { id: 't00001', content: JSON.stringify({ ...makeMessage('same words'), name: 'Old' }) };
        await seedStore(directories, 'owner-2', [sibling, twin]);

        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(await treeDb.renameCharacterInMessages(directories, 'owner-2', 'New')).toBe(0);
        } finally {
            warn.mockRestore();
        }

        treeDb.disposeMessageTreeStores();
        const rows = readRows(directories);
        for (const { id, content } of [sibling, twin]) {
            expect(rows.get(id).content).toBe(content);
            expect(rows.get(id).identity_hash).toBe(treeDb.identityHashOf('owner-2-anchor', content));
        }
    });
});

describe('renameGroupMemberInMessages reads the member\'s rows in keyset chunks', () => {
    const insertSql = 'INSERT INTO messages (id, parent_id, owner_id, content, label, created_at, default_child_id, metadata, identity_hash) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?)';

    /**
     * Opens the store once so it has the current schema, then writes the rows straight into its file.
     * @param {{ root: string }} directories
     * @param {string} ownerId
     * @param {{ id: string, content: string }[]} replies Children of the owner's anchor.
     */
    async function seedStore(directories, ownerId, replies) {
        await treeDb.getDbHandle(directories);
        treeDb.disposeMessageTreeStores();
        const raw = new WasmDatabase(path.join(directories.root, 'message-tree.sqlite'));
        try {
            raw.exec('BEGIN');
            raw.run(insertSql, [`${ownerId}-anchor`, null, ownerId, treeDb.ANCHOR_CONTENT, 1, null]);
            replies.forEach(({ id, content }, i) => {
                raw.run(insertSql, [id, `${ownerId}-anchor`, ownerId, content, i + 2, treeDb.identityHashOf(`${ownerId}-anchor`, content)]);
            });
            raw.exec('COMMIT');
        } finally {
            raw.close();
        }
    }

    /** @param {{ root: string }} directories */
    function readRows(directories) {
        const check = new WasmDatabase(path.join(directories.root, 'message-tree.sqlite'));
        try {
            return new Map(Array.from(check.prepare('SELECT id, content, identity_hash FROM messages WHERE parent_id IS NOT NULL').iterate(), r => [r.id, r]));
        } finally {
            check.close();
        }
    }

    test('2001 rows of the member: three bounded chunk reads, every one renamed, re-avatared and rehashed, another member\'s row untouched, a rerun opens no transaction', async () => {
        const directories = makeDirectories();
        const oldAvatar = 'Old Member.png';
        const newAvatar = 'New Member.png';
        /** @type {{ id: string, content: string }[]} */
        const memberRows = [];
        for (let i = 0; i < 2001; i++) {
            const msg = { ...makeMessage(`hello ${i}`), name: 'Old', original_avatar: oldAvatar };
            if (i % 2 === 0) msg.force_avatar = `/thumbnail?type=avatar&file=${encodeURIComponent(oldAvatar)}`;
            memberRows.push({ id: `g${String(i).padStart(5, '0')}`, content: JSON.stringify(msg) });
        }
        const otherRow = { id: 'o00000', content: JSON.stringify({ ...makeMessage('someone else'), name: 'Other', original_avatar: 'Other.png', force_avatar: `/thumbnail?type=avatar&file=${encodeURIComponent('Other.png')}` }) };
        await seedStore(directories, 'group-1', [...memberRows, otherRow]);
        await treeDb.getDbHandle(directories);

        calls.length = 0;
        expect(await treeDb.renameGroupMemberInMessages(directories, 'group-1', oldAvatar, newAvatar, 'New')).toBe(2001);

        const chunkSql = 'SELECT id, content FROM messages WHERE owner_id = @groupOwnerId AND parent_id IS NOT NULL AND json_extract(content, \'$.original_avatar\') = @oldAvatar AND id > @lastId ORDER BY id LIMIT @limit';
        const chunkReads = calls.filter(c => oneLine(c) === chunkSql);
        expect(chunkReads.map(c => c.method)).toEqual(['readBounded', 'readBounded', 'readBounded']);
        expect(chunkReads.map(c => c.args[0].lastId)).toEqual(['', 'g00999', 'g01999']);
        for (const read of chunkReads) {
            expect(read.args[1]).toBe(1000);
            expect(read.args[0].limit).toBe(1000);
        }
        expect(calls.filter(c => c.method === 'all' && oneLine(c).startsWith('SELECT id, content FROM messages WHERE owner_id = @groupOwnerId'))).toEqual([]);

        calls.length = 0;
        expect(await treeDb.renameGroupMemberInMessages(directories, 'group-1', oldAvatar, newAvatar, 'New')).toBe(0);
        expect(calls.filter(c => c.method === 'transaction' || c.method === 'run')).toEqual([]);

        treeDb.disposeMessageTreeStores();
        const rows = readRows(directories);
        for (const { id, content } of memberRows) {
            const msg = { ...JSON.parse(content), name: 'New', original_avatar: newAvatar };
            if (typeof msg.force_avatar === 'string') msg.force_avatar = `/thumbnail?type=avatar&file=${encodeURIComponent(newAvatar)}`;
            const expected = JSON.stringify(msg);
            expect(rows.get(id).content).toBe(expected);
            expect(rows.get(id).identity_hash).toBe(treeDb.identityHashOf('group-1-anchor', expected));
        }
        expect(rows.get(otherRow.id).content).toBe(otherRow.content);
        expect(rows.get(otherRow.id).identity_hash).toBe(treeDb.identityHashOf('group-1-anchor', otherRow.content));
    });
});
