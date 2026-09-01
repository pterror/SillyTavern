import { describe, test, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import { openWasmDatabase } from '../src/endpoints/sqlite-engine.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

// message-tree-db.js resolves its backend through getSqliteEngine() (native better-sqlite3 first, wasm
// fallback - see sqlite-engine.js's header). A native build isn't guaranteed to be compiled in every
// environment these tests run in, so this suite always exercises the wasm adapter directly, the same
// approach sqlite-engine.test.js uses for the search index - it's the same SQLite/FTS engine either way,
// just compiled to WebAssembly instead of a native addon, so nothing about message-tree-db.js's own
// logic (schema, recursive CTEs, dedup) goes untested by picking this tier.
const getSqliteEngineMock = jest.fn(async () => ({
    kind: 'wasm',
    openDatabase: (dbPath) => openWasmDatabase(WasmDatabase, dbPath),
}));

jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    getSqliteEngine: getSqliteEngineMock,
    openWasmDatabase,
    openNativeDatabase: jest.fn(),
}));

/** @type {typeof import('../src/message-tree-db.js')} */
let treeDb;
/** @type {typeof import('../src/message-tree-migration.js')} */
let migration;

beforeAll(async () => {
    treeDb = await import('../src/message-tree-db.js');
    migration = await import('../src/message-tree-migration.js');
});

const tmpDirs = [];

/** Creates a fresh directories-shaped object (only `.root` matters to message-tree-db.js) backed by a real tmp dir. */
function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-tree-test-'));
    tmpDirs.push(root);
    return { root };
}

/** Minimal chat message shape message-tree-db.js round-trips (mirrors a JSONL chat line). */
function makeMessage({ mes, sendDate, isUser = false, name = 'Char', extra = {} } = {}) {
    return { name, is_user: isUser, mes, send_date: sendDate, extra, swipes: [mes] };
}

beforeEach(() => {
    getSqliteEngineMock.mockClear();
});

