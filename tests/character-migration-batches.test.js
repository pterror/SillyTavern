import { describe, test, expect, jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
        return handle.get(sql, params);
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
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** @param {string} name */
function card(name) {
    return JSON.stringify({ name, data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { world: '' } } });
}

/** Writes 'seed.png' through the store, then `count` raw copies of it with ids c00000.png, c00001.png, ... */
async function seedCopies(count) {
    await metadataDb.upsertCharacterFromWrite(directories, 'seed.png', card('seed'));
    withRawDb(db => {
        const columns = db.prepare('SELECT name FROM pragma_table_info(\'characters\')').pluck().all().filter(c => c !== 'id');
        db.prepare(`
            WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
            INSERT INTO characters (id, ${columns.join(', ')})
            SELECT printf('c%05d.png', n.i), ${columns.map(c => `s.${c}`).join(', ')} FROM n, characters s WHERE s.id = 'seed.png'
        `).run(count);
    });
}

/** @param {string} key */
function rawMeta(key) {
    return withRawDb(db => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null);
}

/** @param {string} id */
function shallowOf(id) {
    return withRawDb(db => JSON.parse(db.prepare('SELECT shallow_json FROM characters WHERE id = ?').get(id).shallow_json));
}

/** @param {string} where */
function markFavStale(where) {
    withRawDb(db => db.prepare(`UPDATE characters SET fav = 0, shallow_json = json_set(shallow_json, '$.fav', json('true')) WHERE ${where}`).run());
}

/** @param {string} where */
function dropTagIds(where) {
    withRawDb(db => db.prepare(`UPDATE characters SET shallow_json = json_remove(shallow_json, '$.tag_ids') WHERE ${where}`).run());
}

describe('one-time character passes resume after a mid-pass stop', () => {
    test('normalizeCharacterFavIfNeeded resumes after the last committed batch', async () => {
        await seedCopies(2500);
        markFavStale('1');

        transactionCalls = 0;
        crashAtTransaction = 2;
        await expect(metadataDb.normalizeCharacterFavIfNeeded(directories)).rejects.toThrow('simulated stop');
        crashAtTransaction = 0;

        expect(rawMeta('character_fav_normalized_v1_progress')).toBe('c00999.png');
        expect(rawMeta('character_fav_normalized_v1')).toBeNull();
        expect(shallowOf('c00999.png').fav).toBe(false);
        expect(shallowOf('c01000.png').fav).toBe(true);

        // A row before the saved key is made stale again: a resumed run must not revisit it.
        markFavStale('id = \'c00000.png\'');
        const result = await metadataDb.normalizeCharacterFavIfNeeded(directories);

        expect(shallowOf('c00000.png').fav).toBe(true);
        expect(shallowOf('c01000.png').fav).toBe(false);
        expect(shallowOf('seed.png').fav).toBe(false);
        expect(result).toEqual({ batches: 2, rowsChanged: 1501 });
        expect(rawMeta('character_fav_normalized_v1')).not.toBeNull();
        expect(rawMeta('character_fav_normalized_v1_progress')).toBeNull();
    }, 60000);

    test('backfillTagIdsInShallowJson resumes after the last committed batch', async () => {
        await seedCopies(1500);
        dropTagIds('1');

        transactionCalls = 0;
        crashAtTransaction = 2;
        await expect(metadataDb.backfillTagIdsInShallowJson(directories)).rejects.toThrow('simulated stop');
        crashAtTransaction = 0;

        expect(rawMeta('tag_ids_shallow_json_backfill_progress')).toBe('c00999.png');
        expect(rawMeta('tag_ids_shallow_json_backfill_completed')).toBeNull();
        expect(shallowOf('c00999.png').tag_ids).toEqual([]);
        expect('tag_ids' in shallowOf('c01000.png')).toBe(false);

        dropTagIds('id = \'c00000.png\'');
        const result = await metadataDb.backfillTagIdsInShallowJson(directories);

        expect('tag_ids' in shallowOf('c00000.png')).toBe(false);
        expect(shallowOf('c01000.png').tag_ids).toEqual([]);
        expect(shallowOf('seed.png').tag_ids).toEqual([]);
        expect(result).toEqual({ batches: 1, rowsChanged: 501 });
        expect(rawMeta('tag_ids_shallow_json_backfill_completed')).not.toBeNull();
        expect(rawMeta('tag_ids_shallow_json_backfill_progress')).toBeNull();
    }, 60000);
});

describe('one-time character passes are not marked done when a row fails', () => {
    const cases = [
        {
            pass: 'normalizeCharacterFavIfNeeded',
            flag: 'character_fav_normalized_v1',
            makeStale: () => markFavStale('1'),
            isFixed: (/** @type {string} */ id) => shallowOf(id).fav === false,
        },
        {
            pass: 'normalizeCharacterTagIdsIfNeeded',
            flag: 'character_tag_ids_normalized_v1',
            makeStale: () => withRawDb(db => db.prepare('UPDATE characters SET shallow_json = json_set(shallow_json, \'$.tag_ids\', json(\'["tb","ta"]\'))').run()),
            isFixed: (/** @type {string} */ id) => JSON.stringify(shallowOf(id).tag_ids) === '["ta","tb"]',
        },
        {
            pass: 'backfillTagIdsInShallowJson',
            flag: 'tag_ids_shallow_json_backfill_completed',
            makeStale: () => dropTagIds('1'),
            isFixed: (/** @type {string} */ id) => Array.isArray(shallowOf(id).tag_ids),
        },
    ];

    for (const { pass, flag, makeStale, isFixed } of cases) {
        test(`${pass}: the failed row is listed in a warning, the flag stays unset, and the next run starts over`, async () => {
            await seedCopies(2);
            makeStale();
            withRawDb(db => db.prepare('UPDATE characters SET shallow_json = \'{broken\' WHERE id = \'c00001.png\'').run());
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

            const result = await metadataDb[pass](directories);

            expect(result).toEqual({ batches: 1, rowsChanged: 2 });
            expect(isFixed('c00000.png')).toBe(true);
            expect(isFixed('seed.png')).toBe(true);
            const warnings = warn.mock.calls.map(args => args.join(' '));
            expect(warnings.some(w => w.includes('c00001.png'))).toBe(true);
            expect(warnings.some(w => w.includes('c00000.png') || w.includes('seed.png'))).toBe(false);
            expect(rawMeta(flag)).toBeNull();
            expect(rawMeta(`${flag.replace(/_completed$/, '')}_progress`)).toBeNull();

            withRawDb(db => db.prepare('UPDATE characters SET shallow_json = (SELECT shallow_json FROM characters WHERE id = \'c00000.png\') WHERE id = \'c00001.png\'').run());
            makeStale();
            warn.mockClear();
            await metadataDb[pass](directories);

            expect(isFixed('c00000.png')).toBe(true);
            expect(isFixed('c00001.png')).toBe(true);
            expect(warn).not.toHaveBeenCalled();
            expect(rawMeta(flag)).not.toBeNull();
        });
    }
});

describe('one-time character passes checkpoint the WAL', () => {
    test('PASSIVE every 10 batches, TRUNCATE once at the end', async () => {
        await seedCopies(10_001);
        checkpointCalls = [];

        const result = await metadataDb.normalizeCharacterTagIdsIfNeeded(directories);

        expect(result.batches).toBe(11);
        expect(checkpointCalls).toEqual(['PASSIVE', 'TRUNCATE']);
    }, 60000);
});
