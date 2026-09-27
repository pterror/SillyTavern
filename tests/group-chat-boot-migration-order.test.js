import { describe, test, expect, jest, beforeAll, afterAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import * as realSqliteEngine from '../src/endpoints/sqlite-engine.js';
const { openWasmDatabase } = realSqliteEngine;

const { Database: WasmDatabase } = NodeSqlite3Wasm;

// A native sqlite build is not guaranteed in every test environment; wasm is.
jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    ...realSqliteEngine,
    getSqliteEngine: jest.fn(async () => ({
        kind: 'wasm',
        openDatabase: (dbPath) => openWasmDatabase(WasmDatabase, dbPath),
    })),
    openNativeDatabase: jest.fn(),
}));

// Lets a test hold the metadata migration at its chat-file write, after it has read the group JSON and before it
// writes it back - the window a concurrent group save would fall into.
// Mocked at the copy src/ resolves (the repo root's node_modules), not tests/node_modules' own.
const srcRequire = createRequire(new URL('../src/endpoints/groups.js', import.meta.url));
const writeFileAtomicPath = srcRequire.resolve('write-file-atomic');
const realWriteFileAtomic = srcRequire('write-file-atomic');
/** @type {{ reached: () => void, released: Promise<void> } | null} */
let chatWriteGate = null;
jest.unstable_mockModule(writeFileAtomicPath, () => ({
    default: async (...args) => {
        const gate = chatWriteGate;
        if (gate) {
            chatWriteGate = null;
            gate.reached();
            await gate.released;
        }
        return realWriteFileAtomic(...args);
    },
    sync: realWriteFileAtomic.sync,
}));

/** Arms the gate; resolves `reached` when the migration arrives at it, and `release()` lets it go on. */
function armChatWriteGate() {
    /** @type {() => void} */
    let release = () => {};
    /** @type {Promise<void>} */
    let reached;
    const released = new Promise(resolve => { release = () => resolve(undefined); });
    reached = new Promise(resolve => {
        chatWriteGate = { reached: () => resolve(undefined), released };
    });
    return { reached, release };
}

