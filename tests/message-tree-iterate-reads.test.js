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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-tree-iterate-reads-test-'));
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

/**
 * Asserts the recorder saw `sql` (whitespace collapsed) at least once, every time through iterate(), and never through all().
 * @param {string} sql
 */
function expectReadThroughIterate(sql) {
    const wanted = sql.replace(/\s+/g, ' ').trim();
    const matches = calls.filter(c => oneLine(c) === wanted);
    expect({ sql: wanted, methods: [...new Set(matches.map(c => c.method))] }).toEqual({ sql: wanted, methods: ['iterate'] });
}

const PATH_SQL = `
    WITH RECURSIVE path(id, parent_id, owner_id, content, label, created_at, default_child_id, metadata, depth) AS (
        SELECT id, parent_id, owner_id, content, label, created_at, default_child_id, metadata, 0
        FROM messages WHERE id = @leafId
        UNION ALL
        SELECT m.id, m.parent_id, m.owner_id, m.content, m.label, m.created_at, m.default_child_id, m.metadata, p.depth + 1
        FROM messages m JOIN path p ON m.id = p.parent_id
    )
    SELECT id, parent_id, owner_id, content, label, created_at, default_child_id, metadata FROM path ORDER BY depth DESC`;
const FORK_SIBLINGS_SQL = `
    WITH RECURSIVE sub(id, root_child, label) AS (
        SELECT id, id, label FROM messages WHERE parent_id = @messageId
        UNION ALL
        SELECT m.id, s.root_child, m.label FROM messages m JOIN sub s ON m.parent_id = s.id
    )
    SELECT id, root_child AS childId, label AS name FROM sub WHERE label IS NOT NULL`;
/** @param {number} n */
const siblingsBatchSql = n => `SELECT id, parent_id, content FROM messages WHERE parent_id IN (${Array.from({ length: n }, (_, i) => '@p' + i).join(',')}) ORDER BY created_at ASC, id ASC`;
/** @param {number} n */
const childIdsBatchSql = n => `SELECT id, parent_id FROM messages WHERE parent_id IN (${Array.from({ length: n }, (_, i) => '@p' + i).join(',')})`;
const SIBLINGS_SQL = 'SELECT id, content FROM messages WHERE parent_id = @parentId ORDER BY created_at ASC, id ASC';
const LABELED_NODES_SQL = 'SELECT * FROM messages WHERE owner_id = @ownerId AND label IS NOT NULL ORDER BY created_at ASC, id ASC';
const CHILDREN_BY_P_SQL = 'SELECT id, content FROM messages WHERE parent_id = @p ORDER BY created_at ASC, id ASC';
const LABELS_SQL = 'SELECT id, label, created_at, content FROM messages WHERE owner_id = @ownerId AND label IS NOT NULL ORDER BY created_at ASC, id ASC';

/** @param {string} mes @param {boolean} [isUser] */
function makeMessage(mes, isUser = false) {
    return { name: isUser ? 'User' : 'Char', is_user: isUser, mes, send_date: 'd', extra: {}, swipes: [mes] };
}

/**
 * One owner, chat "main" = hello → q → a, then a second reply "a2" beside "a" bookmarked as "alt-bookmark".
 * @returns {Promise<{ directories: { root: string }, ids: string[], altId: string }>}
 */
async function seedTree() {
    const directories = makeDirectories();
    await treeDb.saveChatToTree(directories, 'owner-1', 'main',
        [{ chat_metadata: {} }, makeMessage('hello'), makeMessage('q', true), makeMessage('a')], false);
    const loaded = await treeDb.loadBranch(directories, 'owner-1', 'main');
    const ids = loaded.messages.map(m => m.node_id);
    const added = await treeDb.addAlternatives(directories, 'owner-1', ids[2], [makeMessage('a2')]);
    expect(added).toMatchObject({ ok: true, added: 1, total: 2 });
    const altId = added.node_ids[0];
    expect(await treeDb.labelNode(directories, altId, 'alt-bookmark')).toEqual({ ok: true, label: 'alt-bookmark' });
    return { directories, ids, altId };
}