afterEach(() => {
    // Close every DB handle opened during the test before removing its backing directory - an open
    // sqlite file handle would otherwise make the rmSync below fail (or leak) on some platforms.
    treeDb.disposeMessageTreeStores();
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('message insertion and path reconstruction', () => {
    test('saveChatToTree() on a new branch chains messages by parent_id, and loadBranch() walks them root-to-leaf', async () => {
        const directories = makeDirectories();
        const header = { chat_metadata: {} };
        const chatData = [
            header,
            makeMessage({ mes: 'first', sendDate: 'd0' }),
            makeMessage({ mes: 'second', sendDate: 'd1', isUser: true }),
            makeMessage({ mes: 'third', sendDate: 'd2' }),
        ];

        const saveResult = await treeDb.saveChatToTree(directories, 'owner-1', 'chat-a', chatData, false);
        expect(saveResult).toEqual({ integrity: expect.any(String), assignedNodeIds: expect.any(Array) });

        const loaded = await treeDb.loadBranch(directories, 'owner-1', 'chat-a');
        expect(loaded).not.toBeNull();
        expect(loaded.messages.map(m => m.mes)).toEqual(['first', 'second', 'third']);
        // Every message gets a node_id for client round-tripping, and they're all distinct.
        const nodeIds = loaded.messages.map(m => m.node_id);
        expect(nodeIds.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
        expect(new Set(nodeIds).size).toBe(3);
    });
});

describe('branch creation and loading', () => {
    test('loadBranch() returns the branch record and metadata alongside the message path', async () => {
        const directories = makeDirectories();
        const header = { chat_metadata: { some_flag: true } };
        const chatData = [header, makeMessage({ mes: 'only message', sendDate: 'd0' })];

        await treeDb.saveChatToTree(directories, 'owner-2', 'solo-chat', chatData, false);

        const loaded = await treeDb.loadBranch(directories, 'owner-2', 'solo-chat');
        expect(loaded.branch.name).toBe('solo-chat');
        expect(loaded.branch.owner_id).toBe('owner-2');
        expect(loaded.metadata.some_flag).toBe(true);
        expect(loaded.messages).toHaveLength(1);
    });

    test('loadBranch() returns null for a branch name that does not exist', async () => {
        const directories = makeDirectories();
        expect(await treeDb.loadBranch(directories, 'owner-2', 'nope')).toBeNull();
    });
});

describe('forking', () => {
    test('forkBranch() at a mid-chain node creates a branch whose path stops there, and getForkRing() groups the siblings that diverge after it', async () => {
        const directories = makeDirectories();
        const header = { chat_metadata: {} };
        const chatData = [
            header,
            makeMessage({ mes: 'm0', sendDate: 'd0' }),
            makeMessage({ mes: 'm1', sendDate: 'd1' }),
            makeMessage({ mes: 'm2-main', sendDate: 'd2' }),
        ];
        await treeDb.saveChatToTree(directories, 'owner-3', 'main', chatData, false);

        const mainLoaded = await treeDb.loadBranch(directories, 'owner-3', 'main');
        const [m0, m1] = mainLoaded.messages;

        // Fork at m1: the new branch's path is just [m0, m1], with no new rows inserted.
        const forkResult = await treeDb.forkBranch(directories, 'owner-3', m1.node_id, 'fork-a', false, {});
        expect(forkResult).toEqual({ branchId: expect.any(String), branchName: 'fork-a' });

        const forkLoaded = await treeDb.loadBranch(directories, 'owner-3', 'fork-a');
        expect(forkLoaded.messages.map(m => m.mes)).toEqual(['m0', 'm1']);
        expect(forkLoaded.messages[forkLoaded.messages.length - 1].node_id).toBe(m1.node_id);

        // Continue the fork with a divergent message so m1 now has two children: 'm2-main' (from the
        // original branch) and this new one - a real fork point, not just a leaf pointer.
        const forkChatData = [
            header,
            forkLoaded.messages[0],
            forkLoaded.messages[1],
            makeMessage({ mes: 'm2-fork', sendDate: 'd2-fork' }),
        ];
        await treeDb.saveChatToTree(directories, 'owner-3', 'fork-a', forkChatData, false);

        // Verify children directly against the DB: m1 should now have two children.
        const db = await treeDb.getDbHandle(directories);
        const children = db.all('SELECT id FROM messages WHERE parent_id = @parentId', { parentId: m1.node_id });
        expect(children).toHaveLength(2);

        // getForkRing() groups branches by which child of m1 they descend through.
        const ring = await treeDb.getForkRing(directories, m1.node_id);
        expect(ring).toHaveLength(2);
        const branchNamesByGroup = ring.map(group => group.branches.map(b => b.name).sort());
        expect(branchNamesByGroup).toEqual(
            expect.arrayContaining([['main'], ['fork-a']]),
        );
    });
});

describe('message deduplication during migration', () => {
    test('migrateCharacterChats() stores a shared prefix between two JSONL files exactly once', async () => {
        const directories = makeDirectories();
        const chatDir = path.join(directories.root, 'chats', 'migrate-char');
        fs.mkdirSync(chatDir, { recursive: true });

        const rootHeader = { chat_metadata: {} };
        const rootMessages = [
            makeMessage({ mes: 'm0', sendDate: 'd0' }),
            makeMessage({ mes: 'm1', sendDate: 'd1' }),
            makeMessage({ mes: 'm2-root', sendDate: 'd2-root' }),
        ];
        const rootLines = [rootHeader, ...rootMessages].map(l => JSON.stringify(l)).join('\n') + '\n';
        fs.writeFileSync(path.join(chatDir, 'root.jsonl'), rootLines);

        // Shares m0/m1 (identical send_date) with root, then diverges at index 2.
        const branchHeader = { chat_metadata: { main_chat: 'root' } };
        const branchMessages = [
            makeMessage({ mes: 'm0', sendDate: 'd0' }),
            makeMessage({ mes: 'm1', sendDate: 'd1' }),
            makeMessage({ mes: 'm2-branch', sendDate: 'd2-branch' }),
        ];
        const branchLines = [branchHeader, ...branchMessages].map(l => JSON.stringify(l)).join('\n') + '\n';
        fs.writeFileSync(path.join(chatDir, 'branch.jsonl'), branchLines);

        const result = await migration.migrateCharacterChats(directories, 'migrate-char', chatDir, false);
        expect(result.errors).toEqual([]);
        expect(result.migrated).toBe(2);

        // 4 unique messages total: m0, m1 shared once each, plus m2-root and m2-branch's divergent tails.
        const db = await treeDb.getDbHandle(directories);
        const { count } = db.get('SELECT COUNT(*) as count FROM messages');
        expect(count).toBe(4);

        const rootLoaded = await treeDb.loadBranch(directories, 'migrate-char', 'root');
        expect(rootLoaded.messages.map(m => m.mes)).toEqual(['m0', 'm1', 'm2-root']);

        const branchLoaded = await treeDb.loadBranch(directories, 'migrate-char', 'branch');
        expect(branchLoaded.messages.map(m => m.mes)).toEqual(['m0', 'm1', 'm2-branch']);

        // The shared m0/m1 nodes are literally the same rows across both branches' paths.
        expect(branchLoaded.messages[0].node_id).toBe(rootLoaded.messages[0].node_id);
        expect(branchLoaded.messages[1].node_id).toBe(rootLoaded.messages[1].node_id);

        // Migrated files get renamed out of the way so a re-run skips them (hasBranchesSync() gate).
        expect(fs.existsSync(path.join(chatDir, 'root.jsonl.pre-migration'))).toBe(true);
        expect(fs.existsSync(path.join(chatDir, 'branch.jsonl.pre-migration'))).toBe(true);
        expect(fs.existsSync(path.join(chatDir, 'root.jsonl'))).toBe(false);

        // Re-running migration on an already-migrated owner is a no-op (idempotent per this module's header).
        const rerun = await migration.migrateCharacterChats(directories, 'migrate-char', chatDir, false);
        expect(rerun).toEqual({ migrated: 0, skipped: 0, errors: [] });
    });

    test('an explicit file list migrates only that owner\'s files out of a shared directory', async () => {
        // Groups don't get a directory per owner the way characters do - every group chat of every
        // group lives flat in one shared folder, and only the group's own descriptor says which chat
        // ids are its. This is the case the scan cannot express: point it at the shared folder and
        // both groups' histories land under whichever owner ran first.
        const directories = makeDirectories();
        const sharedDir = path.join(directories.root, 'group chats');
        fs.mkdirSync(sharedDir, { recursive: true });

        const writeChat = (name, texts, metadata = {}) => {
            const lines = [{ chat_metadata: metadata }, ...texts.map((t, i) => makeMessage({ mes: t, sendDate: `d${i}` }))];
            fs.writeFileSync(path.join(sharedDir, `${name}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
        };

        writeChat('chat-alpha-1', ['a0', 'a1']);
        writeChat('chat-alpha-2', ['a0', 'a2']);
        writeChat('chat-beta-1', ['b0']);

        const alpha = await migration.migrateCharacterChats(
            directories, 'group-alpha', sharedDir, true,
            // A stale entry (no such file) and a traversal attempt are both dropped without failing
            // the run - the descriptor this list comes from is user-editable and outlives its files.
            ['chat-alpha-1.jsonl', 'chat-alpha-2.jsonl', 'chat-deleted-long-ago.jsonl', '../escape.jsonl'],
        );
        expect(alpha.errors).toEqual([]);
        expect(alpha.migrated).toBe(2);

        // Beta's file was never touched by alpha's run - still sitting there unmigrated.
        expect(fs.existsSync(path.join(sharedDir, 'chat-beta-1.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(sharedDir, 'chat-alpha-1.jsonl.pre-migration'))).toBe(true);

        const beta = await migration.migrateCharacterChats(
            directories, 'group-beta', sharedDir, true, ['chat-beta-1.jsonl'],
        );
        expect(beta.migrated).toBe(1);
        expect(fs.existsSync(path.join(sharedDir, 'chat-beta-1.jsonl.pre-migration'))).toBe(true);

        // Each group owns exactly its own chats, and alpha's shared 'a0' prefix still dedups to one row.
        const alphaBranches = await treeDb.listBranches(directories, 'group-alpha');
        expect(alphaBranches.map(b => b.name).sort()).toEqual(['chat-alpha-1', 'chat-alpha-2']);
        expect(alphaBranches.every(b => b.is_group === 1)).toBe(true);

        const betaBranches = await treeDb.listBranches(directories, 'group-beta');
        expect(betaBranches.map(b => b.name)).toEqual(['chat-beta-1']);

        const alpha1 = await treeDb.loadBranch(directories, 'group-alpha', 'chat-alpha-1');
        const alpha2 = await treeDb.loadBranch(directories, 'group-alpha', 'chat-alpha-2');
        expect(alpha1.messages.map(m => m.mes)).toEqual(['a0', 'a1']);
        expect(alpha2.messages.map(m => m.mes)).toEqual(['a0', 'a2']);
        expect(alpha1.messages[0].node_id).toBe(alpha2.messages[0].node_id);
        // The is-a-group marker is storage bookkeeping, not chat metadata the client should see.
        expect(alpha1.metadata.__is_group).toBeUndefined();

        // Beta's 'b0' is a different owner's row even though nothing about the text differs.
        const beta1 = await treeDb.loadBranch(directories, 'group-beta', 'chat-beta-1');
        expect(beta1.messages.map(m => m.mes)).toEqual(['b0']);

        // Same idempotency gate as the scan path: a second touch of an already-migrated owner is a no-op.
        const rerun = await migration.migrateCharacterChats(
            directories, 'group-alpha', sharedDir, true, ['chat-alpha-1.jsonl', 'chat-alpha-2.jsonl'],
        );
        expect(rerun).toEqual({ migrated: 0, skipped: 0, errors: [] });
    });

    test('ingesting a new chat under a migrated group leaves its existing branches intact', async () => {
        // The /group/import ordering hazard, from the store's side: an import ingests under the group's
        // owner id exactly like a save does, and once it labels a node the migration gate is satisfied
        // forever. So the group's own files have to already be in by then - and the ingest itself must not
        // disturb what migration put there.
        const directories = makeDirectories();
        const sharedDir = path.join(directories.root, 'group chats');
        fs.mkdirSync(sharedDir, { recursive: true });

        const lines = [{ chat_metadata: {} }, makeMessage({ mes: 'existing', sendDate: 'd0' })];
        fs.writeFileSync(path.join(sharedDir, 'old-chat.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

        await migration.migrateCharacterChats(directories, 'grp', sharedDir, true, ['old-chat.jsonl']);

        const imported = [{ chat_metadata: {} }, makeMessage({ mes: 'existing', sendDate: 'd0' }), makeMessage({ mes: 'imported tail', sendDate: 'd1' })];
        await treeDb.saveChatToTree(directories, 'grp', 'imported-chat', imported, true);

        const branches = await treeDb.listBranches(directories, 'grp');
        expect(branches.map(b => b.name).sort()).toEqual(['imported-chat', 'old-chat']);
        expect(branches.every(b => b.is_group === 1)).toBe(true);

        const old = await treeDb.loadBranch(directories, 'grp', 'old-chat');
        const fresh = await treeDb.loadBranch(directories, 'grp', 'imported-chat');
        expect(fresh.messages.map(m => m.mes)).toEqual(['existing', 'imported tail']);
        // The shared opening is one row, not a second copy - the import converged onto migrated history
        // rather than duplicating it.
        expect(fresh.messages[0].node_id).toBe(old.messages[0].node_id);
        // What old-chat loads as is the strict-prefix question the test below leaves open on purpose.
    });

    test('a new chat that opens like an existing one does not take over its name', async () => {
        // Identity is (parent, speaker, text), so a second chat opening with the same message lands on the
        // first chat's row rather than getting one of its own. Naming a new chat at its first message
        // therefore used to write over whatever name that row already carried, and the older chat became
        // unreachable - history still stored, nothing pointing at it, nothing reported. Two group chats
        // seeded from the same members' greetings hit this on an ordinary day.
        const directories = makeDirectories();
        const greeting = makeMessage({ mes: 'hello there', sendDate: 'd0' });

        await treeDb.saveChatToTree(directories, 'grp-x', 'chat-one', [{ chat_metadata: {} }, greeting], true);
        await treeDb.saveChatToTree(directories, 'grp-x', 'chat-two', [
            { chat_metadata: {} }, greeting, makeMessage({ mes: 'diverges here', sendDate: 'd1' }),
        ], true);

        const names = (await treeDb.listBranches(directories, 'grp-x')).map(b => b.name).sort();
        expect(names).toEqual(['chat-one', 'chat-two']);

        expect((await treeDb.loadBranch(directories, 'grp-x', 'chat-two')).messages.map(m => m.mes))
            .toEqual(['hello there', 'diverges here']);

        // NOT asserted, and deliberately so: what chat-one loads as. Both names survive now, but a chat
        // whose messages are a strict prefix of another chat's still cannot be told apart from that other
        // chat on load - resolution is "label, then follow default_child_id down", and the longer chat owns
        // that pointer. Terminating the shorter chat's path is what endPathAt() exists for and nothing calls
        // it here. That is a pre-existing property of the model, not of groups, but groups reach it far more
        // often than characters do, because two chats in one group start from the same greetings verbatim.
        // Left open on purpose rather than papered over - see docs/design/group-chat-tree-migration.md.
    });

    test('an owner with no surviving files is left untouched, not marked migrated', async () => {
        // The state a brand-new group is in: a descriptor with chat ids whose files don't exist yet.
        // Nothing to migrate must stay "nothing has happened here", so the first real save still
        // creates the owner's rows normally rather than finding a half-built owner.
        const directories = makeDirectories();
        const sharedDir = path.join(directories.root, 'group chats');
        fs.mkdirSync(sharedDir, { recursive: true });

        const result = await migration.migrateCharacterChats(
            directories, 'group-empty', sharedDir, true, ['never-written.jsonl'],
        );
        expect(result).toEqual({ migrated: 0, skipped: 0, errors: [] });
        expect(await treeDb.hasSavedChats(directories, 'group-empty')).toBe(false);

        const header = { chat_metadata: {} };
        await treeDb.saveChatToTree(directories, 'group-empty', 'first-chat', [header, makeMessage({ mes: 'hello', sendDate: 'd0' })], true);
        const loaded = await treeDb.loadBranch(directories, 'group-empty', 'first-chat');
        expect(loaded.messages.map(m => m.mes)).toEqual(['hello']);
    });
});

describe('labeling nodes', () => {
    test('labelNode() sets a label that loadBranch() surfaces as extra.bookmark_link', async () => {
        const directories = makeDirectories();
        const header = { chat_metadata: {} };
        const chatData = [header, makeMessage({ mes: 'checkpoint me', sendDate: 'd0' })];
        await treeDb.saveChatToTree(directories, 'owner-4', 'chat-b', chatData, false);

        const loaded = await treeDb.loadBranch(directories, 'owner-4', 'chat-b');
        const nodeId = loaded.messages[0].node_id;
        expect(loaded.messages[0].extra?.bookmark_link).toBeUndefined();

        const labelResult = await treeDb.labelNode(directories, nodeId, 'my-checkpoint');
        expect(labelResult).toBe(true);

        const relabeled = await treeDb.loadBranch(directories, 'owner-4', 'chat-b');
        expect(relabeled.messages[0].extra.bookmark_link).toBe('my-checkpoint');

        // Passing null clears the label again.
        await treeDb.labelNode(directories, nodeId, null);
        const cleared = await treeDb.loadBranch(directories, 'owner-4', 'chat-b');
        expect(cleared.messages[0].extra?.bookmark_link).toBeUndefined();
    });

    test('labelNode() returns false for a node that does not exist', async () => {
        const directories = makeDirectories();
        // Ensure the DB file exists so this hits the "not found" branch, not "no backend".
        await treeDb.isAvailable(directories);
        expect(await treeDb.labelNode(directories, 'not-a-real-id', 'x')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
//  Stub wire protocol tests: stubs, edits, deletes, swipes
// ---------------------------------------------------------------------------

describe('slim wire protocol (stub handling)', () => {
    /** @type {ReturnType<typeof makeDirs>} */
    let directories;

    beforeEach(() => { directories = makeDirectories(); });
    afterEach(() => { treeDb.disposeMessageTreeStores(); });

    test('stubs for unchanged messages skip DB updates, full content for changed ones updates DB', async () => {
        // Initial save: 3 messages
        const header = { chat_metadata: {} };
        const chatData = [
            header,
            makeMessage({ mes: 'hello', sendDate: 'd0' }),
            makeMessage({ mes: 'world', sendDate: 'd1' }),
            makeMessage({ mes: 'end', sendDate: 'd2' }),
        ];
        const firstSave = await treeDb.saveChatToTree(directories, 'owner', 'chat', chatData, false);
        expect(firstSave.assignedNodeIds).toHaveLength(3);

        // Load to get node_ids
        const loaded = await treeDb.loadBranch(directories, 'owner', 'chat');
        const nodeIds = loaded.messages.map(m => m.node_id);

        // Second save: messages 0 and 2 unchanged (stubs), message 1 edited
        const stubSave = [
            { chat_metadata: {} },
            { node_id: nodeIds[0], _unchanged: true },
            { node_id: nodeIds[1], mes: 'EDITED', name: 'Char', is_user: false, send_date: 'd1', extra: {} },
            { node_id: nodeIds[2], _unchanged: true },
        ];
        const secondSave = await treeDb.saveChatToTree(directories, 'owner', 'chat', stubSave, false);
        expect(secondSave.assignedNodeIds).toHaveLength(0); // No new messages

        // Verify edit was applied
        const reloaded = await treeDb.loadBranch(directories, 'owner', 'chat');
        expect(reloaded.messages[1].mes).toBe('EDITED');
        // Verify unchanged messages are untouched
        expect(reloaded.messages[0].mes).toBe('hello');
        expect(reloaded.messages[2].mes).toBe('end');
    });

    test('stubs + append: unchanged stubs followed by a new message', async () => {
        // Initial save
        const chatData = [
            { chat_metadata: {} },
            makeMessage({ mes: 'first', sendDate: 'd0' }),
        ];
        const firstSave = await treeDb.saveChatToTree(directories, 'owner', 'chat', chatData, false);
        const nodeId0 = firstSave.assignedNodeIds[0].node_id;

        // Second save: stub for existing + new message
        const appendSave = [
            { chat_metadata: {} },
            { node_id: nodeId0, _unchanged: true },
            makeMessage({ mes: 'appended', sendDate: 'd1' }),
        ];
        const secondSave = await treeDb.saveChatToTree(directories, 'owner', 'chat', appendSave, false);
        expect(secondSave.assignedNodeIds).toHaveLength(1); // One new message
        expect(secondSave.assignedNodeIds[0].index).toBe(1); // Index 1 in the message array

        const loaded = await treeDb.loadBranch(directories, 'owner', 'chat');
        expect(loaded.messages.map(m => m.mes)).toEqual(['first', 'appended']);
    });

    test('truncation: fewer stubs than existing messages moves the branch leaf back', async () => {
        // Initial save: 4 messages
        const chatData = [
            { chat_metadata: {} },
            makeMessage({ mes: 'm0', sendDate: 'd0' }),
            makeMessage({ mes: 'm1', sendDate: 'd1' }),
            makeMessage({ mes: 'm2', sendDate: 'd2' }),
            makeMessage({ mes: 'm3', sendDate: 'd3' }),
        ];
        await treeDb.saveChatToTree(directories, 'owner', 'chat', chatData, false);
        const loaded = await treeDb.loadBranch(directories, 'owner', 'chat');
        const nodeIds = loaded.messages.map(m => m.node_id);

        // Truncate to 2 messages
        const truncSave = [
            { chat_metadata: {} },
            { node_id: nodeIds[0], _unchanged: true },
            { node_id: nodeIds[1], _unchanged: true },
        ];
        await treeDb.saveChatToTree(directories, 'owner', 'chat', truncSave, false);

        const reloaded = await treeDb.loadBranch(directories, 'owner', 'chat');
        expect(reloaded.messages).toHaveLength(2);
        expect(reloaded.messages.map(m => m.mes)).toEqual(['m0', 'm1']);
    });

    test('swipe change: same node_id with different swipe_id sends full content and updates DB', async () => {
        // Initial save with swipes
        const msgWithSwipes = makeMessage({ mes: 'swipe0', sendDate: 'd0' });
        msgWithSwipes.swipes = ['swipe0', 'swipe1', 'swipe2'];
        msgWithSwipes.swipe_id = 0;
        const chatData = [{ chat_metadata: {} }, msgWithSwipes];
        const firstSave = await treeDb.saveChatToTree(directories, 'owner', 'chat', chatData, false);
        const nodeId = firstSave.assignedNodeIds[0].node_id;

        // Save with different swipe selected (full content, not stub)
        const swipedMsg = { ...msgWithSwipes, node_id: nodeId, swipe_id: 2, mes: 'swipe2' };
        const swipeSave = [{ chat_metadata: {} }, swipedMsg];
        await treeDb.saveChatToTree(directories, 'owner', 'chat', swipeSave, false);

        const loaded = await treeDb.loadBranch(directories, 'owner', 'chat');
        expect(loaded.messages[0].swipe_id).toBe(2);
        expect(loaded.messages[0].mes).toBe('swipe2');
    });

    test('assignedNodeIds correctly maps indices for mixed stubs and new messages', async () => {
        // Initial: 2 messages
        const chatData = [
            { chat_metadata: {} },
            makeMessage({ mes: 'a', sendDate: 'd0' }),
            makeMessage({ mes: 'b', sendDate: 'd1' }),
        ];
        const first = await treeDb.saveChatToTree(directories, 'owner', 'chat', chatData, false);
        const nodeIds = first.assignedNodeIds.map(a => a.node_id);

        // Save: stub, stub, new, new
        const mixedSave = [
            { chat_metadata: {} },
            { node_id: nodeIds[0], _unchanged: true },
            { node_id: nodeIds[1], _unchanged: true },
            makeMessage({ mes: 'c', sendDate: 'd2' }),
            makeMessage({ mes: 'd', sendDate: 'd3' }),
        ];
        const second = await treeDb.saveChatToTree(directories, 'owner', 'chat', mixedSave, false);
        expect(second.assignedNodeIds).toHaveLength(2);
        // Indices are 0-based within the message array (not chatData)
        expect(second.assignedNodeIds[0].index).toBe(2);
        expect(second.assignedNodeIds[1].index).toBe(3);
    });
});