/** @type {typeof import('../src/message-tree-db.js')} */
let treeDb;
/** @type {typeof import('../src/message-tree-migration.js')} */
let migration;
/** @type {typeof import('../src/endpoints/groups.js')} */
let groups;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('node:http').Server} */
let server;
let baseUrl = '';
/** @type {any} */
let requestDirectories = null;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    treeDb = await import('../src/message-tree-db.js');
    migration = await import('../src/message-tree-migration.js');
    groups = await import('../src/endpoints/groups.js');
    metadataDb = await import('../src/character-metadata-db.js');

    const { router: chatsRouter } = await import('../src/endpoints/chats.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories: requestDirectories, profile: { handle: `test-user-${path.basename(requestDirectories.root)}` } };
        next();
    });
    app.use('/api/groups', groups.router);
    app.use('/api/chats', chatsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

const tmpDirs = [];

afterEach(() => {
    chatWriteGate = null;
    requestDirectories = null;
    treeDb.disposeMessageTreeStores();
    metadataDb.disposeMetadataStores();
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-boot-migration-test-'));
    tmpDirs.push(root);
    const directories = {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'group chats'),
        backups: path.join(root, 'backups'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.backups]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return directories;
}

function makeMessage(mes, name = 'Alice', isUser = false) {
    return { name, is_user: isUser, mes, send_date: `date-${mes}`, extra: {}, swipes: [mes], swipe_id: 0 };
}

/**
 * Writes a group in the pre-metadata-migration shape: chat metadata lives on the group JSON
 * (`chat_metadata` for the current chat, `past_metadata` for the others), and each chat file is
 * messages only - no header line.
 */
function writeOldFormatGroup(directories, { groupId, chatId, messages, chatMetadata }) {
    const group = {
        id: groupId,
        name: 'Old Group',
        members: ['alice.png'],
        chat_id: chatId,
        chats: [chatId],
        chat_metadata: chatMetadata,
        past_metadata: {},
    };
    fs.writeFileSync(path.join(directories.groups, `${groupId}.json`), JSON.stringify(group, null, 4));
    fs.writeFileSync(
        path.join(directories.groupChats, `${chatId}.jsonl`),
        messages.map(m => JSON.stringify(m)).join('\n') + '\n',
    );
}

/** The per-user body of migrateAllGroupChats() (started after listening by src/server-main.js), for one scratch user. */
async function bootGroupMigration(directories) {
    await migration.migrateUserGroupChats(directories);
}

function readGroup(directories, groupId) {
    return JSON.parse(fs.readFileSync(path.join(directories.groups, `${groupId}.json`), 'utf8'));
}

function writeChatFile(directories, name, lines) {
    fs.writeFileSync(path.join(directories.groupChats, `${name}.jsonl`), lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}

/** Every file under a directory with its bytes, to prove a run wrote nothing. */
function snapshot(dir) {
    const out = {};
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = path.join(entry.parentPath ?? entry.path, entry.name);
        out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
    return out;
}

describe('boot migrations on an old-format group chat (no header line)', () => {
    test('the chat keeps its first message and its metadata', async () => {
        const directories = makeDirectories();
        writeOldFormatGroup(directories, {
            groupId: 'g1',
            chatId: 'chat-1',
            messages: [makeMessage('first'), makeMessage('second', 'You', true), makeMessage('third')],
            chatMetadata: { note_prompt: 'keep me' },
        });

        await bootGroupMigration(directories);

        const loaded = await treeDb.loadBranch(directories, 'g1', 'chat-1');
        expect(loaded?.messages.map(m => m.mes)).toEqual(['first', 'second', 'third']);
        expect(loaded?.metadata).toEqual({ note_prompt: 'keep me' });
        expect(Object.hasOwn(readGroup(directories, 'g1'), 'chat_metadata')).toBe(false);
        expect(Object.hasOwn(readGroup(directories, 'g1'), 'past_metadata')).toBe(false);
    });

    test('a one-message chat still exists afterwards', async () => {
        const directories = makeDirectories();
        writeOldFormatGroup(directories, {
            groupId: 'g2',
            chatId: 'chat-only',
            messages: [makeMessage('only')],
            chatMetadata: { note_prompt: 'keep me too' },
        });

        await bootGroupMigration(directories);

        const loaded = await treeDb.loadBranch(directories, 'g2', 'chat-only');
        expect(loaded?.messages.map(m => m.mes)).toEqual(['only']);
        expect(loaded?.metadata).toEqual({ note_prompt: 'keep me too' });
    });

    test('past_metadata lands on each past chat, and a second boot writes nothing', async () => {
        const directories = makeDirectories();
        writeOldFormatGroup(directories, {
            groupId: 'g3',
            chatId: 'chat-now',
            messages: [makeMessage('now-1'), makeMessage('now-2')],
            chatMetadata: { note_prompt: 'current' },
        });
        const group = readGroup(directories, 'g3');
        group.chats.push('chat-past');
        group.past_metadata = { 'chat-past': { note_prompt: 'past' } };
        fs.writeFileSync(path.join(directories.groups, 'g3.json'), JSON.stringify(group, null, 4));
        writeChatFile(directories, 'chat-past', [makeMessage('past-1')]);

        await bootGroupMigration(directories);

        expect((await treeDb.loadBranch(directories, 'g3', 'chat-past'))?.metadata).toEqual({ note_prompt: 'past' });
        expect((await treeDb.loadBranch(directories, 'g3', 'chat-past'))?.messages.map(m => m.mes)).toEqual(['past-1']);
        expect((await treeDb.loadBranch(directories, 'g3', 'chat-now'))?.metadata).toEqual({ note_prompt: 'current' });

        const before = snapshot(directories.root);
        treeDb.disposeMessageTreeStores();
        const beforeWithoutDb = Object.fromEntries(Object.entries(before).filter(([k]) => !k.endsWith('.db') && !k.includes('.db-')));
        await bootGroupMigration(directories);
        const after = Object.fromEntries(Object.entries(snapshot(directories.root)).filter(([k]) => !k.endsWith('.db') && !k.includes('.db-')));
        expect(after).toEqual(beforeWithoutDb);
    });
});

describe('tree migration never drops a message line', () => {
    test('a headerless file migrated directly keeps its first message', async () => {
        const directories = makeDirectories();
        writeChatFile(directories, 'direct', [makeMessage('first'), makeMessage('second')]);

        const result = await migration.migrateCharacterChats(directories, 'gd', directories.groupChats, true, ['direct.jsonl']);

        expect(result).toEqual({ migrated: 1, skipped: 0, errors: [] });
        expect((await treeDb.loadBranch(directories, 'gd', 'direct'))?.messages.map(m => m.mes)).toEqual(['first', 'second']);
    });

    test('a file with a malformed line is left in place, reported, and none of its rows are kept', async () => {
        const directories = makeDirectories();
        writeChatFile(directories, 'good', [{ chat_metadata: {} }, makeMessage('fine')]);
        writeChatFile(directories, 'broken', [{ chat_metadata: {} }, makeMessage('unique-before'), '{not json', makeMessage('after')]);

        const result = await migration.migrateCharacterChats(directories, 'gm', directories.groupChats, true, ['good.jsonl', 'broken.jsonl']);

        expect(result.migrated).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('broken.jsonl');
        expect(result.errors[0]).toContain('3');
        expect(fs.existsSync(path.join(directories.groupChats, 'broken.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(directories.groupChats, 'broken.jsonl.pre-migration'))).toBe(false);
        expect(fs.existsSync(path.join(directories.groupChats, 'good.jsonl.pre-migration'))).toBe(true);
        const db = await treeDb.getDbHandle(directories);
        expect(db.get('SELECT COUNT(*) AS n FROM messages WHERE owner_id = @o AND content LIKE @c', { o: 'gm', c: '%unique-before%' }).n).toBe(0);
    });

    test('a chat with no messages is left in place and reported, not counted or renamed', async () => {
        const directories = makeDirectories();
        writeChatFile(directories, 'empty', [{ chat_metadata: { note_prompt: 'only metadata' } }]);

        const result = await migration.migrateCharacterChats(directories, 'ge', directories.groupChats, true, ['empty.jsonl']);

        expect(result.migrated).toBe(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('empty.jsonl');
        expect(fs.existsSync(path.join(directories.groupChats, 'empty.jsonl'))).toBe(true);
    });

    test('a chat whose name or metadata cannot be placed is left in place and its rows rolled back', async () => {
        const directories = makeDirectories();
        writeChatFile(directories, 'a-first', [{ chat_metadata: {} }, makeMessage('same')]);
        writeChatFile(directories, 'b-copy', [{ chat_metadata: { note_prompt: 'copy meta' } }, makeMessage('same', 'Alice')]);
        // Same content as a-first, but with an extra swipe on the one message: that swipe row is new.
        const withSwipe = makeMessage('same');
        withSwipe.swipes = ['same', 'extra-swipe'];
        writeChatFile(directories, 'c-swipe', [{ chat_metadata: {} }, withSwipe]);

        const result = await migration.migrateCharacterChats(directories, 'gl', directories.groupChats, true, ['a-first.jsonl', 'b-copy.jsonl', 'c-swipe.jsonl']);

        expect(result.migrated).toBe(1);
        expect(result.errors.map(e => e.split(':')[0]).sort()).toEqual(['Failed to migrate b-copy.jsonl', 'Failed to migrate c-swipe.jsonl']);
        expect(fs.existsSync(path.join(directories.groupChats, 'b-copy.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(directories.groupChats, 'c-swipe.jsonl'))).toBe(true);
        const db = await treeDb.getDbHandle(directories);
        expect(db.get('SELECT COUNT(*) AS n FROM messages WHERE owner_id = @o AND content LIKE @c', { o: 'gl', c: '%extra-swipe%' }).n).toBe(0);
    });
});

describe('metadata migration never strips metadata it did not land', () => {
    test('metadata for a missing chat file, or a chat not in the list, stays in the group JSON; landed metadata is removed', async () => {
        const directories = makeDirectories();
        writeOldFormatGroup(directories, {
            groupId: 'gk',
            chatId: 'chat-missing',
            messages: [],
            chatMetadata: { note_prompt: 'nowhere to go' },
        });
        fs.rmSync(path.join(directories.groupChats, 'chat-missing.jsonl'));
        const group = readGroup(directories, 'gk');
        group.chats.push('chat-here');
        group.past_metadata = { 'chat-here': { note_prompt: 'lands' }, 'chat-orphan': { note_prompt: 'orphan' } };
        fs.writeFileSync(path.join(directories.groups, 'gk.json'), JSON.stringify(group, null, 4));
        writeChatFile(directories, 'chat-here', [makeMessage('here')]);

        await groups.migrateGroupChatsMetadataFormat([directories]);

        const after = readGroup(directories, 'gk');
        expect(after.chat_metadata).toEqual({ note_prompt: 'nowhere to go' });
        expect(after.past_metadata).toEqual({ 'chat-orphan': { note_prompt: 'orphan' } });
        const firstLine = JSON.parse(fs.readFileSync(path.join(directories.groupChats, 'chat-here.jsonl'), 'utf8').split('\n')[0]);
        expect(firstLine.chat_metadata).toEqual({ note_prompt: 'lands' });
        const backup = JSON.parse(fs.readFileSync(path.join(directories.backups, '_group_metadata_update', 'gk.json'), 'utf8'));
        expect(backup.past_metadata['chat-here']).toEqual({ note_prompt: 'lands' });

        // Nothing left that can land: a second run writes nothing.
        const before = snapshot(directories.root);
        await groups.migrateGroupChatsMetadataFormat([directories]);
        expect(snapshot(directories.root)).toEqual(before);
    });

    test('a chat file after the tree migration renamed it keeps its metadata in the group JSON', async () => {
        const directories = makeDirectories();
        writeOldFormatGroup(directories, {
            groupId: 'gr',
            chatId: 'chat-r',
            messages: [makeMessage('r1'), makeMessage('r2')],
            chatMetadata: { note_prompt: 'still here' },
        });
        await migration.migrateCharacterChats(directories, 'gr', directories.groupChats, true, ['chat-r.jsonl']);

        await groups.migrateGroupChatsMetadataFormat([directories]);

        expect(readGroup(directories, 'gr').chat_metadata).toEqual({ note_prompt: 'still here' });
        expect((await treeDb.loadBranch(directories, 'gr', 'chat-r'))?.messages.map(m => m.mes)).toEqual(['r1', 'r2']);
    });

    test('a headerless chat file with a malformed line keeps every line when the header is added', async () => {
        const directories = makeDirectories();
        writeOldFormatGroup(directories, {
            groupId: 'gb',
            chatId: 'chat-b',
            messages: [],
            chatMetadata: { note_prompt: 'm' },
        });
        const original = [JSON.stringify(makeMessage('one')), '{broken', JSON.stringify(makeMessage('two'))].join('\n') + '\n';
        fs.writeFileSync(path.join(directories.groupChats, 'chat-b.jsonl'), original);

        await groups.migrateGroupChatsMetadataFormat([directories]);

        const raw = fs.readFileSync(path.join(directories.groupChats, 'chat-b.jsonl'), 'utf8');
        const [headerLine, ...rest] = raw.split('\n');
        expect(JSON.parse(headerLine).chat_metadata).toEqual({ note_prompt: 'm' });
        expect(rest.join('\n')).toBe(original);
    });
});

async function postJson(urlPath, body) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
}

/** Whether `promise` has settled 50ms from now. */
async function isSettled(promise) {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    return settled;
}

describe('the group migration runs after the server listens', () => {
    test('the boot chain before listening no longer runs it; postSetupTasks starts it', () => {
        const source = fs.readFileSync(path.join(process.cwd(), '..', 'src', 'server-main.js'), 'utf8');
        const chainStart = source.indexOf('initUserStorage(globalThis.DATA_ROOT)');
        const listenAt = source.indexOf('new ServerStartup(app, cliArgs).start()', chainStart);
        expect(chainStart).toBeGreaterThan(-1);
        expect(listenAt).toBeGreaterThan(chainStart);
        const preListen = source.slice(chainStart, listenAt);
        expect(preListen).not.toMatch(/GroupChat/);

        const postSetup = source.slice(source.indexOf('async function postSetupTasks('));
        const postSetupBody = postSetup.slice(0, postSetup.indexOf('\n}\n'));
        expect(postSetupBody).toContain('startGroupChatMigrations(');
        expect(postSetupBody).not.toMatch(/await\s+startGroupChatMigrations/);
        // The restore starts from inside the migration's completion callback, not beside it.
        const restoreAt = postSetupBody.indexOf('maybeStartGroupChatRestore(');
        expect(restoreAt).toBeGreaterThan(postSetupBody.indexOf('afterMigration'));
        expect(postSetupBody.match(/maybeStartGroupChatRestore\(/g)).toHaveLength(1);
    });

    test('startGroupChatMigrations() returns without waiting, and runs what follows only after the pass', async () => {
        /** @type {() => void} */
        let finish = () => {};
        const events = [];
        const done = migration.startGroupChatMigrations({
            migrate: () => new Promise(resolve => { finish = () => { events.push('migrated'); resolve(undefined); }; }),
            afterMigration: () => { events.push('after'); },
        });
        expect(await isSettled(done)).toBe(false);
        expect(events).toEqual([]);
        finish();
        await done;
        expect(events).toEqual(['migrated', 'after']);
    });

    test('a failed pass does not run what follows, and does not reject', async () => {
        const after = jest.fn();
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await migration.startGroupChatMigrations({ migrate: async () => { throw new Error('boom'); }, afterMigration: after });
        } finally {
            error.mockRestore();
        }
        expect(after).not.toHaveBeenCalled();
    });
});

describe('the pass migrates one group at a time', () => {
    test('each group gets its metadata then its tree migration, with a yield between groups', async () => {
        const directories = makeDirectories();
        const ids = ['ga', 'gb', 'gc'];
        for (const id of ids) {
            writeOldFormatGroup(directories, {
                groupId: id,
                chatId: `chat-${id}`,
                messages: [makeMessage(`${id}-first`), makeMessage(`${id}-second`)],
                chatMetadata: { note_prompt: `meta-${id}` },
            });
        }
        const isDone = id => !fs.existsSync(path.join(directories.groupChats, `chat-${id}.jsonl`))
            && fs.existsSync(path.join(directories.groupChats, `chat-${id}.jsonl.pre-migration`))
            && !Object.hasOwn(readGroup(directories, id), 'chat_metadata');
        const isUntouched = id => fs.existsSync(path.join(directories.groupChats, `chat-${id}.jsonl`))
            && Object.hasOwn(readGroup(directories, id), 'chat_metadata');

        /** @type {string[][]} */
        const doneAtEachYield = [];
        await migration.migrateUserGroupChats(directories, {
            yieldBetweenGroups: async () => {
                const done = ids.filter(isDone);
                expect(ids.filter(id => !isDone(id)).every(isUntouched)).toBe(true);
                doneAtEachYield.push(done);
            },
        });

        expect(doneAtEachYield.map(done => done.length)).toEqual([1, 2, 3]);
        for (const id of ids) {
            const loaded = await treeDb.loadBranch(directories, id, `chat-${id}`);
            expect(loaded?.messages.map(m => m.mes)).toEqual([`${id}-first`, `${id}-second`]);
            expect(loaded?.metadata).toEqual({ note_prompt: `meta-${id}` });
        }
    });
});

describe('group writes during the pass', () => {
    test('a group save racing the metadata migration is not lost', async () => {
        const directories = makeDirectories();
        requestDirectories = directories;
        writeOldFormatGroup(directories, {
            groupId: 'g-race',
            chatId: 'chat-race',
            messages: [makeMessage('r-first'), makeMessage('r-second')],
            chatMetadata: { note_prompt: 'race meta' },
        });

        const gate = armChatWriteGate();
        const pass = migration.migrateUserGroupChats(directories);
        await gate.reached;

        const save = postJson('/api/groups/save-partial', { id: 'g-race', props: { name: 'Renamed mid-migration' } });
        // The save waits for the group's lock, which the migration holds until its step for this group is done.
        expect(await isSettled(save)).toBe(false);
        gate.release();
        await Promise.all([pass, save]);

        const after = readGroup(directories, 'g-race');
        expect(after.name).toBe('Renamed mid-migration');
        expect(Object.hasOwn(after, 'chat_metadata')).toBe(false);
        const loaded = await treeDb.loadBranch(directories, 'g-race', 'chat-race');
        expect(loaded?.messages.map(m => m.mes)).toEqual(['r-first', 'r-second']);
        expect(loaded?.metadata).toEqual({ note_prompt: 'race meta' });
    });

    test('opening a group during its migration waits, so its metadata still lands in the tree', async () => {
        const directories = makeDirectories();
        requestDirectories = directories;
        writeOldFormatGroup(directories, {
            groupId: 'g-open',
            chatId: 'chat-open',
            messages: [makeMessage('o-first'), makeMessage('o-second')],
            chatMetadata: { note_prompt: 'open meta' },
        });

        const gate = armChatWriteGate();
        const pass = migration.migrateUserGroupChats(directories);
        await gate.reached;

        const open = postJson('/api/chats/group/get', { id: 'chat-open', group_id: 'g-open' });
        expect(await isSettled(open)).toBe(false);
        gate.release();
        const [, messages] = await Promise.all([pass, open]);

        expect(messages.slice(1).map(m => m.mes)).toEqual(['o-first', 'o-second']);
        const loaded = await treeDb.loadBranch(directories, 'g-open', 'chat-open');
        expect(loaded?.metadata).toEqual({ note_prompt: 'open meta' });
        expect(Object.hasOwn(readGroup(directories, 'g-open'), 'chat_metadata')).toBe(false);
    });
});
