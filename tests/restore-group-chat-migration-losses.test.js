import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import { isBusyError, openWasmDatabase, streamRows } from '../src/endpoints/sqlite-engine.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

// A native sqlite build is not guaranteed in every test environment; wasm is.
jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    getSqliteEngine: jest.fn(async () => ({
        kind: 'wasm',
        openDatabase: (dbPath, options) => openWasmDatabase(WasmDatabase, dbPath, options),
    })),
    openWasmDatabase,
    openNativeDatabase: jest.fn(),
    streamRows,
    isBusyError,
}));

const queueChatStats = jest.fn();
const openOwnerChatStatsQueue = jest.fn(async () => queueChatStats);
const disposeMetadataStores = jest.fn();
jest.unstable_mockModule('../src/character-metadata-db.js', () => ({ openOwnerChatStatsQueue, disposeMetadataStores }));

/** @param {object | undefined} params */
const prefixParams = params => (params ? Object.fromEntries(Object.entries(params).map(([k, v]) => [`@${k}`, v])) : {});

/** The part of better-sqlite3's API the dry run uses, over wasm. */
class WasmBetterSqlite3 {
    constructor(file, options = {}) {
        this.db = new WasmDatabase(file, { readOnly: !!options.readonly, fileMustExist: !!options.fileMustExist });
    }

    function(name, options, fn) {
        this.db.function(name, fn, options);
    }

    prepare(sql) {
        const db = this.db;
        return {
            get: params => {
                const stmt = db.prepare(sql);
                try {
                    return stmt.get(prefixParams(params)) ?? undefined;
                } finally {
                    stmt.finalize();
                }
            },
            iterate: function* (params) {
                const stmt = db.prepare(sql);
                try {
                    yield* stmt.iterate(prefixParams(params));
                } finally {
                    stmt.finalize();
                }
            },
        };
    }

    close() {
        this.db.close();
    }
}

/** @type {typeof import('../src/migrations/restore-group-chat-migration-losses.js')} */
let restore;
/** @type {typeof import('../src/message-tree-db.js')} */
let treeDb;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    restore = await import('../src/migrations/restore-group-chat-migration-losses.js');
    treeDb = await import('../src/message-tree-db.js');
});

const tmpDirs = [];
/** @type {string[]} */
let logs;
/** @type {string[]} */
let warns;

beforeEach(() => {
    logs = [];
    warns = [];
    queueChatStats.mockClear();
    openOwnerChatStatsQueue.mockClear();
    disposeMetadataStores.mockClear();
});

