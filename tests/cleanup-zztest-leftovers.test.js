import { describe, test, expect, jest, beforeAll, afterAll, afterEach } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import { openWasmDatabase, streamRows } from '../src/endpoints/sqlite-engine.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

// A native sqlite build is not guaranteed in every test environment; wasm is.
jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    getSqliteEngine: jest.fn(async () => ({
        kind: 'wasm',
        openDatabase: (dbPath) => openWasmDatabase(WasmDatabase, dbPath),
    })),
    openWasmDatabase,
    openNativeDatabase: jest.fn(),
    streamRows,
}));

/** @param {object | undefined} params */
const prefixParams = params => (params ? Object.fromEntries(Object.entries(params).map(([k, v]) => [`@${k}`, v])) : {});

/** The part of better-sqlite3's API the script uses, over wasm; records how each connection was opened. */
class WasmBetterSqlite3 {
    /** @type {{ file: string, options: object }[]} */
    static opened = [];

    constructor(file, options = {}) {
        WasmBetterSqlite3.opened.push({ file, options });
        this.db = new WasmDatabase(file, { readOnly: !!options.readonly, fileMustExist: !!options.fileMustExist });
    }

    prepare(sql) {
        const db = this.db;
        const once = fn => {
            const stmt = db.prepare(sql);
            try {
                return fn(stmt);
            } finally {
                stmt.finalize();
            }
        };
        return {
            get: params => once(stmt => stmt.get(prefixParams(params)) ?? undefined),
            run: params => once(stmt => stmt.run(prefixParams(params))),
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

    exec(sql) {
        this.db.exec(sql);
    }

    close() {
        this.db.close();
    }
}

/** @type {typeof import('../src/migrations/cleanup-zztest-leftovers.js')} */
let cleanup;
/** @type {typeof import('../src/message-tree-db.js')} */
let treeDb;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metaDb;
/** @type {typeof import('../public/scripts/hash-utils.js')} */
let hashUtils;

let port = 0;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-zztest-config-'));

beforeAll(async () => {
    port = await new Promise(resolve => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
            const { port: free } = /** @type {net.AddressInfo} */ (probe.address());
            probe.close(() => resolve(free));
        });
    });
    const configPath = path.join(configDir, 'config.yaml');
    fs.writeFileSync(configPath, `port: ${port}\nlisten: false\n`);
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(configPath);

    cleanup = await import('../src/migrations/cleanup-zztest-leftovers.js');
    treeDb = await import('../src/message-tree-db.js');
    metaDb = await import('../src/character-metadata-db.js');
    hashUtils = await import('../public/scripts/hash-utils.js');
});

afterAll(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
});

