import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defineCharacterStoreFunctions } from '../src/character-store-schema.js';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;
/** @type {typeof import('better-sqlite3')} */
let Database;
const originalCwd = process.cwd();

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/** While armed, the transaction call with this 1-based number throws instead of running. */
let crashAtTransaction = 0;
let transactionCalls = 0;
/** @type {string[]} */
let checkpointCalls = [];
/** @type {((sql: string, params: any) => boolean) | null} run() throws instead of running a statement this matches. */
let failWrite = null;
/** @type {((sql: string, params: any) => boolean) | null} get() throws instead of running a statement this matches. */
let failRead = null;

/** @param {any} handle */
function instrumentedHandle(handle) {
    const wrapped = { ...handle };
    wrapped.transaction = (fn) => {
        transactionCalls++;
        if (crashAtTransaction && transactionCalls === crashAtTransaction) {
            throw new Error('simulated stop');
        }
        return handle.transaction(fn);
    };
    wrapped.get = (sql, params) => {
        const match = /wal_checkpoint\((\w+)\)/.exec(String(sql));
        if (match) checkpointCalls.push(match[1]);
        if (failRead?.(String(sql), params)) {
            throw new Error('simulated read failure');
        }
        return handle.get(sql, params);
    };
    wrapped.run = (sql, params) => {
        if (failWrite?.(String(sql), params)) {
            throw new Error('simulated write failure');
        }
        return handle.run(sql, params);
    };
    wrapped.checkpoint = () => {
        checkpointCalls.push('TRUNCATE');
        return handle.checkpoint();
    };
    return wrapped;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    const sqliteEngine = await import('../src/endpoints/sqlite-engine.js');
    const engine = await sqliteEngine.getSqliteEngine();
    const openDatabase = engine.openDatabase;
    engine.openDatabase = (dbPath) => instrumentedHandle(openDatabase(dbPath));

    metadataDb = await import('../src/character-metadata-db.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
    Database = (await import('better-sqlite3')).default;
});

afterAll(() => {
    process.chdir(originalCwd);
});

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-character-migration-batches-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
        thumbnailsAvatar: path.join(tempDir, 'thumbnails', 'avatar'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats, directories.thumbnailsAvatar]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    crashAtTransaction = 0;
    transactionCalls = 0;
    checkpointCalls = [];
    failWrite = null;
    failRead = null;
});