afterEach(() => {
    treeDb.disposeMessageTreeStores();
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function makeDirectories() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-group-chat-losses-test-'));
    tmpDirs.push(dataRoot);
    const root = path.join(dataRoot, 'default-user');
    const directories = {
        root,
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'group chats'),
        backups: path.join(root, 'backups'),
    };
    for (const dir of [directories.groups, directories.groupChats, directories.backups]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return directories;
}

function makeMessage(mes, { name = 'Alice', isUser = false, swipes = [mes], swipeId = 0 } = {}) {
    return { name, is_user: isUser, mes, send_date: 'date-' + mes, extra: {}, swipes, swipe_id: swipeId };
}

function writeGroup(dirs, { groupId, chats }) {
    const group = { id: groupId, name: 'G', members: ['alice.png'], chats, chat_id: chats[0] };
    fs.writeFileSync(path.join(dirs.groups, `${groupId}.json`), JSON.stringify(group));
}

function writeOriginal(dirs, chatId, messages) {
    fs.writeFileSync(
        path.join(dirs.groupChats, `${chatId}.jsonl.pre-migration`),
        messages.map(m => JSON.stringify(m)).join('\n') + '\n',
    );
}

function writeBackup(dirs, groupId, backup) {
    const dir = path.join(dirs.backups, '_group_metadata_update');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${groupId}.json`), JSON.stringify(backup));
}

/** What the old migration left: the anchor, messages 2..n under it, the label on the last one (if any). */
async function seedOldMigration(dirs, { groupId, chatId, messages }) {
    const db = await treeDb.getDbHandle(dirs);
    let anchorId = '';
    const ids = [];
    db.transaction(() => {
        const anchor = treeDb.ensureAnchorSync(db, groupId, 1000);
        anchorId = anchor.id;
        let parent = anchor.id;
        for (const msg of messages.slice(1)) {
            const alts = treeDb.alternativesFromMessage(msg);
            let chosen = '';
            alts.contents.forEach((content, k) => {
                const id = treeDb.newId();
                treeDb.insertMessageSync(db, { id, parentId: parent, ownerId: groupId, content, createdAt: 1000 + k });
                if (k === alts.selected) chosen = id;
            });
            treeDb.setDefaultChildSync(db, parent, chosen);
            parent = chosen;
            ids.push(chosen);
        }
        if (ids.length > 0) {
            treeDb.createBranchSync(db, { leafId: parent, name: chatId, isGroup: true, metadata: '{}' });
        }
    });
    return { anchorId, ids };
}

function snapshot(db, ownerId) {
    return Array.from(db.iterate('SELECT id, parent_id, content, label, default_child_id, metadata, identity_hash FROM messages WHERE owner_id = @o ORDER BY id LIMIT 1000', { o: ownerId }));
}

const APPLY = ['--apply', '--server-stopped'];
const notRunning = async () => ({ running: false, lines: ['port probe: free'] });

/**
 * Runs the script's CLI on `dirs`, a real run unless `args` says otherwise. The script closes the stores it opened,
 * so a test reads the tree again afterwards through a fresh treeDb.getDbHandle().
 * @returns {Promise<number>} The exit code.
 */
function run(dirs, args = APPLY, { Database = WasmBetterSqlite3, probeServer = notRunning } = {}) {
    return restore.main([...args, '--data-root', path.dirname(dirs.root), '--handle', path.basename(dirs.root)], {
        Database, probeServer, pauseMs: 0, log: (l) => logs.push(l), warn: (l) => warns.push(l),
    });
}

const test1Messages = () => [
    makeMessage('m1b', { swipes: ['m1a', 'm1b'], swipeId: 1 }),
    makeMessage('m2a', { swipes: ['m2a', 'm2b'], swipeId: 0 }),
    makeMessage('m3', { isUser: true }),
];

async function test1Setup() {
    const dirs = makeDirectories();
    const messages = test1Messages();
    writeGroup(dirs, { groupId: 'g1', chats: ['c1'] });
    const seeded = await seedOldMigration(dirs, { groupId: 'g1', chatId: 'c1', messages });
    writeOriginal(dirs, 'c1', messages);
    const db = await treeDb.getDbHandle(dirs);
    return { dirs, db, ...seeded };
}

describe('restoring a group chat', () => {
    test('bad-path multi-message chat gets its first message back', async () => {
        const { dirs, anchorId } = await test1Setup();

        expect(await run(dirs)).toBe(0);

        const db = await treeDb.getDbHandle(dirs);
        const loaded = await treeDb.loadBranch(dirs, 'g1', 'c1');
        expect(loaded?.messages.map(m => m.mes)).toEqual(['m1b', 'm2a', 'm3']);
        expect(loaded?.messages[0].swipes).toHaveLength(3);
        expect(loaded?.messages[0].swipes).toContain('m1a');
        expect(loaded?.messages[0].swipes).toContain('m1b');
        expect(loaded?.messages[0].swipes).toContain('m2b');
        expect(loaded?.messages[1].swipes).toContain('m2a');
        expect(loaded?.messages[1].swipes).toContain('m2b');
        const anchor = db.get('SELECT default_child_id FROM messages WHERE id = @id', { id: anchorId });
        expect(anchor.default_child_id).toBe(loaded?.messages[0].node_id);
        expect(logs.filter(l => l.includes('RESTORED group g1 chat "c1"'))).toHaveLength(1);
    });

    test('one-message chat with no branch is restored whole', async () => {
        const dirs = makeDirectories();
        const messages = [makeMessage('only')];
        writeGroup(dirs, { groupId: 'g2', chats: ['c2'] });
        await seedOldMigration(dirs, { groupId: 'g2', chatId: 'c2', messages });
        writeOriginal(dirs, 'c2', messages);
        writeBackup(dirs, 'g2', { id: 'g2', chat_id: 'c2', chats: ['c2'], chat_metadata: { note_prompt: 'np', main_chat: 'x' } });

        expect(await run(dirs)).toBe(0);

        const loaded = await treeDb.loadBranch(dirs, 'g2', 'c2');
        expect(loaded?.messages.map(m => m.mes)).toEqual(['only']);
        const db = await treeDb.getDbHandle(dirs);
        const row = db.get('SELECT metadata FROM messages WHERE owner_id = @o AND label = @l LIMIT 1', { o: 'g2', l: 'c2' });
        expect(JSON.parse(row.metadata)).toEqual({ note_prompt: 'np', __is_group: true });
    });

    test('metadata from backup onto an intact chat, differing keys kept', async () => {
        const dirs = makeDirectories();
        const messages = [makeMessage('a'), makeMessage('b')];
        writeGroup(dirs, { groupId: 'g3', chats: ['c3'] });
        let db = await treeDb.getDbHandle(dirs);
        let labelId = '';
        db.transaction(() => {
            const anchor = treeDb.ensureAnchorSync(db, 'g3', 1000);
            let parent = anchor.id;
            for (const msg of messages) {
                const alts = treeDb.alternativesFromMessage(msg);
                let chosen = '';
                alts.contents.forEach((content, k) => {
                    const id = treeDb.newId();
                    treeDb.insertMessageSync(db, { id, parentId: parent, ownerId: 'g3', content, createdAt: 1000 + k });
                    if (k === alts.selected) chosen = id;
                });
                treeDb.setDefaultChildSync(db, parent, chosen);
                parent = chosen;
            }
            treeDb.createBranchSync(db, { leafId: parent, name: 'c3', isGroup: true, metadata: '{"integrity":"new"}' });
            labelId = parent;
        });
        writeOriginal(dirs, 'c3', messages);
        writeBackup(dirs, 'g3', { id: 'g3', chat_id: 'other', chats: ['c3'], past_metadata: { c3: { integrity: 'old', note_prompt: 'p' } } });
        const before = snapshot(db, 'g3');

        expect(await run(dirs)).toBe(0);

        db = await treeDb.getDbHandle(dirs);
        const row = db.get('SELECT metadata FROM messages WHERE id = @id', { id: labelId });
        expect(JSON.parse(row.metadata)).toEqual({ integrity: 'new', __is_group: true, note_prompt: 'p' });
        expect(warns.some(l => l.includes('NOTE group g3 chat "c3"') && l.includes('integrity'))).toBe(true);
        const withoutLabelMetadata = rows => rows.map(r => (r.id === labelId ? { ...r, metadata: null } : r));
        expect(withoutLabelMetadata(snapshot(db, 'g3'))).toEqual(withoutLabelMetadata(before));
    });

    test('idempotent', async () => {
        const { dirs } = await test1Setup();
        expect(await run(dirs)).toBe(0);
        const db = await treeDb.getDbHandle(dirs);
        const before = snapshot(db, 'g1');

        const result = await restore.restoreGroupChatLosses(dirs, { reader: db, apply: true, pauseMs: 0 });

        expect(result.restored).toEqual([]);
        expect(result.intact.map(i => i.chatId)).toContain('c1');
        expect(snapshot(db, 'g1')).toEqual(before);

        logs.length = 0;
        expect(await run(dirs)).toBe(0);
        expect(logs.some(l => l.includes('0 restored, 1 already intact'))).toBe(true);
        expect(snapshot(await treeDb.getDbHandle(dirs), 'g1')).toEqual(before);
    });

    describe('unrestorable cases are warned and untouched', () => {
        test('a bookmark under the current first message', async () => {
            const { dirs, db, ids } = await test1Setup();
            const forkId = treeDb.newId();
            treeDb.insertMessageSync(db, { id: forkId, parentId: ids[0], ownerId: 'g1', content: JSON.stringify(makeMessage('fork')), createdAt: 2000 });
            db.run('UPDATE messages SET label = @l WHERE id = @id', { l: 'bm', id: forkId });
            const before = snapshot(db, 'g1');

            expect(await run(dirs)).toBe(1);

            expect(warns.some(l => l.includes('CANNOT RESTORE group g1 chat "c1"') && l.includes('"bm"') && l.includes('left untouched'))).toBe(true);
            expect(snapshot(await treeDb.getDbHandle(dirs), 'g1')).toEqual(before);
        });

        test('a message edited in place', async () => {
            const { dirs, db, ids } = await test1Setup();
            const c = JSON.stringify(makeMessage('edited'));
            const { parent_id: parentId } = db.get('SELECT parent_id FROM messages WHERE id = @id', { id: ids[1] });
            db.run('UPDATE messages SET content = @c, identity_hash = @h WHERE id = @id', { c, h: treeDb.identityHashOf(parentId, c), id: ids[1] });
            const before = snapshot(db, 'g1');

            expect(await run(dirs)).toBe(1);

            expect(warns.some(l => l.includes('CANNOT RESTORE') && l.includes('no longer match the original from message 3 on'))).toBe(true);
            expect(snapshot(await treeDb.getDbHandle(dirs), 'g1')).toEqual(before);
        });
    });

    test('headered original is not a candidate', async () => {
        const dirs = makeDirectories();
        writeGroup(dirs, { groupId: 'g6', chats: ['c6'] });
        writeOriginal(dirs, 'c6', [{ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }, makeMessage('m')]);

        await treeDb.getDbHandle(dirs);

        expect(await run(dirs)).toBe(0);

        expect(logs.some(l => l.includes('0 headerless original(s) found'))).toBe(true);
        expect(warns).toEqual([]);
    });

    test('dry run writes nothing, lists what would change, and opens the tree read-only', async () => {
        const { dirs, db } = await test1Setup();
        const before = snapshot(db, 'g1');
        treeDb.disposeMessageTreeStores();
        const treeBytes = fs.readFileSync(path.join(dirs.root, 'message-tree.sqlite'));

        expect(await run(dirs, ['--dry-run'], { probeServer: async () => { throw new Error('a dry run does not probe'); } })).toBe(0);

        expect(logs.some(l => l.includes('WOULD RESTORE group g1 chat "c1"') && l.includes('in front of its 2 message(s)'))).toBe(true);
        expect(logs.at(-1)).toContain('dry run: nothing was written.');
        expect(fs.readFileSync(path.join(dirs.root, 'message-tree.sqlite'))).toEqual(treeBytes);
        expect(snapshot(await treeDb.getDbHandle(dirs), 'g1')).toEqual(before);
        expect(openOwnerChatStatsQueue).not.toHaveBeenCalled();
    });
});

describe('the command line', () => {
    test('neither or both of --dry-run and --apply, or an unknown argument, is a usage error', async () => {
        const dirs = makeDirectories();
        expect(await run(dirs, [])).toBe(2);
        expect(await run(dirs, ['--dry-run', '--apply', '--server-stopped'])).toBe(2);
        expect(await run(dirs, ['--dry-run', '--bogus'])).toBe(2);
        expect(warns.some(l => l.includes('usage: --dry-run | --apply --server-stopped'))).toBe(true);
        expect(warns.some(l => l.includes('unknown argument(s): --bogus'))).toBe(true);
    });

    test('a real run without --server-stopped is refused and writes nothing', async () => {
        const { dirs, db } = await test1Setup();
        const before = snapshot(db, 'g1');

        expect(await run(dirs, ['--apply'])).toBe(1);

        expect(warns.some(l => l.includes('REFUSED: the real run needs --server-stopped'))).toBe(true);
        expect(snapshot(db, 'g1')).toEqual(before);
    });

    test('a real run is refused when the server appears to be running', async () => {
        const { dirs, db } = await test1Setup();
        const before = snapshot(db, 'g1');

        expect(await run(dirs, APPLY, { probeServer: async () => ({ running: true, lines: ['port probe: in-use'] }) })).toBe(1);

        expect(logs.some(l => l.includes('port probe: in-use'))).toBe(true);
        expect(warns.some(l => l.includes('REFUSED: the server appears to be running'))).toBe(true);
        expect(snapshot(db, 'g1')).toEqual(before);
    });

    test('no usable better-sqlite3, or no message tree, is refused', async () => {
        const dirs = makeDirectories();
        expect(await run(dirs, ['--dry-run'], { Database: null })).toBe(1);
        expect(warns.some(l => l.includes('REFUSED: native better-sqlite3 is not available'))).toBe(true);
        expect(await run(dirs, ['--dry-run'])).toBe(1);
        expect(warns.some(l => l.includes('message-tree.sqlite does not exist'))).toBe(true);
    });
});

describe('a restore queues the groups whose messages it changed', () => {
    test('a restored group is queued after its tree commit, from a store opened without creating one', async () => {
        const { dirs, db } = await test1Setup();
        /** @type {number[]} */
        const rowsWhenQueued = [];
        // The script opens the tree through the store, which hands it this same open connection until it closes it.
        queueChatStats.mockImplementation(() => {
            rowsWhenQueued.push(db.get('SELECT COUNT(*) AS n FROM messages WHERE owner_id = @o', { o: 'g1' }).n);
        });
        const rowsBefore = db.get('SELECT COUNT(*) AS n FROM messages WHERE owner_id = @o', { o: 'g1' }).n;

        expect(await run(dirs)).toBe(0);

        expect(openOwnerChatStatsQueue).toHaveBeenCalledWith(expect.objectContaining({ root: dirs.root }), { existingOnly: true });
        expect(queueChatStats.mock.calls.every(([ownerId, owner]) => ownerId === 'g1' && owner.kind === 'group' && owner.rowId === 'g1')).toBe(true);
        expect(queueChatStats).toHaveBeenCalledTimes(2);
        const rowsAfter = (await treeDb.getDbHandle(dirs)).get('SELECT COUNT(*) AS n FROM messages WHERE owner_id = @o', { o: 'g1' }).n;
        expect(rowsAfter).toBeGreaterThan(rowsBefore);
        expect(rowsWhenQueued.at(-1)).toBe(rowsAfter);
        expect(disposeMetadataStores).toHaveBeenCalled();
    });
});