const tmpDirs = [];
afterEach(() => {
    treeDb.disposeMessageTreeStores();
    metaDb.disposeMetadataStores();
    WasmBetterSqlite3.opened = [];
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const GROUP = () => ({
    id: cleanup.GROUP_ID,
    name: 'Ivy and friends',
    members: ['ivy.png', 'rowan.png'],
    avatar_url: '',
    allow_self_responses: false,
    activation_strategy: 0,
    generation_mode: 0,
    disabled_members: [],
    chat_metadata: {},
    fav: false,
    chat_id: cleanup.GROUP_CHAT,
    chats: [cleanup.GROUP_CHAT, cleanup.STRAY_GROUP_CHAT],
    auto_mode_delay: 5,
});

const message = (mes, isUser) => JSON.stringify({ name: isUser ? 'User' : 'Ivy', is_user: isUser, mes, send_date: 'd', extra: {} });

/** The user's data as the facts describe it. */
async function makeScratch({ group = GROUP() } = {}) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-zztest-'));
    tmpDirs.push(dataRoot);
    const root = path.join(dataRoot, 'default-user');
    const dirs = {
        root,
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'group chats'),
        characters: path.join(root, 'characters'),
        backups: path.join(root, 'backups'),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dirs.groups, `${cleanup.GROUP_ID}.json`), JSON.stringify(group, null, 4));

    const db = await treeDb.getDbHandle(dirs);
    const insert = (row) => db.run(
        'INSERT INTO messages (id, parent_id, owner_id, content, label, created_at, default_child_id, metadata) VALUES (@id, @parent, @owner, @content, @label, @createdAt, NULL, @metadata)',
        { parent: null, label: null, metadata: null, createdAt: 1000, ...row },
    );
    const setDefault = (id, child) => db.run('UPDATE messages SET default_child_id = @child WHERE id = @id', { id, child });
    db.transaction(() => {
        const owner = cleanup.GROUP_ID;
        insert({ id: cleanup.GROUP_ANCHOR_ID, owner, content: '{"__anchor":true}' });
        insert({ id: cleanup.IVY_OPENING_ID, parent: cleanup.GROUP_ANCHOR_ID, owner, content: message('Hello, I am Ivy.', false) });
        insert({
            id: cleanup.HI_GROUP_ID, parent: cleanup.GROUP_ANCHOR_ID, owner, content: message('hi group', true), createdAt: 1789578278574,
            metadata: JSON.stringify({ integrity: 'bc756733-f799-4d6b-847c-20c413afd4a5', __is_group: true }),
        });
        setDefault(cleanup.GROUP_ANCHOR_ID, cleanup.HI_GROUP_ID);
        let parent = cleanup.IVY_OPENING_ID;
        for (let i = 0; i < 27; i++) {
            const id = `mid-${i}`;
            insert({ id, parent, owner, content: message(`m${i}`, i % 2 === 0) });
            setDefault(parent, id);
            parent = id;
        }
        insert({ id: cleanup.LABEL_NODE_ID, parent, owner, content: message('last', false), label: cleanup.GROUP_CHAT, metadata: '{"integrity":"x","__is_group":true}' });
        setDefault(parent, cleanup.LABEL_NODE_ID);

        insert({ id: cleanup.STRAY_ANCHOR_ID, owner: cleanup.STRAY_OWNER, content: '{"__anchor":true}' });
        insert({ id: cleanup.STRAY_CHILD_ID, parent: cleanup.STRAY_ANCHOR_ID, owner: cleanup.STRAY_OWNER, content: message('hi', true) });
        setDefault(cleanup.STRAY_ANCHOR_ID, cleanup.STRAY_CHILD_ID);

        insert({ id: 'other-anchor', owner: 'someone-else', content: '{"__anchor":true}' });
    });
    treeDb.disposeMessageTreeStores();

    await metaDb.ensureSchemaMigrated(dirs);
    await metaDb.upsertGroupRow(dirs, group.id, group.name, { fav: group.fav, group });
    metaDb.disposeMetadataStores();

    return { dataRoot, root, dirs };
}

/** Every file under `dir` with its sha1, so any write shows. */
function snapshotFiles(dir) {
    const out = {};
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                out[path.relative(dir, full) + '/'] = 'dir';
                walk(full);
            } else {
                out[path.relative(dir, full)] = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
            }
        }
    };
    walk(dir);
    return out;
}

