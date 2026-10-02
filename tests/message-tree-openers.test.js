import { describe, test, expect, jest, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import Database from 'better-sqlite3';
import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import { isBusyError, openWasmDatabase, streamRows } from '../src/endpoints/sqlite-engine.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    getSqliteEngine: async () => ({
        kind: 'wasm',
        openDatabase: (dbPath, options) => openWasmDatabase(WasmDatabase, dbPath, options),
    }),
    openWasmDatabase,
    openNativeDatabase: jest.fn(),
    streamRows,
    isBusyError,
}));

/** @type {typeof import('../src/message-tree-db.js')} */
let treeDb;
/** @type {typeof import('../src/message-stats.js')} */
let stats;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    treeDb = await import('../src/message-tree-db.js');
    stats = await import('../src/message-stats.js');
});

const tmpDirs = [];

afterEach(() => {
    treeDb.disposeMessageTreeStores();
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const T0 = Date.parse('2026-09-01T10:00:00.000Z');

async function seed() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-tree-openers-test-'));
    tmpDirs.push(root);
    const directories = { root };
    const saved = /** @type {any} */ (await treeDb.saveChatToTree(directories, 'rex', 'main', [
        { chat_metadata: {} },
        { name: 'Rex', is_user: false, mes: 'Welcome.', send_date: T0, extra: {} },
        { name: 'User', is_user: true, mes: 'hello there', send_date: T0 + 1000, extra: {} },
        { name: 'Rex', is_user: false, mes: 'one two three', send_date: T0 + 2000, extra: {} },
    ]));
    const replyId = saved.assignedNodeIds.at(-1).node_id;
    treeDb.disposeMessageTreeStores();
    return { directories, file: path.join(root, 'message-tree.sqlite'), replyId };
}

/** @param {import('better-sqlite3').Database} db */
function charWords(db) {
    return db.prepare('SELECT char_words FROM owner_message_stats WHERE owner_id = ?').get('rex')?.char_words;
}

/** @param {import('better-sqlite3').Database} db @param {string} id */
function editReply(db, id) {
    const content = JSON.parse(db.prepare('SELECT content FROM messages WHERE id = ?').get(id).content);
    content.mes = 'one two three four five';
    return db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(JSON.stringify(content), id);
}

describe('every connection that writes message rows keeps the stats', () => {
    test('a script connection opened through openNativeTreeDatabase writes and updates the counters', async () => {
        const { file, replyId } = await seed();
        const db = stats.openNativeTreeDatabase(Database, file, { fileMustExist: true });
        try {
            expect(charWords(db)).toBe(3);
            editReply(db, replyId);
            expect(charWords(db)).toBe(5);
        } finally {
            db.close();
        }
    });

    test('a connection without the functions has the write refused, and nothing changes', async () => {
        const { file, replyId } = await seed();
        const db = new Database(file, { fileMustExist: true });
        try {
            expect(() => editReply(db, replyId)).toThrow(/no such function/);
            expect(JSON.parse(db.prepare('SELECT content FROM messages WHERE id = ?').get(replyId).content).mes).toBe('one two three');
        } finally {
            db.close();
        }
    });

    test('a fresh connection opened the way a worker opens it can write', async () => {
        const { directories, replyId } = await seed();
        const result = await treeDb.appendMessages(directories, 'rex', replyId, [
            { name: 'User', is_user: true, mes: 'again', send_date: T0 + 3000, extra: {} },
        ]);
        expect(result.ok).toBe(true);
        const read = await treeDb.readMessageStats(directories, ['rex']);
        expect(read.owners.get('rex').user_msgs).toBe(2);
    });
});

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(full);
    }
    return out;
}

describe('nothing under src/ opens the tree without the stats functions', () => {
    const srcDir = path.join(process.cwd(), '..', 'src');

    test('every direct open of message-tree.sqlite goes through openNativeTreeDatabase', () => {
        const offenders = [];
        for (const file of sourceFiles(srcDir)) {
            const text = fs.readFileSync(file, 'utf8');
            if (!text.includes('message-tree.sqlite')) continue;
            for (const match of text.matchAll(/(new Database|openReadOnly|openDatabase)\(([^)]*)\)/g)) {
                if (/tree/i.test(match[2])) offenders.push(`${path.relative(srcDir, file)}: ${match[0]}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('message-tree-db.js registers the functions on the connection it opens, before its schema', () => {
        const text = fs.readFileSync(path.join(srcDir, 'message-tree-db.js'), 'utf8');
        const open = text.indexOf('engine.openDatabase(getDbPath(directories))');
        const define = text.indexOf('defineMessageStatsFunctions(db)', open);
        const schema = text.indexOf('db.exec(SCHEMA_SQL)', open);
        expect(open).toBeGreaterThan(-1);
        expect(define).toBeGreaterThan(open);
        expect(schema).toBeGreaterThan(define);
    });
});
