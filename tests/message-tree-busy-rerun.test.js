import { describe, test, expect, jest, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import { isBusyError, openWasmDatabase, streamRows } from '../src/endpoints/sqlite-engine.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

// How many upcoming transactions to run once, roll back, and run again: what the engine does when a
// transaction hits busy partway through.
let rerunNext = 0;
const ROLLBACK = new Error('simulated busy');

jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    getSqliteEngine: async () => ({
        kind: 'wasm',
        openDatabase: (dbPath, options) => {
            const handle = openWasmDatabase(WasmDatabase, dbPath, options);
            const realTransaction = handle.transaction;
            handle.transaction = (fn) => {
                if (rerunNext > 0) {
                    rerunNext--;
                    try {
                        realTransaction(() => { fn(); throw ROLLBACK; });
                    } catch (error) {
                        if (error !== ROLLBACK) throw error;
                    }
                }
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-tree-busy-rerun-test-'));
    tmpDirs.push(root);
    return { root };
}

afterEach(() => {
    rerunNext = 0;
    treeDb.disposeMessageTreeStores();
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** @param {string} mes @param {boolean} [isUser] */
function makeMessage(mes, isUser = false) {
    return { name: isUser ? 'User' : 'Char', is_user: isUser, mes, send_date: 'd', extra: {}, swipes: [mes] };
}

/** @param {{ root: string }} directories @param {string} sql @param {any[]} [params] */
function readRows(directories, sql, params = []) {
    treeDb.disposeMessageTreeStores();
    const db = new WasmDatabase(path.join(directories.root, 'message-tree.sqlite'));
    try {
        return db.all(sql, params);
    } finally {
        db.close();
    }
}

/** @param {{ root: string }} directories */
async function seedChat(directories) {
    const saved = /** @type {any} */ (await treeDb.saveChatToTree(directories, 'owner-1', 'main', [
        { chat_metadata: {} },
        makeMessage('hi', true),
        makeMessage('hello'),
    ]));
    return saved.assignedNodeIds.map(a => a.node_id);
}

describe('a tree write rerun after busy starts over from the database, not from the attempt that was rolled back', () => {
    test('addAlternatives: an alternative added on the rerun is stored, and its returned id exists', async () => {
        const directories = makeDirectories();
        const [, replyId] = await seedChat(directories);

        rerunNext = 1;
        const result = await treeDb.addAlternatives(directories, 'owner-1', replyId, [makeMessage('another hello')]);

        expect(result.ok).toBe(true);
        expect(result.added).toBe(1);
        expect(result.node_ids).toHaveLength(1);
        const stored = readRows(directories, 'SELECT id, content FROM messages WHERE id = ?', [result.node_ids[0]]);
        expect(stored).toHaveLength(1);
        expect(JSON.parse(stored[0].content).mes).toBe('another hello');
    });

    test('saveChatToTree: each message gets one assigned id, and every id exists', async () => {
        const directories = makeDirectories();
        rerunNext = 1;
        const saved = /** @type {any} */ (await treeDb.saveChatToTree(directories, 'owner-1', 'main', [
            { chat_metadata: {} },
            makeMessage('hi', true),
            makeMessage('hello'),
        ]));

        expect(saved.assignedNodeIds.map(a => a.index)).toEqual([0, 1]);
        const ids = saved.assignedNodeIds.map(a => a.node_id);
        const stored = readRows(directories, 'SELECT id FROM messages WHERE id IN (?, ?)', ids);
        expect(stored).toHaveLength(2);
    });

    test('appendMessages: one id per message, and every id exists', async () => {
        const directories = makeDirectories();
        const [, replyId] = await seedChat(directories);

        rerunNext = 1;
        const result = await treeDb.appendMessages(directories, 'owner-1', replyId, [makeMessage('and you?', true), makeMessage('fine')]);

        expect(result.ok).toBe(true);
        expect(result.node_ids).toHaveLength(2);
        const stored = readRows(directories, 'SELECT id FROM messages WHERE id IN (?, ?)', result.node_ids);
        expect(stored).toHaveLength(2);
    });

    test('editMessages: the applied count and the refusals are counted once', async () => {
        const directories = makeDirectories();
        const [, replyId] = await seedChat(directories);

        rerunNext = 1;
        const result = await treeDb.editMessages(directories, 'owner-1', [
            { node_id: replyId, content: makeMessage('hello there') },
            { node_id: 'no-such-node', content: makeMessage('x') },
        ]);

        expect(result.applied).toBe(1);
        expect(result.refused.map(r => r.node_id)).toEqual(['no-such-node']);
    });

    test('addOpeningAlternatives: one id per opening and the added count is counted once', async () => {
        const directories = makeDirectories();

        rerunNext = 1;
        const result = await treeDb.addOpeningAlternatives(directories, 'owner-1', [makeMessage('greeting one'), makeMessage('greeting two')]);

        expect(result.added).toBe(2);
        expect(result.node_ids).toHaveLength(2);
        const stored = readRows(directories, 'SELECT id FROM messages WHERE id IN (?, ?)', result.node_ids);
        expect(stored).toHaveLength(2);
    });

    test('renameCharacterInMessages: the renamed count is counted once', async () => {
        const directories = makeDirectories();
        await seedChat(directories);

        rerunNext = 1;
        const updated = await treeDb.renameCharacterInMessages(directories, 'owner-1', 'Renamed');

        expect(updated).toBe(1);
    });
});