afterEach(async () => {
    jest.restoreAllMocks();
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @template T @param {(db: import('better-sqlite3').Database) => T} fn @returns {T} */
function withRawDb(fn) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    defineCharacterStoreFunctions({ defineFunction: (name, f) => db.function(name, { deterministic: true }, f) });
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** @param {string} key */
function rawMeta(key) {
    return withRawDb(db => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null);
}

/** @param {boolean} fav */
async function groupDigestFav(fav) {
    const { groupDigestFavHash } = await import('../public/scripts/hash-utils.js');
    return groupDigestFavHash({ fav });
}

/** Group files g00000.json, g00001.json, ... holding fav "false", with rows whose fav column and digest_fav say true. */
async function seedStaleGroups(count) {
    const seed = { id: 'seedg', name: 'seedg', members: [], chats: [], fav: 'false' };
    fs.writeFileSync(path.join(directories.groups, 'seedg.json'), JSON.stringify(seed));
    await metadataDb.upsertGroupRow(directories, 'seedg', 'seedg', { fav: false, group: seed });
    for (let i = 0; i < count; i++) {
        const id = `g${String(i).padStart(5, '0')}`;
        fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify({ ...seed, id, name: id }));
    }
    const staleDigest = await groupDigestFav(true);
    withRawDb(db => {
        const columns = Array.from(db.prepare('SELECT name FROM pragma_table_info(\'groups\')').pluck().iterate()).filter(c => c !== 'id');
        db.prepare(`
            WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
            INSERT INTO groups (id, ${columns.join(', ')})
            SELECT printf('g%05d', n.i), ${columns.map(c => `s.${c}`).join(', ')} FROM n, groups s WHERE s.id = 'seedg'
        `).run(count);
        db.prepare('UPDATE groups SET fav = 1, digest_fav = ?').run(staleDigest);
    });
}

/** @param {string} id */
function groupFavOf(id) {
    return withRawDb(db => db.prepare('SELECT fav FROM groups WHERE id = ?').get(id).fav);
}

describe('one-time passes checkpoint the WAL', () => {
    test('PASSIVE every 10 batches, TRUNCATE once at the end', async () => {
        await seedStaleGroups(10_000);
        checkpointCalls = [];

        const result = await metadataDb.normalizeGroupFavIfNeeded(directories);

        expect(result.batches).toBe(11);
        expect(checkpointCalls).toEqual(['PASSIVE', 'TRUNCATE']);
    }, 60000);
});

describe('one-time group and card-tag passes resume after a mid-pass stop', () => {
    test('normalizeGroupFavIfNeeded resumes after the last committed batch', async () => {
        await seedStaleGroups(1500);

        transactionCalls = 0;
        crashAtTransaction = 2;
        await expect(metadataDb.normalizeGroupFavIfNeeded(directories)).rejects.toThrow('simulated stop');
        crashAtTransaction = 0;

        expect(rawMeta(`${metadataDb.GROUP_FAV_NORMALIZED_FLAG}_progress`)).toBe('g00999');
        expect(rawMeta(metadataDb.GROUP_FAV_NORMALIZED_FLAG)).toBeNull();
        expect(groupFavOf('g00999')).toBe(0);
        expect(groupFavOf('g01000')).toBe(1);

        // A row before the saved key is made stale again: a resumed run must not revisit it.
        withRawDb(db => db.prepare('UPDATE groups SET fav = 1 WHERE id = \'g00000\'').run());
        const result = await metadataDb.normalizeGroupFavIfNeeded(directories);

        expect(groupFavOf('g00000')).toBe(1);
        expect(groupFavOf('g01000')).toBe(0);
        expect(groupFavOf('seedg')).toBe(0);
        expect(result).toEqual({ batches: 1, rowsChanged: 501 });
        expect(rawMeta(metadataDb.GROUP_FAV_NORMALIZED_FLAG)).not.toBeNull();
        expect(rawMeta(`${metadataDb.GROUP_FAV_NORMALIZED_FLAG}_progress`)).toBeNull();
    }, 60000);

});

describe('one-time group, tag and card-tag passes are not marked done when a row fails', () => {
    test('normalizeGroupFavIfNeeded: the failed group is listed, the flag stays unset, and the next run starts over', async () => {
        await seedStaleGroups(2);
        fs.writeFileSync(path.join(directories.groups, 'g00001.json'), '{broken');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await metadataDb.normalizeGroupFavIfNeeded(directories);

        expect(result).toEqual({ batches: 1, rowsChanged: 2 });
        expect(groupFavOf('g00000')).toBe(0);
        expect(groupFavOf('g00001')).toBe(1);
        const warnings = warn.mock.calls.map(args => args.join(' '));
        expect(warnings.some(w => w.includes('g00001'))).toBe(true);
        expect(warnings.some(w => w.includes('g00000') || w.includes('seedg'))).toBe(false);
        expect(rawMeta(metadataDb.GROUP_FAV_NORMALIZED_FLAG)).toBeNull();
        expect(rawMeta(`${metadataDb.GROUP_FAV_NORMALIZED_FLAG}_progress`)).toBeNull();

        fs.writeFileSync(path.join(directories.groups, 'g00001.json'), JSON.stringify({ id: 'g00001', name: 'g00001', members: [], chats: [], fav: 'false' }));
        warn.mockClear();
        await metadataDb.normalizeGroupFavIfNeeded(directories);

        expect(groupFavOf('g00001')).toBe(0);
        expect(warn).not.toHaveBeenCalled();
        expect(rawMeta(metadataDb.GROUP_FAV_NORMALIZED_FLAG)).not.toBeNull();
    });

    test('recoverNumericIdGroupsIfNeeded: the failed file is listed by name and the flag stays unset', async () => {
        fs.writeFileSync(path.join(directories.groups, '777.json'), JSON.stringify({ id: 777, name: 'Legacy', members: [], chats: [] }));
        fs.writeFileSync(path.join(directories.groups, 'broken.json'), '{broken');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await metadataDb.recoverNumericIdGroupsIfNeeded(directories);

        expect(result).toEqual({ batches: 1, rowsChanged: 1 });
        expect(withRawDb(db => db.prepare('SELECT name FROM groups WHERE id = \'777\'').get())?.name).toBe('Legacy');
        const warnings = warn.mock.calls.map(args => args.join(' '));
        expect(warnings.some(w => w.includes('broken.json'))).toBe(true);
        expect(warnings.some(w => w.includes('777.json'))).toBe(false);
        expect(rawMeta(metadataDb.GROUP_NUMERIC_ID_RECOVERY_FLAG)).toBeNull();

        fs.rmSync(path.join(directories.groups, 'broken.json'));
        const rerun = await metadataDb.recoverNumericIdGroupsIfNeeded(directories);

        expect(rerun).toEqual({ batches: 1, rowsChanged: 0 });
        expect(rawMeta(metadataDb.GROUP_NUMERIC_ID_RECOVERY_FLAG)).not.toBeNull();
    });

});

describe('one-time group and card-tag passes never leave a row half-written', () => {
    test('normalizeGroupFavIfNeeded: a write that throws rolls back its whole batch and fails the pass', async () => {
        await seedStaleGroups(1500);

        failWrite = (sql, params) => sql.startsWith('UPDATE groups SET') && params?.id === 'g01200';
        await expect(metadataDb.normalizeGroupFavIfNeeded(directories)).rejects.toThrow('simulated write failure');
        failWrite = null;

        expect(groupFavOf('g00999')).toBe(0);
        expect(groupFavOf('g01000')).toBe(1);
        expect(rawMeta(`${metadataDb.GROUP_FAV_NORMALIZED_FLAG}_progress`)).toBe('g00999');
        expect(rawMeta(metadataDb.GROUP_FAV_NORMALIZED_FLAG)).toBeNull();

        const result = await metadataDb.normalizeGroupFavIfNeeded(directories);

        expect(result).toEqual({ batches: 1, rowsChanged: 501 });
        expect(groupFavOf('g01200')).toBe(0);
        expect(rawMeta(metadataDb.GROUP_FAV_NORMALIZED_FLAG)).not.toBeNull();
    }, 60000);

});