/** @param {string} file @param {(db: any) => any} fn */
function withDb(file, fn) {
    const db = new WasmDatabase(file);
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

const treeRow = (root, id) => withDb(path.join(root, 'message-tree.sqlite'), db => db.get('SELECT * FROM messages WHERE id = ?', [id]));
const groupRow = root => withDb(path.join(root, 'character-metadata.sqlite'), db => db.get('SELECT * FROM groups WHERE id = ?', [cleanup.GROUP_ID]));
const readGroup = dirs => JSON.parse(fs.readFileSync(path.join(dirs.groups, `${cleanup.GROUP_ID}.json`), 'utf8'));

async function run(scratch, args, { Database = WasmBetterSqlite3 } = {}) {
    const logs = [];
    const warns = [];
    const code = await cleanup.main([...args, '--data-root', scratch.dataRoot, '--handle', 'default-user'], {
        Database, log: l => logs.push(l), warn: l => warns.push(l),
    });
    return { code, logs, warns, all: [...logs, ...warns].join('\n') };
}

const APPLY = ['--apply', '--server-stopped'];

describe('cleanup-zztest-leftovers', () => {
    test('dry run reports all three changes, opens read-only, and writes nothing', async () => {
        const scratch = await makeScratch();
        const before = snapshotFiles(scratch.dataRoot);

        const out = await run(scratch, ['--dry-run']);

        expect(out.code).toBe(0);
        expect(out.all).toContain('1. group file: WOULD CHANGE');
        expect(out.all).toContain(`chats: ["${cleanup.GROUP_CHAT}","${cleanup.STRAY_GROUP_CHAT}"] -> ["${cleanup.GROUP_CHAT}"]`);
        expect(out.all).toMatch(/groups row digest_content: \d+ -> \d+/);
        expect(out.all).toContain('2. anchor default: WOULD CHANGE');
        expect(out.all).toContain(`default_child_id: ${cleanup.HI_GROUP_ID}`);
        expect(out.all).toContain('3. zztestchar rows: WOULD CHANGE');
        expect(out.all).toContain('dry run: nothing was written.');
        expect(snapshotFiles(scratch.dataRoot)).toEqual(before);
        expect(WasmBetterSqlite3.opened.length).toBeGreaterThan(0);
        for (const { options } of WasmBetterSqlite3.opened) {
            expect(options).toEqual({ readonly: true, fileMustExist: true });
        }
    });

    test('real run makes all three changes and backs up what it changed first', async () => {
        const scratch = await makeScratch();
        const originalGroupText = fs.readFileSync(path.join(scratch.dirs.groups, `${cleanup.GROUP_ID}.json`), 'utf8');
        const rowsBefore = [cleanup.GROUP_ANCHOR_ID, cleanup.STRAY_ANCHOR_ID, cleanup.STRAY_CHILD_ID].map(id => treeRow(scratch.root, id));
        const groupRowBefore = groupRow(scratch.root);

        const out = await run(scratch, APPLY);

        expect(out.warns).toEqual([]);
        expect(out.code).toBe(0);

        const expectedGroup = { ...GROUP(), chats: [cleanup.GROUP_CHAT] };
        expect(readGroup(scratch.dirs)).toEqual(expectedGroup);
        expect(fs.readFileSync(path.join(scratch.dirs.groups, `${cleanup.GROUP_ID}.json`), 'utf8')).toBe(JSON.stringify(expectedGroup, null, 4));
        const row = groupRow(scratch.root);
        expect(Number(row.digest_content)).toBe(hashUtils.groupDigestContentHash(JSON.parse(JSON.stringify(expectedGroup))));
        expect(Number(row.digest_content)).not.toBe(Number(groupRowBefore.digest_content));

        expect(treeRow(scratch.root, cleanup.GROUP_ANCHOR_ID).default_child_id).toBe(cleanup.IVY_OPENING_ID);
        expect(treeRow(scratch.root, cleanup.HI_GROUP_ID)).toBeTruthy();
        expect(treeRow(scratch.root, cleanup.STRAY_ANCHOR_ID)).toBeNull();
        expect(treeRow(scratch.root, cleanup.STRAY_CHILD_ID)).toBeNull();
        expect(treeRow(scratch.root, 'other-anchor')).toBeTruthy();

        const backupParent = path.join(scratch.dirs.backups, '_cleanup-zztest-leftovers');
        const [backupDir] = fs.readdirSync(backupParent);
        const dir = path.join(backupParent, backupDir);
        expect(fs.readFileSync(path.join(dir, `group-${cleanup.GROUP_ID}.json`), 'utf8')).toBe(originalGroupText);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'message-tree-rows.json'), 'utf8')).rows).toEqual(rowsBefore);
        const backedUpRow = JSON.parse(fs.readFileSync(path.join(dir, 'character-metadata-groups-row.json'), 'utf8'));
        expect(Number(backedUpRow.digest_content)).toBe(Number(groupRowBefore.digest_content));
    });

    test('second real run is a no-op', async () => {
        const scratch = await makeScratch();
        expect((await run(scratch, APPLY)).code).toBe(0);
        const before = snapshotFiles(scratch.dataRoot);

        const out = await run(scratch, APPLY);

        expect(out.code).toBe(0);
        expect(out.all).toContain('1. group file: ALREADY DONE');
        expect(out.all).toContain('2. anchor default: ALREADY DONE');
        expect(out.all).toContain('3. zztestchar rows: ALREADY DONE');
        expect(out.all).toContain('nothing to change; nothing was written.');
        expect(snapshotFiles(scratch.dataRoot)).toEqual(before);
    });

    test('state that does not match is refused and left untouched', async () => {
        const scratch = await makeScratch({ group: { ...GROUP(), chats: [cleanup.GROUP_CHAT, cleanup.STRAY_GROUP_CHAT, 'another'] } });
        withDb(path.join(scratch.root, 'message-tree.sqlite'), db => {
            db.run('UPDATE messages SET default_child_id = NULL WHERE id = ?', [cleanup.GROUP_ANCHOR_ID]);
            db.run('INSERT INTO messages (id, parent_id, owner_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
                ['extra', cleanup.STRAY_CHILD_ID, cleanup.STRAY_OWNER, message('more', false), 1]);
        });
        const before = snapshotFiles(scratch.dataRoot);

        const out = await run(scratch, APPLY);

        expect(out.code).toBe(1);
        expect(out.warns.join('\n')).toContain('1. group file: REFUSED - chats is');
        expect(out.warns.join('\n')).toContain('2. anchor default: REFUSED - default_child_id is null');
        expect(out.warns.join('\n')).toContain('3. zztestchar rows: REFUSED - owner rows are');
        expect(snapshotFiles(scratch.dataRoot)).toEqual(before);
    });

    test('an existing zztestchar character refuses item 3 only', async () => {
        const scratch = await makeScratch();
        fs.writeFileSync(path.join(scratch.dirs.characters, 'zztestchar.png'), 'png');

        const out = await run(scratch, APPLY);

        expect(out.code).toBe(1);
        expect(out.warns.join('\n')).toContain('3. zztestchar rows: REFUSED - character zztestchar exists');
        expect(treeRow(scratch.root, cleanup.STRAY_ANCHOR_ID)).toBeTruthy();
        expect(treeRow(scratch.root, cleanup.STRAY_CHILD_ID)).toBeTruthy();
        expect(treeRow(scratch.root, cleanup.GROUP_ANCHOR_ID).default_child_id).toBe(cleanup.IVY_OPENING_ID);
        expect(readGroup(scratch.dirs).chats).toEqual([cleanup.GROUP_CHAT]);
    });

    describe('while the server is running', () => {
        /** @type {net.Server} */
        let server;
        afterEach(async () => {
            await new Promise(resolve => server.close(resolve));
        });
        const listen = () => new Promise(resolve => {
            server = net.createServer().listen(port, '127.0.0.1', resolve);
        });

        test('the real run is refused', async () => {
            const scratch = await makeScratch();
            await listen();
            const before = snapshotFiles(scratch.dataRoot);

            const out = await run(scratch, APPLY);

            expect(out.code).toBe(1);
            expect(out.all).toContain(`port probe 127.0.0.1:${port}: in-use`);
            expect(out.warns.join('\n')).toContain('REFUSED: the server appears to be running');
            expect(snapshotFiles(scratch.dataRoot)).toEqual(before);
            expect(WasmBetterSqlite3.opened).toEqual([]);
        });

        test('the dry run is allowed', async () => {
            const scratch = await makeScratch();
            await listen();
            const before = snapshotFiles(scratch.dataRoot);

            const out = await run(scratch, ['--dry-run']);

            expect(out.code).toBe(0);
            expect(out.all).toContain('2. anchor default: WOULD CHANGE');
            expect(snapshotFiles(scratch.dataRoot)).toEqual(before);
        });
    });

    test('a real run without --server-stopped is refused', async () => {
        const scratch = await makeScratch();
        const before = snapshotFiles(scratch.dataRoot);

        const out = await run(scratch, ['--apply']);

        expect(out.code).toBe(1);
        expect(out.warns.join('\n')).toContain('needs --server-stopped');
        expect(snapshotFiles(scratch.dataRoot)).toEqual(before);
    });

    test.each([
        ['a missing marker index', db => db.exec('DROP INDEX idx_groups_fav_desc_name_fold_asc'), 'missing index(es) idx_groups_fav_desc_name_fold_asc'],
        ['file_mtime still present', db => db.exec('ALTER TABLE characters ADD COLUMN file_mtime INTEGER'), 'characters still has file_mtime'],
    ])('schema not current (%s): real run refused', async (_name, mutate, detail) => {
        const scratch = await makeScratch();
        withDb(path.join(scratch.root, 'character-metadata.sqlite'), mutate);
        const before = snapshotFiles(scratch.dataRoot);

        const out = await run(scratch, APPLY);

        expect(out.code).toBe(1);
        expect(out.warns.join('\n')).toContain(detail);
        expect(out.warns.join('\n')).toContain('start the server once, stop it, then rerun');
        expect(snapshotFiles(scratch.dataRoot)).toEqual(before);
    });

    test.each([[['--dry-run']], [APPLY]])('native better-sqlite3 unavailable: %j refused', async (args) => {
        const scratch = await makeScratch();
        const before = snapshotFiles(scratch.dataRoot);

        const out = await run(scratch, args, { Database: null });

        expect(out.code).toBe(1);
        expect(out.warns.join('\n')).toContain('native better-sqlite3 is not available');
        expect(snapshotFiles(scratch.dataRoot)).toEqual(before);
    });

    test('a missing groups row is reported, its digest write skipped, and no row created', async () => {
        const scratch = await makeScratch();
        withDb(path.join(scratch.root, 'character-metadata.sqlite'), db => db.run('DELETE FROM groups WHERE id = ?', [cleanup.GROUP_ID]));

        const dry = await run(scratch, ['--dry-run']);
        expect(dry.all).toContain(`groups row for ${cleanup.GROUP_ID}: missing - the digest write is skipped`);

        const out = await run(scratch, APPLY);

        expect(out.code).toBe(0);
        expect(out.all).toContain('groups row missing, digest write skipped');
        expect(readGroup(scratch.dirs).chats).toEqual([cleanup.GROUP_CHAT]);
        expect(groupRow(scratch.root)).toBeNull();
        const backupParent = path.join(scratch.dirs.backups, '_cleanup-zztest-leftovers');
        const [backupDir] = fs.readdirSync(backupParent);
        expect(fs.existsSync(path.join(backupParent, backupDir, 'character-metadata-groups-row.json'))).toBe(false);
    });

    test('with native better-sqlite3 where it loads: dry run, real run, then no-op', async () => {
        const { getBetterSqlite3 } = await import('../src/endpoints/native-sqlite.js');
        const Native = await getBetterSqlite3();
        if (!Native) return;
        const scratch = await makeScratch();
        const before = snapshotFiles(scratch.dataRoot);

        const dry = await run(scratch, ['--dry-run'], { Database: Native });
        expect(dry.code).toBe(0);
        expect(snapshotFiles(scratch.dataRoot)).toEqual(before);

        const real = await run(scratch, APPLY, { Database: Native });
        expect(real.warns).toEqual([]);
        expect(treeRow(scratch.root, cleanup.GROUP_ANCHOR_ID).default_child_id).toBe(cleanup.IVY_OPENING_ID);
        expect(treeRow(scratch.root, cleanup.STRAY_ANCHOR_ID)).toBeNull();

        const again = await run(scratch, APPLY, { Database: Native });
        expect(again.code).toBe(0);
        expect(again.all).toContain('nothing to change; nothing was written.');
    });

    test.each([[[]], [['--dry-run', '--apply']], [['--dry-run', '--bogus']]])('usage error for %j', async (args) => {
        const scratch = await makeScratch();
        const before = snapshotFiles(scratch.dataRoot);

        const out = await run(scratch, args);

        expect(out.code).toBe(2);
        expect(snapshotFiles(scratch.dataRoot)).toEqual(before);
    });
});