describe('message-tree reads of one chat\'s path or subtree, one parent\'s children or labels, and IN (...) batches use iterate()', () => {
    test('loadBranch(): the path, the siblings and child-id batches and the fork-siblings walk go through iterate()', async () => {
        const { directories, ids, altId } = await seedTree();

        calls.length = 0;
        const loaded = await treeDb.loadBranch(directories, 'owner-1', 'main');

        expect(loaded.messages.map(m => m.mes)).toEqual(['hello', 'q', 'a']);
        expect(loaded.messages.map(m => m.node_id)).toEqual(ids);
        // The path's parents are the anchor, hello and q; the child-id batch is over hello, q and a.
        expect(loaded.messages[2].swipes).toEqual(['a', 'a2']);
        expect(loaded.messages[2].swipe_info.map(s => s.node_id)).toEqual([ids[2], altId]);
        expect(loaded.messages.slice(0, 2).map(m => m.swipes)).toEqual([undefined, undefined]);
        expect(loaded.messages[1].extra.branches).toEqual(['alt-bookmark']);
        expect(loaded.messages[0].extra.branches).toBeUndefined();
        expect(loaded.messages[2].extra.branches).toBeUndefined();

        expectReadThroughIterate(PATH_SQL);
        expectReadThroughIterate(siblingsBatchSql(3));
        expectReadThroughIterate(childIdsBatchSql(3));
        expectReadThroughIterate(FORK_SIBLINGS_SQL);
    });

    test('addAlternatives(): the parent\'s children read goes through iterate()', async () => {
        const { directories, ids, altId } = await seedTree();

        calls.length = 0;
        const result = await treeDb.addAlternatives(directories, 'owner-1', ids[2], [makeMessage('a'), makeMessage('a3')]);

        expect(result.ok).toBe(true);
        expect(result.added).toBe(1);
        expect(result.total).toBe(3);
        expect(result.node_ids[0]).toBe(ids[2]);
        expect([ids[2], altId]).not.toContain(result.node_ids[1]);
        expectReadThroughIterate(SIBLINGS_SQL);
    });

    test('listBranches(): the labeled-nodes read goes through iterate()', async () => {
        const { directories } = await seedTree();

        calls.length = 0;
        const branches = await treeDb.listBranches(directories, 'owner-1');

        expect(branches.map(b => b.name)).toEqual(['main', 'alt-bookmark']);
        expectReadThroughIterate(LABELED_NODES_SQL);
    });

    test('getAlternatives(): the node\'s siblings read goes through iterate()', async () => {
        const { directories, ids, altId } = await seedTree();

        calls.length = 0;
        const result = await treeDb.getAlternatives(directories, altId);

        expect(result.selected).toBe(1);
        expect(result.total).toBe(2);
        expect(result.alternatives.map(a => [a.node_id, a.mes])).toEqual([[ids[2], 'a'], [altId, 'a2']]);
        expectReadThroughIterate(CHILDREN_BY_P_SQL);
    });

    test('getOpeningAlternatives(): the anchor\'s children read goes through iterate()', async () => {
        const { directories, ids } = await seedTree();

        calls.length = 0;
        const result = await treeDb.getOpeningAlternatives(directories, 'owner-1', {}, [makeMessage('hello'), makeMessage('bonjour')]);

        expect(result.has_saved_chats).toBe(true);
        expect(result.stored).toBe(1);
        expect(result.total).toBe(2);
        expect(result.default_node_id).toBe(ids[0]);
        expect(result.alternatives.map(a => a.mes)).toEqual(['hello', 'bonjour']);
        expectReadThroughIterate(CHILDREN_BY_P_SQL);
    });

    test('listLabels(): the labels read goes through iterate()', async () => {
        const { directories, ids, altId } = await seedTree();

        calls.length = 0;
        const labels = await treeDb.listLabels(directories, 'owner-1');

        expect(labels.map(l => [l.node_id, l.label, l.mes])).toEqual([[ids[0], 'main', 'hello'], [altId, 'alt-bookmark', 'a2']]);
        for (const l of labels) expect(typeof l.created_at).toBe('number');
        expectReadThroughIterate(LABELS_SQL);
    });
});

describe('the identity_hash migration reads PRAGMA table_info(messages) through iterate()', () => {
    test('a store whose messages table predates identity_hash gets the column, a hash on every non-anchor row, and still loads', async () => {
        const directories = makeDirectories();
        const anchorContent = treeDb.ANCHOR_CONTENT;
        const helloContent = JSON.stringify(makeMessage('hello'));
        const replyContent = JSON.stringify(makeMessage('q', true));

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
            raw.run('INSERT INTO messages (id, parent_id, owner_id, content, label, created_at, default_child_id, metadata) VALUES (?, ?, ?, ?, ?, 2, NULL, ?)',
                ['m0', 'anchor', 'owner-1', helloContent, 'main', JSON.stringify({ integrity: 'x' })]);
            raw.run('INSERT INTO messages (id, parent_id, owner_id, content, label, created_at, default_child_id, metadata) VALUES (?, ?, ?, ?, NULL, 3, NULL, NULL)',
                ['m1', 'm0', 'owner-1', replyContent]);
            raw.run('UPDATE messages SET default_child_id = ? WHERE id = ?', ['m0', 'anchor']);
            raw.run('UPDATE messages SET default_child_id = ? WHERE id = ?', ['m1', 'm0']);
        } finally {
            raw.close();
        }

        calls.length = 0;
        const loaded = await treeDb.loadBranch(directories, 'owner-1', 'main');

        expect(loaded.messages.map(m => [m.node_id, m.mes])).toEqual([['m0', 'hello'], ['m1', 'q']]);
        expectReadThroughIterate('PRAGMA table_info(messages)');

        treeDb.disposeMessageTreeStores();
        const check = new WasmDatabase(path.join(directories.root, 'message-tree.sqlite'));
        try {
            expect(check.get('SELECT COUNT(*) AS c FROM pragma_table_info(\'messages\') WHERE name = \'identity_hash\'')).toEqual({ c: 1 });
            expect(check.get('SELECT identity_hash AS h FROM messages WHERE id = ?', ['anchor'])).toEqual({ h: null });
            expect(check.get('SELECT identity_hash AS h FROM messages WHERE id = ?', ['m0'])).toEqual({ h: treeDb.identityHashOf('anchor', helloContent) });
            expect(check.get('SELECT identity_hash AS h FROM messages WHERE id = ?', ['m1'])).toEqual({ h: treeDb.identityHashOf('m0', replyContent) });
        } finally {
            check.close();
        }
    });

    test('reopening a current store reads its columns through iterate() and adds nothing', async () => {
        const { directories } = await seedTree();
        treeDb.disposeMessageTreeStores();

        calls.length = 0;
        expect((await treeDb.listBranches(directories, 'owner-1')).map(b => b.name)).toEqual(['main', 'alt-bookmark']);

        expectReadThroughIterate('PRAGMA table_info(messages)');
    });
});
