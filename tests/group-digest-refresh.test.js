import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('better-sqlite3')} */
let Database;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

const FLAG = 'group_digest_tag_ids_refreshed_v1';
const PROGRESS_KEY = `${FLAG}_progress`;
const STALE = 12345;

/** While armed, the transaction call with this 1-based number throws instead of running. */
let crashAtTransaction = 0;
let transactionCalls = 0;
/** @type {string[]} The SQL of every write made through the store's handle. */
let runSql = [];

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
    wrapped.run = (sql, params) => {
        runSql.push(sql);
        return handle.run(sql, params);
    };
    return wrapped;
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    const sqliteEngine = await import('../src/endpoints/sqlite-engine.js');
    const engine = await sqliteEngine.getSqliteEngine();
    const openDatabase = engine.openDatabase;
    engine.openDatabase = (dbPath, options) => instrumentedHandle(openDatabase(dbPath, options));

    metadataDb = await import('../src/character-metadata-db.js');
    Database = (await import('better-sqlite3')).default;
});

beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-group-digest-refresh-test-'));
    directories = /** @type {any} */ ({
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    crashAtTransaction = 0;
    transactionCalls = 0;
    runSql = [];
});

afterEach(() => {
    jest.restoreAllMocks();
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

/** @template T @param {(db: import('better-sqlite3').Database) => T} fn @returns {T} */
function withRawDb(fn) {
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

async function seedGroup(id) {
    const group = { id, name: id, members: [], chats: [], fav: false };
    fs.writeFileSync(path.join(directories.groups, `${id}.json`), JSON.stringify(group));
    await metadataDb.upsertGroupRow(directories, id, id, { fav: false, group });
}

/** @param {string[]} ids */
async function saveTags(ids) {
    expect(await metadataDb.saveTagDefinitions(directories, ids.map(id => ({ id, name: `name-${id}` })))).toBe('ok');
}

async function assign(id, tagId) {
    expect(await metadataDb.assignEntityTag(directories, id, tagId)).toBe('ok');
}

/** A new group row's digest_tag_ids is NULL; this leaves it with no tags and the digest of none. */
async function setNoTagsDigest(id) {
    await assign(id, 'tmp');
    expect(await metadataDb.unassignEntityTag(directories, id, 'tmp')).toBe('ok');
}

/** @returns {Record<string, number | null>} */
function digests() {
    return Object.fromEntries(withRawDb(db => Array.from(db.prepare('SELECT id, digest_tag_ids FROM groups ORDER BY id').iterate(), r => [r.id, r.digest_tag_ids])));
}

/** @param {string[]} ids @param {number | null} value */
function setDigest(ids, value) {
    withRawDb(db => {
        const update = db.prepare('UPDATE groups SET digest_tag_ids = ? WHERE id = ?');
        db.transaction(() => { for (const id of ids) update.run(value, id); })();
    });
}

function metaOf(key) {
    return withRawDb(db => db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key));
}

/** Listed lines of the form `  id`, in the order they were logged. */
function listedIds(warn) {
    return warn.mock.calls.map(args => String(args[0])).join('\n').split('\n').filter(line => /^ {2}\S/.test(line)).map(line => line.trim());
}

describe('refreshGroupDigestTagIdsIfNeeded', () => {
    test('with every digest right it writes only its done key, and once done it writes nothing and runs no transaction', async () => {
        await saveTags(['x', 'y']);
        await seedGroup('g1');
        await seedGroup('g2');
        await assign('g1', 'x');
        await assign('g1', 'y');
        await setNoTagsDigest('g2');
        const before = digests();
        expect(Object.values(before)).not.toContain(null);
        runSql = [];
        transactionCalls = 0;
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(await metadataDb.refreshGroupDigestTagIdsIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });

        expect(digests()).toEqual(before);
        expect(metaOf(FLAG)).toBeDefined();
        expect(metaOf(PROGRESS_KEY)).toBeUndefined();
        expect(runSql.filter(sql => !/INTO meta/.test(sql))).toEqual([]);
        expect(runSql.filter(sql => /INTO meta/.test(sql))).toHaveLength(1);
        expect(warn).not.toHaveBeenCalled();

        runSql = [];
        transactionCalls = 0;
        expect(await metadataDb.refreshGroupDigestTagIdsIfNeeded(directories)).toEqual({ batches: 0, rowsChanged: 0 });
        expect(runSql).toEqual([]);
        expect(transactionCalls).toBe(0);
    });

    test('a stale or NULL digest is recomputed from group_tags, and the warning lists exactly those groups', async () => {
        await saveTags(['x', 'y']);
        for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', 'legacy.png']) await seedGroup(id);
        await assign('g1', 'x');
        await assign('g2', 'y');
        await assign('g3', 'x');
        await assign('g3', 'y');
        await setNoTagsDigest('g4');
        await setNoTagsDigest('g5');
        withRawDb(db => db.prepare('INSERT INTO group_tags (group_id, tag_id) VALUES (\'legacy.png\', \'x\')').run());
        const right = digests();
        // legacy.png carries the same tags as g1.
        right['legacy.png'] = right.g1;
        setDigest(['g2', 'g4', 'legacy.png'], STALE);
        setDigest(['g3', 'g5'], null);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const result = await metadataDb.refreshGroupDigestTagIdsIfNeeded(directories);

        expect(digests()).toEqual(right);
        expect(listedIds(warn)).toEqual(['g2', 'g3', 'g4', 'g5', 'legacy.png']);
        expect(result).toEqual({ batches: 1, rowsChanged: 5 });
        expect(metaOf(FLAG)).toBeDefined();
        expect(metaOf(PROGRESS_KEY)).toBeUndefined();
    });

    test('runs right after removeOrphanTagRowsIfNeeded and before finishDeletedTags in MIGRATION_PASSES', async () => {
        const { MIGRATION_PASSES } = await import('../src/metadata-migration-coordinator.js');
        const at = MIGRATION_PASSES.indexOf(/** @type {any} */ ('refreshGroupDigestTagIdsIfNeeded'));
        expect(at).toBeGreaterThan(0);
        expect(MIGRATION_PASSES[at - 1]).toBe('removeOrphanTagRowsIfNeeded');
        expect(MIGRATION_PASSES.indexOf('finishDeletedTags')).toBeGreaterThan(at);
    });
});

/** Writes 'seed' through the store, then `count` raw copies g00000, g00001, ... with no tags and the digest of none. */
async function seedGroupCopies(count) {
    await seedGroup('seed');
    await setNoTagsDigest('seed');
    withRawDb(db => {
        const columns = Array.from(db.prepare('SELECT name FROM pragma_table_info(\'groups\')').pluck().iterate()).filter(c => c !== 'id');
        db.prepare(`
            WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
            INSERT INTO groups (id, ${columns.join(', ')})
            SELECT printf('g%05d', n.i), ${columns.map(c => `s.${c}`).join(', ')} FROM n, groups s WHERE s.id = 'seed'
        `).run(count);
    });
}

describe('refreshGroupDigestTagIdsIfNeeded over many batches', () => {
    const COUNT = 2500;
    const idOf = (/** @type {number} */ i) => `g${String(i).padStart(5, '0')}`;

    test('a page with nothing stale writes nothing: only the batch that changes digests and the done key write', async () => {
        await seedGroupCopies(COUNT);
        const right = digests();
        setDigest([idOf(2400)], STALE);
        runSql = [];
        transactionCalls = 0;
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(await metadataDb.refreshGroupDigestTagIdsIfNeeded(directories)).toEqual({ batches: 1, rowsChanged: 1 });

        expect(transactionCalls).toBe(2);
        expect(runSql.filter(sql => /INTO meta/.test(sql))).toHaveLength(2);
        expect(runSql.filter(sql => /UPDATE groups/.test(sql))).toHaveLength(1);
        expect(listedIds(warn)).toEqual([idOf(2400)]);
        expect(digests()).toEqual(right);
    }, 60000);

    test('a pass stopped mid-way resumes after the last batch that changed digests, and lists every changed group once', async () => {
        await seedGroupCopies(COUNT);
        const right = digests();
        const all = Object.keys(right).filter(id => id !== 'seed');
        // Every copy stale: every page changes digests, so every page saves its position.
        setDigest(all, STALE);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});

        transactionCalls = 0;
        crashAtTransaction = 2;
        await expect(metadataDb.refreshGroupDigestTagIdsIfNeeded(directories)).rejects.toThrow('simulated stop');
        crashAtTransaction = 0;

        const mid = digests();
        expect(all.filter(id => mid[id] === STALE)).toHaveLength(COUNT - 1000);
        expect(metaOf(PROGRESS_KEY)).toBeDefined();
        expect(metaOf(FLAG)).toBeUndefined();
        const firstRun = listedIds(warn);
        expect(firstRun).toEqual(all.slice(0, 1000));

        metadataDb.disposeMetadataStores();
        warn.mockClear();
        const result = await metadataDb.refreshGroupDigestTagIdsIfNeeded(directories);

        expect(result).toEqual({ batches: 2, rowsChanged: COUNT - 1000 });
        expect(listedIds(warn)).toEqual(all.slice(1000));
        expect(digests()).toEqual(right);
        expect(metaOf(FLAG)).toBeDefined();
        expect(metaOf(PROGRESS_KEY)).toBeUndefined();
    }, 60000);
});
