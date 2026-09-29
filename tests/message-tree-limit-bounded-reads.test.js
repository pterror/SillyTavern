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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-tree-limit-bounded-reads-test-'));
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

/** One chat per owner, oldest first. created_at comes from Date.now(), so the pause keeps owners from tying on recency. */
async function seedOwners(directories, ownerIds) {
    for (const ownerId of ownerIds) {
        const chatData = [{ chat_metadata: {} }, { name: 'Char', is_user: false, mes: `hi from ${ownerId}`, send_date: 'd0', extra: {}, swipes: [`hi from ${ownerId}`] }];
        await treeDb.saveChatToTree(directories, ownerId, `chat-${ownerId}`, chatData, false);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

const OWNER_READ = /^SELECT owner_id, MAX\(created_at\) AS t FROM messages GROUP BY owner_id ORDER BY t DESC LIMIT @shortlist$/;
const ownerReads = () => calls.filter(c => OWNER_READ.test(c.sql.replace(/\s+/g, ' ').trim()));

describe('listRecentBranches() reads its owner shortlist with readBounded(), bounded by the same value its LIMIT binds', () => {
    test('returns the most recent branches, the owner read bounded by the requested count', async () => {
        const directories = makeDirectories();
        await seedOwners(directories, ['owner-a', 'owner-b', 'owner-c']);

        calls.length = 0;
        const branches = await treeDb.listRecentBranches(directories, 2);

        expect(branches.map(b => b.owner_id)).toEqual(['owner-c', 'owner-b']);
        const reads = ownerReads();
        expect(reads.map(c => c.method)).toEqual(['readBounded']);
        const [params, max] = reads[0].args;
        expect(max).toBe(2);
        expect(params).toEqual({ shortlist: max });
    });

    test('a count past the shortlist cap (MAX_SAFE_INTEGER) is bounded at 500 and returns every branch', async () => {
        const directories = makeDirectories();
        await seedOwners(directories, ['owner-a', 'owner-b', 'owner-c']);

        calls.length = 0;
        const branches = await treeDb.listRecentBranches(directories, Number.MAX_SAFE_INTEGER);

        expect(branches.map(b => b.owner_id)).toEqual(['owner-c', 'owner-b', 'owner-a']);
        const [read] = ownerReads();
        expect(read.method).toBe('readBounded');
        const [params, max] = read.args;
        expect(max).toBe(500);
        expect(params).toEqual({ shortlist: max });
    });

    test.each([
        ['NaN', NaN],
        ['0', 0],
        ['a negative count', -3],
        ['undefined', undefined],
    ])('%s is treated as 1: one branch, the owner read bounded by 1', async (_label, count) => {
        const directories = makeDirectories();
        await seedOwners(directories, ['owner-a', 'owner-b']);

        calls.length = 0;
        const branches = await treeDb.listRecentBranches(directories, /** @type {number} */ (count));

        expect(branches.map(b => b.owner_id)).toEqual(['owner-b']);
        const [read] = ownerReads();
        expect(read.method).toBe('readBounded');
        const [params, max] = read.args;
        expect(max).toBe(1);
        expect(params).toEqual({ shortlist: max });
    });
});
